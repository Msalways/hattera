// Exercise the real shared runtime through every registered API adapter.
import { afterEach, expect, it, vi } from "vitest";
import { GrokDriver } from "./grok.ts";
import { MinimaxDriver } from "./minimax.ts";
import { MistralDriver } from "./mistral.ts";
import { CerebrasDriver } from "./cerebras.ts";
import { GroqDriver } from "./groq.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { recordEvents } from "../testing/events.ts";
import { observedMetrics, clearObservedMetrics } from "../account-metrics.ts";

afterEach(() => { vi.unstubAllGlobals(); clearObservedMetrics(); });
const drivers = [GrokDriver, MinimaxDriver, MistralDriver, CerebrasDriver, GroqDriver, OpenAICompatDriver];
const environment = { XAI_API_KEY: "fixture", MINIMAX_API_KEY: "fixture", MISTRAL_API_KEY: "fixture", CEREBRAS_API_KEY: "fixture", GROQ_API_KEY: "fixture", OPENAI_COMPAT_API_KEY: "fixture" };

it.each(drivers)("$driverKind preserves cached input and the provider-reported price", async driver => {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => String(url).endsWith("/models") ? Response.json({ data: [] }) : new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"Fixture reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":90},"cost":0.004}}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  )));
  const instance = await driver.create({ instanceId: `cost-${driver.driverKind}`, displayName: "Usage fixture", enabled: true, environment, config: driver.defaultConfig() });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "known-price", text: "Hello" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ cost: 0.004 });
    expect(recorder.events.find(e => e.type === "thread.token-usage.updated")).toMatchObject({ input: 100, output: 5, cachedInput: 90 });
  } finally { recorder.stop(); await instance.dispose(); }
});

it.each(drivers)("$driverKind preserves partial usage and account-scoped headers", async driver => {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => String(url).endsWith("/models") ? Response.json({ data: [] }) : new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"Fixture reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":20}}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream", "x-ratelimit-limit-requests": "10", "x-ratelimit-remaining-requests": "0" } },
  )));
  const instance = await driver.create({ instanceId: `usage-${driver.driverKind}`, displayName: "Usage fixture", enabled: true, environment, config: driver.defaultConfig() });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "partial-usage", text: "Hello" });
    await recorder.until(event => event.type === "turn.completed");
    expect(recorder.events.find(e => e.type === "thread.token-usage.updated")).toMatchObject({ input: 20, output: 0, tokensReported: false });
    expect(observedMetrics(instance.instanceId)?.metrics[0]).toMatchObject({ remaining: 0, limit: 10 });
    expect(observedMetrics("another-account")).toBeUndefined();
  } finally { recorder.stop(); await instance.dispose(); }
});
