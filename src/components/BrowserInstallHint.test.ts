// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { setAdvancedMode } from "@/lib/interface-mode";
import { BROWSER_INSTALL_COMMAND, BrowserInstallHint } from "./BrowserInstallHint";

let host: HTMLDivElement;
let root: Root;
const draw = () => flushSync(() => root.render(createElement(BrowserInstallHint)));

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  setAdvancedMode(false);
});

describe("browser install hint (A-18)", () => {
  it("is hidden entirely when Advanced is off", () => {
    setAdvancedMode(false);
    draw();
    expect(host.textContent).toBe("");
    expect(host.querySelector("code")).toBeNull();
  });

  it("shows the lead-in, the command in its own code element and a copy action when Advanced is on", () => {
    setAdvancedMode(true);
    draw();
    expect(host.textContent).toContain("On the computer running Hattera, run");
    const code = host.querySelector("code");
    expect(code?.textContent).toBe(BROWSER_INSTALL_COMMAND);
    expect(BROWSER_INSTALL_COMMAND).toBe("hattera browser install");
    // no literal backticks in any visible text
    expect(host.textContent).not.toContain("`");
    expect(host.querySelector('button[aria-label="Copy command"]')).not.toBeNull();
  });
});
