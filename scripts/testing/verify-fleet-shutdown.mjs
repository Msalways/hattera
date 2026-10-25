// Run only against a packaged CLI, with a private home and Unix socket.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

const entry = process.argv[2];
assert.equal(process.platform, "linux", "Fleet service qualification requires Linux");
assert.ok(entry && isAbsolute(entry) && existsSync(entry), "Pass the absolute packaged cli.js path");
const home = mkdtempSync(join(tmpdir(), "hattera-agent-")), socket = join(home, "fleet.sock");
try {
  const result = await new Promise((done, fail) => {
    const child = spawn(process.execPath, [entry, "fleet", "agent", "--socket", socket], {
      env: { PATH: process.env.PATH, HOME: home, HATTERA_DATA_DIR: join(home, "data") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", signalled = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
    child.stdout.on("data", chunk => {
      output = (output + String(chunk)).slice(-4096);
      if (!signalled && output.includes("fleet agent listening on ")) { signalled = true; child.kill("SIGTERM"); }
    });
    child.stderr.on("data", chunk => { output = (output + String(chunk)).slice(-4096); });
    child.once("error", error => { clearTimeout(timer); fail(error); });
    child.once("close", code => { clearTimeout(timer); done({ code, signalled, timedOut, output }); });
  });
  assert.equal(result.timedOut, false, result.output);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.signalled, true, result.output);
  assert.equal(existsSync(socket), false, "Agent must close and unlink its private listener");
  console.log(JSON.stringify({ ok: true, fleetAgentGracefulShutdown: true }));
} finally {
  assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep));
  rmSync(home, { recursive: true, force: true });
}
