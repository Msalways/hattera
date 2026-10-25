/** Numeric fields stay compatible with older clients; false marks a partial total. */
export interface TokenUsage {
  input: number;
  output: number;
  cachedInput?: number;
  tokensReported?: boolean;
}

export const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export function reportedTokens(usage: { input?: unknown; output?: unknown; tokensReported?: boolean } | undefined): boolean {
  return usage?.tokensReported !== false && tokenCount(usage?.input) !== undefined && tokenCount(usage?.output) !== undefined;
}

export function tokenUsage(input: unknown, output: unknown): TokenUsage | undefined {
  const i = tokenCount(input), o = tokenCount(output);
  if (i === undefined && o === undefined) return undefined;
  return { input: i ?? 0, output: o ?? 0, ...(i === undefined || o === undefined ? { tokensReported: false } : {}) };
}
