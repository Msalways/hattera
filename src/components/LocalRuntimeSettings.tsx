import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

export function LocalRuntimeSettings() {
  const [runtime, setRuntime] = useState<{ persistent: boolean; pid: number; environmentId: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<{ persistent: boolean; pid: number; environmentId: string }>("/api/local-runtime").then(value => { if (active) setRuntime(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  if (!runtime?.persistent) return null;
  return <section data-local-runtime className="space-y-3 rounded-xl border border-hairline/40 p-4">
    <h3 className="text-[13px] font-medium text-ink">{t("localRuntime.title")}</h3>
    <p className="text-[12px] leading-relaxed text-ink-secondary">{t(stopped ? "localRuntime.stopped" : "localRuntime.description")}</p>
    {!stopped && <button type="button" className="ui-button text-danger" disabled={busy} onClick={() => setConfirm(true)}>{t("localRuntime.stop")}</button>}
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    <ConfirmDialog open={confirm} title={t("localRuntime.stop")} body={t("localRuntime.stopHint")} confirmLabel={t("localRuntime.stop")} onCancel={() => setConfirm(false)} onConfirm={() => {
      setConfirm(false); setBusy(true); setError("");
      void api("/api/local-runtime/stop", { method: "POST", body: JSON.stringify({ pid: runtime.pid, environmentId: runtime.environmentId }) }).then(() => setStopped(true))
        .catch(cause => setError(cause instanceof Error ? cause.message : t("localRuntime.failed"))).finally(() => setBusy(false));
    }} />
  </section>;
}
