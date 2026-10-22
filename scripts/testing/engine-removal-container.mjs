// Run ONLY in a disposable container with its own /data volume and no network.
// Mount this file read-only; `serve` seeds synthetic data and starts the image.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

assert.equal(process.env.HATTERA_REMOVAL_FIXTURE, '1', 'Refusing to change a non-fixture server');
assert.equal(process.platform, 'linux');
const base = '/data/.openmausbot';
const slot = join(base, 'tools/engines/cline');
const account = '/data/.cline/data/settings/providers.json';
const receipt = JSON.stringify({ version: 1, lastUsedProvider: 'openai-compatible', providers: {
  'openai-compatible': { settings: { provider: 'openai-compatible', model: 'fixture-model', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1' } },
} });
const marker = join(base, 'tools/removed-engines/cline.json');
const phase = process.argv[2];
if (phase === 'serve') {
  const seeded = '/data/removal-fixture-seeded';
  if (!existsSync(seeded)) {
    const version = randomUUID();
    mkdirSync(join(slot, version, 'bin'), { recursive: true });
    writeFileSync(join(slot, version, 'bin/cline'), '#!/bin/sh\necho hattera-removal-fixture-1.0.0\n', { mode: 0o755 });
    writeFileSync(join(slot, 'active.json'), JSON.stringify({ version }));
    mkdirSync('/data/.cline/data/settings', { recursive: true });
    writeFileSync(account, receipt, { mode: 0o600 });
    writeFileSync(seeded, 'synthetic data only');
  }
  await import('/app/render/start.mjs');
} else {
  const api = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:8799${path}`, { method,
      signal: AbortSignal.timeout(120_000),
      headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
  };
  const instance = data => data.instances.find(item => item.instanceId === 'cline');
  if (phase === 'remove') {
    const before = instance(await api('GET', '/api/instances'));
    assert.equal(before.runtimeRemoval.managed, true);
    const configPath = join(base, 'config.json');
    const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
    const bots = JSON.stringify(await api('GET', '/api/bots'));
    const removed = instance(await api('POST', '/api/instances/cline/uninstall', { confirm: true }));
    assert.equal(removed.runtimeRemoval.removed, true);
    assert.equal(existsSync(slot), false);
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(configPath) ? readFileSync(configPath, 'utf8') : null, config);
    assert.equal(JSON.stringify(await api('GET', '/api/bots')), bots);
  } else if (phase === 'restore') {
    const disabled = instance(await api('GET', '/api/instances'));
    assert.equal(disabled.runtimeRemoval.removed, true);
    assert.equal(disabled.snapshot.state, 'unavailable');
    assert.deepEqual(disabled.models.options, []);
    // The real image-bundled binary remains. It cannot bypass the marker.
    assert.match(execFileSync('cline', ['--version'], { encoding: 'utf8' }), /\d+\.\d+/);
    const restored = instance(await api('POST', '/api/instances/cline/restore-runtime', {}));
    assert.equal(restored.runtimeRemoval.removed, false);
    assert.equal(restored.runtimeRemoval.managed, false);
    assert.equal(restored.snapshot.state, 'available');
    assert.equal(existsSync(marker), false);
  } else throw new Error('Use serve, remove, or restore');
  assert.equal(readFileSync(account, 'utf8'), receipt);
  console.log(JSON.stringify({ ok: true, phase, credentialsKept: true, syntheticData: true }));
}
