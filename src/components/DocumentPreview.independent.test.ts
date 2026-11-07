import { describe, expect, it } from 'vitest';
import { readDocumentPreviewResponse } from './DocumentPreview';
function stream(chunks: Uint8Array[]) {
  return new Response(new ReadableStream({start(c){for(const chunk of chunks)c.enqueue(chunk);c.close();}}));
}
describe('independent document preview byte boundaries',()=>{
  it('caps bytes even when a high-width prefix precedes an ASCII suffix',async()=>{
    const input=new TextEncoder().encode('😀'.repeat(1000)+'a'.repeat(1000));
    const result=await readDocumentPreviewResponse(stream([input]),new AbortController().signal,{maxBytes:500,maxLines:20000});
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(500);
    expect(result.truncatedBytes).toBe(true);
  });
  it('keeps a UTF-8 scalar split between network chunks intact',async()=>{
    const input=new TextEncoder().encode('A😀B');
    const result=await readDocumentPreviewResponse(stream([input.slice(0,3),input.slice(3)]),new AbortController().signal,{maxBytes:6,maxLines:20000});
    expect(result.text).toBe('A😀B');
    expect(result.truncatedBytes).toBe(false);
  });
  it('does not create replacement characters when the byte cap cuts a scalar',async()=>{
    const input=new TextEncoder().encode('a'.repeat(498)+'😀Z');
    const result=await readDocumentPreviewResponse(stream([input]),new AbortController().signal,{maxBytes:500,maxLines:20000});
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(500);
    expect(result.text).not.toContain('\uFFFD');
    expect(result.truncatedBytes).toBe(true);
  });
});
