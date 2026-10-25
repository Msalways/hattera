// Browser click from localhost must reach the server's GitHub start route on the callback origin.
// Usage: node scripts/testing/github-origin-browser.mjs BROWSER_EXE [ISOLATED_DOCKER_URL]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

const [executable, dockerUrl] = process.argv.slice(2);
if (!executable) throw new Error('Pass an Edge or Chrome executable');
if (dockerUrl && (new URL(dockerUrl).hostname !== '127.0.0.1' || !new URL(dockerUrl).port)) throw new Error('The Docker fixture URL must be loopback with a port');
const profile = await mkdtemp(join(tmpdir(), 'hattera-github-browser-'));
const dist = resolve('dist');
const starts = [];
const pairAttempts = [];
let canonical = dockerUrl ? new URL(dockerUrl).origin : undefined;
const server = dockerUrl ? null : createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/.well-known/openmausbot/environment') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ environmentId: 'fixture', label: 'GitHub fixture', platform: 'win32', version: 'fixture',
      githubSignInOrigin: canonical, capabilities: { remoteSessions: true, selfUpdate: 'operator', githubSignIn: true } }));
    return;
  }
  if (pathname === '/api/auth/session') {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Sign in to this fixture' }));
    return;
  }
  if (pathname === '/api/auth/pair') {
    pairAttempts.push(pathname);
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Self-hosted fixture requires sign-in' }));
    return;
  }
  if (pathname === '/identity/start/github' && req.method === 'GET') {
    starts.push({ host: req.headers.host, path: pathname });
    res.writeHead(303, { location: `${canonical}/identity/mock-started` });
    res.end();
    return;
  }
  if (pathname === '/identity/mock-started') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>GitHub OAuth started</title>');
    return;
  }
  const file = resolve(dist, `.${pathname}`);
  const target = file.startsWith(dist + sep) && (await stat(file).catch(() => null))?.isFile() ? file : resolve(dist, 'index.html');
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'content-type': mime[extname(target)] ?? 'application/octet-stream' });
  res.end(await readFile(target));
});
if (server) {
  await new Promise((done) => server.listen(0, done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server has no port');
  canonical = `http://127.0.0.1:${address.port}`;
}
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
  const visited = [];
  socket.onmessage = ({ data }) => {
    const reply = JSON.parse(data);
    if (reply.method === 'Network.requestWillBeSent') visited.push(reply.params.request.url);
    if (!reply.id || !pending.has(reply.id)) return;
    pending.get(reply.id)(reply);
    pending.delete(reply.id);
  };
  const send = (method, params = {}) => new Promise((done, fail) => {
    const call = ++id;
    pending.set(call, (reply) => reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.result));
    socket.send(JSON.stringify({ id: call, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const until = async (check) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`GitHub sign-in did not start; requests: ${JSON.stringify({ starts, visited: visited.slice(-12) })}`);
  };
  await send('Page.enable');
  await send('Network.enable');
  if (dockerUrl) await send('Network.setBlockedURLs', { urls: ['*github.com*'] });
  else {
    await send('Page.navigate', { url: `${canonical}/pair?github=state` });
    await until(() => evaluate('document.querySelector("[role=alert]")?.textContent?.includes("lost its browser session") ?? false'));
  }
  await send('Page.navigate', { url: `${canonical}/pair?cli=1#code=ABCD-EFGH-JK23` });
  await until(() => evaluate('!!Array.from(document.querySelectorAll("button")).find(button => button.textContent?.trim() === "Sign in with GitHub")'));
  await new Promise(done => setTimeout(done, 1000));
  if (pairAttempts.length || visited.some(url => new URL(url).pathname === '/api/auth/pair')) throw new Error('A CLI URL flag attempted automatic authentication on self-hosting');
  const from = dockerUrl ? canonical : `http://localhost:${new URL(canonical).port}`;
  for (let attempt = 1; attempt <= (dockerUrl ? 2 : 1); attempt++) {
    await send('Page.navigate', { url: `${from}/` });
    await until(() => evaluate('!!Array.from(document.querySelectorAll("button")).find(button => button.textContent?.trim() === "Sign in with GitHub")'));
    await evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent?.trim() === "Sign in with GitHub").click()');
    if (dockerUrl) {
      await until(() => visited.filter((url) => url.includes('/identity/start/github')).length === attempt);
      await until(() => visited.filter((url) => url.startsWith('https://github.com/login/oauth/authorize?')).length === attempt);
      const cookies = (await send('Network.getCookies', { urls: [canonical] })).cookies;
      if (!cookies.some((cookie) => cookie.name === 'better-auth.state')) throw new Error('The GitHub OAuth state cookie was not stored');
    } else await until(() => starts.length === 1);
  }
  if (!dockerUrl) {
    const [start] = starts;
    if (start.host !== new URL(canonical).host || start.path !== '/identity/start/github') {
      throw new Error(`OAuth started on the wrong origin: ${JSON.stringify(start)}`);
    }
  }
  console.log(JSON.stringify({ ok: true, from, callbackOrigin: canonical, starts: dockerUrl ? 2 : starts.length, cliUrlCannotSkipSelfHostedLogin: true }));
} finally {
  socket?.close();
  browser.kill();
  if (server) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  if (resolve(profile).startsWith(resolve(tmpdir()) + sep)) await rm(profile, { recursive: true, force: true }).catch(() => {});
}
