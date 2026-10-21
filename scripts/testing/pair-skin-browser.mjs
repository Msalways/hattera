// Built pairing page in a real browser, with each saved skin and a phone viewport.
// Usage: node scripts/testing/pair-skin-browser.mjs PREVIEW_URL BROWSER_EXE
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';

const [url, executable] = process.argv.slice(2);
if (!url || !executable || new URL(url).hostname !== '127.0.0.1') throw new Error('Pass an isolated loopback preview and a browser executable');
const profile = await mkdtemp(join(tmpdir(), 'hattera-pair-browser-'));
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await new Promise((done) => setTimeout(done, 100)); }
  }
  if (!port) throw new Error('Browser did not start');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id || !pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}) => new Promise((done, fail) => {
    const call = ++id;
    pending.set(call, (reply) => reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.result));
    socket.send(JSON.stringify({ id: call, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitForForm = async () => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate('!!document.querySelector(".hattera-pair-card #pair-code")')) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('Pairing form did not render');
  };
  const luminance = (rgb) => [...rgb.matchAll(/[\d.]+/g)].slice(0, 3).map((part) => Number(part[0]) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = ({ color, background }) => {
    const a = luminance(color), b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1354, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: new URL('/pair', url).href });
  await waitForForm();
  const skins = ['hattera', 'midnight', 'atelier', 'foundry', 'lagoon', 'graphite', 'linen', 'dusk', 'daylight', 'meadow'];
  const screenshots = [];
  await mkdir(resolve('output/playwright'), { recursive: true });
  for (const skin of skins) {
    await evaluate(`localStorage.setItem('omb-skin', ${JSON.stringify(skin)})`);
    await send('Page.reload');
    await waitForForm();
    const result = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.hattera-pair-card')];
      return { skin: document.documentElement.dataset.skin, overflow: document.documentElement.scrollWidth > innerWidth,
        pairs: cards.flatMap(card => [...card.querySelectorAll('h2, p, label, input')].map(element => ({
          color: getComputedStyle(element).color,
          background: getComputedStyle(element.tagName === 'INPUT' ? element : document.querySelector('.hattera-pair-main')).backgroundColor,
        }))) };
    })()`);
    if (result.skin !== skin) throw new Error(`Saved ${skin} skin was not restored: ${result.skin}`);
    for (const pair of result.pairs) if (contrast(pair) < 4.5) throw new Error(`${skin} pairing text is unreadable: ${JSON.stringify(pair)}`);
    if (result.overflow) throw new Error(`${skin} pairing page overflows the viewport`);
    if (skin === 'hattera' || skin === 'midnight') {
      const browserName = executable.toLowerCase().includes('msedge') ? 'edge' : 'chrome';
      const path = resolve(`output/playwright/pair-${skin}-${browserName}-check.png`);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(path, Buffer.from(shot.data, 'base64'));
      screenshots.push(path);
    }
  }
  for (const width of [768, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 680 });
    await evaluate("localStorage.setItem('omb-skin', 'midnight')");
    await send('Page.reload');
    await waitForForm();
    if (await evaluate('document.documentElement.scrollWidth > innerWidth')) throw new Error(`${width}px pairing page overflows the viewport`);
    const mobile = await evaluate(`(() => {
    const selectors = ['.hattera-pair-title', '.hattera-pair-github button', '#pair-code', '#pair-label', '.hattera-pair-card button[type="submit"]'];
    return selectors.map(selector => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return { selector, visible: Boolean(rect && rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth) };
    });
  })()`);
    if (mobile.some(item => !item.visible)) throw new Error(`${width}px control is missing or clipped: ${JSON.stringify(mobile)}`);
    if (width === 390 || width === 320) {
      const mobileShot = resolve(`output/playwright/pair-midnight-edge-${width}-check.png`);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(mobileShot, Buffer.from(shot.data, 'base64'));
      screenshots.push(mobileShot);
    }
  }
  console.log(JSON.stringify({ ok: true, browser: executable, skins: skins.length, screenshots }));
} finally {
  socket?.close();
  browser.kill();
  if (resolve(profile).startsWith(resolve(tmpdir()) + sep)) await rm(profile, { recursive: true, force: true }).catch(() => {});
}
