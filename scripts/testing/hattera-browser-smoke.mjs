// Real Chrome -> built Hattera UI -> isolated server -> native browser -> local test page.
// Usage: node scripts/testing/hattera-browser-smoke.mjs PREVIEW_URL CHROME_PATH
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';

const [previewUrl, chromePath] = process.argv.slice(2);
if (!previewUrl || !chromePath) throw new Error('Pass the printed preview URL and Chrome executable path');
const base = new URL(previewUrl);
const screenshotRoot = resolve(process.env.OMB_E2E_ARTIFACT_DIR ? join(process.env.OMB_E2E_ARTIFACT_DIR, 'app-screenshots') : 'output/playwright');
if (base.hostname !== '127.0.0.1') throw new Error('Only an isolated loopback preview is allowed');
const profile = await mkdtemp(join(tmpdir(), 'hattera-ui-smoke-'));
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true });
let socket;
let stage = 'browser startup';
let sequence = 0;
const pending = new Map();
const browserRequests = [];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await pause(100); }
  }
  if (!port) throw new Error('Chrome did not start');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const tab = tabs.find((entry) => entry.type === 'page');
  if (!tab) throw new Error('No Chrome page target');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  socket.onmessage = ({ data }) => {
    const reply = JSON.parse(data);
    if (reply.method === 'Network.requestWillBeSent' && reply.params?.request?.url?.includes('/browser/action')) {
      browserRequests.push({ url: reply.params.request.url, method: reply.params.request.method, body: reply.params.request.postData });
    }
    if (!reply.id || !pending.has(reply.id)) return;
    pending.get(reply.id)(reply);
    pending.delete(reply.id);
  };
  const send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++sequence;
    pending.set(id, (reply) => reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.result));
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (check, timeoutMs, label) => {
    stage = label;
    console.error(`Browser check: ${label}`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await pause(500);
    }
    const body = await evaluate('document.body?.innerText?.slice(-1200)');
    throw new Error(`${label} timed out. Visible UI: ${body}`);
  };
  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base.href });
  await until(() => evaluate('document.title === "Hattera" && !!document.querySelector("button[data-tour=computer]")'), 20_000, 'Hattera chat');
  // Welcome and the guided tour mount asynchronously after the chat shell.
  // Dismiss each through its visible control before using the rest of the UI.
  await pause(1_200);
  for (let i = 0; i < 5; i++) {
    await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent?.trim() === "Skip tour" && button.getClientRects().length)?.click()');
    await pause(800);
  }
  await until(() => evaluate('!document.querySelector("[data-tour-card]") && !document.querySelector(".welcome-card")'), 10_000, 'onboarding tour dismissal');
  const botsUrl = new URL('/api/bots', base);
  const replies = (bot) => bot.messages?.filter((message) => message.role === 'bot' && message.text === 'hello from fake claude') ?? [];
  const beforeReplies = replies((await (await fetch(botsUrl)).json()).bots[0]).length;
  await evaluate('document.querySelector("textarea[aria-label^=Message]").focus()');
  await send('Input.insertText', { text: 'Hattera smoke chat' });
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify('button[aria-label="Send message"]')})`), 10_000, 'chat send action');
  await evaluate(`document.querySelector(${JSON.stringify('button[aria-label="Send message"]')}).click()`);
  const replyId = await until(async () => {
    const bot = (await (await fetch(botsUrl)).json()).bots[0];
    const matching = replies(bot);
    return !bot.busy && matching.length > beforeReplies ? matching.at(-1).id : null;
  }, 60_000, 'new fake engine reply');
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(`[data-mid="${replyId}"]`)})`), 10_000, 'rendered chat reply');
  const instances = await (await fetch(new URL('/api/instances', base))).json();
  const openCodeInstance = instances.instances?.find((instance) => instance.driverKind === 'opencodeGo');
  if (!openCodeInstance || openCodeInstance.snapshot.state !== 'available') {
    throw new Error(`The isolated OpenCode test provider is not ready: ${JSON.stringify(openCodeInstance?.snapshot)}`);
  }
  await evaluate('document.querySelector("button[data-tour=model]").click()');
  await until(() => evaluate('!!document.querySelector("[data-simple-provider=opencodeGo]")'), 10_000, 'OpenCode model provider');
  await evaluate('document.querySelector("[data-simple-provider=opencodeGo]").click()');
  const openCodeModel = '[...document.querySelectorAll("[data-simple-models] button")].find(button => button.textContent?.includes("Fixture") && button.textContent?.includes("opencode"))';
  await until(() => evaluate(`!!(${openCodeModel})`), 30_000, 'OpenCode test model');
  if (await evaluate('!!document.querySelector("[data-simple-set-up]")')) throw new Error('Ready OpenCode provider still asks for setup');
  const modelColors = await evaluate(`(() => { const button = (${openCodeModel}); return { text: getComputedStyle(button).color, background: getComputedStyle(button.closest('[data-model-picker-content]')).backgroundColor }; })()`);
  const rgb = (value) => [...value.matchAll(/[\d.]+/g)].slice(0, 3).map((match) => Number(match[0]) / 255);
  const luminance = (value) => rgb(value).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const contrastOf = ({ text, background }) => {
    const a = luminance(text), b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  if (contrastOf(modelColors) < 4.5) throw new Error(`OpenCode model text is unreadable: ${JSON.stringify(modelColors)}`);
  const providerColors = await evaluate('(() => { const button = document.querySelector("[data-simple-provider=opencodeGo]"); return { text: getComputedStyle(button).color, background: getComputedStyle(button).backgroundColor }; })()');
  if (contrastOf(providerColors) < 4.5) throw new Error(`Selected OpenCode provider is unreadable: ${JSON.stringify(providerColors)}`);
  await mkdir(screenshotRoot, { recursive: true });
  const pickerScreenshot = join(screenshotRoot, 'hattera-opencode-picker.png');
  await pause(800);
  const pickerShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(pickerScreenshot, Buffer.from(pickerShot.data, 'base64'));
  await evaluate(`(${openCodeModel}).click()`);
  await until(() => evaluate('!document.querySelector("[data-model-picker-content]")'), 10_000, 'model picker closure');
  const beforeOpenCodeReplies = (await (await fetch(botsUrl)).json()).bots[0].messages.filter((message) => message.role === 'bot' && message.text === 'hello from fake OpenCode').length;
  await evaluate('document.querySelector("textarea[aria-label^=Message]").focus()');
  await send('Input.insertText', { text: 'Hattera OpenCode smoke chat' });
  const sendButtonSelector = 'button[aria-label="Send message"]';
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(sendButtonSelector)})`), 10_000, 'OpenCode chat send action');
  await evaluate(`document.querySelector(${JSON.stringify(sendButtonSelector)}).click()`);
  const openCodeReplyId = await until(async () => {
    const bot = (await (await fetch(botsUrl)).json()).bots[0];
    const matching = bot.messages.filter((message) => message.role === 'bot' && message.text === 'hello from fake OpenCode');
    return !bot.busy && matching.length > beforeOpenCodeReplies ? matching.at(-1).id : null;
  }, 60_000, 'new OpenCode ACP test reply');
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(`[data-mid="${openCodeReplyId}"]`)})`), 10_000, 'rendered OpenCode test reply');
  await evaluate('Array.from(document.querySelectorAll("[data-sidebar] button[aria-haspopup=menu]")).at(-1).click()');
  await until(() => evaluate('!!document.querySelector("[data-menu-key=settings]")'), 10_000, 'Settings menu');
  await evaluate('document.querySelector("[data-menu-key=settings]").click()');
  await until(() => evaluate('!!document.querySelector("[role=dialog] [data-settings-page=ai]")'), 10_000, 'Settings pages');
  await evaluate('document.querySelector("[data-settings-page=ai]").click()');
  await until(() => evaluate('!!document.querySelector("[data-engine-card=opencodeGo]")'), 15_000, 'OpenCode provider card');
  const openCodeCard = await evaluate('document.querySelector("[data-engine-card=opencodeGo]").innerText');
  if (!openCodeCard.includes('OpenCode (test provider)') || openCodeCard.includes('Needs setup')) {
    throw new Error(`OpenCode provider card has no clear status: ${openCodeCard}`);
  }
  await evaluate('document.querySelector("[data-engine-card=opencodeGo]").scrollIntoView({block:"center"})');
  await pause(500);
  await mkdir(screenshotRoot, { recursive: true });
  const providerScreenshot = join(screenshotRoot, 'hattera-opencode-provider.png');
  const providerShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(providerScreenshot, Buffer.from(providerShot.data, 'base64'));
  await evaluate('document.querySelector("[data-engine-card=minimax] summary").click()');
  await until(() => evaluate('document.querySelector("[data-engine-card=minimax]")?.innerText.includes("Open API keys")'), 10_000, 'MiniMax saved-key setup card');
  const miniMaxCard = await evaluate('document.querySelector("[data-engine-card=minimax]").innerText');
  if (!miniMaxCard.includes('Needs setup') || miniMaxCard.includes('Install MiniMax') || miniMaxCard.includes('CLI path and updates')) {
    throw new Error(`MiniMax has an incorrect setup path: ${miniMaxCard}`);
  }
  await evaluate('document.querySelector("[data-engine-card=minimax]").scrollIntoView({block:"center"})');
  await pause(500);
  const miniMaxScreenshot = join(screenshotRoot, 'hattera-minimax-setup.png');
  const miniMaxShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(miniMaxScreenshot, Buffer.from(miniMaxShot.data, 'base64'));
  await evaluate('document.querySelector("[data-engine-card=qwen] summary").click()');
  await until(() => evaluate('!!document.querySelector("[data-engine-card=qwen] [data-provider-account-setup=model]")'), 10_000, 'Qwen model provider setup form');
  const qwenCard = await evaluate('document.querySelector("[data-engine-card=qwen]").innerText');
  if (!qwenCard.includes('Sign-in required') || !qwenCard.includes('Model ID') || qwenCard.includes('Install Qwen on this server') || qwenCard.includes('Copy command')) {
    throw new Error(`Unconfigured Qwen has an incorrect setup path: ${qwenCard}`);
  }
  await evaluate('document.querySelector("[data-engine-card=qwen]").scrollIntoView({block:"center"})');
  await pause(500);
  const qwenScreenshot = join(screenshotRoot, 'hattera-qwen-setup.png');
  const qwenShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(qwenScreenshot, Buffer.from(qwenShot.data, 'base64'));
  await evaluate('document.querySelector("[data-engine-card=bedrock] summary").click()');
  await until(() => evaluate('!!document.querySelector("[data-engine-card=bedrock] [data-provider-account-setup=bedrock]")'), 10_000, 'Bedrock account setup');
  if (await evaluate('document.querySelector("[data-engine-card=bedrock]").innerText.includes("Install Amazon Bedrock")')) throw new Error('Bedrock was treated as a downloadable CLI');
  await evaluate('document.querySelector("[data-engine-card=codex] summary").click()');
  await until(() => evaluate('!!document.querySelector("[data-engine-card=codex] [data-device-sign-in=codex]")'), 10_000, 'Codex sign-in card').catch(async (cause) => {
    const card = await evaluate('document.querySelector("[data-engine-card=codex]")?.innerText');
    const instances = await (await fetch(new URL('/api/instances', base))).json();
    const codex = instances.instances?.find((instance) => instance.instanceId === 'codex');
    throw new Error(`${cause.message}\nCodex card: ${card}\nCodex snapshot: ${JSON.stringify(codex)}`);
  });
  const codexChoices = await evaluate('Array.from(document.querySelectorAll("[data-engine-card=codex] button[aria-pressed]")).map(button => [button.textContent.trim(), button.getAttribute("aria-pressed")])');
  if (!codexChoices.some(([label, pressed]) => label === 'Browser sign-in' && pressed === 'true') || !codexChoices.some(([label]) => label === 'One-time code')) {
    throw new Error(`Codex did not offer both local sign-in methods: ${JSON.stringify(codexChoices)}`);
  }
  await evaluate('document.querySelector("[data-engine-card=codex]").scrollIntoView({block:"center"})');
  await pause(500);
  const codexScreenshot = join(screenshotRoot, 'hattera-codex-auth-options.png');
  const codexShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(codexScreenshot, Buffer.from(codexShot.data, 'base64'));
  await evaluate('Array.from(document.querySelectorAll("[data-engine-card=codex] button")).find(button => button.textContent.includes("One-time code")).click()');
  await until(() => evaluate('!!Array.from(document.querySelectorAll("[data-engine-card=codex] button[aria-pressed=true]")).find(button => button.textContent.includes("One-time code"))'), 10_000, 'Codex device-code choice');
  const codexCodeScreenshot = join(screenshotRoot, 'hattera-codex-auth-code.png');
  const codexCodeShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(codexCodeScreenshot, Buffer.from(codexCodeShot.data, 'base64'));
  await evaluate('document.querySelector("[data-settings-page=account]").click()');
  await until(() => evaluate('!!document.querySelector("[data-account-usage=opencodeGo]") && !!document.querySelector("[data-account-usage=codex]")'), 25_000, 'all configured accounts in usage');
  const report = await (await fetch(new URL('/api/plan-usage', base))).json();
  const visibleAccountIds = await evaluate('Array.from(document.querySelectorAll("[data-account-usage]")).map(row => row.dataset.accountUsage)');
  if (report.providers.some(provider => !visibleAccountIds.includes(provider.id))) throw new Error('Usage omitted a configured account');
  // This journey deliberately leaves Codex signed out to exercise its setup UI.
  // Native successful snapshots are checked by verify-account-network.ts.
  await until(() => evaluate('document.querySelector("[data-account-usage=codex]")?.innerText.includes("Account reporting could not refresh")'), 40_000, 'signed-out account reporting state');
  if (await evaluate('!!document.querySelector("[data-account-usage=codex] [role=meter]")')) throw new Error('Signed-out account displayed a fabricated allowance');
  await evaluate('document.querySelector("[data-settings-block=usage]").scrollIntoView({block:"start"})');
  const accountScreenshot = join(screenshotRoot, 'hattera-account-usage.png');
  await writeFile(accountScreenshot, Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pause(300);
  if (await evaluate('document.documentElement.scrollWidth > window.innerWidth')) throw new Error('Account usage overflows the mobile viewport');
  const mobileAccountScreenshot = join(screenshotRoot, 'hattera-account-usage-mobile.png');
  await writeFile(mobileAccountScreenshot, Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.querySelector("[data-settings-page=computers]").click()');
  await until(() => evaluate('Array.from(document.querySelectorAll("button")).some(button => button.textContent.trim() === "Connect Tailscale" && !button.disabled)'), 15_000, 'packaged private network control');
  const disconnected = await (await fetch(new URL('/api/private-network', base))).json();
  if (!disconnected.available || disconnected.enabled) throw new Error('Private network was missing or unexpectedly enabled');
  await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "Connect Tailscale").scrollIntoView({block:"center"})');
  const networkScreenshot = join(screenshotRoot, 'hattera-private-network.png');
  await writeFile(networkScreenshot, Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pause(300);
  if (await evaluate('document.documentElement.scrollWidth > window.innerWidth')) throw new Error('Private network settings overflow the mobile viewport');
  const mobileNetworkScreenshot = join(screenshotRoot, 'hattera-private-network-mobile.png');
  await writeFile(mobileNetworkScreenshot, Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector(${JSON.stringify('button[aria-label="Close settings"]')}).click()`);
  await until(() => evaluate('!document.querySelector("[role=dialog] [data-settings-page=ai]")'), 10_000, 'Settings closure');
  await evaluate('document.querySelector("button[data-tour=computer]").click()');
  await until(() => evaluate('!!document.querySelector("input[aria-label^=Browser]") || document.body.innerText.includes("Browser engine not installed")'), 20_000, 'browser panel');
  const installedError = await evaluate('document.body.innerText.includes("Browser engine not installed")');
  if (installedError) throw new Error('Browser panel still reports that the engine is not installed');
  await until(() => evaluate('!!document.querySelector("input[aria-label^=Browser]:not([readonly])") || document.body.innerText.includes("Browser disconnected")'), 90_000, 'live browser connection');
  if (await evaluate('document.body.innerText.includes("Browser disconnected")')) throw new Error('Native browser disconnected');
  const testPage = new URL('/__hattera-browser-test', base).href;
  const statusUrl = new URL('/__hattera-browser-test/status', base);
  const before = (await (await fetch(statusUrl)).json()).visits;
  await evaluate('document.querySelector("input[aria-label^=Browser]").focus()');
  await send('Input.insertText', { text: testPage });
  await pause(300);
  const entered = await evaluate('document.querySelector("input[aria-label^=Browser]").value');
  if (entered !== testPage) throw new Error(`Browser address input did not accept text: ${JSON.stringify(entered)}`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await pause(500);
  if (!browserRequests.some((entry) => entry.body?.includes('"navigate"'))) {
    await evaluate('document.querySelector("input[aria-label^=Browser]").form.requestSubmit()');
    await pause(500);
  }
  if (!browserRequests.some((entry) => entry.body?.includes('"navigate"'))) throw new Error('Browser panel did not submit a navigate action');
  await until(async () => (await (await fetch(statusUrl)).json()).visits > before, 45_000, 'native browser navigation');
  // A page visit precedes the navigation reply. Close an idle panel so this
  // check exercises explicit hand-back, rather than server disconnect cleanup.
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify('button[aria-label="New tab"]:not(:disabled)')})`), 45_000, 'completed browser navigation');
  const output = join(screenshotRoot, 'hattera-browser-smoke.png');
  await mkdir(screenshotRoot, { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(output, Buffer.from(shot.data, 'base64'));
  await evaluate('document.querySelector("button[data-tour=computer]").click()');
  await until(() => evaluate('!document.querySelector("input[aria-label^=Browser]")'), 10_000, 'browser panel closure');
  await until(() => browserRequests.some((entry) => entry.body?.includes('"release"')), 10_000, 'browser control release');
  await evaluate('document.querySelector("[data-chathead-pill]").click()');
  await until(() => evaluate('!!document.querySelector("[data-hattera-settings][role=dialog]")'), 10_000, 'bot settings');
  for (const section of ['identity', 'skills', 'memory', 'access', 'model', 'permissions']) {
    await evaluate(`Array.from(document.querySelectorAll('.hattera-settings-nav button')).find(button => button.textContent?.trim().toLowerCase().startsWith(${JSON.stringify(section === 'access' ? 'access' : section)}))?.click()`);
    await until(() => evaluate(`!!document.querySelector('.hattera-settings-nav button[aria-current=page]') && !!document.querySelector('section[aria-labelledby="hattera-settings-${section}"]:not([hidden]) h2')`), 10_000, `${section} settings section`);
  }
  await evaluate('Array.from(document.querySelectorAll(".hattera-settings-nav button")).find(button => button.textContent?.trim() === "Access").click()');
  const browserSwitch = 'button[aria-label="Give this bot a built-in browser"]';
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(`${browserSwitch}:not([disabled])`)})`), 10_000, 'bot browser setting');
  await evaluate(`document.querySelector(${JSON.stringify(browserSwitch)}).click()`);
  await until(async () => (await (await fetch(botsUrl)).json()).bots[0]?.browser === false, 15_000, 'browser permission off');
  await evaluate(`document.querySelector(${JSON.stringify(browserSwitch)}).click()`);
  await until(async () => (await (await fetch(botsUrl)).json()).bots[0]?.browser === true, 15_000, 'browser permission restored');
  await evaluate('document.querySelector(".hattera-settings-back button").click()');
  await until(() => evaluate('!document.querySelector("[data-hattera-settings][role=dialog]")'), 10_000, 'bot settings closure');
  await evaluate(`document.querySelector(${JSON.stringify('[data-sidebar-top-buttons] button[aria-label="New or share"]')}).click()`);
  await until(() => evaluate('Array.from(document.querySelectorAll("[data-sidebar-top-buttons] button")).some(button => button.textContent?.includes("New Bot"))'), 10_000, 'new bot menu');
  await evaluate('Array.from(document.querySelectorAll("[data-sidebar-top-buttons] button")).find(button => button.textContent?.includes("New Bot")).click()');
  const newBotDialog = '[role=dialog][aria-label="New Bot"]';
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(`${newBotDialog} input[id^=bot-name]`)})`), 20_000, 'new bot editor');
  await evaluate(`document.querySelector(${JSON.stringify(`${newBotDialog} input[id^=bot-name]`)}).select()`);
  await send('Input.insertText', { text: 'Hattera smoke bot' });
  await until(() => evaluate(`!!Array.from(document.querySelectorAll(${JSON.stringify(`${newBotDialog} button`)})).find(button => button.textContent?.trim() === "Create bot" && !button.disabled)`), 10_000, 'create bot action');
  await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(`${newBotDialog} button`)})).find(button => button.textContent?.trim() === "Create bot").click()`);
  const createdBot = await until(async () => (await (await fetch(botsUrl)).json()).bots.find((bot) => bot.name === 'Hattera smoke bot'), 30_000, 'saved bot');
  await until(() => evaluate(`!document.querySelector(${JSON.stringify(newBotDialog)})`), 10_000, 'new bot dialog closure');
  await evaluate('document.querySelector("[data-chathead-pill]").click()');
  await until(() => evaluate('!!document.querySelector("[data-hattera-settings][role=dialog]")'), 10_000, 'created bot settings');
  await evaluate('Array.from(document.querySelectorAll(".hattera-settings-nav button")).find(button => button.textContent?.trim() === "Identity").click()');
  const identityName = 'section[aria-labelledby="hattera-settings-identity"]:not([hidden]) input[id^=bot-name]';
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(identityName)})`), 10_000, 'identity editor');
  await evaluate(`document.querySelector(${JSON.stringify(identityName)}).select()`);
  await send('Input.insertText', { text: 'Hattera reviewed bot' });
  await evaluate(`document.querySelector(${JSON.stringify(identityName)}).blur()`);
  await until(async () => (await (await fetch(botsUrl)).json()).bots.some((bot) => bot.name === 'Hattera reviewed bot'), 20_000, 'saved bot identity');
  await evaluate('Array.from(document.querySelectorAll(".hattera-settings-nav button")).find(button => button.textContent?.trim() === "Memory").click()');
  const memoryEditor = 'textarea[aria-label="Bot memory"]';
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(memoryEditor)})`), 20_000, 'memory editor');
  await evaluate(`document.querySelector(${JSON.stringify(memoryEditor)}).select()`);
  await send('Input.insertText', { text: 'The bot remembers this fixture note.' });
  await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify('section[aria-labelledby="hattera-settings-memory"] button')})).find(button => button.textContent?.trim() === "Save").click()`);
  const memoryUrl = new URL(`/api/bots/${createdBot.id}/memory/file?path=MEMORY.md`, base);
  await until(async () => (await (await fetch(memoryUrl)).json()).text === 'The bot remembers this fixture note.', 20_000, 'saved bot memory');
  await evaluate('Array.from(document.querySelectorAll(".hattera-settings-nav button")).find(button => button.textContent?.trim() === "Access").click()');
  const toolMode = 'section[aria-labelledby="hattera-settings-access"] select[aria-label="Tool selection"]';
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(toolMode)})`), 10_000, 'tool selection');
  await evaluate(`(() => { const select = document.querySelector(${JSON.stringify(toolMode)}); select.value = 'custom'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const excludeTool = 'textarea[aria-label="Exclude (one per line)"]';
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(excludeTool)})`), 10_000, 'custom tool editor');
  await evaluate(`document.querySelector(${JSON.stringify('section[aria-labelledby="hattera-settings-access"] input[type=checkbox]')}).click()`);
  await evaluate(`document.querySelector(${JSON.stringify(excludeTool)}).focus()`);
  await send('Input.insertText', { text: 'mcp:fixture:blocked' });
  await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify('section[aria-labelledby="hattera-settings-access"] button')})).find(button => button.textContent?.trim() === "Save tool selection").click()`);
  await until(async () => (await (await fetch(botsUrl)).json()).bots.find((bot) => bot.id === createdBot.id)?.toolScope?.deny?.includes('mcp:fixture:blocked'), 20_000, 'saved tool selection');
  await evaluate('Array.from(document.querySelectorAll(".hattera-settings-nav button")).find(button => button.textContent?.trim() === "Skills").click()');
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify('input[aria-label="Command name"]')})`), 10_000, 'skill authoring');
  for (const [selector, value] of [['input[aria-label="Command name"]', 'fixture-note'], ['input[aria-label="What it does"]', 'Remember a fixture note'], ['textarea[aria-label="Instructions"]', 'Repeat the fixture note.']]) {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await send('Input.insertText', { text: value });
  }
  await until(() => evaluate('!!Array.from(document.querySelectorAll("button")).find(button => button.textContent?.trim() === "Save command" && !button.disabled)'), 10_000, 'save skill action');
  await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent?.trim() === "Save command").click()');
  const skillsUrl = new URL(`/api/bots/${createdBot.id}/skills`, base);
  await until(async () => (await (await fetch(skillsUrl)).json()).skills?.some((skill) => skill.name === 'fixture-note' && skill.enabled), 20_000, 'saved skill');
  await evaluate('Array.from(document.querySelectorAll(".hattera-settings-nav button")).find(button => button.textContent?.trim() === "Permissions").click()');
  const approvalTrigger = 'section[aria-labelledby="hattera-settings-permissions"] button[aria-haspopup=menu]';
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(approvalTrigger)})`), 10_000, 'approval level selector');
  await evaluate(`document.querySelector(${JSON.stringify(approvalTrigger)}).click()`);
  await until(() => evaluate('!!Array.from(document.querySelectorAll("[role=menuitemradio]")).find(button => button.textContent?.includes("Auto-accept edits"))'), 10_000, 'approval level options');
  await evaluate('Array.from(document.querySelectorAll("[role=menuitemradio]")).find(button => button.textContent?.includes("Auto-accept edits")).click()');
  await until(async () => (await (await fetch(botsUrl)).json()).bots.find((bot) => bot.id === createdBot.id)?.approvalMode === 'edits', 20_000, 'saved approval level');
  await evaluate('document.querySelector(".hattera-settings-back button").click()');
  await until(() => evaluate('!document.querySelector("[data-hattera-settings][role=dialog]")'), 10_000, 'created bot settings closure');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await until(() => evaluate('innerWidth === 390 && !!document.querySelector("textarea[aria-label^=Message]")'), 10_000, 'mobile chat layout');
  await pause(350); // The drawer has a 200 ms slide transition at this breakpoint.
  const mobileLayout = await evaluate('({ overflow: document.documentElement.scrollWidth > innerWidth, sidebarRight: document.querySelector("[data-sidebar]").getBoundingClientRect().right, composerLeft: document.querySelector("textarea[aria-label^=Message]").getBoundingClientRect().left })');
  if (mobileLayout.overflow || mobileLayout.sidebarRight > 1 || mobileLayout.composerLeft < 0) {
    throw new Error(`Mobile chat is obscured or overflows: ${JSON.stringify(mobileLayout)}`);
  }
  const mobileScreenshot = join(screenshotRoot, 'hattera-mobile-smoke.png');
  const mobileShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(mobileScreenshot, Buffer.from(mobileShot.data, 'base64'));
  const pairing = await fetch(new URL('/api/auth/pairing', base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  if (!pairing.ok) throw new Error(`Could not mint isolated pairing code: ${pairing.status}`);
  const { code } = await pairing.json();
  await send('Network.setExtraHTTPHeaders', { headers: { 'x-forwarded-for': '203.0.113.50' } });
  await send('Page.navigate', { url: new URL(`/pair#code=${code}`, base).href });
  await until(() => evaluate('!!document.querySelector("#pair-code") && !document.querySelector("#pair-code").disabled'), 20_000, 'remote pairing page');
  if (await evaluate('document.querySelector("#pair-code").value') !== code) throw new Error('Pairing link did not populate its code');
  for (const skin of ['hattera', 'midnight', 'atelier', 'foundry', 'lagoon', 'graphite', 'linen', 'dusk', 'daylight', 'meadow']) {
    const colors = await evaluate(`(() => {
      document.documentElement.dataset.skin = ${JSON.stringify(skin)};
      const card = document.querySelector('.hattera-pair-card');
      const field = card.querySelector('input');
      return [card.querySelector('h2'), card.querySelector('p'), card.querySelector('label')].map(element => ({
        text: getComputedStyle(element).color, background: getComputedStyle(document.querySelector('.hattera-pair-main')).backgroundColor,
      })).concat({ text: getComputedStyle(field).color, background: getComputedStyle(field).backgroundColor });
    })()`);
    for (const colorsOnSurface of colors) {
      if (contrastOf(colorsOnSurface) < 4.5) throw new Error(`${skin} pairing text is unreadable: ${JSON.stringify(colorsOnSurface)}`);
    }
  }
  await evaluate("localStorage.setItem('omb-skin', 'midnight')");
  await send('Page.reload');
  await until(() => evaluate('document.documentElement?.dataset.skin === "midnight" && !!document.querySelector("#pair-code")'), 20_000, 'saved dark pairing skin');
  const darkPairScreenshot = join(screenshotRoot, 'hattera-pair-dark-smoke.png');
  const darkPairShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(darkPairScreenshot, Buffer.from(darkPairShot.data, 'base64'));
  await evaluate("localStorage.setItem('omb-skin', 'hattera')");
  await send('Page.reload');
  await until(() => evaluate('document.documentElement?.dataset.skin === "hattera" && !!document.querySelector("#pair-code")'), 20_000, 'saved Hattera pairing skin');
  await evaluate('document.querySelector("#pair-code").focus(); document.querySelector("#pair-code").select()');
  await send('Input.insertText', { text: code });
  await until(() => evaluate(`document.querySelector("#pair-code")?.value === ${JSON.stringify(code)}`), 10_000, 'pairing code entry');
  const pairScreenshot = join(screenshotRoot, 'hattera-pair-smoke.png');
  const pairShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(pairScreenshot, Buffer.from(pairShot.data, 'base64'));
  await evaluate('Array.from(document.querySelectorAll("form button[type=submit]")).find(button => button.textContent?.trim() === "Connect").click()');
  await until(() => evaluate('location.pathname === "/" && !!document.querySelector("textarea[aria-label^=Message]")'), 20_000, 'paired remote chat');
  await evaluate('Array.from(document.querySelectorAll("[data-sidebar] button[aria-haspopup=menu]")).at(-1).click()');
  await until(() => evaluate('!!document.querySelector("[data-menu-key=settings]")'), 10_000, 'paired Settings menu');
  await evaluate('document.querySelector("[data-menu-key=settings]").click()');
  await until(() => evaluate('!!document.querySelector("[role=dialog] [data-settings-page=ai]")'), 10_000, 'paired Settings pages');
  await evaluate('document.querySelector("[data-settings-page=ai]").click()');
  const clineCard = '[data-engine-card=cline]';
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(clineCard)})`), 10_000, 'Cline provider card');
  await evaluate(`document.querySelector(${JSON.stringify(`${clineCard} summary`)}).click()`);
  const clineInstall = `${clineCard} button`;
  await until(() => evaluate(`!!Array.from(document.querySelectorAll(${JSON.stringify(clineInstall)})).find(button => button.textContent?.includes('Install Cline on this server'))`), 10_000, 'Cline server install action');
  await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(clineInstall)})).find(button => button.textContent?.includes('Install Cline on this server')).click()`);
  await until(async () => {
    const data = await (await fetch(new URL('/api/instances', base))).json();
    return data.instances?.find((instance) => instance.instanceId === 'cline')?.snapshot.version?.includes('fake-acp 1.0.0');
  }, 90_000, 'Cline installed by browser action');
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(`${clineCard} [role=status]`)}) || !document.querySelector(${JSON.stringify(`${clineCard} button`)})?.textContent?.includes('Installing')`), 10_000, 'Cline install feedback');
  await until(() => evaluate('!!document.querySelector("[data-device-sign-in=cline] button")'), 10_000, 'Cline browser sign-in after install');
  if (await evaluate(`document.querySelector(${JSON.stringify(clineCard)}).innerText.includes('Finish signing in to your account in Terminal')`)) throw new Error('Cline still requires a server terminal');
  await evaluate('document.querySelector("[data-device-sign-in=cline] button").click()');
  await until(() => evaluate('Array.from(document.querySelectorAll("[data-device-sign-in=cline] a")).some(link => link.href === "https://authkit.cline.bot/device?user_code=ABCD-EFGH")'), 10_000, 'Cline one-time code');
  const duringAuth = await fetch(new URL('/api/instances/cline/uninstall', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
  if (duringAuth.status !== 409) throw new Error(`Engine removal during sign-in was not blocked: ${duringAuth.status}`);
  await evaluate('Array.from(document.querySelectorAll("[data-device-sign-in=cline] button")).find(button => button.textContent?.includes("Cancel")).click()');
  await until(() => evaluate('document.querySelector("[data-device-sign-in=cline]")?.innerText.includes("cancelled")'), 10_000, 'Cline auth cancellation');
  await evaluate('Array.from(document.querySelectorAll("[data-device-sign-in=cline] button")).find(button => button.textContent?.includes("Try again")).click()');
  await until(() => evaluate('!!document.querySelector("[data-device-sign-in=cline] a")'), 10_000, 'Cline auth retry');
  const clineAuthScreenshot = join(screenshotRoot, 'hattera-cline-browser-sign-in.png');
  await evaluate('document.querySelector("[data-device-sign-in=cline]").scrollIntoView({ block: "center" })');
  const clineAuthShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(clineAuthScreenshot, Buffer.from(clineAuthShot.data, 'base64'));
  await fetch(new URL('/__hattera-cline-auth/approve', base), { method: 'POST' });
  await until(async () => (await (await fetch(new URL('/api/instances', base))).json()).instances?.find(instance => instance.instanceId === 'cline')?.snapshot.authenticated === true, 20_000, 'Cline saved account confirmation');
  const runtimeStatus = async () => (await fetch(new URL('/__hattera-cline-runtime', base))).json();
  const cardButton = async (card, text) => {
    const cardSelector = `[data-engine-card=${card}]`;
    const selector = `${cardSelector} button`;
    await evaluate(`(() => { const card = document.querySelector(${JSON.stringify(cardSelector)}); if (card && !card.open) card.querySelector('summary').click(); })()`);
    await until(() => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(button => button.getClientRects().length && button.textContent?.trim() === ${JSON.stringify(text)})`), 10_000, text);
    await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(button => button.textContent?.trim() === ${JSON.stringify(text)}).click()`);
  };
  const dialogButton = async text => {
    await until(() => evaluate('!!document.querySelector("[role=alertdialog]")'), 5_000, 'engine removal confirmation');
    await evaluate(`Array.from(document.querySelectorAll('[role=alertdialog] button')).find(button => button.textContent?.trim() === ${JSON.stringify(text)}).click()`);
    // Runtime disposal and Windows file release are asynchronous. Require the
    // actual completion (and the disk/account assertions below), using the
    // same bounded budget as installation rather than a ten-second UI budget.
    await until(() => evaluate('!document.querySelector("[role=alertdialog]")'), text === 'Cancel' ? 10_000 : 90_000, 'engine removal confirmation closed');
  };
  if (!(await runtimeStatus()).installed) throw new Error('No managed Cline runtime before uninstall');
  await cardButton('cline', 'Uninstall engine');
  await until(() => evaluate('document.activeElement?.textContent === "Cancel"'), 5_000, 'safe uninstall confirmation focus');
  const removalShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(screenshotRoot, 'hattera-engine-uninstall.png'), Buffer.from(removalShot.data, 'base64'));
  await dialogButton('Cancel');
  if (!(await runtimeStatus()).installed) throw new Error('Cancel removed the engine');
  await cardButton('cline', 'Uninstall engine');
  await dialogButton('Uninstall engine');
  const afterRemoval = await runtimeStatus();
  if (afterRemoval.installed || !afterRemoval.accountKept) {
    const feedback = await evaluate('document.querySelector("[data-engine-card=cline] [data-engine-runtime-removal]")?.innerText');
    throw new Error(`Uninstall did not remove software and preserve the account: ${JSON.stringify(afterRemoval)}; feedback: ${feedback}`);
  }
  await send('Page.reload');
  await until(() => evaluate('!!document.querySelector("[data-sidebar] button[aria-haspopup=menu]")'), 15_000, 'chat after reload');
  await evaluate('Array.from(document.querySelectorAll("[data-sidebar] button[aria-haspopup=menu]")).at(-1).click()');
  await until(() => evaluate('!!document.querySelector("[data-menu-key=settings]")'), 10_000, 'Settings menu after reload');
  await evaluate('document.querySelector("[data-menu-key=settings]").click()');
  await until(() => evaluate('!!document.querySelector("[data-settings-page=ai]")'), 10_000, 'Settings after reload');
  await evaluate('document.querySelector("[data-settings-page=ai]").click()');
  await until(() => evaluate('!!document.querySelector("[data-engine-card=cline]")'), 15_000, 'provider card after reload');
  if (!await evaluate('document.querySelector("[data-engine-card=cline]").innerText.includes("Removed")')) throw new Error('Removed state was lost on reload');
  await evaluate('document.querySelector("[data-engine-card=cline] summary").click()');
  await cardButton('cline', 'Install Cline on this server');
  await until(async () => (await (await fetch(new URL('/api/instances', base))).json()).instances?.find(instance => instance.instanceId === 'cline')?.snapshot.authenticated === true, 90_000, 'Cline reinstall with preserved account');
  if (!(await runtimeStatus()).installed || !(await runtimeStatus()).accountKept) throw new Error('Reinstall lost the saved account');
  await evaluate('document.querySelector("[data-engine-card=qwen] summary").click()');
  await cardButton('qwen', 'Disable engine');
  await dialogButton('Disable engine');
  const qwenRemoved = (await (await fetch(new URL('/api/instances', base))).json()).instances.find(instance => instance.instanceId === 'qwen');
  if (!qwenRemoved?.runtimeRemoval?.removed || qwenRemoved.models.options.length) throw new Error('External runtime remained selectable after disable');
  await cardButton('qwen', 'Enable existing server installation');
  await until(async () => !(await (await fetch(new URL('/api/instances', base))).json()).instances.find(instance => instance.instanceId === 'qwen')?.runtimeRemoval?.removed, 10_000, 'explicit external runtime restore');
  stage = 'independent account profiles';
  await cardButton('cline', 'Add another account');
  await evaluate('document.querySelector("[data-provider-profiles=cline] form input").focus()');
  await send('Input.insertText', { text: 'Independent Cline account' });
  await evaluate('document.querySelector("[data-provider-profiles=cline] form").requestSubmit()');
  const profileId = await until(async () => (await (await fetch(new URL('/api/instances', base))).json()).instances.find(instance => instance.displayName === 'Independent Cline account')?.instanceId, 20_000, 'new independent account');
  await until(() => evaluate(`!!document.querySelector('[data-engine-card="${profileId}"]')`), 10_000, 'new account card');
  await evaluate(`document.querySelector('[data-engine-card="${profileId}"] > summary').click()`);
  await evaluate(`Array.from(document.querySelectorAll('[data-engine-card="${profileId}"] summary')).find(item => item.textContent.trim() === 'Manage account profile').click()`);
  await evaluate(`document.querySelector('[data-provider-profiles="${profileId}"] form input').focus(); document.querySelector('[data-provider-profiles="${profileId}"] form input').select()`);
  await send('Input.insertText', { text: 'Renamed Cline account' });
  await evaluate(`document.querySelector('[data-provider-profiles="${profileId}"] form').requestSubmit()`);
  await until(async () => (await (await fetch(new URL('/api/instances', base))).json()).instances.find(instance => instance.instanceId === profileId)?.displayName === 'Renamed Cline account', 20_000, 'renamed account');
  const profileScreenshot = join(screenshotRoot, 'hattera-account-profile.png');
  await writeFile(profileScreenshot, Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
  await cardButton(profileId, 'Remove account');
  await dialogButton('Remove account');
  await until(async () => !(await (await fetch(new URL('/api/instances', base))).json()).instances.some(instance => instance.instanceId === profileId), 20_000, 'removed account');
  if (!(await runtimeStatus()).installed || !(await runtimeStatus()).accountKept) throw new Error('Removing an account changed the shared engine or its original login');
  await evaluate('document.querySelector(\'button[aria-label="Close settings"]\').click()');
  await until(() => evaluate('!document.querySelector("[role=dialog] [data-settings-page=ai]")'), 10_000, 'Settings closure for group sharing');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const sharingResponse = await fetch(new URL('/api/groups', base), { method: 'POST', headers: { 'content-type': 'application/json', origin: base.origin }, body: JSON.stringify({ name: 'Sharing fixture group', memberIds: [createdBot.id], setup: { bulletin: '', defaultResponder: { kind: 'mentions' } } }) });
  if (sharingResponse.status !== 201) throw new Error(`Could not prepare sharing fixture: ${sharingResponse.status}`);
  const sharingGroup = (await sharingResponse.json()).group;
  await until(() => evaluate(`!!document.querySelector('[data-sidebar-group-row="${sharingGroup.id}"]')`), 10_000, 'shared group in existing sidebar');
  await evaluate(`document.querySelector('[data-sidebar-group-row="${sharingGroup.id}"]').click()`);
  await until(() => evaluate('!!document.querySelector(\'button[aria-label="Share this group"]\')'), 10_000, 'group sharing control');
  await evaluate('document.querySelector(\'button[aria-label="Share this group"]\').click()');
  const sharingPanel = 'section[aria-label="Share this group"]';
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(`${sharingPanel} input[autocomplete=name]`)})`), 10_000, 'group sharing setup');
  const startSharingState = await evaluate(`(() => { const panel = document.querySelector(${JSON.stringify(sharingPanel)}); const button = Array.from(panel.querySelectorAll('button')).find(item => item.textContent.trim() === 'Start sharing this group'); return { disabled: button?.disabled, history: panel.querySelector('input[type=checkbox]')?.checked, privateNotice: panel.innerText.includes('credentials') }; })()`);
  if (!startSharingState.disabled || startSharingState.history !== false || !startSharingState.privateNotice) throw new Error(`Sharing ignored consent or network state: ${JSON.stringify(startSharingState)}`);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pause(300);
  const sharingLayout = await evaluate(`(() => { const panel = document.querySelector(${JSON.stringify(sharingPanel)}); const rect = panel.getBoundingClientRect(); return { left: rect.left, right: rect.right, overflow: panel.scrollWidth > panel.clientWidth + 1 }; })()`);
  if (sharingLayout.left < 0 || sharingLayout.right > 390 || sharingLayout.overflow) throw new Error(`Sharing panel does not fit a phone: ${JSON.stringify(sharingLayout)}`);
  const sharingScreenshot = join(screenshotRoot, 'hattera-group-sharing-mobile.png');
  await writeFile(sharingScreenshot, Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await until(() => evaluate(`!document.querySelector(${JSON.stringify(sharingPanel)})`), 10_000, 'sharing panel keyboard closure');
  if (!(await evaluate('document.activeElement?.getAttribute("aria-label") === "Share this group"'))) throw new Error('Closing group sharing did not return keyboard focus to its trigger');
  console.log(JSON.stringify({ ok: true, checks: ['group-sharing-consent-network-mobile', 'independent-account-create-rename-remove', 'all-account-reporting', 'packaged-private-network-controls', 'chat-reply', 'opencode-model-picker', 'opencode-acp-reply', 'opencode-provider-card', 'minimax-setup-card', 'qwen-setup-card', 'codex-auth-choices', 'cline-browser-server-install', 'cline-browser-device-auth', 'engine-removal-sign-in-guard', 'engine-uninstall-cancel', 'engine-uninstall-reinstall-account-preserved', 'external-engine-disable-restore', 'bedrock-provider-setup', 'browser-navigation', 'browser-release', 'bot-settings-navigation', 'bot-browser-permission', 'bot-creation', 'bot-identity-edit', 'bot-memory-edit', 'bot-tool-selection', 'bot-skill-authoring', 'bot-approval-level', 'mobile-chat-layout', 'pairing-skin-contrast', 'remote-browser-pairing'], previewUrl: base.href, testPage, screenshots: [sharingScreenshot, profileScreenshot, accountScreenshot, mobileAccountScreenshot, networkScreenshot, mobileNetworkScreenshot, pickerScreenshot, providerScreenshot, miniMaxScreenshot, qwenScreenshot, codexScreenshot, codexCodeScreenshot, output, mobileScreenshot, darkPairScreenshot, pairScreenshot, clineAuthScreenshot] }));
} catch (error) {
  throw new Error(`Browser check failed during ${stage}: ${error.message}`, { cause: error });
} finally {
  socket?.close();
  chrome.kill();
  if (resolve(profile).startsWith(resolve(tmpdir()) + sep)) await rm(profile, { recursive: true, force: true }).catch(() => {});
}
