// Run only in the disposable ENGINES-empty container, after the public install probe.
// This obtains and cancels real vendor challenges; it never approves an account.
import assert from "node:assert/strict";

const root = "http://127.0.0.1:8799";
async function api(method, path, body) {
  const response = await fetch(root + path, { method,
    headers: { origin: root, "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(90_000),
  });
  const result = await response.json();
  assert(response.ok, `${method} ${path}: ${response.status} ${result.error ?? ""}`);
  return result;
}

const providers = {
  cline: { origins: ["https://authkit.cline.bot"], path: "/device", carriedCode: true },
  kimi: { origins: ["https://www.kimi.com", "https://www.kimi.ai"], path: "/code/authorize_device", carriedCode: true },
  cursor: { origins: ["https://cursor.com"], path: "/loginDeepControl" },
  claude: { origins: ["https://claude.ai", "https://claude.com", "https://console.anthropic.com", "https://platform.claude.com"] },
  "codex-browser": { instance: "codex", method: "browser-pkce", origins: ["https://auth.openai.com"], path: "/oauth/authorize" },
  "codex-device": { instance: "codex", method: "device-code", origins: ["https://auth.openai.com"], path: "/codex/device", code: true },
  grok: { origins: ["https://accounts.x.ai", "https://auth.x.ai", "https://grok.com", "https://accounts.grok.com"], code: true },
  antigravity: { origins: ["https://accounts.google.com"] },
};
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(providers)) {
  const provider = providers[name];
  assert(provider, `Unknown provider: ${name}`);
  const id = provider.instance ?? name;
  const instance = (await api("GET", "/api/instances")).instances.find(row => row.instanceId === id);
  assert(instance?.authentication, `${id}: missing in-app sign-in`);
  assert.equal(instance.snapshot.authenticated, false, `${id}: not an empty credential home`);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { auth } = await api("POST", `/api/instances/${id}/auth/start`, provider.method ? { method: provider.method } : {});
    try {
      assert.equal(auth.phase, "waiting", `${id}: ${auth.message ?? auth.phase}`);
      const url = new URL(auth.authorizationUrl);
      assert(provider.origins.includes(url.origin), `${name}: unexpected sign-in origin`);
      if (provider.path) assert.equal(url.pathname.replace(/\/$/, ""), provider.path);
      if (provider.code || provider.carriedCode) assert.match(auth.userCode, /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/);
      if (provider.carriedCode) {
        assert.equal(url.searchParams.get("user_code"), auth.userCode);
      }
      // A missing desktop browser launcher must not crash a headless login.
      await new Promise(resolve => setTimeout(resolve, 6000));
      const status = await api("GET", `/api/instances/${id}/auth/status?flowId=${encodeURIComponent(auth.flowId)}`);
      assert.equal(status.auth.phase, "waiting", `${id}: login died after publishing its challenge`);
    } finally {
      await api("POST", `/api/instances/${id}/auth/cancel`, { flowId: auth.flowId });
    }
    const status = await api("GET", `/api/instances/${id}/auth/status?flowId=${encodeURIComponent(auth.flowId)}`);
    assert.equal(status.auth.phase, "cancelled");
    console.log(`PASS ${name}: real challenge, wait, cancel (attempt ${attempt})`);
  }
  const after = (await api("GET", "/api/instances")).instances.find(row => row.instanceId === id);
  assert.equal(after.snapshot.authenticated, false, `${id}: cancelled login was treated as signed in`);
}
