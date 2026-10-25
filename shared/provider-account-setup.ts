/** Built-in account forms. No browser-supplied command or environment name is executed. */
export type ProviderAccountForm = "key" | "model" | "bedrock";

export const PROVIDER_KEY_ENV: Readonly<Record<string, string>> = {
  cursorAgent: "CURSOR_API_KEY", droidAgent: "FACTORY_API_KEY", geminiAgent: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY", minimax: "MINIMAX_API_KEY", cerebras: "CEREBRAS_API_KEY", groq: "GROQ_API_KEY", grok: "XAI_API_KEY",
};

export function providerAccountForm(driverKind: string, instanceId: string, setup?: { form?: ProviderAccountForm }): ProviderAccountForm | null {
  if (setup?.form) return setup.form;
  if (driverKind === "openai-compat" && instanceId === "bedrock") return "bedrock";
  if (["cursorAgent", "droidAgent", "geminiAgent"].includes(driverKind)) return "key";
  if (["qwenAgent", "piAgent", "hermesAgent", "clineAgent"].includes(driverKind)) return "model";
  return null;
}
