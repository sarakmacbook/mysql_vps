const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

let server, base;
const key = 'test-panel-key';
before(async () => {
  const port = 13000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), PANEL_TOKEN: key }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start');
});
after(() => server?.kill('SIGTERM'));

test('health endpoint responds without panel credentials', async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
test('database catalog requires key and includes common engines', async () => {
  assert.equal((await fetch(`${base}/api/databases`)).status, 401);
  const response = await fetch(`${base}/api/databases`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  const { databases } = await response.json();
  assert.deepEqual(databases.map(db => db.id), ['mysql', 'postgres', 'mariadb', 'mongodb', 'redis']);
});
test('deployment rejects unknown engines and unsafe names before Docker is called', async () => {
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const unknown = await fetch(`${base}/api/installations`, { method: 'POST', headers, body: JSON.stringify({ type: 'sqlite' }) });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /supported database/);
  const unsafe = await fetch(`${base}/api/installations`, { method: 'POST', headers, body: JSON.stringify({ type: 'mysql', name: 'unsafe name' }) });
  assert.equal(unsafe.status, 400);
  assert.match((await unsafe.json()).error, /Container name/);
});
