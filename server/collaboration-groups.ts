import { splitTranscriptAttachments } from "../src/lib/composer-attachments.ts";
import { splitTranscriptCitations } from "../src/lib/citations.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { collaborationJson, peerFingerprint } from "./collaboration-ledger.ts";
import type { CollaborationService } from "./collaboration-service.ts";
import type { Store, Message } from "./store.ts";

const publicLabel = (value: string) => value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ").trim().slice(0, 120) || "Member";

/** Projection into existing rooms. Incoming text is inert: never start a
 * bot turn, import native sessions, or resolve a peer's path on this machine. */
export class CollaborationGroups {
  private applying = false;
  private readonly unsubscribe: () => void;
  private readonly store: Store;
  private readonly service: CollaborationService;
  constructor(store: Store, service: CollaborationService) {
    this.store = store; this.service = service;
    this.unsubscribe = store.onChange(change => {
      if (this.applying) return;
      if (change.type === "message" || change.type === "message.patch") {
        const group = store.groupByThread(change.threadId);
        if (group?.sharedGroupId) this.exportMessage(group.sharedGroupId, change.threadId, change.message);
      }
      if (change.type === "group") {
        const group = store.group(change.groupId);
        if (group?.sharedGroupId) this.catalog(group.sharedGroupId);
      }
      if (change.type === "group.deleted") {
        const binding = service.status().find(value => value.localGroupId === change.groupId);
        if (binding) service.setEnabled(binding.groupId, false);
      }
      if (change.type === "bot" || change.type === "bot.deleted") {
        for (const group of store.groups) if (group.sharedGroupId) this.catalog(group.sharedGroupId);
      }
    });
  }
  recover() {
    for (const binding of this.service.status()) {
      const group = this.store.group(binding.localGroupId);
      // A locally deleted group stays deleted; no remote event recreates it.
      if (!group) { this.service.setEnabled(binding.groupId, false); continue; }
      if (!group.sharedGroupId) this.store.patchGroup(group.id, { sharedGroupId: binding.groupId });
      if (!binding.enabled || binding.joining || binding.blocked) continue;
      this.project(binding.groupId); this.catalog(binding.groupId);
      for (const task of group.tasks ?? []) for (const message of this.store.activePath(task.threadId)) this.exportMessage(binding.groupId, task.threadId, message);
    }
  }
  private catalog(groupId: string) {
    const status = this.service.status().find(value => value.groupId === groupId);
    if (!status?.enabled || status.joining || status.blocked) return;
    const group = this.store.group(status.localGroupId);
    if (!group) return;
    const bots = group.memberIds.flatMap(id => { const bot = this.store.bot(id); return bot ? [{ id: bot.id, name: publicLabel(bot.name), title: (bot.title ?? "").slice(0, 200), color: bot.color }] : []; }).slice(0, 100);
    const previous = this.service.ledger(groupId).events.findLast(event => event.origin === status.localPublicKey && event.payload.type === "bots.catalog");
    if (previous?.payload.type === "bots.catalog" && collaborationJson(previous.payload.bots) === collaborationJson(bots)) return;
    this.service.append(groupId, { type: "bots.catalog", bots });
  }
  private exportMessage(groupId: string, threadId: string, message: Message) {
    const status = this.service.status().find(value => value.groupId === groupId);
    if (!status?.enabled || status.joining || status.blocked || message.shared?.remote || message.kind !== "text" || !message.text || message.peerAsk || message.aside
      || message.at < this.service.exportsSince(groupId) || message.turnId && !message.turnTerminal) return;
    const group = this.store.group(status.localGroupId), task = group?.tasks?.find(value => value.threadId === threadId);
    if (!task || !this.store.activePath(threadId).some(value => value.id === message.id)) return;
    // Reuse the transcript parsers: omit file handles and quoted private
    // messages, rather than forwarding another machine's resource links.
    const cited = splitTranscriptCitations(message.text);
    const display = splitTranscriptAttachments(cited.display, false).display;
    // Unknown/older attachment markup is not a portable file reference.
    // Drop its whole line so even malformed attributes cannot leak a handle.
    const portable = display.split("\n").map(line => /<(?:attached-(?:file|image)|file|image)\b[^\n]*\bpath\s*=/i.test(line) ? "[Local attachment reference omitted]" : line).join("\n");
    const text = redactSecretsInText(portable).trim();
    if (!text || text.length > 64_000) return;
    const ledger = this.service.ledger(groupId);
    const previous = ledger.messages().find(event => event.origin === status.localPublicKey && event.payload.type === "message.upsert" && event.payload.messageId === message.id);
    if (previous?.payload.type === "message.upsert" && previous.payload.text === text) return;
    this.service.append(groupId, { type: "message.upsert", topicId: task.sharedTopicId ?? task.threadId, topicTitle: task.title.slice(0, 80),
      messageId: message.id, text, role: message.role === "bot" ? "bot" : "human", authorLabel: publicLabel(message.role === "bot" ? message.from?.name ?? "Bot" : message.sender?.name ?? ledger.localGrant()?.name ?? "Member") });
  }
  project(groupId: string) {
    if (this.applying) return;
    const binding = this.service.status().find(value => value.groupId === groupId);
    if (!binding) return;
    const group = this.store.group(binding.localGroupId);
    if (!group) return;
    const ledger = this.service.ledger(groupId);
    this.applying = true;
    try {
      for (const event of ledger.messages()) {
        const payload = event.payload;
        if (payload.type !== "message.upsert") continue;
        let task = group.tasks?.find(value => (value.sharedTopicId ?? value.threadId) === payload.topicId);
        if (!task) task = this.store.createGroupTask(group.id, payload.topicTitle, (group.tasks ?? []).every(value => this.store.messagesFor(value.threadId).length === 0), payload.topicId) ?? undefined;
        if (!task) continue;
        const local = event.origin === binding.localPublicKey;
        const before = this.store.messagesFor(task.threadId).find(message => message.shared?.origin === event.origin && message.shared.messageId === payload.messageId
          || local && message.id === payload.messageId);
        if (before?.shared?.eventId === event.id) continue;
        const shared = { groupId, eventId: event.id, origin: event.origin, messageId: payload.messageId, remote: !local, author: payload.authorLabel };
        if (before) {
          // Redaction applies to exported text; preserve the owner's original
          // private attachment display and local metadata on this machine.
          this.store.patchMessage(task.threadId, before.id, { shared, ...(!local ? { text: payload.text } : {}) });
        } else {
          this.store.appendMessage(task.threadId, { kind: "text", role: payload.role === "human" ? "user" : "bot", text: payload.text, shared, at: event.at,
            ...(payload.role === "bot" ? { from: { botId: `peer-${peerFingerprint(event.origin).slice(0, 24)}`, name: payload.authorLabel, color: "blue" } } : { sender: { name: payload.authorLabel }, relayed: true }) });
          this.store.patchGroup(group.id, { unread: true });
        }
      }
      const visible = new Set(ledger.messages().map(event => event.id));
      for (const task of group.tasks ?? []) for (const message of this.store.messagesFor(task.threadId)) {
        if (message.shared?.groupId === groupId && message.shared.remote && !visible.has(message.shared.eventId) && message.text !== "[Message outside the member's sharing grant]") {
          this.store.patchMessage(task.threadId, message.id, { text: "[Message outside the member's sharing grant]" });
        }
      }
    } finally { this.applying = false; }
    this.catalog(groupId);
  }
  close() { this.unsubscribe(); }
}
