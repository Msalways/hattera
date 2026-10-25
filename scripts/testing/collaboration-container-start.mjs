// Disposable demo only. Separate homes, real OpenCode, simulated VPN transport.
import { createServer, request } from "node:http";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const names = ["alice", "bob", "chris"];
const index = names.indexOf(process.env.TEAM_PERSON);
if (index < 0) throw new Error("Choose an explicit fixture person.");
const home = "/data/profile";
mkdirSync(`${home}/private-network/state`, { recursive: true });
mkdirSync("/data/project", { recursive: true });
if (!existsSync(`${home}/config.json`)) writeFileSync(`${home}/config.json`, JSON.stringify({
  instances: { opencode: { driver: "opencodeGo", displayName: `${names[index]} OpenCode`, config: { cli: "/usr/local/bin/opencode" } } },
}));
writeFileSync(`${home}/private-network/state/fixture.json`, JSON.stringify({
  origin: `http://100.65.0.${index + 1}`,
  peers: Object.fromEntries(names.map((_, peer) => [`http://100.65.0.${peer + 1}`, `http://127.0.0.1:${19011 + peer}`])),
}));
// The existing fixture helper only dials loopback. These fixed forwards carry
// its signed/encrypted packets across this run's isolated Docker bridge.
for (const [peer, name] of names.entries()) {
  createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/collaboration/peer") { res.writeHead(403).end(); return; }
    forward(req, res, name, 8080);
  }).listen(19011 + peer, "127.0.0.1");
}
function forward(req, res, hostname, port) {
  const outgoing = request({ hostname, port, method: req.method, path: req.url, headers: req.headers }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  outgoing.on("error", () => { if (!res.headersSent) res.writeHead(502, {"content-type":"application/json"}); res.end('{"error":"Fixture peer unavailable"}'); });
  req.pipe(outgoing);
}
// Browser ingress remains remote: pair it normally. It never acquires the
// loopback administrator authority used by the local test controller.
createServer((req, res) => {
  req.headers["x-forwarded-for"] = req.socket.remoteAddress ?? "192.0.2.1";
  req.headers["x-forwarded-proto"] = "http";
  forward(req, res, "127.0.0.1", 8799);
}).listen(8080, "0.0.0.0");
const environment = { ...process.env, HOME: "/data", OMB_DATA_DIR: home, OMB_PORT: "8799", OMB_WEBHOOK_PORT: "8800",
  OMB_STATIC_DIR: "/app/dist", OMB_NETWORK_HELPER: "/fixture/peer", OMB_TAILSCALE_ENABLED: "1" };
// Exercise the real launcher; it must establish CLI mode itself.
for (const key of ["OMB_LOCAL_CLI", "OMB_LOOPBACK_TRUST", "OMB_PERSISTENT_WEB"]) delete environment[key];
const args = ["/app/dist-server/hattera.js", "web", "--cli-only", "--json", "--data-dir", home, "--port", "8799"];
console.log(`CLI launch: node ${args.join(" ")}`);
const child = spawn(process.execPath, args, {
  env: environment,
  stdio: ["ignore", "pipe", "inherit"],
});
let output = "";
child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
child.on("error", error => { console.error(error); process.exit(1); });
child.on("exit", code => {
  if (code !== 0) process.exit(code ?? 1);
  try { if (!Number.isInteger(JSON.parse(output.trim()).pid)) throw new Error("Missing CLI runtime receipt"); }
  catch (error) { console.error(error); process.exit(1); }
  // The launcher exits after starting its daemon. These proxy servers keep
  // PID 1 alive; stop the exact daemon through its normal API on Docker stop.
});
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  child.kill(signal);
  void (async () => {
    const file = `${home}/hattera-runtime.json`;
    try {
      const runtime = JSON.parse(readFileSync(file, "utf8"));
      await fetch("http://127.0.0.1:8799/api/local-runtime/stop", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ pid: runtime.pid, environmentId: runtime.environmentId }), signal: AbortSignal.timeout(5000) });
      const deadline = Date.now() + 5000;
      while (existsSync(file) && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
    } catch { /* Docker still owns and terminates only this fixture's processes. */ }
    process.exit(0);
  })();
});
