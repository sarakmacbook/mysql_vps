const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const token = process.env.PANEL_TOKEN || crypto.randomBytes(24).toString('base64url');
const DB_TYPES = {
  mysql: {
    name: 'MySQL', image: 'mysql:8.4', port: 3306, dataPath: '/var/lib/mysql', defaultUser: 'p2p', defaultDb: 'p2p',
    description: 'The world’s most popular open-source relational database.', icon: 'MY', color: 'amber',
    env: (db, user, pass, rootPass) => ['MYSQL_ROOT_PASSWORD=' + rootPass, 'MYSQL_DATABASE=' + db, 'MYSQL_USER=' + user, 'MYSQL_PASSWORD=' + pass],
    url: (user, pass, host, port, db) => `mysql://${enc(user)}:${enc(pass)}@${host}:${port}/${enc(db)}`,
  },
  postgres: {
    name: 'PostgreSQL', image: 'postgres:17-alpine', port: 5432, dataPath: '/var/lib/postgresql/data', defaultUser: 'p2p', defaultDb: 'p2p',
    description: 'Powerful, standards-compliant relational database.', icon: 'PG', color: 'blue',
    env: (db, user, pass) => [`POSTGRES_PASSWORD=${pass}`, `POSTGRES_DB=${db}`, `POSTGRES_USER=${user}`],
    url: (user, pass, host, port, db) => `postgresql://${enc(user)}:${enc(pass)}@${host}:${port}/${enc(db)}`,
  },
  mariadb: {
    name: 'MariaDB', image: 'mariadb:11', port: 3306, dataPath: '/var/lib/mysql', defaultUser: 'p2p', defaultDb: 'p2p',
    description: 'A community-developed, MySQL-compatible database.', icon: 'MA', color: 'violet',
    env: (db, user, pass, rootPass) => [`MARIADB_ROOT_PASSWORD=${rootPass}`, `MARIADB_DATABASE=${db}`, `MARIADB_USER=${user}`, `MARIADB_PASSWORD=${pass}`],
    url: (user, pass, host, port, db) => `mysql://${enc(user)}:${enc(pass)}@${host}:${port}/${enc(db)}`,
  },
  mongodb: {
    name: 'MongoDB', image: 'mongo:8', port: 27017, dataPath: '/data/db', defaultUser: 'p2p', defaultDb: 'p2p',
    description: 'Flexible document database for modern applications.', icon: 'MG', color: 'green',
    env: (db, user, pass) => [`MONGO_INITDB_ROOT_USERNAME=${user}`, `MONGO_INITDB_ROOT_PASSWORD=${pass}`, `MONGO_INITDB_DATABASE=${db}`],
    url: (user, pass, host, port, db) => `mongodb://${enc(user)}:${enc(pass)}@${host}:${port}/${enc(db)}?authSource=admin`,
  },
  redis: {
    name: 'Redis', image: 'redis:7-alpine', port: 6379, dataPath: '/data', defaultUser: 'default', defaultDb: '0',
    description: 'In-memory data store, cache and message broker.', icon: 'RE', color: 'red',
    env: () => [], args: (pass) => ['redis-server', '--appendonly', 'yes', '--requirepass', pass],
    url: (_user, pass, host, port, db) => `redis://:${enc(pass)}@${host}:${port}/${enc(db)}`,
  },
};

function enc(value) { return encodeURIComponent(String(value)); }
function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
function docker(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Docker command timed out. Check the Docker daemon and try again.')); }, timeout);
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', err => { clearTimeout(timer); reject(new Error(err.code === 'ENOENT' ? 'Docker is not installed or is not on PATH.' : err.message)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Docker exited with status ${code}.`));
    });
  });
}
function body(req) {
  return new Promise((resolve, reject) => {
    let data = ''; req.on('data', chunk => { data += chunk; if (data.length > 16384) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('Request body must be valid JSON.')); } });
    req.on('error', reject);
  });
}
function safeName(value, label, max = 40) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) || value.length > max) throw new Error(`${label} must start with a letter or number and use only letters, numbers, underscores, and hyphens.`);
  return value;
}
function safeHost(value) {
  if (typeof value !== 'string' || value.length > 253 || !/^[a-zA-Z0-9.-]+$/.test(value) || value.startsWith('-')) throw new Error('Host must be a hostname or IP address (no protocol or port).');
  return value;
}
function sendFile(res, filename, contentType) {
  fs.readFile(path.join(ROOT, 'public', filename), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' }); res.end(data);
  });
}
async function route(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true });
  if (!pathname.startsWith('/api/')) {
    if (req.method === 'GET' && pathname === '/') return sendFile(res, 'index.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && pathname === '/app.css') return sendFile(res, 'app.css', 'text/css; charset=utf-8');
    if (req.method === 'GET' && pathname === '/app.js') return sendFile(res, 'app.js', 'text/javascript; charset=utf-8');
    res.writeHead(404); return res.end('Not found');
  }
  if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'Invalid panel access key.' });
  try {
    if (req.method === 'GET' && pathname === '/api/databases') {
      const items = Object.entries(DB_TYPES).map(([id, db]) => ({ id, name: db.name, image: db.image, port: db.port, description: db.description, icon: db.icon, color: db.color }));
      return json(res, 200, { databases: items });
    }
    if (req.method === 'GET' && pathname === '/api/installations') {
      const output = await docker(['ps', '-a', '--filter', 'label=database-panel.managed=true', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t{{.Label "database-panel.type"}}']);
      const containers = output ? output.split('\n').map(line => { const [id, name, image, state, status, ports, type] = line.split('\t'); return { id, name, image, state, status, ports, type }; }) : [];
      return json(res, 200, { installations: containers });
    }
    if (req.method === 'POST' && pathname === '/api/installations') {
      const input = await body(req);
      const db = DB_TYPES[input.type];
      if (!db) return json(res, 400, { error: 'Choose a supported database type.' });
      const name = safeName(input.name || `${input.type}-p2p`, 'Container name');
      const database = safeName(input.database || db.defaultDb, 'Database name');
      const username = safeName(input.username || db.defaultUser, 'Username');
      const host = safeHost(input.host || 'db-host');
      const port = Number(input.port || db.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return json(res, 400, { error: 'Port must be between 1 and 65535.' });
      const password = crypto.randomBytes(18).toString('base64url');
      const rootPassword = crypto.randomBytes(24).toString('base64url');
      // Create the volume separately so it is labeled for complete uninstall on every Docker version (label support since 1.13).
      await docker(['volume', 'create', '--label', 'database-panel.managed=true', '--label', `database-panel.type=${input.type}`, `${name}-data`]);
      const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped', '--label', 'database-panel.managed=true', '--label', `database-panel.type=${input.type}`, '--publish', `${port}:${db.port}`, '--volume', `${name}-data:${db.dataPath}`];
      for (const env of db.env(database, username, password, rootPassword)) args.push('--env', env);
      args.push('--env', `TZ=${process.env.TZ || 'UTC'}`);
      args.push(db.image);
      if (db.args) args.push(...db.args(password));
      let id;
      try {
        id = await docker(args);
      } catch (error) {
        // Do not leave an unused, empty labeled volume behind when the container cannot start.
        await docker(['volume', 'rm', `${name}-data`]).catch(() => {});
        throw error;
      }
      const connectionString = db.url(username, password, host, port, database);
      return json(res, 201, { id: id.slice(0, 12), name, type: input.type, database, username, password, host, port, image: db.image, connectionString, status: 'starting' });
    }
    if (req.method === 'DELETE' && pathname.startsWith('/api/installations/')) {
      const name = safeName(decodeURIComponent(pathname.slice('/api/installations/'.length)), 'Container name');
      const inspect = await docker(['inspect', '--format', '{{ index .Config.Labels "database-panel.managed" }}', name]);
      if (inspect !== 'true') return json(res, 404, { error: 'Managed database not found.' });
      await docker(['rm', '-f', name]);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'API route not found.' });
  } catch (error) { return json(res, 400, { error: error.message || 'Unexpected error.' }); }
}

const server = http.createServer((req, res) => { route(req, res).catch(error => json(res, 500, { error: error.message })); });
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Database panel listening on http://0.0.0.0:${PORT}`);
  if (!process.env.PANEL_TOKEN) console.log(`Panel access key (save this now): ${token}`);
  console.log('Set PANEL_TOKEN to keep the same access key across restarts.');
});
