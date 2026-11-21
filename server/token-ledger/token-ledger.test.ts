import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTokenLedgerRoutes } from "../routes/token-ledger.ts";
import { PASS } from "../routes/table.ts";
import { appendUsage, flushUsageLedger, type UsageRow } from "../usage-ledger.ts";
import { readTokenTurns, rollup, totalRollup, turnTokens } from "./ledger.ts";

const AT = "2026-11-10T10:00:00.000Z";
const row = (extra: Partial<UsageRow> = {}): UsageRow => ({
  at: AT, botId: "b1", botName: "B1", threadId: "t1", instanceId: "i1", driverKind: "d", model: "m1",
  input: 100, output: 20, costUsd: 0, trigger: { kind: "owner" }, ...extra,
} as UsageRow);

describe("token ledger aggregation", () => {
  it("rolls turns up per thread, bot and model", () => {
    const turns = [
      row({ cachedInput: 40 }), row({ input: 50, output: 5, cachedInput: 10 }),
      row({ threadId: "t2", botId: "b2", model: "m2", input: 7, output: 3, cachedInput: 0 }),
    ].map(turnTokens);
    const byThread = rollup(turns, "thread");
    expect(byThread.map((g) => g.key)).toEqual(["t1", "t2"]);
    expect(byThread[0]).toMatchObject({ turns: 2, input: { total: 150 }, cached: { total: 50 }, output: { total: 25 } });
    expect(rollup(turns, "bot").map((g) => [g.key, g.turns])).toEqual([["b1", 2], ["b2", 1]]);
    expect(rollup(turns, "model").map((g) => g.key)).toEqual(["m1", "m2"]);
    expect(totalRollup(turns)).toMatchObject({ turns: 3, input: { total: 157 } });
  });

  it("a missing cached field stays unknown, not 0; an explicit 0 is known", () => {
    expect(turnTokens(row()).cached).toEqual({ status: "unknown" });
    expect(turnTokens(row({ cachedInput: 0 })).cached).toEqual({ status: "known", value: 0 });
    const group = rollup([turnTokens(row()), turnTokens(row())], "model")[0]!;
    expect(group.cached).toEqual({ total: null, reportedTurns: 0, unknownTurns: 2 });
    const mixed = rollup([turnTokens(row()), turnTokens(row({ cachedInput: 9 }))], "model")[0]!;
    expect(mixed.cached).toEqual({ total: 9, reportedTurns: 1, unknownTurns: 1 });
  });

  it("partial telemetry makes input and output unknown", () => {
    const turn = turnTokens(row({ tokensReported: false, input: 0, output: 0 }));
    expect(turn.input.status).toBe("unknown");
    expect(turn.output.status).toBe("unknown");
    expect(rollup([turn], "bot")[0]!.input.total).toBeNull();
  });
});

describe("persistence round-trip", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  it("reads back what appendUsage persisted in a temp dir", async () => {
    dir = mkdtempSync(join(tmpdir(), "token-ledger-"));
    await appendUsage(dir, row({ cachedInput: 30 }));
    await appendUsage(dir, row({ threadId: "t2", tokensReported: false }));
    await flushUsageLedger(dir);
    const turns = readTokenTurns(dir, { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-30T23:59:59Z") });
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ threadId: "t1", input: { status: "known", value: 100 }, cached: { status: "known", value: 30 } });
    expect(turns[1]).toMatchObject({ threadId: "t2", input: { status: "unknown" }, cached: { status: "unknown" } });
  });
});

describe("GET /api/token-ledger", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  function call(dataDir: string, method: string, path: string) {
    let status = 0; let body: unknown; const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as unknown as ServerResponse;
    const url = new URL(path, "http://localhost");
    const handler = createTokenLedgerRoutes({ dataDir, now: () => new Date("2026-11-20T00:00:00Z") });
    return Promise.resolve(handler({
      req: {} as IncomingMessage, res, url, path: url.pathname, method,
      auth: { kind: "loopback", scopes: ["admin"] } as never,
      json: ((_r: unknown, code: number, payload: unknown) => { status = code; body = payload; }) as never,
      readBody: (async () => ({})) as never,
    })).then((out) => ({ out, status, body: body as any, headers }));
  }
  it("passes other paths and methods", async () => {
    expect((await call("x", "POST", "/api/token-ledger")).out).toBe(PASS);
    expect((await call("x", "GET", "/api/usage")).out).toBe(PASS);
  });
  it("rejects bad range and groupBy", async () => {
    expect((await call("x", "GET", "/api/token-ledger?from=bad&to=bad")).status).toBe(400);
    expect((await call("x", "GET", "/api/token-ledger?from=2026-11-01&to=2026-11-30&groupBy=nope")).status).toBe(400);
  });
  it("returns grouped totals, uncached, with unknowns preserved", async () => {
    dir = mkdtempSync(join(tmpdir(), "token-ledger-route-"));
    await appendUsage(dir, row());
    await flushUsageLedger(dir);
    const r = await call(dir, "GET", "/api/token-ledger?from=2026-11-01&to=2026-11-30&groupBy=thread&turns=1");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body.groups[0]).toMatchObject({ key: "t1", input: { total: 100 }, cached: { total: null, unknownTurns: 1 } });
    expect(r.body.turns).toHaveLength(1);
  });
});
