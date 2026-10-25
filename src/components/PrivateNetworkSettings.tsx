import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { PrivateNetworkState } from "../../shared/private-network";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

export function PrivateNetworkSettings() {
  const [network, setNetwork] = useState<PrivateNetworkState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setNetwork(await api<PrivateNetworkState>("/api/private-network")); setError(""); }
    catch { setError(t("privateNetwork.loadError")); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!network?.enabled) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, network.state === "connected" ? 30_000 : 3000);
    return () => window.clearInterval(timer);
  }, [load, network?.enabled, network?.state]);
  const act = async (action: "connect" | "disconnect") => {
    setBusy(true); setError("");
    try { setNetwork(await api<PrivateNetworkState>(`/api/private-network/${action}`, { method: "POST", body: "{}" })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("privateNetwork.actionError")); }
    finally { setBusy(false); }
  };
  return <Card title={t("privateNetwork.title")} subtitle={t("privateNetwork.subtitle")}>
    <div className="flex flex-col gap-3 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-ink" role="status">{network ? t(`privateNetwork.state.${network.state}`) : t("privateNetwork.loading")}</span>
        <button type="button" onClick={() => void load()} aria-label={t("planUsage.refresh")} className="rounded-md p-2 text-ink-secondary hover:bg-control"><RefreshCw size={15} /></button>
      </div>
      {!network?.available && network && <p className="text-ink-secondary">{t("privateNetwork.missingComponent")}</p>}
      {(error || network?.message) && <p role="alert" className="break-words text-danger">{error || network?.message}</p>}
      {network?.authorizationUrl && <a className="rounded-lg bg-accent px-4 py-2.5 text-center font-medium text-accent-ink" href={network.authorizationUrl} target="_blank" rel="noreferrer">{t("privateNetwork.signIn")} ↗</a>}
      {network?.origin && <p className="break-all text-ink-secondary">{t("privateNetwork.address", { origin: network.origin })}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || !network?.available} onClick={() => void act("connect")} className="flex items-center gap-2 rounded-lg bg-control px-4 py-2 text-ink disabled:opacity-50">
          {busy && <Loader2 size={14} className="animate-spin" />}{network?.enabled ? t("privateNetwork.reconnect") : t("privateNetwork.connect")}
        </button>
        {network?.enabled && <button type="button" disabled={busy} onClick={() => void act("disconnect")} className="rounded-lg px-4 py-2 text-danger hover:bg-control disabled:opacity-50">{t("privateNetwork.disconnect")}</button>}
      </div>
      {network?.peers.length ? <ul className="divide-y divide-hairline/30">{network.peers.map(peer => <li key={peer.id} className="flex min-w-0 flex-wrap justify-between gap-2 py-2"><span className="break-all text-ink">{peer.name || peer.id}</span><span className="text-ink-secondary">{peer.online ? t("privateNetwork.online") : t("privateNetwork.offline")}</span></li>)}</ul> : null}
      <p className="text-[12px] leading-relaxed text-ink-secondary">{t("privateNetwork.accessNote")}</p>
    </div>
  </Card>;
}
