import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { PrivateNetwork, parseNetworkStatus, tailnetOrigin } from "./private-network.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const directory = () => { const path = mkdtempSync(join(tmpdir(), "hattera-network-test-")); directories.push(path); return path; };

describe("private network", () => {
  it("restricts peer origins to literal tailnet application addresses", () => {
    expect(tailnetOrigin("http://100.64.0.1/")).toBe("http://100.64.0.1");
    expect(tailnetOrigin("http://[fd7a:115c:a1e0::1]")).toBe("http://[fd7a:115c:a1e0::1]");
    for (const value of ["http://127.0.0.1", "http://100.64.0.1:8080", "http://100.64.0.1/api/config", "http://secret@100.64.0.1", "http://100.64.0.1?key=secret"]) expect(tailnetOrigin(value)).toBeNull();
  });
  it("accepts only official login challenges and tailnet origins", () => {
    expect(parseNetworkStatus({ state: "NeedsLogin", authorizationUrl: "https://login.tailscale.com/a/test" }, true).authorizationUrl).toContain("login.tailscale.com");
    for (const bad of ["javascript:alert(1)", "https://login.tailscale.com.evil.invalid/a", "https://secret@login.tailscale.com/a"]) {
      expect(parseNetworkStatus({ authorizationUrl: bad }, true).authorizationUrl).toBeNull();
    }
    expect(parseNetworkStatus({ state: "Running", serving: true, origin: "http://100.100.20.10" }, true).origin).toBe("http://100.100.20.10");
    for (const bad of ["http://127.0.0.1", "http://100.128.0.1", "http://evil.invalid", "http://100.64.evil.invalid"]) {
      expect(parseNetworkStatus({ state: "Running", serving: true, origin: bad }, true).origin).toBeNull();
    }
    expect(parseNetworkStatus({ state: "NeedsMachineAuth" }, true).state).toBe("approval-required");
  });

  it("stays disabled without starting a process and reports a missing package component", async () => {
    const network = new PrivateNetwork({ dataDir: directory(), port: 8799, helper: () => null });
    expect(await network.status()).toMatchObject({ enabled: false, available: false, state: "disconnected" });
    await expect(network.connect()).rejects.toThrow("does not include");
    expect(await network.status()).toMatchObject({ available: false, state: "error" });
    network.close();
  });

  it("uses private stdio for setup, preserves restart choice and logs out only its own node", async () => {
    const dir = directory();
    const calls: unknown[] = [];
    let backend = "NeedsLogin";
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    let config: Record<string, unknown> | null = null;
    child.stdin.on("data", (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString());
      if (message.stateDir) { config = message; return; }
      calls.push(message.method);
      if (message.method === "login") backend = "NeedsLogin";
      if (message.method === "logout") backend = "Stopped";
      child.stdout.write(JSON.stringify({ id: message.id, result: message.method === "status" ? { state: backend, serving: backend === "Running", authorizationUrl: "https://login.tailscale.com/a/fixture", peers: [] } : {} }) + "\n");
    });
    const network = new PrivateNetwork({ dataDir: dir, port: 9876, helper: () => "packaged-helper", spawn: (() => child) as unknown as typeof spawn });
    expect(await network.connect()).toMatchObject({ state: "sign-in-required", authorizationUrl: "https://login.tailscale.com/a/fixture" });
    expect(config).toMatchObject({ upstream: "http://127.0.0.1:9876", stateDir: join(dir, "private-network", "state") });
    expect(calls).toContain("login");
    backend = "Running";
    expect((await network.status()).state).toBe("connected");
    await network.disconnect();
    expect(calls).toContain("logout");
    expect(JSON.parse(readFileSync(join(dir, "private-network", "settings.json"), "utf8"))).toEqual({ enabled: false });
    expect((await new PrivateNetwork({ dataDir: dir, port: 9876, helper: () => null }).status()).enabled).toBe(false);
    expect(JSON.stringify(config)).not.toMatch(/authKey|token|password/);
  });
});
