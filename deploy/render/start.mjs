import { spawn } from "node:child_process";
import { superviseServer } from "../dist-server/server-launcher.js";

// This entry point always hosts a server, even when invoked from a terminal.
delete process.env.OMB_LOCAL_CLI;
process.env.OMB_LOOPBACK_TRUST ??= "service";

const publicUrl = process.env.RENDER_EXTERNAL_URL;
const onRender = process.env.RENDER === "true" || Boolean(publicUrl);
if (onRender && !publicUrl?.startsWith("https://")) {
  console.error("Render must provide RENDER_EXTERNAL_URL as an HTTPS origin.");
  process.exit(1);
}
if (onRender) {
  process.env.OMB_PUBLIC_URL = publicUrl;
  process.env.OMB_WEBHOOK_PUBLIC_URL = publicUrl;
  process.env.GITHUB_REDIRECT_URI = `${publicUrl}/identity/callback/github`;
}

const edge = onRender
  ? spawn("caddy", ["run", "--config", "/app/render/Caddyfile", "--adapter", "caddyfile"], { stdio: "inherit" })
  : null;
let stopping = false;
let edgeExitCode = null;
function stopEdge(signal) {
  stopping = true;
  edge?.kill(signal);
}
process.on("SIGTERM", () => stopEdge("SIGTERM"));
process.on("SIGINT", () => stopEdge("SIGINT"));
if (edge) {
  edge.on("error", (error) => {
    console.error(error);
    edgeExitCode = 1;
    if (!stopping) process.kill(process.pid, "SIGTERM");
  });
  edge.on("exit", (code) => {
    if (stopping) return;
    edgeExitCode = code || 1;
    process.kill(process.pid, "SIGTERM");
  });
}
// Keep Caddy and the restart supervisor in one Node process. A separate
// launcher costs tens of MB that OpenCode needs on a 512 MB Render instance.
// A non-GitHub self-hosted install still needs its first pairing code. Reuse
// serve's private stdin bootstrap rather than granting the browser local owner
// access. GitHub/Render hosting keeps its existing direct server supervisor.
const entry = !onRender && !process.env.GITHUB_CLIENT_ID
  ? ["/app/dist-server/hattera.js", "serve", "--no-open"]
  : ["/app/dist-server/index.js"];
const code = await superviseServer(() => spawn(process.execPath, entry, { stdio: "inherit" }));
if (!stopping) stopEdge("SIGTERM");
process.exitCode = edgeExitCode ?? code;
