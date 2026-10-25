// Build a pinned app-specific Tailscale node. Release packaging includes this
// executable; end users never need Go or a system-wide VPN installation.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const networkDist = resolve(process.env.HATTERA_NETWORK_DIST || join(root, "dist-native", "network"));
const targets = process.argv.includes("--current") ? [[process.platform, process.arch]]
  : process.argv.includes("--all") ? ["win32", "darwin", "linux"].flatMap(platform => ["x64", "arm64"].map(arch => [platform, arch]))
  : ["x64", "arm64"].map(arch => [process.platform, arch]);
for (const [platform, arch] of targets) {
const goOS = { win32: "windows", linux: "linux", darwin: "darwin" }[platform];
const goArch = { x64: "amd64", arm64: "arm64" }[arch];
if (!goOS || !goArch) throw new Error(`Unsupported network helper target: ${platform}/${arch}`);
const output = join(networkDist, `${platform}-${arch}`, `hattera-network${platform === "win32" ? ".exe" : ""}`);
mkdirSync(dirname(output), { recursive: true });
const result = spawnSync("go", ["build", "-p=2", "-trimpath", "-ldflags=-s -w", "-o", output, "."], {
  cwd: join(root, "network"), stdio: "inherit", windowsHide: true,
  env: { ...process.env, GOOS: goOS, GOARCH: goArch, CGO_ENABLED: "0", GOTOOLCHAIN: "auto" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const notices = spawnSync("go", ["run", "-p=2", "./cmd/notices"], {
  cwd: join(root, "network"), encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  env: { ...process.env, GOTOOLCHAIN: "auto", HATTERA_LICENSE_GOOS: goOS, HATTERA_LICENSE_GOARCH: goArch },
});
if (notices.error) throw notices.error;
if (notices.status !== 0) throw new Error(notices.stderr || "Could not collect network component licenses");
writeFileSync(join(dirname(output), "THIRD_PARTY_NOTICES.txt"), notices.stdout);
if (platform === process.platform && arch === process.arch) {
  const probe = spawnSync(output, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (probe.status !== 0 || !probe.stdout?.startsWith("hattera-network 2 ")) throw new Error("Built network helper failed its version check");
}
console.log(`Network helper ready: ${platform}/${arch}`);
}
