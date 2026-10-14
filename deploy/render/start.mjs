import { spawn } from "node:child_process";
import { superviseServer } from "../dist-server/server-launcher.js";

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
const code = await superviseServer(() => spawn(process.execPath, ["/app/dist-server/index.js"], { stdio: "inherit" }));
if (!stopping) stopEdge("SIGTERM");
process.exitCode = edgeExitCode ?? code;
