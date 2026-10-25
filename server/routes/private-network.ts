import type { PrivateNetwork } from "../private-network.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createPrivateNetworkRoutes(network: PrivateNetwork): RouteHandler {
  return async ({ path, method, res, json, readBody, req, auth }) => {
    if (!path.startsWith("/api/private-network")) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only this installation's administrator can manage its private network." });
    res.setHeader("cache-control", "no-store");
    if (method === "GET" && path === "/api/private-network") return json(res, 200, await network.status());
    if (method === "POST" && (path === "/api/private-network/connect" || path === "/api/private-network/disconnect")) {
      await readBody(req, 1024);
      try {
        if (path.endsWith("/connect")) return json(res, 200, await network.connect());
        await network.disconnect();
        return json(res, 200, await network.status());
      } catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : "Private network action failed." }); }
    }
    return json(res, 404, { error: "Private network action not found." });
  };
}
