import { Wrench } from "lucide-react";
import { t } from "@/lib/i18n";

/** The turn's header: how many tools it used, and a way to the first one.
 * Rendered only for a turn that has tools, at the top of the turn above its
 * first row (the rows themselves stay in stream order below). Not a second
 * activity card: it carries a count and one jump, nothing else. */
export function TurnToolsHeader({ count }: { count: number }) {
  if (count < 1) return null;
  const jump = (event: React.MouseEvent<HTMLButtonElement>) => {
    // The first tool row after this header in document order is the turn's
    // first tool, wherever the wrappers between them fall.
    const header = event.currentTarget.closest("[data-turn-tools]");
    if (!header) return;
    const row = [...header.ownerDocument.querySelectorAll<HTMLElement>("[data-tool-row]")].find(
      (node) => header.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
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
