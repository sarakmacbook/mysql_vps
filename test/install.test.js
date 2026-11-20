const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const python = ['python3', 'python'].find(name => spawnSync(name, ['-c', ''], { stdio: 'ignore' }).status === 0);

const probe = String.raw`
import importlib.util, json, sys, types

spec = importlib.util.spec_from_file_location('dockbase_install', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

# Simulate "curl ... | sudo python3 -" running as root on Linux.
module.__file__ = '<stdin>'
module.os.geteuid = lambda: 0
module.platform.system = lambda: 'Linux'

calls = {'fetched': False, 'commands': []}
def fake_fetch(destination):
    calls['fetched'] = True
    destination.write_text('#!/bin/sh\nexit 0\n')
module.fetch_installer = fake_fetch

def fake_run(command, env, check):
    calls['commands'].append({'command': command, 'env': env})
    return types.SimpleNamespace(returncode=0)
module.subprocess = types.SimpleNamespace(run=fake_run)

sys.argv = ['install.py', '--port', '8080', '--install-dir', sys.argv[2]]
calls['exit'] = module.main()
print(json.dumps(calls))
`;

test('piped Python installer downloads install.sh and forwards options', { skip: !python && 'python3 is not installed' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dockbase-install-test-'));
  try {
    const marker = path.join(tmp, 'local-installer-ran');
    fs.writeFileSync(path.join(tmp, 'install.sh'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    const result = spawnSync(python, ['-c', probe, path.join(repo, 'install.py'), path.join(tmp, 'target')], {
      cwd: tmp, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.equal(calls.fetched, true, 'the published installer should be downloaded');
    assert.equal(calls.exit, 0);
    assert.equal(fs.existsSync(marker), false, 'a local install.sh must never be executed in piped mode');
    assert.equal(calls.commands.length, 1);
    const [{ command, env }] = calls.commands;
    assert.equal(path.basename(command[1]), 'install.sh');
    assert.ok(command[1].includes('dockbase-installer-'), 'installer should be downloaded into a temporary directory');
    assert.equal(command[0], 'bash');
    assert.equal(env.PANEL_PORT, '8080');
    assert.equal(env.DOCKBASE_INSTALL_DIR, path.join(tmp, 'target'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
