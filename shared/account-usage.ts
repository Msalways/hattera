/** Account allowances are provider snapshots, separate from Hattera's turn ledger. */
export interface AccountMetric {
  id: string;
  label: string;
  scope: string | null;
  unit: "percent" | "tokens" | "requests" | "USD" | "credits" | "units" | "currency";
  currency?: string;
  /** Only supplied when explicitly reported by the provider. */
  availability?: "unlimited" | "not-in-plan";
  used: number | null;
  remaining: number | null;
  limit: number | null;
  windowSeconds: number | null;
  resetsAt: string | null;
  estimated?: boolean;
}

export interface AccountReporting {
  status: "current" | "partial" | "stale" | "unavailable" | "sign-in-required" | "not-supported";
  source: string;
  collectedAt: string | null;
  message: string | null;
  dashboardUrl: string | null;
  metrics: AccountMetric[];
}
