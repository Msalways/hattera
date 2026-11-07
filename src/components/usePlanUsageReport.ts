// Shared account-allowance refresh for PlanUsage and chat header details.
// Guards late/out-of-order responses so a stale fetch never replaces newer or
// switched-context data after the caller has moved on. Dedupe in-flight
// requests across simultaneously mounted consumers; the server also caches.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { dueResetDeadlines, type PlanUsageReport } from "./planUsageReport";

const inflight = new Map<string, { seq: number; resetId: number; promise: Promise<PlanUsageReport> }>();
let sharedReport: PlanUsageReport | null = null;
let sharedNow = 0;
let cacheIssuedSeq = 0;
let cacheCommittedSeq = 0;
let cacheResetId = 0;

export function clearPlanUsageReportCache() {
  cacheResetId += 1;
  inflight.clear();
  sharedReport = null;
  sharedNow = 0;
  // Keep sequence monotonic across resets so stale async handlers can never
  // appear "newer" than work issued after the reset.
}

function requestPlanUsage(refresh: boolean): Promise<PlanUsageReport> {
  const key = refresh ? "refresh" : "cached";
  const existing = inflight.get(key);
  if (existing) return existing.promise;
  const seq = ++cacheIssuedSeq;
  const resetId = cacheResetId;
  const promise = api<PlanUsageReport>(refresh ? "/api/plan-usage?refresh=1" : "/api/plan-usage")
    .then((data) => {
      if (resetId !== cacheResetId) return sharedReport ?? data;
      // Newer issued valid results must not be replaced by older late work.
      if (seq > cacheCommittedSeq) {
        cacheCommittedSeq = seq;
        sharedReport = data;
        sharedNow = Date.now();
      }
      // Stale in-flight subscribers must not apply an obsolete payload when a
      // newer canonical snapshot has already been committed.
      return sharedReport ?? data;
    })
    .finally(() => {
      const current = inflight.get(key);
      if (current?.promise === promise) inflight.delete(key);
    });
  inflight.set(key, { seq, resetId, promise });
  return promise;
}

export interface UsePlanUsageReportOptions {
  /** Disable all polling/refresh effects; explicit load() remains callable. */
  enabled?: boolean;
}

export function usePlanUsageReport(options: UsePlanUsageReportOptions = {}) {
  const enabled = options.enabled ?? true;
  const [report, setReport] = useState<PlanUsageReport | null>(sharedReport ?? null);
  const [loading, setLoading] = useState(enabled && !sharedReport);
  const [error, setError] = useState("");
  const [now, setNow] = useState(sharedNow || Date.now());
  const refreshedDeadlines = useRef(new Set<string>());
  const requestSeq = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestSeq.current += 1; };
  }, []);

  const load = useCallback(async (refresh = false) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError("");
    try {
      const data = await requestPlanUsage(refresh);
      if (!mounted.current || seq !== requestSeq.current) return;
      setReport(data);
      setNow(Date.now());
    } catch (cause) {
      if (!mounted.current || seq !== requestSeq.current) return;
      setError(cause instanceof Error && cause.message ? cause.message : t("planUsage.fetchError"));
    } finally {
      if (mounted.current && seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load(false);
    const refreshVisible = () => { if (document.visibilityState === "visible") void load(false); };
    const poll = window.setInterval(refreshVisible, 60_000);
    window.addEventListener("focus", refreshVisible);
    return () => { window.clearInterval(poll); window.removeEventListener("focus", refreshVisible); };
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !report?.refreshing) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(false); }, 3000);
    return () => window.clearInterval(timer);
  }, [enabled, report?.refreshing, load]);

  useEffect(() => {
    if (!enabled || !report) return;
    const due = dueResetDeadlines(report, now, refreshedDeadlines.current);
    if (due.length === 0) return;
    for (const deadline of due) refreshedDeadlines.current.add(deadline);
    void load(true);
  }, [enabled, report, now, load]);

  return { report, loading, error, now, load };
}
