import { Wrench } from "lucide-react";
import { t } from "@/lib/i18n";

/** The turn's header: how many tools it used, and a way to the first one.
 * Rendered only for a turn that has tools, directly above its first tool row,
 * in the same wrapper (the rows themselves stay in stream order below). Not a second activity
 * card: it carries a count and one jump, nothing else. */
export function TurnToolsHeader({ count }: { count: number }) {
  if (count < 1) return null;
  const jump = (event: React.MouseEvent<HTMLButtonElement>) => {
    const row = event.currentTarget.closest("[data-turn-tools]")?.parentElement?.querySelector<HTMLElement>("[data-tool-row]");
    if (!row) return;
    const target = row.querySelector<HTMLElement>("summary, button") ?? row;
    target.scrollIntoView({ block: "nearest" });
    target.focus();
  };
  return (
    <div data-turn-tools className="flex justify-start">
      <button
        type="button"
        onClick={jump}
        className="flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[12px] text-ink-secondary hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <Wrench size={12} aria-hidden="true" />
        <span>{t(count === 1 ? "toolRow.toolCountOne" : "toolRow.toolCount", { count })}</span>
      </button>
    </div>
  );
}
