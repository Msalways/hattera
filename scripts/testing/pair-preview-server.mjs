// Serve a built pairing page with synthetic, unauthenticated server metadata.
// Usage: node scripts/testing/pair-preview-server.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const dist = resolve('dist');
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/.well-known/openmausbot/environment') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ environmentId: 'fixture', label: 'Hattera on this server', platform: 'linux', version: 'fixture',
      capabilities: { remoteSessions: true, githubSignIn: true } }));
    return;
  }
  if (pathname === '/api/auth/session') {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Sign in to this fixture' }));
    return;
  }
  const file = resolve(dist, `.${pathname}`);
  const target = file.startsWith(dist + sep) && (await stat(file).catch(() => null))?.isFile() ? file : resolve(dist, 'index.html');
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  res.writeHead(200, { 'content-type': mime[extname(target)] ?? 'application/octet-stream' });
  res.end(await readFile(target));
});
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));
