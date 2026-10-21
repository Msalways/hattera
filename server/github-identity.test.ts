import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { createGithubIdentity, githubIdentityConfig, isGithubOwner } from "./github-identity.ts";
import { SessionRegistry } from "./sessions.ts";

const config = {
  OMB_PUBLIC_URL: "https://owner.tailnet.ts.net",
  GITHUB_REDIRECT_URI: "https://owner.tailnet.ts.net/identity/callback/github",
  GITHUB_CLIENT_ID: "client",
  GITHUB_CLIENT_SECRET: "client-secret",
  BETTER_AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
  GITHUB_OWNER_ID: "12345",
};
const localConfig = {
  ...config,
  OMB_PUBLIC_URL: "http://127.0.0.1:8080",
  GITHUB_REDIRECT_URI: "http://127.0.0.1:8080/identity/callback/github",
};
let server: Server | undefined;
let dir: string | undefined;
let sessions: SessionRegistry | undefined;
let identity: ReturnType<typeof createGithubIdentity> | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (identity) await identity.close(); identity = undefined;
  sessions?.close(); sessions = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  vi.unstubAllGlobals();
});

it("requires an exact callback, a safe origin, and a stable numeric owner ID", () => {
  expect(githubIdentityConfig({})).toBeNull();
  expect(githubIdentityConfig({ OMB_PUBLIC_URL: "http://localhost:8080" })).toBeNull();
  expect(() => githubIdentityConfig({ GITHUB_CLIENT_ID: "client" })).toThrow("GitHub sign-in is missing OMB_PUBLIC_URL, GITHUB_REDIRECT_URI, GITHUB_CLIENT_SECRET, BETTER_AUTH_SECRET, GITHUB_OWNER_ID");
  expect(githubIdentityConfig(config)?.ownerId).toBe("12345");
  expect(githubIdentityConfig(localConfig)?.publicUrl).toBe("http://127.0.0.1:8080");
  expect(() => githubIdentityConfig({ ...localConfig, OMB_PUBLIC_URL: "http://localhost:8080" })).toThrow("OMB_PUBLIC_URL");
  expect(() => githubIdentityConfig({ ...localConfig, OMB_PUBLIC_URL: "http://192.168.1.10:8080" })).toThrow("OMB_PUBLIC_URL");
  expect(() => githubIdentityConfig({ ...localConfig, OMB_PUBLIC_URL: "http://127.0.0.1" })).toThrow("OMB_PUBLIC_URL");
  expect(() => githubIdentityConfig({ ...config, GITHUB_REDIRECT_URI: "https://other.example/identity/callback/github" })).toThrow("GITHUB_REDIRECT_URI");
  expect(() => githubIdentityConfig({ ...config, GITHUB_OWNER_ID: "owner-name" })).toThrow("numeric GitHub account ID");
  expect(isGithubOwner({ providerId: "github", accountId: "12345" }, "12345")).toBe(true);
  expect(isGithubOwner({ providerId: "github", accountId: "54321" }, "12345")).toBe(false);
  expect(isGithubOwner({ providerId: "google", accountId: "12345" }, "12345")).toBe(false);
});

it("preserves the owner across a clean restart and revokes a changed owner", () => {
  dir = mkdtempSync(join(tmpdir(), "omb-github-session-"));
  const file = join(dir, "sessions.json");
  sessions = new SessionRegistry({ file });
  const issued = sessions.issue({ label: "GitHub owner", scopes: ["admin", "client"], userId: "github:12345" });
  sessions.close();
  sessions = new SessionRegistry({ file });
  expect(sessions.authenticate(issued.token)?.userId).toBe("github:12345");
  sessions.revokeOtherGithubOwners("54321");
  expect(sessions.authenticate(issued.token)).toBeNull();
});

it("mounts Better Auth separately and refuses completion without a verified account", async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-github-identity-"));
  sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  identity = createGithubIdentity({ config: githubIdentityConfig(config)!, dataDir: dir, sessions, cookieName: "omb_test" });
  await identity.ready;
  server = createServer((req, res) => { void identity!.handle(req, res, new URL(req.url!, "http://localhost").pathname); });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  const base = `http://127.0.0.1:${address.port}`;
  const start = await fetch(`${base}/identity/sign-in/social`, {
    method: "POST", headers: { "content-type": "application/json", origin: config.OMB_PUBLIC_URL },
    body: JSON.stringify({ provider: "github", callbackURL: `${config.OMB_PUBLIC_URL}/identity/finish`, disableRedirect: true }),
  });
  expect(start.status).toBe(200);
  const body = await start.json() as { url: string };
  expect(new URL(body.url).searchParams.get("redirect_uri")).toBe(config.GITHUB_REDIRECT_URI);
  const finish = await fetch(`${base}/identity/finish`);
  expect(finish.status).toBe(403);
  expect(finish.headers.getSetCookie().join(" ")).not.toContain("omb_test=");
  expect(sessions.list()).toHaveLength(0);
});

it.each([{ mode: "HTTPS", config }, { mode: "loopback", config: localConfig }])("rejects another GitHub ID and mints an app session only for the owner ($mode)", async ({ config }) => {
  dir = mkdtempSync(join(tmpdir(), "omb-github-callback-"));
  sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  identity = createGithubIdentity({ config: githubIdentityConfig(config)!, dataDir: dir, sessions, cookieName: "omb_test" });
  await identity.ready;
  server = createServer((req, res) => { void identity!.handle(req, res, new URL(req.url!, "http://localhost").pathname); });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  const base = `http://127.0.0.1:${address.port}`;
  const browserStart = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = httpRequest(`${base}/identity/start/github`, {
      headers: { host: new URL(config.OMB_PUBLIC_URL).host, origin: "http://127.0.0.1", cookie: "better-auth.state=fixture" },
    }, (response) => { response.resume(); response.on("end", () => resolve(response)); });
    request.on("error", reject);
    request.end();
  });
  expect(browserStart.statusCode).toBe(303);
  expect(browserStart.headers.location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  expect(browserStart.headers["set-cookie"]?.length).toBeGreaterThan(0);
  const wrongHost = await fetch(`${base}/identity/start/github`, { redirect: "manual" });
  expect(wrongHost.status).toBe(400);
  const wrongOrigin = config.OMB_PUBLIC_URL.startsWith("http:") ? config.OMB_PUBLIC_URL.replace("127.0.0.1", "localhost") : "https://other.example";
  const wrongStart = await fetch(`${base}/identity/sign-in/social`, {
    method: "POST", headers: { "content-type": "application/json", origin: wrongOrigin },
    body: JSON.stringify({ provider: "github", callbackURL: `${wrongOrigin}/identity/finish`, disableRedirect: true }),
  });
  expect(wrongStart.status).toBe(200);
  const wrongUrl = (await wrongStart.json() as { url: string }).url;
  // The browser stores this state cookie on localhost, but GitHub returns to
  // the configured 127.0.0.1 callback, which cannot read that cookie.
  const wrongState = new URL(wrongUrl).searchParams.get("state");
  const unmatchedCallback = await fetch(`${base}/identity/callback/github?state=${encodeURIComponent(wrongState!)}&code=fixture-code`, { redirect: "manual" });
  expect(unmatchedCallback.status).not.toBe(200);
  const errorPage = await fetch(`${base}/identity/error?error=state_mismatch`, { redirect: "manual" });
  expect(errorPage.status).toBe(303);
  expect(errorPage.headers.get("location")).toBe("/pair?github=state");
  expect(sessions.list()).toHaveLength(0);
  const nativeFetch = globalThis.fetch;
  let githubId = 54321;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "verified-token", token_type: "bearer", scope: "read:user,user:email" });
    if (url === "https://api.github.com/user") return Response.json({ id: githubId, login: "owner", email: "owner@example.test", avatar_url: "" });
    if (url === "https://api.github.com/user/emails") return Response.json([{ email: "owner@example.test", primary: true, verified: true }]);
    return nativeFetch(input, init);
  });
  async function callback() {
    const start = await fetch(`${base}/identity/sign-in/social`, {
      method: "POST", headers: { "content-type": "application/json", origin: config.OMB_PUBLIC_URL },
      body: JSON.stringify({ provider: "github", callbackURL: `${config.OMB_PUBLIC_URL}/identity/finish`, disableRedirect: true }),
    });
    expect(start.status).toBe(200);
    const body = await start.json() as { url: string };
    const state = new URL(body.url).searchParams.get("state");
    const cookie = start.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    return fetch(`${base}/identity/callback/github?state=${encodeURIComponent(state!)}&code=fixture-code`, { headers: { cookie }, redirect: "manual" });
  }
  const rejected = await callback();
  expect(rejected.status).toBe(403);
  expect(sessions.list()).toHaveLength(0);
  githubId = 12345;
  const accepted = await callback();
  expect(accepted.status).toBe(302);
  const authCookie = accepted.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const finish = await fetch(`${base}/identity/finish`, { headers: { cookie: authCookie }, redirect: "manual" });
  expect(finish.status).toBe(303);
  expect(finish.headers.getSetCookie().join(" ")).toContain("omb_test=");
  expect(sessions.list()).toHaveLength(1);
  const appCookie = finish.headers.getSetCookie().find((value) => value.startsWith("omb_test="))!;
  expect(appCookie.includes("; Secure")).toBe(config.OMB_PUBLIC_URL.startsWith("https:"));
  expect(sessions.authenticate(appCookie.split(";")[0].slice("omb_test=".length))?.userId).toBe("github:12345");
  const replay = await fetch(`${base}/identity/finish`, { headers: { cookie: authCookie }, redirect: "manual" });
  expect(replay.status).toBe(403);
  expect(sessions.list()).toHaveLength(1);
});
