import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { engineRuntime, engineRemoved, markEngineRemoved, removeEngineFiles, restoreEngine } from "./engine-removal.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const scratch: string[] = [];
const home = () => { const path = mkdtempSync(join(tmpdir(), "hattera-remove-")); scratch.push(path); return path; };
function file(path: string, text = "fixture") { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); }
afterEach(async () => { for (const path of scratch.splice(0)) await removeTempDir(path); });

it("covers every built-in CLI runtime and excludes API-only providers", () => {
  const targets = BUILT_IN_DRIVERS.flatMap(driver => {
    const cli = (driver.defaultConfig() as { cli?: string }).cli;
    const runtime = engineRuntime(driver.driverKind, driver.install, cli);
    if (cli && driver.driverKind !== "customAcp") expect(runtime, driver.driverKind).not.toBeNull();
    return runtime ? [runtime.key] : [];
  });
  expect(targets).toEqual(expect.arrayContaining(["pi", "cline", "codex", "claude", "opencode", "grok", "kimi", "droid", "qwen", "gemini", "cursor-agent", "hermes", "antigravity"]));
  expect(engineRuntime("openai-compat", undefined, undefined)).toBeNull();
  expect(engineRuntime("customAcp", { docsUrl: "https://example.test" }, "custom")).toBeNull();
});

it("removes all managed versions and legacy launchers, keeping accounts, sibling engines and the removal marker", async () => {
  const base = home();
  const runtime = { key: "pi", package: "@earendil-works/pi-coding-agent" };
  const slot = join(base, "tools", "engines", "pi");
  file(join(slot, "old", "bin", "pi")); file(join(slot, "current", "bin", "pi")); file(join(slot, "active.json"));
  const prefix = join(base, "tools", "npm");
  const modules = process.platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");
  const bin = process.platform === "win32" ? prefix : join(prefix, "bin");
  file(join(modules, "@earendil-works", "pi-coding-agent", "package.json")); file(join(bin, "pi.cmd"));
  file(join(base, "tools", "engines", "cline", "keep")); file(join(base, ".pi", "agent", "auth.json"), "private-account");
  markEngineRemoved(runtime, base);
  await removeEngineFiles(runtime, base);
  expect(existsSync(slot)).toBe(false);
  expect(existsSync(join(bin, "pi.cmd"))).toBe(false);
  expect(existsSync(join(modules, "@earendil-works", "pi-coding-agent"))).toBe(false);
  expect(readFileSync(join(base, ".pi", "agent", "auth.json"), "utf8")).toBe("private-account");
  expect(existsSync(join(base, "tools", "engines", "cline", "keep"))).toBe(true);
  expect(engineRemoved(runtime, base)).toBe(true);
  restoreEngine(runtime, base);
  expect(engineRemoved(runtime, base)).toBe(false);
});

it("preserves Hermes account data beside its software", async () => {
  const base = home();
  const root = join(base, "tools", "official", "hermes");
  for (const name of ["bin/hermes", "hermes-agent/venv/python", ".venv/python", "venv/python"]) file(join(root, name));
  for (const name of ["config.yaml", ".env", "auth.json", "profiles/work/config.yaml", "sessions/state.db"]) file(join(root, name), "keep-private");
  await removeEngineFiles({ key: "hermes", vendor: "hermes" }, base);
  expect(existsSync(join(root, "hermes-agent"))).toBe(false);
  expect(existsSync(join(root, "bin"))).toBe(false);
  for (const name of ["config.yaml", ".env", "auth.json", "profiles/work/config.yaml", "sessions/state.db"]) expect(readFileSync(join(root, name), "utf8")).toBe("keep-private");
});

it("removes Cursor software and Antigravity downloads without touching login profiles", async () => {
  const base = home();
  const cursor = join(base, "tools", "official", "cursor");
  for (const name of [".local/share/cursor-agent/version/bin", ".local/bin/cursor-agent", ".local/bin/agent", "cursor-agent/cursor-agent.exe"]) file(join(cursor, name));
  file(join(cursor, ".config", "cursor", "auth.json"), "cursor-private");
  await removeEngineFiles({ key: "cursor-agent", vendor: "cursor" }, base);
  expect(existsSync(join(cursor, ".local", "share", "cursor-agent"))).toBe(false);
  expect(existsSync(join(cursor, "cursor-agent"))).toBe(false);
  expect(readFileSync(join(cursor, ".config", "cursor", "auth.json"), "utf8")).toBe("cursor-private");
  const runtime = join(base, "tools", "antigravity-acp", `${process.platform}-${process.arch}`);
  file(join(runtime, "runtime")); file(join(base, "profiles", "antigravity", "token.json"), "google-private");
  await removeEngineFiles({ key: "antigravity", managed: true }, base);
  expect(existsSync(runtime)).toBe(false);
  expect(readFileSync(join(base, "profiles", "antigravity", "token.json"), "utf8")).toBe("google-private");
});

it("refuses symlinked ancestors before deleting any runtime files", async () => {
  const base = home(); const outside = home();
  file(join(outside, "pi", "keep")); mkdirSync(join(base, "tools"));
  symlinkSync(outside, join(base, "tools", "engines"), process.platform === "win32" ? "junction" : "dir");
  await expect(removeEngineFiles({ key: "pi", package: "pi" }, base)).rejects.toThrow("outside Hattera");
  expect(readFileSync(join(outside, "pi", "keep"), "utf8")).toBe("fixture");
  expect(() => markEngineRemoved({ key: "../escape", package: "pi" }, base)).toThrow("Invalid engine");
});

it("removes a symlink inside an owned runtime without following it", async () => {
  const base = home(); const outside = home();
  file(join(outside, "keep")); mkdirSync(join(base, "tools", "engines", "pi"), { recursive: true });
  symlinkSync(outside, join(base, "tools", "engines", "pi", "external"), process.platform === "win32" ? "junction" : "dir");
  await removeEngineFiles({ key: "pi", package: "pi" }, base);
  expect(existsSync(join(base, "tools", "engines", "pi"))).toBe(false);
  expect(readFileSync(join(outside, "keep"), "utf8")).toBe("fixture");
});
