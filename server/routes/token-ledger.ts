// Token ledger: input / cached / output tokens per thread, bot or model, over a
// date range. Read-only over the persisted usage rows; unreported fields are
// `unknown`, never 0. Admin scope by default, like every route not opened to
// clients (server/request-auth.ts).
//
// GET /api/token-ledger?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=thread|bot|model&turns=1
import { TOKEN_GROUPINGS, readTokenTurns, rollup, totalRollup, type TokenGrouping } from "../token-ledger/ledger.ts";
import { parseUsageRange } from "../usage-ledger.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TokenLedgerRouteDeps {
  dataDir: string;
  now?(): Date;
}

const MAX_TURNS = 1000;

export function createTokenLedgerRoutes(deps: TokenLedgerRouteDeps): RouteHandler {
  return async ({ res, url, path, method, json }) => {
    if (!(method === "GET" && path === "/api/token-ledger")) return PASS;
    const range = parseUsageRange(url.searchParams.get("from"), url.searchParams.get("to"), deps.now?.());
    if (!range) return json(res, 400, { error: "from and to must be YYYY-MM-DD, from no later than to, at most a year apart" });
    const requested = url.searchParams.get("groupBy") ?? "model";
    if (!TOKEN_GROUPINGS.includes(requested as TokenGrouping)) {
      return json(res, 400, { error: `groupBy must be one of ${TOKEN_GROUPINGS.join(", ")}` });
    }
    const turns = readTokenTurns(deps.dataDir, range);
    const withTurns = url.searchParams.get("turns") === "1";
    res.setHeader("cache-control", "no-store");
    return json(res, 200, {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      groupBy: requested,
      groups: rollup(turns, requested as TokenGrouping),
      total: totalRollup(turns),
      ...(withTurns ? { turns: turns.slice(-MAX_TURNS), turnsTruncated: turns.length > MAX_TURNS } : {}),
    });
  };
}
