// Assemble the `hattera` npm package: the self-contained server bundle,
// the built UI, the bundled skills and the CLI, with a package.json of its
// own. `npx hattera serve` then needs Node 24+ and nothing else.
//
//   pnpm build:server && pnpm exec vite build && node scripts/build-npm-package.mjs
//   cd release/npm && npm pack        # or npm publish --access public
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release", "npm");
const app = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const serverDist=resolve(process.env.HATTERA_SERVER_DIST || join(root,"dist-server"));
const webDist=resolve(process.env.HATTERA_WEB_DIST || join(root,"dist"));
const networkDist=resolve(process.env.HATTERA_NETWORK_DIST || join(root,"dist-native","network"));
for (const platform of ["win32", "darwin", "linux"]) {
  for (const arch of ["x64", "arm64"]) {
    for (const name of [`hattera-network${platform === "win32" ? ".exe" : ""}`, "THIRD_PARTY_NOTICES.txt"]) {
      if (!existsSync(join(networkDist, `${platform}-${arch}`, name))) throw new Error("Build all private network targets with pnpm build:network --all before npm packaging.");
    }
  }
}

for (const required of [join(serverDist,"index.js"), join(serverDist,"hattera.js"),join(serverDist,"openmausbot.js"),join(webDist,"index.html")]) {
  if (!existsSync(required)) {
    console.error(`missing ${required}: run \`pnpm build:server && pnpm exec vite build\` first`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(serverDist, join(out, "dist-server"), { recursive: true });
cpSync(webDist, join(out, "dist"), { recursive: true });
cpSync(networkDist, join(out, "network"), { recursive: true });
if (existsSync(join(root, "skills"))) cpSync(join(root, "skills"), join(out, "skills"), { recursive: true });
// The enterprise layer, bundled by scripts/bundle-server.mjs, under the path
// server/enterprise.ts loads from: <package>/enterprise/server/index.js.
// Source-available under its own license; inert without OMB_LICENSE_KEY.
const enterpriseBundle = join(serverDist, "enterprise", "server", "index.js");
if (existsSync(enterpriseBundle)) {
  mkdirSync(join(out, "enterprise", "server"), { recursive: true });
  copyFileSync(enterpriseBundle, join(out, "enterprise", "server", "index.js"));
  for (const file of ["LICENSE", "README.md"]) {
    if (existsSync(join(root, "enterprise", file))) copyFileSync(join(root, "enterprise", file), join(out, "enterprise", file));
  }
}
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
cpSync(join(root, "NOTICE"), join(out, "NOTICE"));

// The bin lives next to the bundle so serverEntry() finds index.js by path.
writeFileSync(join(out, "cli.js"), `#!/usr/bin/env node\nimport "./dist-server/hattera.js";\n`);

writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: app.name,
      version: app.version,
      description: "Run the Hattera server anywhere and pair your devices to it",
      license: "Apache-2.0",
      type: "module",
      bin: { hattera: "cli.js", openmausbot: "cli.js" },
      files: ["cli.js", "dist-server", "dist", "network", "skills", "enterprise", "LICENSE", "NOTICE", "README.md"],
      engines: { node: ">=24" },
      repository: app.repository,
      homepage: app.homepage,
      keywords: ["hattera", "agents", "self-hosted", "server"],
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(join(out, "README.md"), "# Hattera\n\nYour own team of AI agents. Requires Node.js 24 or later.\n\nInstall the tarball built from https://github.com/Msalways/hattera (the public npm name must be configured before registry publishing):\n\n```sh\nnpm install -g ./hattera-VERSION.tgz\nhattera web\n```\n\nThe local web launcher opens the app directly and keeps a background runtime. `hattera web --cli-only` starts without opening a browser. Provider accounts still require their own authorization. The legacy `openmausbot` command remains an alias.\n\nFor self-hosting, use `hattera serve`. Hosted sign-in and pairing remain required; local CLI mode does not disable remote authentication. Use `hattera --help` for setup, pairing, sessions, service and browser-engine commands.\n\nNew installations use ~/.hattera. Existing ~/.openmausbot workspaces are reused without moving or deleting data. HATTERA_* environment settings take precedence over matching OMB_* settings; legacy OMB_* remains supported.\n\nSource, setup and capabilities: https://github.com/Msalways/hattera\n\nHattera derives from OpenMausBot by Milind Soni and contributors. See LICENSE and NOTICE. The optional enterprise components retain their separate license; renaming does not change those terms.\n" );
console.log(`npm package assembled at ${out} (${app.name}@${app.version})`);
