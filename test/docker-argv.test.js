const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const key = 'test-panel-key';
let server, base, tmp, calls;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dockbase-test-'));
  calls = path.join(tmp, 'calls.log');
  const fakeDocker = path.join(tmp, 'docker');
  fs.writeFileSync(fakeDocker, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
case "$1" in
  run) echo 0123456789abcdef ;;
  inspect) echo true ;;
  *) exit 0 ;;
esac
`);
  fs.chmodSync(fakeDocker, 0o755);

  const port = 14000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), PANEL_TOKEN: key, PATH: `${tmp}:${process.env.PATH}` },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start');
});

after(() => {
  server?.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('deployment labels its data volume so it can be uninstalled completely', async () => {
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const response = await fetch(`${base}/api/installations`, { method: 'POST', headers, body: JSON.stringify({ type: 'mysql', name: 'mysql-test', host: 'db.example.com' }) });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.match(result.connectionString, /^mysql:\/\//);

  const lines = fs.readFileSync(calls, 'utf8').split('\n');
  const volume = lines.find(line => line.startsWith('volume create '));
  const run = lines.find(line => line.startsWith('run '));
  assert.ok(volume, 'docker volume create was invoked');
  assert.ok(run, 'docker run was invoked');
  // Volume labels come from `docker volume create` so old Docker versions (no volume-label mount option) also work.
  assert.match(volume, /--label database-panel\.managed=true/);
  assert.match(volume, /--label database-panel\.type=mysql/);
  assert.match(volume, /mysql-test-data$/);
  assert.match(run, /--label database-panel\.managed=true/);
  assert.match(run, /--volume mysql-test-data:\/var\/lib\/mysql/);
  assert.doesNotMatch(run, /--mount/);
});

test('removing a database only deletes the container and keeps its volume', async () => {
  const response = await fetch(`${base}/api/installations/mysql-test`, { method: 'DELETE', headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  const commands = fs.readFileSync(calls, 'utf8');
  assert.match(commands, /^rm -f mysql-test$/m);
  assert.doesNotMatch(commands, /volume rm/);
});
