import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi, afterEach } from "vitest";
import { StoreProvider, type InstanceInfo } from "@/state/store";
import { EngineRuntimeRemoval } from "./EngineRuntimeRemoval";

afterEach(() => vi.unstubAllGlobals());
const instance: InstanceInfo = { instanceId: "pi", displayName: "Pi", driverKind: "piAgent", models: { default: "", options: [] }, snapshot: { state: "available" },
  runtimeRemoval: { key: "pi", managed: true, removed: false, restoreAvailable: false, accounts: 1 } };
function render(row: InstanceInfo) {
  vi.stubGlobal("window", {});
  return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineRuntimeRemoval, { instance: row })));
}
it("offers uninstall for owned software and disable for external/bundled software", () => {
  expect(render(instance)).toContain("Uninstall engine");
  const external = render({ ...instance, runtimeRemoval: { ...instance.runtimeRemoval!, managed: false } });
  expect(external).toContain("Disable engine"); expect(external).not.toContain("Uninstall engine");
  expect(render({ ...instance, snapshot: { state: "unavailable" }, runtimeRemoval: { ...instance.runtimeRemoval!, managed: false, restoreAvailable: true } })).toContain("Disable engine");
});
it("explains preservation after removal and makes fallback an explicit action", () => {
  const removed = { ...instance, snapshot: { state: "unavailable" as const }, runtimeRemoval: { ...instance.runtimeRemoval!, managed: false, removed: true, restoreAvailable: true } };
  expect(render(removed)).toContain("account settings are kept");
  expect(render(removed)).toContain("Enable existing server installation");
  expect(render(removed)).not.toContain("Uninstall engine");
});
it("keeps removal out of managed accounts and API-only providers", () => {
  expect(render({ ...instance, readOnly: true })).toBe("");
  expect(render({ ...instance, runtimeRemoval: undefined })).toBe("");
});
