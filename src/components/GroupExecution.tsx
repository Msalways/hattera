import { useCallback, useEffect, useState } from "react";
import { api, useStore, type Group } from "@/state/store";
import { t } from "@/lib/i18n";
import { ChatMarkdown } from "./ChatMarkdown";
import { terminalExecution, type ExecutionStatus, type ExecutionJob } from "../../shared/collaboration-execution";
import type { SharedGroupStatus } from "../../shared/collaboration";

/** The selector routes an explicit request to an owner-granted native bot.
 * The ordinary local composer keeps its own state and behavior. */
export function GroupExecution({ group, onRemote }: { group: Group; onRemote(remote: boolean): void }) {
  const { state, dispatch } = useStore();
  const [admin, setAdmin] = useState(false);
  const groupId = group.sharedGroupId;
  const [status, setStatus] = useState<ExecutionStatus | null>(null);
  const [sharing, setSharing] = useState<SharedGroupStatus | null>(null);
  const [selection, setSelection] = useState("");
  const [text, setText] = useState("");
  const [botId, setBotId] = useState(group.memberIds[0] ?? "");
  const [label, setLabel] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [approval, setApproval] = useState(true), [acknowledge, setAcknowledge] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const root = `/api/collaboration/${groupId}/execution`;
  useEffect(() => { let active = true; void api("/api/auth/session").then(session => { if (active) setAdmin(session.scopes.includes("admin")); }).catch(() => {}); return () => { active = false; }; }, []);
  const load = useCallback(async () => {
    if (!groupId) return;
    const groups = await api<{groups: SharedGroupStatus[]}>("/api/collaboration");
    const binding = groups.groups.find(value => value.groupId === groupId) ?? null;
    setSharing(binding);
    if (!binding || binding.blocked || binding.joining || !binding.enabled || !binding.members.some(member=>member.active&&member.publicKey===binding.localPublicKey)) {
      setStatus(null); setSelection(""); return;
    }
    setStatus(await api<ExecutionStatus>(`/api/collaboration/${groupId}/execution`));
    setError(current=>current===t("execution.loadError")?"":current);
  }, [groupId]);
  useEffect(() => {
    if (!admin) return;
    let active = true;
    const refresh = () => { if (active && document.visibilityState === "visible") void load().catch(() => { if (active) setError(t("execution.loadError")); }); };
    refresh(); const timer = window.setInterval(refresh, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [load, admin]);
  useEffect(() => { onRemote(Boolean(selection)); return () => onRemote(false); }, [selection, onRemote]);
  useEffect(() => { setSelection(""); setStatus(null); setSharing(null); setMembers([]); setError(""); }, [groupId]);
  const act = async (action: string, body: unknown) => {
    setBusy(true); setError("");
    try { await api(`${root}/${action}`, { method: "POST", body: JSON.stringify(body) }); await load(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("execution.actionError")); return false; }
    finally { setBusy(false); }
  };
  if (!groupId || !admin) return null;
  if (sharing && (sharing.blocked || sharing.joining || !sharing.enabled || !sharing.members.some(member=>member.active&&member.publicKey===sharing.localPublicKey))) {
    return <p role="status" className="mx-3 mb-2 rounded-xl border border-hairline/40 p-3 text-[13px] text-ink-secondary sm:mx-5">{t(sharing.blocked?"sharing.blocked":sharing.joining?"sharing.joining":!sharing.enabled?"sharing.paused":"sharing.ended")}</p>;
  }
  const targets = status?.peers.flatMap(peer => peer.targets.map(target => ({ peer, target, key: `${peer.publicKey}/${target.id}` }))) ?? [];
  const selected = targets.find(value => value.key === selection);
  const topic = group.tasks?.find(task => task.threadId === group.threadId)?.sharedTopicId;
  const conversationJob = topic ? [...(status?.incoming ?? []), ...(status?.outgoing ?? [])].find(job => job.id === topic) : undefined;
  const others = sharing?.members.filter(member => member.active && member.publicKey !== sharing.localPublicKey) ?? [];
  const input = "min-w-0 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-ink";
  const button = "rounded-lg bg-control px-3 py-2 text-ink hover:bg-raised disabled:opacity-50";
  const displayJob = (job: ExecutionJob & {botId?:string;threadId?:string}, incoming: boolean) => <li key={`${incoming}/${job.id}`} className="space-y-2 rounded-xl border border-hairline/40 p-3">
    <div className="flex flex-wrap justify-between gap-2"><span className="font-medium text-ink">{job.requester} → {job.owner} · {job.target.label}</span><span role="status" className="text-ink-secondary">{t(`execution.state.${job.state}`)}</span></div>
    <p className="break-words whitespace-pre-wrap text-ink-secondary">{job.text}</p>
    <p className="break-words text-xs text-ink-secondary">{job.target.account} · {job.target.model}{job.target.effort ? ` · ${job.target.effort}` : ""}{job.target.variant ? ` · ${job.target.variant}` : ""}</p>
    {job.error && <p role="alert" className="break-words text-danger">{job.error}</p>}
    {job.result && <div className="break-words text-ink"><ChatMarkdown text={job.result} portable /></div>}
    {job.usage && <p className="text-xs text-ink-secondary">{job.usage.tokensReported === false ? t("execution.partialUsage") : t("execution.usage", {input:job.usage.input,output:job.usage.output})}</p>}
    <div className="flex flex-wrap gap-2">
      {incoming && job.state === "pending-approval" && <><button type="button" disabled={busy} className={button} onClick={() => void act("decide", {id:job.id,allow:true})}>{t("execution.approve")}</button><button type="button" disabled={busy} className={button} onClick={() => void act("decide", {id:job.id,allow:false})}>{t("execution.deny")}</button></>}
      {!terminalExecution(job.state) && <button type="button" disabled={busy} className={button} onClick={() => void act("cancel", {id:job.id,incoming})}>{t("execution.cancel")}</button>}
      {!incoming && job.state === "delivery-unknown" && <button type="button" disabled={busy} className={button} onClick={() => void act("requests", {id:job.id,ownerKey:job.ownerKey,targetId:job.targetId,text:job.text})}>{t("execution.retry")}</button>}
      {incoming && job.threadId && job.botId && <button type="button" className={button} onClick={() => { dispatch({type:"select",id:job.botId!}); dispatch({type:"switchTask",botId:job.botId!,threadId:job.threadId!}); }}>{t("execution.openTask")}</button>}
      {group.tasks?.some(task => task.sharedTopicId === job.id) && <button type="button" className={button} onClick={() => { const task = group.tasks?.find(value => value.sharedTopicId === job.id); if (task) dispatch({type:"switchGroupTask",groupId:group.id,threadId:task.threadId}); }}>{t("execution.openConversation")}</button>}
    </div>
  </li>;
  return <section data-group-execution={groupId} aria-label={t("execution.title")} className="mx-3 mb-2 max-h-[60dvh] space-y-2 overflow-y-auto rounded-xl border border-hairline/40 bg-panel p-3 text-[13px] sm:mx-5">
    <label className="flex flex-wrap items-center gap-2 text-ink-secondary"><span>{t("execution.runWith")}</span>
      <select aria-label={t("execution.runWith")} value={selection} className={`${input} max-w-full flex-1`} onChange={event => { setSelection(event.target.value); setError(""); }}>
        <option value="">{t("execution.local")}</option>
        {targets.map(({peer,target,key}) => <option key={key} value={key} disabled={!target.ready || peer.state === "unreachable"}>{peer.name} ({peer.publicKey.slice(-12,-1)}) · {target.label} · {target.account} · {target.model}{!target.ready ? ` — ${t("execution.notReady")}` : peer.state === "unreachable" ? ` — ${t("execution.unreachable")}` : ""}</option>)}
      </select>
      <button type="button" className={button} disabled={busy} onClick={() => void load().catch(() => setError(t("execution.loadError")))}>{t("execution.refresh")}</button>
    </label>
    <p data-execution-route className="break-words text-ink-secondary">{selected
      ? t("execution.nextRemote", { owner: selected.peer.name, account: selected.target.account, model: selected.target.model })
      : t("execution.nextGroupLocal", { accounts: [...new Set(group.memberIds.flatMap(id => {
        const bot = state.bots.find(value => value.id === id);
        return bot ? [state.instances.find(instance => instance.instanceId === bot.modelSelection.instanceId)?.displayName ?? bot.modelSelection.instanceId] : [];
      }))].join(", ") })}</p>
    {conversationJob && <p data-execution-receipt className="break-words rounded-lg bg-inset p-2 text-ink-secondary">{t("execution.conversationRoute", { requester: conversationJob.requester, owner: conversationJob.owner, account: conversationJob.target.account, model: conversationJob.target.model })} · {t(`execution.state.${conversationJob.state}`)}</p>}
    {selection && <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (!selected || !text.trim() || busy) return; const requestText=text; void act("requests",{id:crypto.randomUUID(),ownerKey:selected.peer.publicKey,targetId:selected.target.id,text:requestText}).then(ok=>{if(ok){setText("");setManageOpen(true);}}); }}>
      <p className="text-ink-secondary">{selected?.target.approval ? t("execution.needsApproval") : t("execution.nativePermissions")}</p>
      <textarea aria-label={t("execution.request")} placeholder={t("execution.request")} rows={3} maxLength={16_000} value={text} onChange={event=>setText(event.target.value)} className={`${input} w-full`} />
      <button type="submit" disabled={busy || !text.trim() || !selected?.target.ready || selected?.peer.state === "unreachable"} className={button}>{t("execution.send")}</button>
    </form>}
    {(error || status?.error) && <p role="alert" className="break-words text-danger">{error || status?.error}</p>}
    <details data-execution-manage open={manageOpen} onToggle={event=>setManageOpen(event.currentTarget.open)} className="space-y-3"><summary className="cursor-pointer text-ink-secondary">{t("execution.manage")}{status?.incoming.some(job=>job.state==="pending-approval") ? ` · ${t("execution.pending")}` : ""}</summary>
      {!targets.length && <p className="mt-2 text-ink-secondary">{t("execution.noTargets")}</p>}
      <ul className="my-2 space-y-1">{status?.peers.map(peer=><li key={peer.publicKey} className="flex flex-wrap justify-between gap-2"><span>{peer.name}</span><span className="text-ink-secondary">{t(`execution.peer.${peer.state}`)}{peer.lastContactAt ? ` · ${new Date(peer.lastContactAt).toLocaleTimeString()}` : ""}</span></li>)}</ul>
      <details data-execution-share open={shareOpen} onToggle={event=>setShareOpen(event.currentTarget.open)} className="border-t border-hairline/40 pt-3">
      <summary className="cursor-pointer font-medium text-ink">{t("execution.share")}</summary>
      <form className="mt-3 space-y-2" onSubmit={event=>{event.preventDefault();void act("grants",{botId,label:label.trim()||state.bots.find(bot=>bot.id===botId)?.name||"Shared bot",members,approval,acknowledge}).then(ok=>{if(ok){setAcknowledge(false);setMembers([]);setLabel("");setShareOpen(false);}});}}>
        <p className="text-ink-secondary">{t("execution.shareScope")}</p>
        <label className="block text-ink-secondary">{t("execution.bot")}<select aria-label={t("execution.bot")} value={botId} onChange={event=>setBotId(event.target.value)} className={`${input} mt-1 w-full`}>
          <option value="">{t("execution.chooseBot")}</option>{state.bots.filter(bot=>!bot.hidden).map(bot=><option key={bot.id} value={bot.id}>{bot.name} · {state.instances.find(instance=>instance.instanceId===bot.modelSelection.instanceId)?.displayName ?? bot.modelSelection.instanceId} · {bot.modelSelection.model}</option>)}
        </select></label>
        <label className="block text-ink-secondary">{t("execution.label")}<input aria-label={t("execution.label")} value={label} maxLength={160} onChange={event=>setLabel(event.target.value)} className={`${input} mt-1 w-full`} /></label>
        <fieldset className="space-y-1"><legend className="mb-1 text-ink-secondary">{t("execution.allowedPeople")}</legend>{others.map(member=><label key={member.grantId} title={member.publicKey} className="flex items-start gap-2"><input type="checkbox" checked={members.includes(member.publicKey)} onChange={event=>setMembers(current=>event.target.checked?[...current,member.publicKey]:current.filter(key=>key!==member.publicKey))} />{member.name} · {member.publicKey.slice(-12,-1)}</label>)}</fieldset>
        <label className="flex items-start gap-2"><input type="checkbox" checked={approval} onChange={event=>setApproval(event.target.checked)} />{t("execution.approval")}</label>
        <label className="flex items-start gap-2"><input type="checkbox" checked={acknowledge} onChange={event=>setAcknowledge(event.target.checked)} />{t("execution.consent")}</label>
        <button type="submit" disabled={busy || !botId || !members.length || !acknowledge} className={button}>{t("execution.grant")}</button>
      </form>
      </details>
      <ul className="space-y-2">{status?.grants.map(grant=><li key={grant.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-inset p-2"><div className="min-w-0 break-words"><p>{grant.label} · {grant.account} · {grant.model}{!grant.enabled?` · ${t("execution.revoked")}`:""}</p><p className="text-xs text-ink-secondary">{grant.members.map(key=>`${sharing?.members.find(member=>member.publicKey===key)?.name ?? "—"} (${key.slice(-12,-1)})`).join(", ")} · {grant.approval?t("execution.approval"):t("execution.nativePermissions")}</p>{!grant.ready&&<p className="text-xs text-ink-secondary">{grant.reason}</p>}</div>{grant.enabled&&<button type="button" className={button} disabled={busy} onClick={()=>void act("revoke",{id:grant.id})}>{t("execution.revoke")}</button>}</li>)}</ul>
      <h3 className="font-medium text-ink">{t("execution.incoming")}</h3><ul className="space-y-2">{status?.incoming.slice().reverse().map(job=>displayJob(job,true))}</ul>
      <h3 className="font-medium text-ink">{t("execution.outgoing")}</h3><ul className="space-y-2">{status?.outgoing.slice().reverse().map(job=>displayJob(job,false))}</ul>
    </details>
  </section>;
}
