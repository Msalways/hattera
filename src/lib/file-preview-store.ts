// The one preview surface's state: which file is open, and the control that
// opened it so focus can go back. Outside React state on purpose: a chip deep
// in a message opens the surface without prop-drilling or re-rendering the list.
import { useSyncExternalStore } from "react";
import type { PreviewFile } from "./file-preview";

export interface OpenPreview {
  file: PreviewFile;
  /** Bumps on every open, so reopening the same file starts a fresh load. */
  nonce: number;
}

let current: OpenPreview | null = null;
let trigger: HTMLElement | null = null;
let nonce = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function openFilePreview(file: PreviewFile, from?: HTMLElement | null): void {
  trigger = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  current = { file, nonce: ++nonce };
  emit();
}

export function closeFilePreview(): HTMLElement | null {
  const back = trigger;
  current = null;
  trigger = null;
  emit();
  return back;
}

export function currentFilePreview(): OpenPreview | null {
  return current;
}

export function useFilePreview(): OpenPreview | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    currentFilePreview,
    () => null,
  );
}

/** Test seam. */
export function resetFilePreview(): void {
  current = null; trigger = null; emit();
}
