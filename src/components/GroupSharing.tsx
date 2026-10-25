import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2, Share2, X } from "lucide-react";
import type { SharedGroupStatus } from "../../shared/collaboration";
import type { PrivateNetworkState } from "../../shared/private-network";
import { api, type Group } from "@/state/store";
import { t } from "@/lib/i18n";
import { PrivateNetworkSettings } from "./PrivateNetworkSettings";

export function GroupSharing({ group }: { group: Group }) {
  const [admin, setAdmin] = useState(false), [open, setOpen] = useState(false);
  const [loadedStatus, setStatus] = useState<SharedGroupStatus | null>(null), [network, setNetwork] = useState<PrivateNetworkState | null>(null);
  const status = loadedStatus?.localGroupId === group.id ? loadedStatus : null;
  const groupIdRef = useRef(group.id); groupIdRef.current = group.id;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpen(false); setInvitation(""); triggerRef.current?.focus(); }, []);
  const [name, setName] = useState(""), [code, setCode] = useState(""), [invitation, setInvitation] = useState("");
  const [history, setHistory] = useState(false), [manager, setManager] = useState(false), [confirmRevoke, setConfirmRevoke] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const region = useId();
  useEffect(() => { let active = true; void api("/api/auth/session").then(session => { if (active) setAdmin(session.scopes.includes("admin")); }).catch(() => {}); return () => { active = false; }; }, []);
  const load = useCallback(async () => {
    const [sharing, connection] = await Promise.all([api<{ groups: SharedGroupStatus[]; error?: string }>("/api/collaboration"), api<PrivateNetworkState>("/api/private-network")]);
    if (groupIdRef.current !== group.id) return;
    setStatus(sharing.groups.find(value => value.localGroupId === group.id) ?? null); setNetwork(connection);
    if (sharing.error) setError(sharing.error);
  }, [group.id]);
  useEffect(() => {
    if (!open && !group.sharedGroupId) return;
    let active = true;
    const refresh = () => { if (active && document.visibilityState === "visible") void load().catch(() => { if (active) setError(t("sharing.loadError")); }); };
    refresh(); const timer = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [load, open, group.sharedGroupId]);
  useEffect(() => { setOpen(false); setStatus(null); setCode(""); setInvitation(""); setError(""); }, [group.id]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("keydown", escape); return () => document.removeEventListener("keydown", escape);
  }, [open, close]);
  const act = async (action: string, body: unknown) => {
    setBusy(true); setError("");
    try {
      const response = await api<{ invitation?: string }>(`/api/collaboration/${action}`, { method: "POST", body: JSON.stringify(body) });
      if (response.invitation) setInvitation(response.invitation);
      if (action === "join") setCode("");
      setConfirmRevoke(""); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("sharing.actionError")); }
    finally { setBusy(false); }
  };
  if (!admin || group.dm) return null;
  const local = status?.members.find(member => member.publicKey === status.localPublicKey && member.active);
  const connected = network?.state === "connected" && network.peerTransport;
  const button = "rounded-lg bg-control px-3 py-2 text-ink hover:bg-raised disabled:opacity-50";
  const input = "w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-ink";
  return <div className="relative">
    <button ref={triggerRef} type="button" onClick={() => open ? close() : setOpen(true)} aria-expanded={open} aria-controls={region} aria-label={t("sharing.title")} title={t("sharing.title")} className="flex items-center gap-1.5 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><Share2 size={18} /><span className="text-xs">{group.sharedGroupId ? t("execution.people",{count:status?.members.filter(member=>member.active).length ?? "…"}) : t("execution.shareGroup")}</span></button>
    {/* The trigger can sit near the left edge even on wide screens. Keep the
        sharing panel inside the viewport instead of anchoring its right edge to it. */}
    {open && <section id={region} aria-label={t("sharing.title")} className="fixed inset-x-3 top-20 z-30 max-h-[calc(100dvh-7rem)] overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-4 text-[13px] shadow-xl sm:left-auto sm:right-3 sm:w-[min(28rem,calc(100vw-1.5rem))]">
      <div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-semibold text-ink">{t("sharing.title")}</h2><button type="button" onClick={close} aria-label={t("common.close")} className="rounded p-2 text-ink-secondary hover:bg-control"><X size={16} /></button></div>
      <p className="mb-3 text-ink-secondary">{t("sharing.scope")}</p>
      {!connected && <div className="mb-3"><PrivateNetworkSettings /></div>}
      {error && <p role="alert" className="mb-3 break-words text-danger">{error}</p>}
      {status ? <div className="space-y-3">
        <p role="status" className="text-ink">{status.joining ? t("sharing.joining") : status.blocked ? t("sharing.blocked") : !status.enabled ? t("sharing.paused") : !local ? t("sharing.ended") : t("sharing.active", { count: status.pending })}</p>
        {status.error && <p className="break-words text-danger">{status.error}</p>}
        {status.joining && <div className="space-y-2"><label className="block text-ink-secondary">{t("sharing.replaceInvite")}<input placeholder={t("sharing.yourName")} aria-label={t("sharing.yourName")} maxLength={120} value={name} onChange={event => setName(event.target.value)} className={`${input} mt-1`} /><textarea rows={3} maxLength={4096} value={code} onChange={event => setCode(event.target.value)} className={`${input} mt-1 font-mono text-xs`} /></label><button type="button" disabled={busy || !connected || !name.trim() || !code.trim()} className={button} onClick={() => void act("join", { localGroupId: group.id, memberName: name, invitation: code.trim() })}>{t("sharing.join")}</button></div>}
        {status.lastSyncedAt && <p className="text-ink-secondary">{t("sharing.lastSync", { time: new Date(status.lastSyncedAt).toLocaleString() })}</p>}
        <ul className="divide-y divide-hairline/30">{status.members.map(member => <li key={member.grantId} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="min-w-0 break-words text-ink" title={member.publicKey}>{member.name}{member.publicKey === status.localPublicKey ? ` · ${t("sharing.thisDevice")}` : ""}<span className="block text-xs text-ink-secondary">{!member.active ? t("sharing.removed") : member.role === "manager" ? t("sharing.manager") : t("sharing.member")}</span></span>
          {member.lastContactAt && member.active && <span className="text-xs text-ink-secondary">{t("execution.lastContact",{time:new Date(member.lastContactAt).toLocaleTimeString()})}</span>}
          {local?.role === "manager" && member.active && member.publicKey !== status.localPublicKey && member.parent && <button type="button" aria-label={t("execution.removePerson",{name:member.name})} disabled={busy} className="rounded px-2 py-1 text-danger hover:bg-control" onClick={() => setConfirmRevoke(member.grantId)}>{t("sharing.remove")}</button>}
        </li>)}</ul>
        {confirmRevoke && <div className="rounded-lg border border-hairline/50 p-3"><p className="mb-2 text-ink">{t("sharing.revokeNote")}</p><div className="flex flex-wrap gap-2"><button type="button" disabled={busy} className={button} onClick={() => void act("revoke", { groupId: status.groupId, grantId: confirmRevoke })}>{t("sharing.confirmRemove")}</button><button type="button" className={button} onClick={() => setConfirmRevoke("")}>{t("common.cancel")}</button></div></div>}
        {status.bots.length > 0 && <div><h3 className="font-medium text-ink">{t("sharing.bots")}</h3><ul className="mt-1 space-y-1 text-ink-secondary">{status.bots.map(bot => <li key={`${bot.origin}/${bot.id}`}>{bot.name} · {status.members.find(member => member.publicKey === bot.origin)?.name ?? t("sharing.member")}{!status.members.some(member=>member.publicKey===bot.origin&&member.active)?` · ${t("execution.revoked")}`:""}</li>)}</ul></div>}
        {local?.role === "manager" && status.enabled && !status.blocked && <div className="space-y-2 border-t border-hairline/30 pt-3">
          <label className="flex items-start gap-2 text-ink-secondary"><input type="checkbox" checked={manager} onChange={event => setManager(event.target.checked)} />{t("sharing.allowInvites")}</label>
          <button type="button" className={button} disabled={busy || !connected} onClick={() => void act("invite", { groupId: status.groupId, role: manager ? "manager" : "member" })}>{t("sharing.createInvite")}</button>
          {invitation && <label className="block text-ink-secondary">{t("sharing.inviteNote")}<textarea readOnly value={invitation} rows={4} onFocus={event => event.target.select()} className={`${input} mt-2 break-all font-mono text-xs`} /></label>}
        </div>}
        <button type="button" className={button} disabled={busy || status.blocked} onClick={() => void act("enabled", { groupId: status.groupId, enabled: !status.enabled })}>{status.enabled ? t("sharing.pause") : t("sharing.resume")}</button>
      </div> : <div className="space-y-3">
        <label className="block text-ink-secondary">{t("sharing.yourName")}<input autoComplete="name" maxLength={120} value={name} onChange={event => setName(event.target.value)} className={`${input} mt-1`} /></label>
        <label className="flex items-start gap-2 text-ink-secondary"><input type="checkbox" checked={history} onChange={event => setHistory(event.target.checked)} />{t("sharing.includeHistory")}</label>
        <button type="button" disabled={busy || !connected || !name.trim()} className={button} onClick={() => void act("share", { localGroupId: group.id, memberName: name, includeHistory: history })}>{t("sharing.start")}</button>
        <div className="space-y-2 border-t border-hairline/30 pt-3"><label className="block text-ink-secondary">{t("sharing.pasteInvite")}<textarea rows={3} maxLength={4096} value={code} onChange={event => setCode(event.target.value)} className={`${input} mt-1 font-mono text-xs`} /></label><button type="button" disabled={busy || !connected || !name.trim() || !code.trim()} className={button} onClick={() => void act("join", { localGroupId: group.id, memberName: name, invitation: code.trim() })}>{t("sharing.join")}</button></div>
      </div>}
      {busy && <div role="status" className="mt-3 flex items-center gap-2 text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("sharing.saving")}</div>}
    </section>}
  </div>;
}
