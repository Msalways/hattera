import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";

import { cookieMaxAgeSeconds, type SessionRegistry } from "./sessions.ts";
import { serializeSessionCookie } from "./request-auth.ts";

export interface GithubIdentityConfig {
  publicUrl: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  secret: string;
  ownerId: string;
}

/** An unset configuration leaves ordinary local and paired installs alone. */
export function githubIdentityConfig(env: NodeJS.ProcessEnv): GithubIdentityConfig | null {
  const keys = ["OMB_PUBLIC_URL", "GITHUB_REDIRECT_URI", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "BETTER_AUTH_SECRET", "GITHUB_OWNER_ID"] as const;
  const values = keys.map((key) => env[key]?.trim() ?? "");
  if (values.slice(1).every((value) => !value)) return null;
  if (values.some((value) => !value)) throw new Error(`GitHub sign-in requires ${keys.join(", ")}`);
  const [publicUrl, redirectUri, clientId, clientSecret, secret, ownerId] = values as [string, string, string, string, string, string];
  const url = new URL(publicUrl);
  const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port);
  if ((url.protocol !== "https:" && !loopback) || url.origin !== publicUrl) {
    throw new Error("OMB_PUBLIC_URL must be an HTTPS origin or an HTTP 127.0.0.1 origin with a port, without a trailing slash");
  }
  if (redirectUri !== `${publicUrl}/identity/callback/github`) throw new Error("GITHUB_REDIRECT_URI must equal OMB_PUBLIC_URL + /identity/callback/github");
  if (!/^[1-9]\d*$/.test(ownerId)) throw new Error("GITHUB_OWNER_ID must be the numeric GitHub account ID");
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  return { publicUrl, redirectUri, clientId, clientSecret, secret, ownerId };
}

export function isGithubOwner(account: { providerId: string; accountId: string }, ownerId: string): boolean {
  return account.providerId === "github" && account.accountId === ownerId;
}

export function createGithubIdentity(input: { config: GithubIdentityConfig; dataDir: string; sessions: SessionRegistry; cookieName: string; postgresPool?: Pool }) {
  const { config, sessions, cookieName } = input;
  if (!input.postgresPool) mkdirSync(input.dataDir, { recursive: true, mode: 0o700 });
  const sqliteDb = input.postgresPool ? null : new DatabaseSync(join(input.dataDir, "github-identity.sqlite"));
  const auth = betterAuth({
    appName: "OpenMausBot",
    baseURL: config.publicUrl,
    basePath: "/identity",
    secret: config.secret,
    database: input.postgresPool ?? sqliteDb!,
    trustedOrigins: [config.publicUrl],
    socialProviders: {
      github: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectURI: config.redirectUri,
        // The provider profile comes from GitHub's token-authenticated /user.
        // Check it before Better Auth can create an account or session.
        mapProfileToUser(profile) {
          if (String(profile.id) !== config.ownerId) throw new APIError("FORBIDDEN", { message: "This GitHub account is not the configured owner" });
          return {};
        },
      },
    },
  });
  const nodeHandler = toNodeHandler(auth);
  const ready = auth.$context.then((context) => context.runMigrations());

  async function clearOAuthSession(req: IncomingMessage): Promise<string[]> {
    const response = await auth.handler(new Request(`${config.publicUrl}/identity/sign-out`, {
      method: "POST", headers: new Headers({ cookie: req.headers.cookie ?? "", origin: config.publicUrl }),
    }));
    if (!response.ok) throw new Error("GitHub sign-out could not finish");
    return response.headers.getSetCookie();
  }

  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path !== "/identity" && !path.startsWith("/identity/")) return false;
    await ready;
    res.setHeader("cache-control", "no-store");
    if (path !== "/identity/finish") {
      await nodeHandler(req, res);
      return true;
    }
    if (req.method !== "GET") { res.writeHead(405); res.end(); return true; }
    const headers = fromNodeHeaders(req.headers);
    const session = await auth.api.getSession({ headers });
    const accounts = session ? await auth.api.listUserAccounts({ headers }) : [];
    const owner = accounts?.some((account) => isGithubOwner(account, config.ownerId)) ?? false;
    // A Better Auth cookie is only needed during OAuth. Consume it so app
    // logout cannot be undone by revisiting this completion URL.
    let cookies: string[];
    try { cookies = await clearOAuthSession(req); }
    catch { res.writeHead(503); res.end("GitHub sign-in could not finish. Try again."); return true; }
    if (!owner) {
      res.setHeader("set-cookie", cookies);
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("This GitHub account is not the configured owner.");
      return true;
    }
    const issued = sessions.issue({ label: "GitHub owner", scopes: ["admin", "client"], userId: `github:${config.ownerId}` });
    res.setHeader("set-cookie", [...cookies, serializeSessionCookie(cookieName, issued.token, { secure: config.publicUrl.startsWith("https:"), maxAgeSeconds: cookieMaxAgeSeconds(issued.session) })]);
    res.writeHead(303, { location: "/" });
    res.end();
    return true;
  }

  return { ready, handle, clearOAuthSession, close: async () => {
    if (sqliteDb) sqliteDb.close();
    else await input.postgresPool!.end();
  } };
}
