import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import type { PrivateNetworkState } from "../shared/private-network.ts";
import { writeFileAtomic } from "./atomic.ts";

const MAX_OUTPUT = 1024 * 1024;
const HELPER_ENV = new Set(["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"]);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeText = (value: unknown, max = 200): string => typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, max) : "";

export function tailnetOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const tailnet = isIP(host) === 4 ? /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) : isIP(host) === 6 && host.toLowerCase().startsWith("fd7a:115c:a1e0:");
    return url.protocol === "http:" && tailnet && !url.username && !url.password && !url.search && !url.hash && (!url.port || url.port === "80") && url.pathname === "/" ? url.origin : null;
  } catch { return null; }
}

export function networkHelperPath(): string | null {
  const binary = `hattera-network${process.platform === "win32" ? ".exe" : ""}`;
  const target = `${process.platform}-${process.arch}`;
  const here = dirname(fileURLToPath(import.meta.url));
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    process.env.OMB_NETWORK_HELPER,
    resources && join(resources, "network", target, binary),
    join(here, "..", "dist-native", "network", target, binary),
    join(here, "..", "network", target, binary),
    join(here, "..", "network", binary),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

export function parseNetworkStatus(raw: unknown, enabled: boolean): PrivateNetworkState {
  const value = record(raw);
  const backend = safeText(value.state);
  let authorizationUrl: string | null = null;
  try {
    const url = new URL(safeText(value.authorizationUrl, 2048));
    if (url.protocol === "https:" && url.hostname === "login.tailscale.com" && !url.username && !url.password) authorizationUrl = url.href;
  } catch { /* no challenge */ }
  let origin: string | null = null;
  try {
    const url = new URL(safeText(value.origin, 2048));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const tailnet = isIP(host) === 4 ? /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) : isIP(host) === 6 && host.toLowerCase().startsWith("fd7a:115c:a1e0:");
    if (url.protocol === "http:" && tailnet && !url.username && !url.password) origin = url.origin;
  } catch { /* not ready */ }
    const state = !enabled ? "disconnected" : backend === "Running" && value.serving === true ? "connected" : backend === "NeedsLogin" ? "sign-in-required" : backend === "NeedsMachineAuth" ? "approval-required" : "starting";
  return { available: true, enabled, state, authorizationUrl: state === "connected" || state === "disconnected" ? null : authorizationUrl, origin: state === "connected" ? origin : null,
    message: state === "approval-required" ? "A tailnet administrator must approve this Hattera device. Open the Tailscale admin console to approve it, then refresh here." : null,
    ...(value.peerTransport === true ? { peerTransport: true } : {}), peers: (Array.isArray(value.peers) ? value.peers : []).slice(0, 500).map(rawPeer => {
      const peer = record(rawPeer);
      return { id: safeText(peer.id), name: safeText(peer.name), online: peer.online === true,
        addresses: (Array.isArray(peer.addresses) ? peer.addresses : []).filter((ip): ip is string => typeof ip === "string" && /^[\da-f:.]{3,64}$/i.test(ip)) };
    }).filter(peer => peer.id) };
}

/** Browser-managed, app-owned connection. No system service or network settings are changed. */
export class PrivateNetwork {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private retryAt = 0;
  private enabled = false;
  private error: string | null = null;
  private readonly directory: string;
  private readonly upstream: string;
  private readonly helper: () => string | null;
  private readonly spawnHelper: typeof spawn;
  private operation: Promise<void> | null = null;

  constructor(options: { dataDir: string; port: number; helper?: () => string | null; spawn?: typeof spawn }) {
    this.directory = join(options.dataDir, "private-network");
    this.upstream = `http://127.0.0.1:${options.port}`;
    this.helper = options.helper ?? networkHelperPath;
    this.spawnHelper = options.spawn ?? spawn;
    try { this.enabled = JSON.parse(readFileSync(join(this.directory, "settings.json"), "utf8")).enabled === true; }
    catch { this.enabled = process.env.OMB_TAILSCALE_ENABLED === "1"; }
  }

  private save(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(this.directory, "settings.json"), JSON.stringify({ enabled: this.enabled }) + "\n", { mode: 0o600 });
  }

  private start(): void {
    if (this.child) return;
    if (Date.now() < this.retryAt) throw new Error(this.error ?? "The private network connection is retrying. Try again shortly.");
    const helper = this.helper();
    if (!helper) throw new Error("This build does not include the private network component. Install an updated Hattera package to enable Tailscale from the app.");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => HELPER_ENV.has(key.toUpperCase())));
    const child = this.spawnHelper(helper, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.error = null;
    let buffer = "";
    child.stderr.resume(); // native diagnostics may include authentication URLs
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_OUTPUT) { this.fail("The private network component returned an invalid response."); child.kill(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const value = record(JSON.parse(line));
          const pending = typeof value.id === "number" ? this.pending.get(value.id) : null;
          if (!pending) continue;
          this.pending.delete(value.id as number); clearTimeout(pending.timer);
          if (value.error) pending.reject(new Error("The private network action failed. Check connectivity and try again."));
          else pending.resolve(value.result);
        } catch { this.fail("The private network component returned an invalid response."); child.kill(); }
      }
    });
    child.on("error", () => this.fail("The private network component could not start. Check the installation and try again."));
    child.on("close", () => { if (this.child === child) { this.child = null; this.fail("The private network connection stopped. Reconnect to try again."); } });
    child.stdin.on("error", () => this.fail("The private network connection stopped."));
    child.stdin.write(JSON.stringify({ stateDir: join(this.directory, "state"), hostname: "hattera", upstream: this.upstream }) + "\n");
  }

  private fail(message: string): void {
    this.error = message;
    this.retryAt = Date.now() + 30_000;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
  }

  private request(method: "status" | "login" | "logout" | "peer", payload?: { endpoint: string; body: unknown }): Promise<unknown> {
    this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("The private network action timed out. Try again.")); }, 12_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, ...payload }) + "\n");
    });
  }

  async status(): Promise<PrivateNetworkState> {
    const base: PrivateNetworkState = { available: Boolean(this.helper()), enabled: this.enabled, state: "disconnected", authorizationUrl: null, origin: null, message: null, peers: [] };
    if (!this.enabled) return base;
    try { return parseNetworkStatus(await this.request("status"), true); }
    catch (error) { return { ...base, state: "error", message: error instanceof Error ? error.message : this.error }; }
  }

  async peer(endpoint: string, body: unknown): Promise<{ status: number; body: unknown }> {
    if (!this.enabled) throw new Error("Connect Hattera to Tailscale before sharing a group.");
    const origin = tailnetOrigin(endpoint);
    if (!origin) throw new Error("Select a Hattera peer's private tailnet address.");
    if (Buffer.byteLength(JSON.stringify(body)) > 768 * 1024) throw new Error("This shared group packet is too large.");
    const value = record(await this.request("peer", { endpoint: origin, body }));
    if (typeof value.status !== "number" || value.status < 100 || value.status > 599) throw new Error("The peer returned an invalid response.");
    return { status: value.status, body: value.body };
  }

  async connect(): Promise<PrivateNetworkState> {
    if (this.operation) throw new Error("A private network action is already running.");
    this.retryAt = 0;
    this.operation = (async () => {
      this.enabled = true;
      this.save();
      const status = await this.request("status");
      if (parseNetworkStatus(status, true).state !== "connected") await this.request("login");
    })();
    try { await this.operation; return await this.status(); } finally { this.operation = null; }
  }

  async disconnect(): Promise<void> {
    if (this.operation) throw new Error("A private network action is already running.");
    this.operation = (async () => {
      this.enabled = false;
      this.save();
      // Logout revokes only this app's identity; never stop a host's Tailscale service.
      try { if (this.child) await this.request("logout"); } finally { this.close(); }
    })();
    try { await this.operation; } finally { this.operation = null; }
  }

  close(): void {
    const child = this.child;
    this.child = null;
    child?.stdin.end();
    const timer = setTimeout(() => child?.kill(), 1500); timer.unref();
    this.fail("Private network connection closed.");
  }
}
