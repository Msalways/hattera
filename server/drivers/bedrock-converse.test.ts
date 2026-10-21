import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { bedrockConverseBody, bedrockConverseFetch } from "./bedrock-converse.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { recordEvents } from "../testing/events.ts";

afterEach(() => vi.unstubAllEnvs());

it("preserves systems, images, tool calls and tool results in the native Converse protocol", () => {
  const body = bedrockConverseBody({ messages: [
    { role: "system", content: "fixture system" },
    { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"test.txt"}' } }] },
    { role: "tool", tool_call_id: "call-1", content: "fixture file" },
  ], tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } }] });
  expect(body).toMatchObject({ system: [{ text: "fixture system" }], messages: [
    { role: "user", content: [{ text: "Look" }, { image: { format: "png", source: { bytes: "aGVsbG8=" } } }] },
    { role: "assistant", content: [{ toolUse: { toolUseId: "call-1", name: "read_file", input: { path: "test.txt" } } }] },
    { role: "user", content: [{ toolResult: { toolUseId: "call-1", content: [{ text: "fixture file" }] } }] },
  ] });
});

it("routes a real chat turn through Bedrock Converse without model discovery or another provider's key", async () => {
  const requests: Array<{ path: string; key: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push({ path: req.url!, key: String(req.headers.authorization), body: JSON.parse(text) });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ output: { message: { role: "assistant", content: [{ text: "Bedrock fixture reply" }] } }, stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 4 } }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  vi.stubEnv("OPENAI_COMPAT_API_KEY", "foreign-key-must-not-leak");
  const instance = await OpenAICompatDriver.create({ instanceId: "bedrock", displayName: "Amazon Bedrock", enabled: true, environment: {},
    config: OpenAICompatDriver.decodeConfig({ url: `http://127.0.0.1:${address.port}`, apiKeyEnv: "OMB_BEDROCK_API_KEY", catalog: "bedrock", model: "us.anthropic.fixture-v1:0", key: "bedrock-fixture-key", tools: false }),
  });
  const events = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "bedrock-chat", text: "Hello", model: "us.anthropic.fixture-v1:0" });
    expect(await events.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(events.events.some(event => event.type === "item.completed" && event.itemType === "assistant_text" && event.text === "Bedrock fixture reply")).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ path: "/model/us.anthropic.fixture-v1%3A0/converse", key: "Bearer bedrock-fixture-key" });
    expect(JSON.stringify(requests)).not.toContain("foreign-key");
    expect(instance.models.options.map(model => model.id)).toEqual(["us.anthropic.fixture-v1:0"]);
  } finally { events.stop(); await instance.dispose(); await new Promise<void>(done => server.close(() => done())); }
});

it("honors cancellation before sending a provider request", async () => {
  const response = await bedrockConverseFetch("https://bedrock-runtime.us-east-1.amazonaws.com/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "Hello" }] }), signal: AbortSignal.abort(),
  }).catch(error => error);
  expect(response).toBeInstanceOf(Error);
});

it("round-trips a native Bedrock tool request through the app's question approval", async () => {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    bodies.push(JSON.parse(text));
    res.setHeader("content-type", "application/json");
    const first = bodies.length === 1;
    res.end(JSON.stringify({ output: { message: { role: "assistant", content: first
      ? [{ toolUse: { toolUseId: "ask-bedrock", name: "ask_user", input: { questions: [{ question: "Use this route?", options: [{ label: "Yes" }, { label: "No" }] }] } } }]
      : [{ text: "Bedrock tool finished" }] } }, stopReason: first ? "tool_use" : "end_turn" }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const instance = await OpenAICompatDriver.create({ instanceId: "bedrock", displayName: "Bedrock", enabled: true, environment: {},
    config: OpenAICompatDriver.decodeConfig({ url: `http://127.0.0.1:${address.port}`, apiKeyEnv: "OMB_BEDROCK_API_KEY", catalog: "bedrock", model: "fixture", key: "fixture-only" }),
  });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "bedrock-tool", text: "Ask first", model: "fixture" });
    const question = await recorder.until(event => event.type === "request.opened");
    expect(question).toMatchObject({ requestType: "question", tool: "ask_user", choices: ["Yes", "No"] });
    expect(bodies[0].toolConfig.tools.some((tool: any) => tool.toolSpec.name === "ask_user")).toBe(true);
    await instance.adapter.respondToRequest("bedrock-tool", question.requestId!, { behavior: "answer", message: "Yes, use this route." });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(bodies).toHaveLength(2);
    const result = bodies[1].messages.at(-1).content[0].toolResult;
    expect(result.toolUseId).toBe("ask-bedrock");
    expect(result.content[0].text).toContain("Yes, use this route.");
  } finally { recorder.stop(); await instance.dispose(); await new Promise<void>(done => server.close(() => done())); }
}, 20_000);
