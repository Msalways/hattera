// Keep sidecar entries self-contained, including shared launch compatibility.
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const source=join(root,"companion/src");
await build({
  entryPoints:readdirSync(source).filter(name=>name.endsWith(".ts")&&!name.endsWith(".d.ts")).map(name=>join(source,name)),
  outdir:join(root,"dist-companion"),bundle:true,platform:"node",target:"node24",format:"esm",allowOverwrite:true,
});
console.log("Companion entries bundled with Hattera launch compatibility.");
