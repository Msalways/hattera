import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { waitForExit } from "../../server/testing/cleanup.ts";

const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
type CdpPage = {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  evaluate(expression: string): Promise<any>;
  wait(check: () => Promise<any>, label: string, timeout?: number): Promise<any>;
  click(selector: string): Promise<any>;
  fill(selector: string, value: string): Promise<void>;
  button(label: string, within?: string): Promise<any>;
  screenshot(file: string): Promise<void>;
  close(): void;
};

/** A fresh browser/profile owned by an isolated fixture, never an existing
 * CDP listener or the person's signed-in browser. No automation dependency. */
export async function launchCdpBrowser(executable: string, directory: string) {
  await mkdir(directory, { recursive: true });
  // A closed fixture profile retains yesterday's ephemeral port. Wait for the
  // new browser's file, while keeping its saved cookies for reload checks.
  await rm(join(directory, "DevToolsActivePort"), { force: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? dirname(process.execPath), HOME: directory, USERPROFILE: directory,
    APPDATA: join(directory, "AppData/Roaming"), LOCALAPPDATA: join(directory, "AppData/Local"), TEMP: join(directory, "tmp"), TMP: join(directory, "tmp") };
  for (const path of [env.APPDATA!, env.LOCALAPPDATA!, env.TEMP!]) await mkdir(path, { recursive: true });
  for (const [key, value] of Object.entries(process.env)) if (["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "LANG", "LC_ALL", "TZ"].includes(key.toUpperCase())) env[key] = value;
  const child = spawn(executable, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${directory}`, "about:blank"], { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let error: Error | undefined, diagnostics = "";
  child.on("error", value => { error = value; });
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
  const pages: CdpPage[] = [];
  try {
    let port;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (error || child.exitCode !== null || child.signalCode !== null) throw error ?? new Error(`Fixture browser exited: ${diagnostics}`);
      try { port = Number((await readFile(join(directory, "DevToolsActivePort"), "utf8")).split("\n")[0]); if (port) break; } catch {}
      await pause(100);
    }
    if (!port) throw new Error(`The fixture browser did not open its private CDP listener. ${diagnostics}`);
    const page = async () => {
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5000) })).json() as { webSocketDebuggerUrl: string };
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
      let sequence = 0; const pending = new Map<number, { timer: ReturnType<typeof setTimeout>; resolve(value: any): void; reject(error: Error): void }>();
      socket.onmessage = ({ data }) => {
        const reply = JSON.parse(data); const item = pending.get(reply.id); if (!item) return;
        clearTimeout(item.timer); pending.delete(reply.id);
        if (reply.error) item.reject(new Error(reply.error.message)); else item.resolve(reply.result);
      };
      socket.onclose = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("The fixture browser page closed.")); } pending.clear(); };
      const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 15_000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
      });
      const evaluate = async (expression: string) => {
        const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
      };
      const wait = async (check: () => Promise<any>, label: string, timeout = 20_000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) { const result = await check(); if (result) return result; await pause(200); }
        throw new Error(`Browser timed out: ${label}. Visible page: ${await evaluate("document.body?.innerText?.slice(-1200)")}`);
      };
      const hit = async (expression: string, label: string) => {
        await send("Page.bringToFront");
        const point = await wait(() => evaluate(`(() => { const item = ${expression}; if (!item || item.disabled || !item.getClientRects().length) return null; item.scrollIntoView({block:'center',inline:'center'}); const box = item.getBoundingClientRect(); const x = box.left + box.width/2, y = box.top + box.height/2; if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight || !item.contains(document.elementFromPoint(x,y))) return null; return {x,y}; })()`), label);
        await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
      };
      const click = (selector: string) => hit(`document.querySelector(${JSON.stringify(selector)})`, `click ${selector}`);
      const fill = async (selector: string, value: string) => { await send("Page.bringToFront"); await wait(() => evaluate(`(() => { const item = document.querySelector(${JSON.stringify(selector)}); if (!item || item.disabled || !item.getClientRects().length) return false; item.focus(); item.select(); return true; })()`), `field ${selector}`); await send("Input.insertText", { text: value }); };
      const button = (label: string, within = "body") => hit(`Array.from(document.querySelectorAll(${JSON.stringify(`${within} button`)})).find(item => item.textContent.trim() === ${JSON.stringify(label)})`, `button ${label}`);
      const screenshot = async (file: string) => {
        // A resize starts the mobile drawer transition. Capture its settled
        // layout; two animation frames alone can still land halfway through it.
        await evaluate("(async () => { await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))); await Promise.allSettled(document.getAnimations().filter(animation=>animation.playState==='running' && animation.effect?.getComputedTiming().endTime < 1500).map(animation=>animation.finished)); await new Promise(done=>requestAnimationFrame(done)); })()");
        await mkdir(dirname(file), { recursive: true }); await writeFile(file, Buffer.from((await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64"));
      };
      const result = { send, evaluate, wait, click, fill, button, screenshot, close: () => socket.close() }; pages.push(result);
      await send("Page.enable"); await send("Network.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      return result;
    };
    return { page, close: async () => {
      // Let Chromium close its renderers and release its profile before the
      // owned-child fallback, especially on Windows.
      if (pages[0]) await pages[0].send("Browser.close").catch(() => {});
      pages.forEach(page => page.close()); await waitForExit(child); child.stderr.destroy();
    } };
  } catch (error) { await waitForExit(child, { signal: "SIGTERM" }); child.stderr.destroy(); throw error; }
}
