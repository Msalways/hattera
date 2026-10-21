import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { providerAccountForm } from "../../shared/provider-account-setup";
import { t } from "@/lib/i18n";

/** Server account setup uses write-only inputs; existing credentials are never fetched. */
export function ProviderAccountSetup({ instance }: { instance: InstanceInfo }) {
  const { dispatch, refreshModels } = useStore();
  const form = providerAccountForm(instance.driverKind, instance.instanceId);
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [model, setModel] = useState(instance.accountSetup?.model ?? "");
  const [region, setRegion] = useState(instance.accountSetup?.region ?? "us-east-1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (!form) return null;
  const field = "mt-1 w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent";
  return <form data-provider-account-setup={form} className="mt-3 space-y-3" onSubmit={async event => {
    event.preventDefault();
    setBusy(true); setError(null); setSaved(false);
    try {
      const result = await api<{ instances: InstanceInfo[] }>(`/api/instances/${encodeURIComponent(instance.instanceId)}/account`, {
        method: "POST", body: JSON.stringify({ key: key.trim(), ...(form === "model" ? { url: url.trim(), model: model.trim() } : form === "bedrock" ? { region, model: model.trim() } : {}) }),
      });
      setKey(""); setSaved(true);
      dispatch({ type: "instances", instances: result.instances });
      await refreshModels(instance.instanceId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("engineSetup.account.failed")); }
    finally { setBusy(false); }
  }}>
    <p className="text-[12px] leading-relaxed text-ink-secondary">{t(form === "bedrock" ? "engineSetup.account.bedrockDescription" : form === "model" ? "engineSetup.account.modelDescription" : "engineSetup.account.keyDescription", { name: instance.displayName })}</p>
    {form === "bedrock" && <label className="block text-[12px] text-ink-secondary">{t("engineSetup.account.region")}<input aria-label={t("engineSetup.account.region")} required value={region} onChange={e => setRegion(e.target.value)} className={field} placeholder="us-east-1" /></label>}
    {form === "model" && <label className="block text-[12px] text-ink-secondary">{t("engineSetup.account.url")}<input aria-label={t("engineSetup.account.url")} type="url" required value={url} onChange={e => setUrl(e.target.value)} className={field} placeholder="https://provider.example/v1" /></label>}
    {form !== "key" && <label className="block text-[12px] text-ink-secondary">{t(form === "bedrock" ? "engineSetup.account.bedrockModel" : "engineSetup.account.model")}<input aria-label={t("engineSetup.account.model")} required value={model} onChange={e => setModel(e.target.value)} className={field} /></label>}
    <label className="block text-[12px] text-ink-secondary">{t(form === "bedrock" ? "engineSetup.account.bedrockKey" : "engineSetup.account.key")}<input aria-label={t("engineSetup.account.key")} type="password" autoComplete="off" required value={key} onChange={e => setKey(e.target.value)} className={field} /></label>
    <button disabled={busy || !key.trim() || (form !== "key" && !model.trim())} type="submit" className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-accent-ink disabled:opacity-50">{busy && <Loader2 size={14} className="animate-spin" />}{t(busy ? "engineSetup.account.saving" : "engineSetup.account.save")}</button>
    {saved && <p role="status" className="text-[12px] text-success">{t("engineSetup.account.saved")}</p>}
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
  </form>;
}
