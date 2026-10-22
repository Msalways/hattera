import { useState } from "react";
import { Loader2, Trash2, RotateCcw } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

export function EngineRuntimeRemoval({ instance }: { instance: InstanceInfo }) {
  const { dispatch, refreshInstances } = useStore();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const removal = instance.runtimeRemoval;
  if (!removal || instance.readOnly) return null;
  const canRemove = removal.managed || (!removal.removed && (instance.snapshot.state === "available" || removal.restoreAvailable));
  const label = t(removal.managed ? "engines.removal.uninstall" : "engines.removal.disable");
  const run = async (action: "uninstall" | "restore-runtime") => {
    setBusy(true); setError(null);
    try {
      const result = await api<{ instances: InstanceInfo[] }>(`/api/instances/${encodeURIComponent(instance.instanceId)}/${action}`, {
        method: "POST", body: JSON.stringify(action === "uninstall" ? { confirm: true } : {}),
      });
      dispatch({ type: "instances", instances: result.instances });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("engines.removal.failed"));
      await Promise.resolve(refreshInstances()).catch(() => {});
    } finally { setBusy(false); setConfirming(false); }
  };
  return <div data-engine-runtime-removal className="mt-4 space-y-2 border-t border-hairline/40 pt-3">
    {removal.removed && <p role="status" className="text-[12px] leading-relaxed text-ink-secondary">{t("engines.removal.kept")}</p>}
    {removal.removed && removal.restoreAvailable && <button disabled={busy} onClick={() => void run("restore-runtime")} className="flex items-center gap-2 rounded-lg bg-control px-3 py-2 text-[12px] font-semibold text-ink disabled:opacity-50">
      {busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}{t("engines.removal.restore")}
    </button>}
    {canRemove && <button disabled={busy} onClick={() => { setError(null); setConfirming(true); }} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] font-medium text-danger hover:bg-danger/10 disabled:opacity-50">
      <Trash2 size={13} />{label}
    </button>}
    {error && <p role="alert" className="text-[12px] leading-relaxed text-danger">{error}</p>}
    <ConfirmDialog open={confirming} title={t(removal.managed ? "engines.removal.titleUninstall" : "engines.removal.titleDisable", { name: instance.displayName })}
      body={[t(removal.managed ? "engines.removal.body" : "engines.removal.external"), removal.accounts > 1 ? t("engines.removal.shared", { count: removal.accounts }) : ""].filter(Boolean).join(" ")}
      confirmLabel={label} pending={busy} onCancel={() => { if (!busy) setConfirming(false); }} onConfirm={() => void run("uninstall")} />
  </div>;
}
