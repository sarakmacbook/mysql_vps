const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const key = 'a-strong-first-run-access-key';
let server, base, tmp, port;

async function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), PANEL_CONFIG_FILE: path.join(tmp, 'panel-config.json') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start');
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dockbase-setup-test-'));
  port = 15000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  await startServer();
});

after(() => {
  server?.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('first-run setup creates a durable access key exactly once', async () => {
  const status = await fetch(`${base}/api/setup-status`).then(response => response.json());
  assert.deepEqual(status, { setupRequired: true });

  const tooShort = await fetch(`${base}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'short' }),
  });
  assert.equal(tooShort.status, 400);

  const setup = await fetch(`${base}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: key }),
  });
  assert.equal(setup.status, 201);
  assert.deepEqual(await setup.json(), { ok: true });

  const configPath = path.join(tmp, 'panel-config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.version, 1);
  assert.equal(config.verifier.includes(key), false, 'the raw key is not persisted');
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);

  const repeated = await fetch(`${base}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'another-key-long-enough' }),
  });
  assert.equal(repeated.status, 409);
  assert.deepEqual(await fetch(`${base}/api/setup-status`).then(response => response.json()), { setupRequired: false });
  assert.equal((await fetch(`${base}/api/databases`, { headers: { authorization: `Bearer ${key}` } })).status, 200);

  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
  await startServer();
  assert.deepEqual(await fetch(`${base}/api/setup-status`).then(response => response.json()), { setupRequired: false });
  assert.equal((await fetch(`${base}/api/databases`, { headers: { authorization: `Bearer ${key}` } })).status, 200);
});
