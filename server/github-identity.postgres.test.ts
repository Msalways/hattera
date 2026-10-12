import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { createGithubIdentity, githubIdentityConfig } from "./github-identity.ts";
import { SessionRegistry } from "./sessions.ts";

const url = process.env.OMB_TEST_DATABASE_URL;

it.skipIf(!url)("initializes and reopens Better Auth in a disposable PostgreSQL database", async () => {
  const parsed = new URL(url!);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/ombtest") {
    throw new Error("OMB_TEST_DATABASE_URL must point to the disposable 127.0.0.1/ombtest database");
  }
  const dir = mkdtempSync(join(tmpdir(), "omb-pg-identity-"));
  const sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  const config = githubIdentityConfig({
    OMB_PUBLIC_URL: "http://127.0.0.1:8080",
    GITHUB_REDIRECT_URI: "http://127.0.0.1:8080/identity/callback/github",
    GITHUB_CLIENT_ID: "client",
    GITHUB_CLIENT_SECRET: "client-secret",
    BETTER_AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
    GITHUB_OWNER_ID: "12345",
  })!;
  const identity = () => createGithubIdentity({ config, dataDir: dir, sessions, cookieName: "omb_test", postgresPool: new Pool({ connectionString: url, max: 2 }) });
  let server: Server | undefined;
  try {
    const first = identity();
    try { await first.ready; }
    finally { await first.close(); }
    const second = identity();
    try {
      await second.ready;
      server = createServer((req, res) => { void second.handle(req, res, new URL(req.url!, config.publicUrl).pathname); });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test port");
      const base = `http://127.0.0.1:${address.port}`;
      const nativeFetch = globalThis.fetch;
      let githubId = 54321;
      vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const requestUrl = input instanceof Request ? input.url : String(input);
        if (requestUrl === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "verified-token", token_type: "bearer", scope: "read:user,user:email" });
        if (requestUrl === "https://api.github.com/user") return Response.json({ id: githubId, login: "owner", email: "owner@example.test", avatar_url: "" });
        if (requestUrl === "https://api.github.com/user/emails") return Response.json([{ email: "owner@example.test", primary: true, verified: true }]);
        return nativeFetch(input, init);
      });
      async function callback() {
        const start = await fetch(`${base}/identity/sign-in/social`, {
          method: "POST", headers: { "content-type": "application/json", origin: config.publicUrl },
          body: JSON.stringify({ provider: "github", callbackURL: `${config.publicUrl}/identity/finish`, disableRedirect: true }),
        });
        expect(start.status).toBe(200);
        const body = await start.json() as { url: string };
        const state = new URL(body.url).searchParams.get("state");
        const cookie = start.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
        return fetch(`${base}/identity/callback/github?state=${encodeURIComponent(state!)}&code=fixture-code`, { headers: { cookie }, redirect: "manual" });
      }
      expect((await callback()).status).toBe(403);
      expect(sessions.list()).toHaveLength(0);
      githubId = 12345;
      const accepted = await callback();
      expect(accepted.status).toBe(302);
      const cookie = accepted.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      const finish = await fetch(`${base}/identity/finish`, { headers: { cookie }, redirect: "manual" });
      expect(finish.status).toBe(303);
      expect(sessions.list()).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await second.close();
    }
    const check = new Pool({ connectionString: url, max: 1 });
    try {
      const rows = await check.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('user', 'account', 'session', 'verification')");
      expect(rows.rows.map((row) => row.table_name).sort()).toEqual(["account", "session", "user", "verification"]);
      const accounts = await check.query<{ accountId: string }>("SELECT \"accountId\" FROM account");
      expect(accounts.rows.map((row) => row.accountId)).toEqual(["12345"]);
    } finally { await check.end(); }
    expect(existsSync(join(dir, "github-identity.sqlite"))).toBe(false);
  } finally {
    sessions.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
