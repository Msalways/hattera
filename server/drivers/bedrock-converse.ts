// Bedrock's native Converse API, adapted to the existing chat/tool runtime.
// The runtime owns approvals, tool execution, cancellation and transcript replay.
import type { OpenAIChatMessage } from "./openai-chat.ts";

function content(value: OpenAIChatMessage["content"]): any[] {
  if (typeof value === "string") return value ? [{ text: value }] : [];
  return (value ?? []).map((part) => {
    if (part.type === "text") return { text: part.text };
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(part.image_url.url);
    if (!match) throw new Error("Bedrock images must be embedded PNG, JPEG, WebP or GIF data.");
    return { image: { format: match[1], source: { bytes: match[2] } } };
  });
}

export function bedrockConverseBody(body: Record<string, any>): Record<string, unknown> {
  const system: any[] = [];
  const messages: Array<{ role: string; content: any[] }> = [];
  for (const message of body.messages as OpenAIChatMessage[]) {
    if (message.role === "system") { system.push(...content(message.content)); continue; }
    const role = message.role === "assistant" ? "assistant" : "user";
    const parts = message.role === "tool"
      ? [{ toolResult: { toolUseId: message.tool_call_id, content: content(message.content) } }]
      : [...content(message.content), ...(message.tool_calls ?? []).map(call => ({ toolUse: {
        toolUseId: call.id, name: call.function.name, input: JSON.parse(call.function.arguments),
      } }))];
    if (!parts.length) continue;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...parts);
    else messages.push({ role, content: parts });
  }
  return { messages, ...(system.length ? { system } : {}),
    ...(body.tools?.length ? { toolConfig: { tools: body.tools.map((tool: any) => ({ toolSpec: {
      name: tool.function.name, description: tool.function.description || tool.function.name,
      inputSchema: { json: tool.function.parameters },
    } })) } } : {}),
  };
}

/** Uses only the key and endpoint passed by this instance; redirects never carry credentials. */
export const bedrockConverseFetch: typeof fetch = async (address, options) => {
  const url = new URL(String(address));
  const body = JSON.parse(String(options?.body));
  url.pathname = `/model/${encodeURIComponent(body.model)}/converse`;
  const response = await fetch(url, { ...options, body: JSON.stringify(bedrockConverseBody(body)), redirect: "error" });
  const json = await response.json() as { message?: unknown; output?: { message?: { content?: unknown } };
    stopReason?: string; usage?: { inputTokens?: number; outputTokens?: number } };
  if (!response.ok) return Response.json({ error: { message: typeof json.message === "string" ? json.message : "Bedrock rejected the request." } }, { status: response.status });
  const blocks = json.output?.message?.content;
  if (!Array.isArray(blocks)) throw new Error("Bedrock returned no conversation message.");
  const calls = blocks.filter(block => block.toolUse).map(block => ({ id: block.toolUse.toolUseId, type: "function",
    function: { name: block.toolUse.name, arguments: JSON.stringify(block.toolUse.input) } }));
  return Response.json({ choices: [{ index: 0,
    message: { role: "assistant", content: blocks.map(block => block.text ?? "").join(""), ...(calls.length ? { tool_calls: calls } : {}) },
    finish_reason: json.stopReason === "tool_use" ? "tool_calls" : json.stopReason === "max_tokens" ? "length" : "stop",
  }], usage: { prompt_tokens: json.usage?.inputTokens ?? 0, completion_tokens: json.usage?.outputTokens ?? 0 } });
};
