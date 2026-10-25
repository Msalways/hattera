import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";
import { installOfficialEngine, managedHermesHome, officialEngineBinDir, officialEngineFor } from "./official-engine-install.ts";
import { findCliCandidates } from "./env-path.ts";

const scratch: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const path of scratch.splice(0)) await removeTempDir(path);
});

it("only offers built-in official installers on supported systems and never in a sealed fixture", () => {
  expect(officialEngineFor("cursorAgent", "win32")).toEqual({ vendor: "cursor" });
  expect(officialEngineFor("hermesAgent", "linux")).toEqual({ vendor: "hermes" });
  expect(officialEngineFor("fake", "win32")).toBeNull();
  expect(officialEngineFor("cursorAgent", "freebsd")).toBeNull();
  const old = process.env.OMB_TEST_SEALED_PATH;
  process.env.OMB_TEST_SEALED_PATH = "1";
  try { expect(officialEngineFor("cursorAgent")).toBeNull(); }
  finally {
    if (old === undefined) delete process.env.OMB_TEST_SEALED_PATH;
    else process.env.OMB_TEST_SEALED_PATH = old;
  }
});

it.each(["cursor", "hermes"] as const)("runs the official %s installer in the server's owned folder and verifies its CLI", async (vendor) => {
  const base = mkdtempSync(join(tmpdir(), "hattera-official-install-"));
  scratch.push(base);
  // A real executable lets the installer verify --version. Link the Node
  // fixture on the same volume rather than copying ~100 MB for each case;
  // cross-volume CI homes fall back to a copy. Both paths are test-owned.
  const windowsExecutable = (cli: string) => `try { New-Item -ItemType HardLink -Path (Join-Path $dir "${cli}.exe") -Target (Get-Command node).Source -ErrorAction Stop | Out-Null } catch { Copy-Item (Get-Command node).Source (Join-Path $dir "${cli}.exe") -ErrorAction Stop }`;
  const script = process.platform === "win32"
    ? vendor === "cursor"
      ? '$dir = Join-Path $env:LOCALAPPDATA "cursor-agent"; New-Item -ItemType Directory -Force $dir | Out-Null; ' + windowsExecutable("cursor-agent")
      : '$dir = Join-Path $env:HERMES_HOME "bin"; New-Item -ItemType Directory -Force $dir | Out-Null; ' + windowsExecutable("hermes")
    : vendor === "cursor"
      ? 'mkdir -p "$HOME/.local/bin"; printf "#!/bin/sh\\necho fixture\\n" > "$HOME/.local/bin/cursor-agent"; chmod +x "$HOME/.local/bin/cursor-agent"'
      : 'mkdir -p "$HERMES_HOME/bin"; printf "#!/bin/sh\\necho fixture\\n" > "$HERMES_HOME/bin/hermes"; chmod +x "$HERMES_HOME/bin/hermes"';
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const response = new Response(script, { status: 200 });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }));
  await installOfficialEngine(vendor, base);
  const cli = vendor === "cursor" ? "cursor-agent" : "hermes";
  expect(findCliCandidates(cli).some((path) => path.startsWith(officialEngineBinDir(vendor, base)))).toBe(true);
  if (vendor === "hermes") expect(managedHermesHome(base)).not.toBeNull();
});

it("rejects an installer redirected away from the provider before executing it", async () => {
  const base = mkdtempSync(join(tmpdir(), "hattera-official-redirect-"));
  scratch.push(base);
  vi.stubGlobal("fetch", vi.fn(async () => {
    const response = new Response("exit 0", { status: 200 });
    Object.defineProperty(response, "url", { value: "https://other.example/install" });
    return response;
  }));
  await expect(installOfficialEngine("cursor", base)).rejects.toThrow("could not be downloaded");
  expect(findCliCandidates("cursor-agent").some((path) => path.startsWith(officialEngineBinDir("cursor", base)))).toBe(false);
});
