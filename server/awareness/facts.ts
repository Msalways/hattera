// A fact the awareness view reports: its value, where it came from and when it
// was observed. A fact nobody reported is "unknown", never a guess or a default.
// Nothing here names a provider or a model.

export type Fact<T> =
  | {
      status: "known";
      value: T;
      /** What reported it, e.g. "provider-snapshot". Never a secret or a URL with one. */
      source: string;
      /** ISO time the source was read. */
      observedAt: string;
      /** True when observedAt is older than the freshness window at assembly time. */
      stale: boolean;
    }
  | {
      status: "unknown";
      /** The source that was asked and had nothing, or "none" when nothing was asked. */
      source: string;
      observedAt: string | null;
      /** Why it is unknown, when the source said so. */
      reason?: string;
    };

export function known<T>(value: T, source: string, observedAt: string, now: number, staleAfterMs: number): Fact<T> {
  const at = Date.parse(observedAt);
  const stale = !Number.isFinite(at) || now - at > staleAfterMs;
  return { status: "known", value, source, observedAt, stale };
}

export function unknown<T = never>(source = "none", observedAt: string | null = null, reason?: string): Fact<T> {
  return { status: "unknown", source, observedAt, ...(reason ? { reason } : {}) };
}
