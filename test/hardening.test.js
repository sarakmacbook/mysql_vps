const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const key = 'test-panel-key';
let server, base, tmp, calls;

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start');
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dockbase-hardening-test-'));
  calls = path.join(tmp, 'calls.log');
  const fakeDocker = path.join(tmp, 'docker');
  fs.writeFileSync(fakeDocker, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
case "$1" in
  run) echo 0123456789abcdef ;;
  inspect) echo true ;;
  ps) printf 'abc123\\tmysql-test\\tmysql:8.4\\trunning\\tUp 1 minute\\t0.0.0.0:3306->3306/tcp\\tmysql\\n' ;;
  *) exit 0 ;;
esac
`);
  fs.chmodSync(fakeDocker, 0o755);

  const port = 16000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), PANEL_TOKEN: key, PATH: `${tmp}:${process.env.PATH}` },
    stdio: 'ignore',
  });
  await waitReady();
});

after(() => {
  server?.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${key}` };

test('responses carry security headers', async () => {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.match(health.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  const page = await fetch(`${base}/`);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
});

test('HEAD requests return headers without a body', async () => {
  const response = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('oversized and malformed bodies are rejected with clear status codes', async () => {
  const tooLarge = await fetch(`${base}/api/installations`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'mysql', pad: 'x'.repeat(20000) }),
  });
  assert.equal(tooLarge.status, 413);

  const malformed = await fetch(`${base}/api/installations`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /valid JSON/);
});

test('container lifecycle actions call Docker and validate input', async () => {
  for (const action of ['stop', 'start', 'restart']) {
    const response = await fetch(`${base}/api/installations/mysql-test/${action}`, { method: 'POST', headers: auth });
    assert.equal(response.status, 200, action);
    assert.deepEqual(await response.json(), { ok: true, name: 'mysql-test', action });
  }
  const commands = fs.readFileSync(calls, 'utf8');
  assert.match(commands, /^stop mysql-test$/m);
  assert.match(commands, /^start mysql-test$/m);
  assert.match(commands, /^restart mysql-test$/m);

  const unknownAction = await fetch(`${base}/api/installations/mysql-test/pause`, { method: 'POST', headers: auth });
  assert.equal(unknownAction.status, 404);

  const unsafeName = await fetch(`${base}/api/installations/unsafe%20name/stop`, { method: 'POST', headers: auth });
  assert.equal(unsafeName.status, 400);
});

test('failed authentication is rate limited', async () => {
  // Use a fresh server so earlier tests do not consume the bucket.
  const port = 17000 + Math.floor(Math.random() * 1000);
  const limitedBase = `http://127.0.0.1:${port}`;
  const limited = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), PANEL_TOKEN: key },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${limitedBase}/api/health`)).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    let saw429 = false;
    for (let i = 0; i < 35; i++) {
      const response = await fetch(`${limitedBase}/api/databases`, { headers: { authorization: 'Bearer wrong-key' } });
      if (response.status === 429) { saw429 = true; break; }
      assert.equal(response.status, 401);
    }
    assert.equal(saw429, true, 'expected a 429 after repeated failed logins');
  } finally {
    limited.kill('SIGTERM');
  }
});
