// Token ledger: input / cached / output tokens per turn, rolled up per thread,
// bot and model. It is derived from the usage rows the runtime already books
// at turn settlement (server/usage-ledger.ts, <data>/usage/YYYY-MM.jsonl); it
// makes no provider call and writes nothing. A field a driver did not report is
// `unknown`, never 0: the usage row stores no cachedInput when it was not
// reported, and tokensReported === false marks input/output as partial.
// Nothing here names a provider or a model.
import { readUsage, type UsageRow } from "../usage-ledger.ts";

/** A token count the driver reported, or unknown. */
export type TokenField = { status: "known"; value: number } | { status: "unknown" };

export interface TurnTokens {
  at: string;
  threadId: string;
  botId: string;
  instanceId: string;
  model: string;
  input: TokenField;
  cached: TokenField;
  output: TokenField;
}

/** A rolled-up count: the sum over turns that reported it, and how many did not.
 * `total` is null when no turn reported the field. */
export interface TokenSum {
  total: number | null;
  reportedTurns: number;
  unknownTurns: number;
}

export interface TokenRollup {
  key: string;
  turns: number;
  input: TokenSum;
  cached: TokenSum;
  output: TokenSum;
}

export type TokenGrouping = "thread" | "bot" | "model";
export const TOKEN_GROUPINGS: readonly TokenGrouping[] = ["thread", "bot", "model"];

const known = (value: number): TokenField => ({ status: "known", value });
const UNKNOWN: TokenField = { status: "unknown" };

export function turnTokens(row: UsageRow): TurnTokens {
  const partial = row.tokensReported === false;
  return {
    at: row.at,
    threadId: row.threadId,
    botId: row.botId,
    instanceId: row.instanceId,
    model: row.model,
    input: partial ? UNKNOWN : known(row.input),
    cached: typeof row.cachedInput === "number" ? known(row.cachedInput) : UNKNOWN,
    output: partial ? UNKNOWN : known(row.output),
  };
}

function add(sum: TokenSum, field: TokenField): void {
  if (field.status === "known") {
    sum.total = (sum.total ?? 0) + field.value;
    sum.reportedTurns += 1;
  } else sum.unknownTurns += 1;
}

const emptySum = (): TokenSum => ({ total: null, reportedTurns: 0, unknownTurns: 0 });

export function rollup(turns: readonly TurnTokens[], by: TokenGrouping): TokenRollup[] {
  const groups = new Map<string, TokenRollup>();
  for (const turn of turns) {
    const key = by === "thread" ? turn.threadId : by === "bot" ? turn.botId : turn.model;
    let group = groups.get(key);
    if (!group) {
      group = { key, turns: 0, input: emptySum(), cached: emptySum(), output: emptySum() };
      groups.set(key, group);
    }
    group.turns += 1;
    add(group.input, turn.input);
    add(group.cached, turn.cached);
    add(group.output, turn.output);
  }
  return [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function totalRollup(turns: readonly TurnTokens[]): TokenRollup {
  return rollup(turns.map((turn) => ({ ...turn, threadId: "all" })), "thread")[0]
    ?? { key: "all", turns: 0, input: emptySum(), cached: emptySum(), output: emptySum() };
}

/** Per-turn records for a range, oldest first, read from the persisted usage rows. */
export function readTokenTurns(dataDir: string, range: { from: Date; to: Date }): TurnTokens[] {
  return readUsage(dataDir, range).map(turnTokens);
}
