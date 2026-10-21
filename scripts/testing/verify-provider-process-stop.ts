// Run in a disposable Linux container WITHOUT --init to exercise orphan zombies.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { killCliTree, spawnCli } from "../../server/procs.ts";

assert.equal(process.platform, "linux");
for (const exitFirst of [false, true]) {
  const child = spawnCli(process.execPath, ["-e", `
    const helper = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000)"], {stdio:['ignore','pipe','ignore']});
    helper.stdout.once('data', data => { process.stdout.write(data); ${exitFirst ? "process.exit(0);" : ""} });
    setInterval(()=>{},1000);
  `], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  const [data] = await once(child.stdout, "data");
  const helper = Number(String(data).trim());
  try {
    assert(helper > 1);
    if (exitFirst) await closed;
    assert.equal(await killCliTree(child, 80), true, "dead helpers must not block retry");
    try {
      const stat = readFileSync(`/proc/${helper}/stat`, "utf8");
      assert.match(stat.slice(stat.lastIndexOf(")") + 2), /^[ZX]\s/, "no live helper may survive");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    assert.equal(await killCliTree(child, 80), true, "a repeated stop must remain safe");
    console.log(`PASS provider process stop: root exited first=${exitFirst}, no live helpers, retry allowed`);
  } finally { await killCliTree(child, 0); }
}
