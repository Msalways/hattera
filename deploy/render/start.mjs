import { spawn } from "node:child_process";

const publicUrl = process.env.RENDER_EXTERNAL_URL;
if (!publicUrl?.startsWith("https://")) {
  console.error("Render must provide RENDER_EXTERNAL_URL as an HTTPS origin.");
  process.exit(1);
}
process.env.OMB_PUBLIC_URL = publicUrl;
process.env.OMB_WEBHOOK_PUBLIC_URL = publicUrl;
process.env.GITHUB_REDIRECT_URI = `${publicUrl}/identity/callback/github`;

const children = [
  spawn("caddy", ["run", "--config", "/app/render/Caddyfile", "--adapter", "caddyfile"], { stdio: "inherit" }),
  spawn(process.execPath, ["/app/dist-server/server-launcher.js"], { stdio: "inherit" }),
];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const child of children) {
  child.on("error", (error) => { console.error(error); stop(1); });
  child.on("exit", (code) => stop(code ?? 1));
}
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
