const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = (() => {
  const parsed = Number(process.env.PORT || 3000);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.error(`Invalid PORT "${process.env.PORT}"; falling back to 3000.`);
    return 3000;
  }
  return parsed;
})();
const ROOT = __dirname;
const CONFIG_FILE = process.env.PANEL_CONFIG_FILE || path.join(ROOT, 'state', 'panel-config.json');
const MAX_BODY_BYTES = 16384;
const MAX_DOCKER_OUTPUT = 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

// Simple in-memory rate limiter: at most `limit` hits per `windowMs` per IP.
const rateBuckets = new Map();
function rateLimited(req, limit, windowMs) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (rateBuckets.size > 500) {
    for (const [key, value] of rateBuckets) if (now > value.reset) rateBuckets.delete(key);
  }
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + windowMs };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.reset - now) / 1000));
    return retryAfter;
  }
  return 0;
}
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
function makeCredential(value, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, verifier: crypto.scryptSync(value, salt, 32).toString('hex') };
}
function loadCredential() {
  if (process.env.PANEL_TOKEN) return makeCredential(process.env.PANEL_TOKEN);
  try {
    const stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (stored.version !== 1 || typeof stored.salt !== 'string' || !/^[a-f0-9]{32}$/.test(stored.salt) || typeof stored.verifier !== 'string' || !/^[a-f0-9]{64}$/.test(stored.verifier)) {
      throw new Error('Invalid panel setup file. Remove or repair ' + CONFIG_FILE + '.');
    }
    return { salt: stored.salt, verifier: stored.verifier };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
let credential = loadCredential();
function authorized(req) {
  const header = req.headers.authorization || '';
  if (!credential || !header.startsWith('Bearer ') || header.length > 263) return false;
  const candidate = makeCredential(header.slice(7), credential.salt).verifier;
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(credential.verifier, 'hex'));
}
function json(res, code, data) {
  const payload = JSON.stringify(data);
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
function docker(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const fail = (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => { child.kill('SIGTERM'); fail(new HttpError(502, 'Docker command timed out. Check the Docker daemon and try again.')); }, timeout);
    const append = (current, chunk) => {
      const next = current + chunk;
      if (next.length > MAX_DOCKER_OUTPUT) { child.kill('SIGTERM'); fail(new HttpError(502, 'Docker returned too much output.')); return current; }
      return next;
    };
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', err => fail(new HttpError(502, err.code === 'ENOENT' ? 'Docker is not installed or is not on PATH.' : err.message)));
    child.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else {
        const message = (stderr.trim() || `Docker exited with status ${code}.`).slice(0, 500);
        // Name/port conflicts are client errors, everything else is a Docker problem.
        if (/already in use|already allocated|is already in use/i.test(message)) reject(new HttpError(409, message));
        else if (/no such container|no such (volume|image|network)/i.test(message)) reject(new HttpError(404, message));
        else reject(new HttpError(502, message));
      }
    });
  });
}
function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    req.on('data', chunk => {
      if (settled) return; // Discard the rest so memory stays bounded.
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { fail(new HttpError(413, 'Request body is too large.')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(text || '{}')); } catch { reject(new HttpError(400, 'Request body must be valid JSON.')); }
    });
    req.on('error', fail);
  });
}
function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { throw new HttpError(400, 'URL contains invalid escape sequences.'); }
}
function safeName(value, label, max = 40) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) || value.length > max) throw new HttpError(400, `${label} must start with a letter or number and use only letters, numbers, underscores, and hyphens.`);
  return value;
}
function safeHost(value) {
  if (typeof value !== 'string' || value.length > 253 || !/^[a-zA-Z0-9.-]+$/.test(value) || value.startsWith('-')) throw new HttpError(400, 'Host must be a hostname or IP address (no protocol or port).');
  return value;
}
function sendFile(req, res, filename, contentType) {
  fs.readFile(path.join(ROOT, 'public', filename), (err, data) => {
    if (err) { res.writeHead(404, SECURITY_HEADERS); return res.end('Not found'); }
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': contentType, 'cache-control': 'no-cache', 'content-length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}
async function route(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && pathname === '/api/setup-status') return json(res, 200, { setupRequired: !credential });
  if (req.method === 'POST' && pathname === '/api/setup') {
    const retryAfter = rateLimited(req, 5, 60000);
    if (retryAfter) { res.setHeader('retry-after', String(retryAfter)); return json(res, 429, { error: 'Too many setup attempts. Try again later.' }); }
    if (credential) return json(res, 409, { error: 'Initial setup is already complete.' });
    let input;
    try { input = await body(req); } catch (error) { return json(res, error.status || 400, { error: error.message }); }
    if (typeof input.token !== 'string' || input.token.length < 16 || input.token.length > 256) {
      return json(res, 400, { error: 'Access key must be between 16 and 256 characters.' });
    }
    const created = makeCredential(input.token);
    try {
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(CONFIG_FILE, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, ...created }) + '\n'); } finally { fs.closeSync(fd); }
      fs.chmodSync(CONFIG_FILE, 0o600);
      credential = created;
      return json(res, 201, { ok: true });
    } catch (error) {
      if (error.code === 'EEXIST') {
        credential = loadCredential();
        return json(res, 409, { error: 'Initial setup is already complete.' });
      }
      return json(res, 500, { error: 'Could not save setup. Check that the panel state directory is writable.' });
    }
  }
  if (!pathname.startsWith('/api/')) {
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/') return sendFile(req, res, 'index.html', 'text/html; charset=utf-8');
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/app.css') return sendFile(req, res, 'app.css', 'text/css; charset=utf-8');
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/app.js') return sendFile(req, res, 'app.js', 'text/javascript; charset=utf-8');
    res.writeHead(404, SECURITY_HEADERS); return res.end('Not found');
  }
  if (!authorized(req)) {
    const retryAfter = rateLimited(req, 30, 60000);
    if (retryAfter) { res.setHeader('retry-after', String(retryAfter)); return json(res, 429, { error: 'Too many failed attempts. Try again later.' }); }
    return json(res, 401, { error: 'Invalid panel access key.' });
  }
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
      const name = safeName(safeDecode(pathname.slice('/api/installations/'.length)), 'Container name');
      const inspect = await docker(['inspect', '--format', '{{ index .Config.Labels "database-panel.managed" }}', name]);
      if (inspect !== 'true') return json(res, 404, { error: 'Managed database not found.' });
      await docker(['rm', '-f', name]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname.startsWith('/api/installations/')) {
      const rest = safeDecode(pathname.slice('/api/installations/'.length));
      const slash = rest.lastIndexOf('/');
      const action = slash >= 0 ? rest.slice(slash + 1) : '';
      if (!['stop', 'start', 'restart'].includes(action)) return json(res, 404, { error: 'API route not found.' });
      const name = safeName(rest.slice(0, slash), 'Container name');
      const inspect = await docker(['inspect', '--format', '{{ index .Config.Labels "database-panel.managed" }}', name]);
      if (inspect !== 'true') return json(res, 404, { error: 'Managed database not found.' });
      await docker([action, name]);
      return json(res, 200, { ok: true, name, action });
    }
    return json(res, 404, { error: 'API route not found.' });
  } catch (error) {
    if (error instanceof HttpError) return json(res, error.status, { error: error.message });
    console.error(error);
    return json(res, 500, { error: 'Unexpected error.' });
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: 'Unexpected error.' });
    else res.end();
  });
});
server.headersTimeout = 10000;
// Deployments can take a while (image pulls); the Docker timeout bounds them.
server.requestTimeout = 180000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Database panel listening on http://0.0.0.0:${PORT}`);
  console.log(credential ? 'Panel access key is configured.' : `First-run setup is available at http://0.0.0.0:${PORT}/`);
  if (process.env.PANEL_TOKEN) console.log('Panel access key is provided by PANEL_TOKEN.');
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
