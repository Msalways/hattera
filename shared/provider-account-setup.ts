/** Built-in account forms. No browser-supplied command or environment name is executed. */
export type ProviderAccountForm = "key" | "model" | "bedrock";

export function providerAccountForm(driverKind: string, instanceId: string): ProviderAccountForm | null {
  if (driverKind === "openai-compat" && instanceId === "bedrock") return "bedrock";
  if (["cursorAgent", "droidAgent", "geminiAgent"].includes(driverKind)) return "key";
  if (["qwenAgent", "piAgent", "hermesAgent", "clineAgent"].includes(driverKind)) return "model";
  return null;
}
