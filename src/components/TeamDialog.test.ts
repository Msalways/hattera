// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const dispatch = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({
  useStore: () => ({ dispatch, state: { bots: [], groups: [], sections: [], botCreationPending: false } }),
  api,
}));
vi.mock("./lazy-screens", () => ({ NewBotDialog: () => null }));
vi.mock("./BotPickerList", () => ({ BotPickerList: () => null }));

const { TeamDialog } = await import("./TeamDialog");

let host: HTMLDivElement;
let root: Root;
let opener: HTMLButtonElement;
const onClose = vi.fn<() => void>();
const field = () => document.querySelector<HTMLInputElement>("input")!;
const submit = () => flushSync(() => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
const type = (value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
  flushSync(() => field().dispatchEvent(new Event("input", { bubbles: true })));
};
const blur = () => flushSync(() => field().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const buttons = () => [...document.querySelectorAll("button")].map((b) => b.textContent?.trim() || b.getAttribute("aria-label"));

beforeEach(() => {
  dispatch.mockReset();
  api.mockReset();
  onClose.mockReset();
  setLocale("en");
  opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(TeamDialog, { onClose })));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  opener.remove();
});

describe("Create team dialog", () => {
  it("uses the shared anatomy: labelled dialog, persistent label, close, Cancel and the primary action", () => {
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Create team");
    expect(document.querySelector(`label[for="${field().id}"]`)?.textContent).toBe("Team name");
    expect(buttons()).toEqual(expect.arrayContaining(["Close", "Cancel", "Create team"]));
    expect(document.activeElement).toBe(field());
  });

  it("starts neutral, then shows the error only after typing and leaving the field, or on submit", () => {
    expect(document.querySelector('[role="alert"]')).toBeNull();
    blur();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    type("x");
    type("");
    blur();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Enter a team name.");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().getAttribute("aria-describedby")).toBe(document.querySelector('[role="alert"]')!.id);
  });

  it("an invalid submit shows the error, focuses the field and sends nothing", () => {
    (document.querySelector("[aria-label='Close']") as HTMLElement).focus();
    submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Enter a team name.");
    expect(document.activeElement).toBe(field());
    expect(api).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and the entry on a server failure", async () => {
    api.mockRejectedValueOnce(new Error("Could not reach the server"));
    type("Design");
    submit();
    await expect.poll(() => document.querySelector('[role="alert"]')?.textContent).toBe("Could not reach the server");
    expect(field().value).toBe("Design");
    expect(onClose).not.toHaveBeenCalled();
    expect(field().disabled).toBe(false);
  });

  it("Escape and Cancel dismiss, and focus returns to the opener on unmount", () => {
    flushSync(() => document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(onClose).toHaveBeenCalledOnce();
    flushSync(() => root.unmount());
    expect(document.activeElement).toBe(opener);
    root = createRoot(host);
  });
});
