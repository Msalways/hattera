// For tests that render the panel to static markup (effects never run there):
// seed the answer the server would give for a config and a bot, using the same
// reasons as server/turn-capabilities.ts.
import { seedBotCapabilities, type BotCapabilities, type BrowserReason } from "./bot-capabilities";

export function seedCapabilitiesFor(
  bot: { id: string; threadId?: string; browser?: boolean },
  config: { features?: { browser?: boolean }; browserEngine?: { kind?: string } } | undefined,
  overrides: Partial<{ engineSupports: boolean; shell: boolean; control: boolean }> = {},
): BotCapabilities {
  const reason: BrowserReason = config?.features?.browser !== true ? "workspace-off"
    : bot.browser === false ? "bot-off"
      : overrides.engineSupports === false ? "engine-unsupported"
        : config?.browserEngine?.kind !== "engine" ? "not-installed" : "ready";
  const value: BotCapabilities = {
    browser: { mounts: reason === "ready", reason, available: reason === "ready", availableReason: reason, message: reason,
      switches: { workspaceOn: config?.features?.browser === true, botOn: bot.browser !== false, engineSupports: overrides.engineSupports !== false, engineInstalled: config?.browserEngine?.kind === "engine" } },
    thisPc: { control: { ready: overrides.control === true }, shell: { available: overrides.shell === true } },
  };
  seedBotCapabilities(bot.id, bot.threadId, value);
  return value;
}
