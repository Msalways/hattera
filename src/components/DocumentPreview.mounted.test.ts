// @vitest-environment happy-dom
// Only fetch and unsupported native dialog methods are substituted. This does
// not establish browser focus containment, inertness, or 360px geometry.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentPreviewButton } from './DocumentPreview';

let root: Root;
let host: HTMLDivElement;
const network = vi.fn<typeof fetch>();
const message = { threadId: 'fixture-thread', messageId: 'fixture-message' };
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 20)); }); };
const render = (path = 'plan.md') => act(() => root.render(createElement(DocumentPreviewButton, { path, name: path, message })));
const click = (button: Element) => act(() => (button as HTMLButtonElement).click());
const open = () => click(host.querySelector('button')!);
const close = () => click(document.querySelector('dialog header button')!);
const deferred = () => {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>(r => { resolve = r; });
  return { promise, resolve };
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', network);
  network.mockReset();
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () { this.open = true; });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function () { this.open = false; });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('mounted document preview', () => {
  it('activates readable portable Markdown without save/download or remote resource requests', async () => {
    network.mockResolvedValue(new Response('# Delivery plan\n\nReadable next steps.\n\n![remote](https://invalid.example/tracker.png)'));
    await render(); await open();
    await vi.waitFor(async () => { await settle(); expect(document.querySelector('dialog .chat-md')?.textContent).toContain('Delivery plan'); }, { timeout: 10000 });
    expect(document.querySelector('dialog')?.textContent).toContain('Readable next steps.');
    expect(document.querySelector('dialog img, dialog a[download]')).toBeNull();
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0]![0]).toBe('/api/threads/fixture-thread/messages/fixture-message/file');
    expect(JSON.parse(network.mock.calls[0]![1]!.body as string)).toEqual({ path: 'plan.md' });
    expect(document.querySelectorAll('dialog button')).toHaveLength(1);
  });
  it('aborts deferred fetch on close and ignores its response after reopen', async () => {
    const old = deferred(); network.mockReturnValueOnce(old.promise).mockResolvedValue(new Response('Fresh plan'));
    await render('plan.txt'); await open();
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
    const signal = network.mock.calls[0]![1]!.signal!;
    await close(); expect(signal.aborted).toBe(true); expect(document.querySelector('dialog')).toBeNull();
    await open(); await vi.waitFor(async () => { await settle(); expect(document.querySelector('dialog pre')?.textContent).toBe('Fresh plan'); });
    old.resolve(new Response('STALE SECRET')); await settle();
    expect(document.body.textContent).not.toContain('STALE SECRET');
    expect(document.querySelector('dialog pre')?.textContent).toBe('Fresh plan');
  });
  it('isolates ignored-abort responses when switching documents while open', async () => {
    const old = deferred(); network.mockReturnValueOnce(old.promise).mockResolvedValue(new Response('Second document'));
    await render('first.txt'); await await open(); await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
    const signal = network.mock.calls[0]![1]!.signal!;
    await render('second.txt'); expect(signal.aborted).toBe(true);
    await vi.waitFor(async () => { await settle(); expect(document.querySelector('dialog pre')?.textContent).toBe('Second document'); });
    old.resolve(new Response('OLD DOCUMENT')); await settle(); expect(document.body.textContent).not.toContain('OLD DOCUMENT');
  });
  it.each([403, 404])('shows %s failure and retries through the real effect', async status => {
    network.mockResolvedValueOnce(new Response(JSON.stringify({ error: `Fixture failure ${status}` }), { status })).mockResolvedValue(new Response('Recovered plan'));
    await render('plan.txt'); await open();
    await vi.waitFor(async () => { await settle(); expect(document.querySelector('[role=alert]')?.textContent).toBe(`Fixture failure ${status}`); });
    const buttons = document.querySelectorAll('dialog button'); await click(buttons[buttons.length - 1]!);
    await vi.waitFor(async () => { await settle(); expect(document.querySelector('dialog pre')?.textContent).toBe('Recovered plan'); });
    expect(network).toHaveBeenCalledTimes(2); expect(document.querySelector('[role=alert]')).toBeNull();
  });
});


