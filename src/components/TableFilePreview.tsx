import { TABLE_FILE_MAX_BYTES } from "@/lib/table-data";

/** Bound chunked responses too; this is a preview limit, not a download limit. */
export async function readTableResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > TABLE_FILE_MAX_BYTES) {
    await response.body?.cancel(); throw new Error("size");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, text = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > TABLE_FILE_MAX_BYTES) throw new Error("size");
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
