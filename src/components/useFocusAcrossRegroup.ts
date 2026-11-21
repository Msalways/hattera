// Keyboard focus across a regroup of tool rows.
//
// When a call finishes, the transcript replaces its individual rows with a
// freshly mounted run (consecutive Reads become one "Read N files" group). The
// row that held focus is unmounted and the browser drops focus to the page. The
// owner of the whole transcript remembers which message row focus was in and,
// once that element is gone and focus is on the page body, hands it to the
// control that now stands for the row: the group's toggle, or the same message's
// own summary. Focus the reader moved elsewhere is never taken back.
import { useCallback, useEffect, useLayoutEffect, useRef, type FocusEvent, type RefObject } from "react";

type Held = { element: HTMLElement; messageId: string | undefined };

function restore(container: HTMLElement, held: Held): HTMLElement | null {
  if (held.element.isConnected || !held.messageId) return null;
  const active = document.activeElement;
  if (active && active !== document.body) return null;
  const rows = [...container.querySelectorAll<HTMLElement>("[data-mid]")];
  const own = rows.find((node) => node.dataset.mid === held.messageId)?.querySelector<HTMLElement>("summary, button, [tabindex]");
  const group = [...container.querySelectorAll<HTMLElement>("[data-group-id]")]
    .find((node) => (node.dataset.groupMembers ?? "").split(" ").includes(held.messageId!))
    ?.querySelector<HTMLElement>("[data-group-toggle]");
  const target = own ?? group ?? null;
  target?.focus();
  return target;
}

export function useFocusAcrossRegroup(container: RefObject<HTMLElement | null>) {
  const held = useRef<Held | null>(null);
  const settle = useCallback(() => {
    const root = container.current;
    const current = held.current;
    if (!root || !current) return;
    if (current.element.isConnected) return;
    const next = restore(root, current);
    held.current = next ? { element: next, messageId: current.messageId } : null;
  }, [container]);
  useLayoutEffect(settle);
  useEffect(() => {
    const root = container.current;
    if (!root || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(settle);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [container, settle]);
  const onFocusCapture = useCallback((event: FocusEvent<HTMLElement>) => {
    const element = event.target as HTMLElement;
    const row = element.closest<HTMLElement>("[data-mid]");
    const group = element.closest<HTMLElement>("[data-group-id]");
    held.current = { element, messageId: row?.dataset.mid ?? (group?.dataset.groupMembers ?? "").split(" ")[0] ?? undefined };
    if (!held.current.messageId) held.current = null;
  }, []);
  // A blur because the row was removed keeps the memory; a blur while the
  // element is still mounted means the reader moved on, so forget it.
  const onBlurCapture = useCallback((event: FocusEvent<HTMLElement>) => {
    const element = event.target as HTMLElement;
    queueMicrotask(() => {
      if (held.current?.element === element && element.isConnected) held.current = null;
    });
  }, []);
  return { onFocusCapture, onBlurCapture };
}
