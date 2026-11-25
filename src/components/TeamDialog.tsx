import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { BotPickerList } from "./BotPickerList";
import { NewBotDialog } from "./lazy-screens";
import { t } from "@/lib/i18n";
import { DialogField, SharedDialog, dialogControlClass } from "./SharedDialog";

/** A team may start empty; choosing bots moves their membership, never copies them. */
export function TeamDialog({ section, rename = false, onClose, onRenamed }: {
  section?: string;
  rename?: boolean;
  onRenamed?: (oldName: string, newName: string) => void;
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(section ?? "");
  const managing = Boolean(section) && !rename;
  const initialMembers = useRef(new Set(managing ? state.bots.filter(bot => !bot.hidden && (bot.section?.trim() ?? "") === section).map(bot => bot.id) : []));
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initialMembers.current));
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // No error until the field was blurred after typing, or a submit was tried.
  const [edited, setEdited] = useState(false);
  const [blurred, setBlurred] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const moving = section !== undefined && !rename;
  const title = rename ? t("team.rename") : managing ? t(initialMembers.current.size ? "team.manageBots" : "team.addBots") : moving ? t("team.moveTo", { name: section || "General" }) : t("team.create");
  const candidates = state.bots.filter((bot) => !bot.hidden && (managing || !moving || (bot.section?.trim() ?? "") !== section));
  const addBotIds = [...picked].filter(id => !initialMembers.current.has(id));
  const removeBotIds = [...initialMembers.current].filter(id => !picked.has(id));
  const unchanged = managing ? !addBotIds.length && !removeBotIds.length : moving && !picked.size;
  const needsName = !moving || rename;
  const nameError = needsName && !name.trim() && (submitted || (edited && blurred)) ? t("team.nameRequired") : null;
  const save = async () => {
    if (saving || unchanged) return;
    if (needsName && !name.trim()) {
      setSubmitted(true);
      nameInput.current?.focus();
      return;
    }
    if (section === undefined && [...(state.sections ?? []), ...state.bots.map((bot) => bot.section), ...state.groups.map((group) => group.section)].includes(name.trim())) {
      setError(t("team.duplicate"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result: { sections: string[]; bots?: Bot[] } = await api(
        rename || managing ? `/api/sidebar-sections?section=${encodeURIComponent(section!)}` : "/api/sidebar-sections",
        { method: rename ? "PATCH" : managing ? "PUT" : "POST", body: JSON.stringify(rename ? { name: name.trim() } : managing ? { addBotIds, removeBotIds } : { name: name.trim(), botIds: [...picked] }) },
      );
      dispatch({ type: "sections", sections: result.sections });
      for (const bot of result.bots ?? []) dispatch({ type: "botPatched", bot });
      if (rename && section !== undefined) onRenamed?.(section, name.trim());
      onCloseRef.current();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };
  if (creating) return createPortal(<NewBotDialog section={section} preserveSelection onClose={() => setCreating(false)} onCreated={(bot) => {
    initialMembers.current.add(bot.id);
    setPicked(previous => new Set([...previous, bot.id]));
  }} />, document.body);
  const primaryLabel = saving ? t("team.saving") : rename ? t("folder.saveName") : managing ? t("common.save") : moving ? picked.size ? t(picked.size === 1 ? "team.moveOne" : "team.moveMany", { count: picked.size }) : t("team.moveSelected") : t("team.create");
  return (
    <SharedDialog title={title} busy={saving} onClose={onClose} onSubmit={() => void save()} initialFocus={needsName ? nameInput : undefined}
      primary={{ label: primaryLabel, disabled: unchanged }} testId="team-dialog">
      {needsName && <DialogField label={t("team.name")} error={nameError}>
        {(field) => <input {...field} ref={nameInput} value={name} maxLength={60} disabled={saving} autoComplete="off"
          onChange={(event) => { setName(event.target.value); setEdited(true); }}
          onBlur={() => setBlurred(true)}
          className={dialogControlClass(Boolean(nameError))} />}
      </DialogField>}
      {!rename && <>
        <p className="mb-3 text-[13px] leading-relaxed text-ink-secondary">
          {managing ? t("team.manageIntro") : moving ? t("team.moveIntro") : t("team.createIntro")} {t("team.moveWarning")}
        </p>
        {managing && <button type="button" disabled={saving || state.botCreationPending} onClick={() => setCreating(true)}
          className="mb-3 flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] text-accent hover:bg-raised disabled:opacity-40 sm:min-h-9">
          <Plus size={14} />{t("sidebar.newBot")}
        </button>}
        <fieldset disabled={saving}>
          <legend className="mb-1 text-[12px] font-medium text-ink-secondary">{t("team.existingBots")}</legend>
          <BotPickerList bots={candidates} picked={picked} emptyHint={t("team.noBots")} onToggle={(id) => setPicked((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          })} />
        </fieldset>
      </>}
      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
    </SharedDialog>
  );
}
