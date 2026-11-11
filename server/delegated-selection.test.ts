import { expect, it } from "vitest";
import { validateDelegatedSelection, type DelegatedSelectionContext } from "./delegated-selection.ts";

const requested = { instanceId: "account-opaque-97", model: "family/arbitrary-42", effort: "high" as const };
const context = (): DelegatedSelectionContext => ({
  authorized: [requested],
  engines: [{instanceId: requested.instanceId, ready: true, models: [requested.model], effortLevels: ["high"]}],
  approvalPending: false, approvalCompatible: () => true,
});

it("keeps absent selection legacy and returns an immutable independent explicit selection", () => {
  expect(validateDelegatedSelection(undefined, {...context(), authorized: [], approvalPending: true})).toBeUndefined();
  const input = {...requested};
  const selection = validateDelegatedSelection(input, context());
  expect(selection).toEqual(input);
  expect(selection).not.toBe(input);
  expect(Object.isFrozen(selection)).toBe(true);
  input.model = "changed-after-validation";
  expect(selection?.model).toBe(requested.model);
});

it.each([null, {}, {instanceId: "", model: "x"}, {...requested, effort: "invented"},
  {...requested, model: 42}, {...requested, variant: "unsupported-field"}])("rejects malformed explicit selection %j", raw => {
  expect(() => validateDelegatedSelection(raw, context())).toThrow();
});

it.each([
  ["unconfigured", (c: DelegatedSelectionContext) => { c.authorized = []; }, /authorized/],
  ["not-ready", (c: DelegatedSelectionContext) => { c.engines = [{...c.engines[0]!, ready: false}]; }, /not ready/],
  ["not-offered", (c: DelegatedSelectionContext) => { c.engines = [{...c.engines[0]!, models: []}]; }, /not currently offered/],
  ["effort", (c: DelegatedSelectionContext) => { c.engines = [{...c.engines[0]!, effortLevels: []}]; }, /effort/],
  ["pending", (c: DelegatedSelectionContext) => { c.approvalPending = true; }, /pending/],
  ["incompatible", (c: DelegatedSelectionContext) => { c.approvalCompatible = () => false; }, /incompatible/],
] as const)("rejects %s against current inputs without fallback", (_name, change, error) => {
  const current = context();
  expect(validateDelegatedSelection(requested, current)).toEqual(requested);
  change(current);
  expect(() => validateDelegatedSelection(requested, current)).toThrow(error);
});

it("omitted effort remains omitted instead of acquiring a default", () => {
  expect(validateDelegatedSelection({instanceId: requested.instanceId, model: requested.model}, context())).not.toHaveProperty("effort");
});
