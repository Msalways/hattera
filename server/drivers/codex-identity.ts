// Let Codex resolve its effective account, including keyring credentials.
// Reading auth.json directly can label an API-key or keyring login with an
// old file's email. Only the protocol's display email leaves this helper.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { userHome } from "../env-path.ts";
import { killCliTree, spawnCli } from "../procs.ts";

const MAX_OUTPUT = 16_384;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Where this environment's Codex keeps its credentials, or null when the
 * configured home is not absolute (the login controller refuses those too). */
export function codexHome(env: Record<string, string | undefined>): string | null {
  if (env.CODEX_HOME) return isAbsolute(env.CODEX_HOME) ? resolve(env.CODEX_HOME) : null;
  const home = userHome(env);
  return isAbsolute(home) ? join(home, ".codex") : null;
}

/** Read-only account metadata. Unsupported CLIs and uncertain responses stay
 * unnamed; never fall back to a potentially inactive credential file. */
export async function codexAccountEmail(
  cli: string,
  env: Record<string, string | undefined>,
  timeoutMs = 3_000,
): Promise<string | null> {
  const response = await codexAccountRequest(cli, env, "account/read", timeoutMs);
  const account = (response as { account?: { type?: string; email?: unknown } } | null)?.account;
  const email = account?.type === "chatgpt" ? account.email : null;
  return typeof email === "string" && email.length <= 254 && EMAIL.test(email) && !/[\p{Cc}\p{Cf}]/u.test(email) ? email : null;
}

/** A bounded, read-only exchange; never creates a thread or starts inference. */
export async function codexAccountRequest(
  cli: string,
  env: Record<string, string | undefined>,
  method: "account/read" | "account/rateLimits/read" | "account/usage/read",
  timeoutMs = 8_000,
): Promise<unknown | null> {
  return (await codexAccountRequests(cli, env, [method], timeoutMs))?.[method] ?? null;
}

export async function codexAccountRequests(
  cli: string,
  env: Record<string, string | undefined>,
  methods: readonly ("account/read" | "account/rateLimits/read" | "account/usage/read")[],
  timeoutMs = 8_000,
): Promise<Record<string, unknown> | null> {
  if (!methods.length) return {};
  const cwd = env.HOME || env.USERPROFILE || homedir();
  if (!isAbsolute(cwd) || !codexHome(env)) return null;
  return new Promise((resolveResult) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(cli, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolveResult(null);
      return;
    }
    let finishing = false;
    let buffer = "";
    let outputBytes = 0;
    let initialized = false;
    const results: Record<string, unknown> = {};
    const finish = async (result: Record<string, unknown> | null) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      let stopped = await killCliTree(child, 1_000);
      if (!stopped && child.pid) {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
        stopped = await killCliTree(child, 1_000);
      }
      resolveResult(stopped ? result : null);
    };
    const timer = setTimeout(() => { void finish(null); }, timeoutMs);
    timer.unref();
    const send = (message: unknown) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { void finish(null); }
    };
    child.stdin.on("error", () => { void finish(null); });
    child.stderr.resume(); // Do not retain or log raw CLI errors or credentials.
    child.on("error", () => { void finish(null); });
    child.on("close", () => { void finish(null); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (finishing) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > (methods.length === 1 && methods[0] === "account/read" ? MAX_OUTPUT : 256 * 1024)) { void finish(null); return; }
      buffer += chunk;
      let newline: number;
      while (!finishing && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { void finish(null); return; }
        if (!initialized && message?.id === 1) {
          if (message.error || !message.result) { void finish(null); return; }
          initialized = true;
          send({ method: "initialized", params: {} });
          methods.forEach((method, index) => send({ id: index + 2, method, params: method === "account/read" ? { refreshToken: false } : {} }));
        } else if (initialized && typeof message?.id === "number" && methods[message.id - 2]) {
          results[methods[message.id - 2]] = message.error ? null : message.result ?? null;
          if (Object.keys(results).length === methods.length) void finish(results);
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "openmausbot", version: "1" }, ...(methods.some(method => method !== "account/read") ? { capabilities: { experimentalApi: true } } : {}) } });
  });
}
