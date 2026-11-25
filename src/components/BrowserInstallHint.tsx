import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { CopyableValue } from "./CopyableValue";

/** The real command, shown only in Advanced mode: a code element of its own
 * (never literal backticks inside a sentence) with a copy action. */
export const BROWSER_INSTALL_COMMAND = "hattera browser install";

export function BrowserInstallHint({ className }: { className?: string }) {
  const advanced = useAdvancedMode();
  if (!advanced) return null;
  return (
    <p className={className ?? "mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-secondary"}>
      <span>{t("browser.installCommandLead")}</span>
      <CopyableValue value={BROWSER_INSTALL_COMMAND} copyLabel={t("browser.installCommandCopy")} />
    </p>
  );
}
