import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

export function ProviderProfiles({ instance }: { instance: InstanceInfo }) {
  const { dispatch } = useStore();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [rename, setRename] = useState(instance.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [remove, setRemove] = useState(false);
  const profile = instance.accountProfile;
  if (!profile?.canAdd || instance.readOnly) return null;
  const field = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-50";
  const perform = async (action: "add" | "rename" | "remove") => {
    if (busy) return;
    setBusy(true); setError(""); setRemove(false);
    try {
      const result = await api<{ instances: InstanceInfo[] }>(action === "add" ? "/api/instances/accounts" : `/api/instances/${encodeURIComponent(instance.instanceId)}`, {
        method: action === "add" ? "POST" : action === "remove" ? "DELETE" : "PATCH",
        ...(action === "remove" ? {} : { body: JSON.stringify(action === "add" ? { sourceInstanceId: instance.instanceId, displayName: name.trim() } : { displayName: rename.trim() }) }),
      });
      dispatch({ type: "instances", instances: result.instances });
      if (action === "add") { setAdding(false); setName(""); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("providerProfiles.failed")); }
    finally { setBusy(false); }
  };
  return <div data-provider-profiles={instance.instanceId} className="mt-4 space-y-3 border-t border-hairline/40 pt-3 text-[12px]">
    {profile.isolated && <details>
      <summary className="cursor-pointer py-1 text-ink-secondary">{t("providerProfiles.manage")}</summary>
      <form className="mt-2 space-y-3 rounded-xl bg-inset p-3" onSubmit={event => { event.preventDefault(); void perform("rename"); }}>
        <label className="block space-y-1 text-ink-secondary"><span>{t("engines.account.name")}</span><input className={field} value={rename} maxLength={80} required disabled={busy} onChange={event => setRename(event.target.value)} /></label>
        <p className="leading-relaxed text-ink-secondary">{t("providerProfiles.private")}</p>
        <div className="flex flex-wrap justify-between gap-3">
          {profile.removable && <button type="button" disabled={busy} onClick={() => setRemove(true)} className="text-danger disabled:opacity-50">{t("providerProfiles.remove")}</button>}
          <button type="submit" disabled={busy || !rename.trim() || rename.trim() === instance.displayName} className="ui-button disabled:opacity-50">{t("common.save")}</button>
        </div>
      </form>
    </details>}
    {adding ? <form className="space-y-3 rounded-xl bg-inset p-3" onSubmit={event => { event.preventDefault(); void perform("add"); }}>
      <label className="block space-y-1 text-ink-secondary"><span>{t("engines.account.name")}</span><input autoFocus className={field} value={name} maxLength={80} required disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <p className="leading-relaxed text-ink-secondary">{t("providerProfiles.addHint")}</p>
      <div className="flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => setAdding(false)} className="ui-button">{t("common.cancel")}</button>
        <button type="submit" disabled={busy || !name.trim()} className="ui-button flex items-center gap-2">{busy && <Loader2 size={13} className="animate-spin" />}{t("providerProfiles.add")}</button>
      </div>
    </form> : <button type="button" onClick={() => { setAdding(true); setError(""); }} className="ui-button flex items-center gap-1.5"><Plus size={13} />{t("providerProfiles.add")}</button>}
    {error && <p role="alert" className="text-danger">{error}</p>}
    <ConfirmDialog open={remove} title={t("providerProfiles.remove")} body={t("providerProfiles.removeHint")} confirmLabel={t("providerProfiles.remove")} onCancel={() => setRemove(false)} onConfirm={() => void perform("remove")} />
  </div>;
}
