// Guard release identity without rejecting attribution or legacy wire contracts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const read=path=>readFileSync(join(root,path),"utf8");
const app=JSON.parse(read("package.json"));
assert.equal(app.name,"hattera"); assert.equal(app.productName,"Hattera");
assert.equal(app.repository.url,"https://github.com/Msalways/hattera.git");
for(const path of ["apps/docs/package.json","cloudflare/control-plane/package.json","companion/package.json"]) assert.ok(JSON.parse(read(path)).name.startsWith("@hattera/"),path);
const desktop=parse(read("electron-builder.yml"));
assert.equal(desktop.appId,"com.hattera.app"); assert.equal(desktop.productName,"Hattera");
assert.equal(desktop.linux.executableName,"hattera");
assert.equal(desktop.publish[0].owner,"Msalways"); assert.equal(desktop.publish[0].repo,"hattera");
assert.deepEqual(desktop.protocols[0].schemes,["hattera","openmausbot"]);
for(const path of ["src/lib/brand.ts","server/brand.ts"]) assert.match(read(path),/name: "Hattera"/);
for(const name of readdirSync(join(root,"src/locales")).filter(name=>name.endsWith(".json"))) assert.doesNotMatch(read(`src/locales/${name}`),/OpenMausBot|MausBot/,name);
for(const path of ["build/icon.ico","build/icon.icns","build/icon-1024.png","server/hattera.ts","server/legacy-cli.ts","scripts/control-hattera.ts","scripts/testing/control-hattera-ui.ts","server/hooks/hattera-hook.ts","server/testing/hattera-env.ts",".claude/skills/verify-hattera/SKILL.md"]) assert.ok(existsSync(join(root,path)),path);
assert.equal(readFileSync(join(root,"build/icon.icns")).subarray(0,4).toString(),"icns");
assert.match(read("server/legacy-cli.ts"),/import "\.\/hattera.ts"/);
for(const path of ["server/openmausbot.ts","scripts/control-omb.ts","scripts/control-omb.test.ts","scripts/testing/control-omb-ui.ts","scripts/testing/control-omb-ui.e2e.test.ts","server/control-omb.test.ts","server/hooks/omb-hook.ts","server/hooks/omb-hook.test.ts","server/testing/omb-env.ts","server/testing/scrub-ambient-omb-env.ts",".claude/skills/verify-omb/SKILL.md"]) assert.ok(!existsSync(join(root,path)),`Renamed source must not return: ${path}`);
for(const path of [".github/workflows/release.yml",".github/workflows/sync-published-release.yml",".github/workflows/npm-package.yml"]) {
  const workflow=parse(read(path));
  for(const job of Object.values(workflow.jobs)) for(const step of job.steps??[]) assert.doesNotMatch(step.run??"",/--repo\s+milind-soni\/|npm publish.*openmausbot/,`${path}: ${step.name}`);
}
assert.match(read("NOTICE"),/Copyright 2026 Milind Soni and OpenMausBot contributors/);
assert.ok(existsSync(join(root,"enterprise/LICENSE")));
// Keep standard license texts detectable and preserve component terms verbatim.
for (const [file, expected] of [
  ["LICENSE", "2d17a32cbe049c5536a7fd031cf4ec51e268e6a18dbd8e2d13556537b72fc8a7"],
  ["third_party/openmausbot/LICENSE", "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"],
  ["enterprise/LICENSE", "2168215aaa38b7739adbf028da7504ee85aa5822f09339b10a084aeca0808a0b"],
]) {
  assert.equal(createHash("sha256").update(read(file).replace(/\r\n/g, "\n")).digest("hex"), expected, `${file}: review licensing changes before updating the recorded text hash`);
}
const rootLicenses = readdirSync(root).filter(name => /^(?:(?:un)?licen[sc]e|copying|copyright|patents|ofl)(?:$|[-_.])/i.test(name));
assert.deepEqual(rootLicenses, ["LICENSE"], "Additional root license files make GitHub detection ambiguous; preserve component terms under third_party instead");
assert.ok(!existsSync(join(root, "LICENSES")), "Review GitHub detection before adding a REUSE license directory");
console.log("Hattera package, desktop, locale, icon, release and attribution checks passed.");
