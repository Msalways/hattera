import { z } from "zod";
import { isEffortLevel, type EffortLevel, type ModelSelection } from "../shared/wire.ts";

/** Explicit requested route, never a fallback or a change to the recipient's defaults. */
export const delegatedSelectionSchema = z.object({
  instanceId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  effort: z.custom<EffortLevel>(isEffortLevel).optional(),
}).strict().readonly();
export type DelegatedSelection = z.infer<typeof delegatedSelectionSchema>;

export interface DelegatedSelectionContext {
  authorized: readonly Pick<ModelSelection, "instanceId" | "model">[];
  engines: readonly {
    instanceId: string;
    ready: boolean;
    models: readonly string[];
    effortLevels: readonly EffortLevel[];
  }[];
  approvalPending: boolean;
  approvalCompatible(selection: DelegatedSelection): boolean;
}

/** Call with fresh recipient/configuration inputs at acceptance AND dispatch.
 * Caller retains responsibility for role, reachability and peer approval gates.
 * Undefined preserves legacy selection resolution; explicit failures never do. */
export function validateDelegatedSelection(raw: unknown, context: DelegatedSelectionContext): DelegatedSelection | undefined {
  if (raw === undefined) return undefined;
  const selection = delegatedSelectionSchema.parse(raw);
  if (!context.authorized.some(s => s.instanceId === selection.instanceId && s.model === selection.model)) {
    throw new Error("Delegated model has not been authorized in configured choices");
  }
  const engine = context.engines.find(e => e.instanceId === selection.instanceId);
  if (!engine?.ready) throw new Error("Delegated engine is not ready");
  if (!engine.models.includes(selection.model)) throw new Error("Delegated model is not currently offered");
  if (selection.effort !== undefined && !engine.effortLevels.includes(selection.effort)) {
    throw new Error("Delegated effort is not offered by the engine");
  }
  if (context.approvalPending) throw new Error("Recipient approval level is still pending confirmation");
  if (!context.approvalCompatible(selection)) throw new Error("Delegated selection is incompatible with recipient permissions");
  return selection;
}

/** Stable identity independent of input object key order, including omitted effort. */
export function delegatedSelectionKey(selection: DelegatedSelection | undefined): string {
  return selection === undefined ? "legacy" : JSON.stringify([selection.instanceId, selection.model, selection.effort ?? null]);
}
