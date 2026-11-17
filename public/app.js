const $ = (selector) => document.querySelector(selector);
const state = { token: sessionStorage.getItem('panelToken') || '', databases: [], installations: [] };
const iconClass = id => ({ mysql: 'amber', postgres: 'blue', mariadb: 'violet', mongodb: 'green', redis: 'red' }[id] || 'amber');
const iconText = id => ({ mysql: 'MY', postgres: 'PG', mariadb: 'MA', mongodb: 'MG', redis: 'RE' }[id] || 'DB');
const names = { mysql: 'MySQL', postgres: 'PostgreSQL', mariadb: 'MariaDB', mongodb: 'MongoDB', redis: 'Redis' };
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}`, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { lock(); throw new Error(data.error || 'Access key required.'); }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function lock() {
  state.token = ''; sessionStorage.removeItem('panelToken');
  $('#login-screen').classList.remove('hidden');
}
async function unlock(token) {
  state.token = token;
  const { databases } = await api('/api/databases');
  state.databases = databases;
  sessionStorage.setItem('panelToken', token);
  $('#login-screen').classList.add('hidden');
  $('#engine-status').textContent = 'Connected · local engine';
  renderCatalog(); await refreshInstallations();
}
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2300);
}
function switchView(view) {
  $('#overview-view').classList.toggle('hidden', view !== 'overview');
  $('#databases-view').classList.toggle('hidden', view !== 'databases');
  $('#crumb').textContent = view === 'overview' ? 'Overview' : 'Databases';
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
}
function connectionFor(name) { return sessionStorage.getItem(`connection:${name}`) || ''; }
async function refreshInstallations() {
  try {
    const { installations } = await api('/api/installations');
    state.installations = installations;
    renderInstallations();
    $('#engine-status').textContent = 'Connected · local engine';
  } catch (error) {
    $('#engine-status').textContent = 'Docker unavailable';
    if (error.message !== 'Invalid panel access key.') toast(error.message);
    renderInstallations(error.message);
  }
}
function renderInstallations(error = '') {
  const list = $('#installation-list');
  $('#db-count').textContent = state.installations.length;
  $('#running-count').textContent = `(${state.installations.filter(item => item.state === 'running').length})`;
  if (error) {
    $('#empty-state').classList.add('hidden');
    list.innerHTML = `<div class="empty-state"><h3>Couldn’t reach Docker.</h3><p>${escapeHtml(error)} Check that Docker is installed and running.</p><button class="outline-btn" id="retry-docker">Try again <span>→</span></button></div>`;
    $('#retry-docker').onclick = refreshInstallations;
    return;
  }
  $('#empty-state').classList.toggle('hidden', state.installations.length > 0);
  if (!state.installations.length) { list.innerHTML = ''; return; }
  list.innerHTML = state.installations.map(item => {
    const type = item.type || (item.name.split('-')[0] || '').toLowerCase();
    const typeName = names[type] || item.image.split(':')[0].split('/').pop();
    const uri = connectionFor(item.name);
    return `<article class="installation-card"><div class="engine-icon ${iconClass(type)}">${iconText(type)}</div><div class="install-main"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.image)}</small></div><div class="connection-preview"><code title="${uri ? escapeHtml(uri) : 'Connection URL is available after deployment'}">${uri ? escapeHtml(uri) : `${escapeHtml(typeName)} · ${escapeHtml(item.status)}`}</code>${uri ? `<button class="copy-btn" data-copy="${escapeHtml(uri)}">Copy URL</button>` : ''}</div><span class="status-tag">${escapeHtml(item.state)}</span><button class="danger-btn" data-remove="${escapeHtml(item.name)}" title="Remove container (data volume is kept)">Remove</button></article>`;
  }).join('');
  list.querySelectorAll('[data-copy]').forEach(button => button.onclick = () => copy(button.dataset.copy));
  list.querySelectorAll('[data-remove]').forEach(button => button.onclick = () => confirmRemove(button.dataset.remove));
}
function renderCatalog() {
  $('#database-grid').innerHTML = state.databases.map(db => `<article class="database-card"><div class="card-top"><div class="engine-icon ${db.color}">${escapeHtml(db.icon)}</div><span class="port-label">PORT ${db.port}</span></div><h3>${escapeHtml(db.name)}</h3><p>${escapeHtml(db.description)}</p><div class="card-footer"><span class="image-tag">${escapeHtml(db.image)}</span><button class="deploy-btn" data-deploy="${db.id}">Deploy <span>↗</span></button></div></article>`).join('');
  document.querySelectorAll('[data-deploy]').forEach(button => button.onclick = () => openDeploy(button.dataset.deploy));
}
function showModal(content) {
  $('#modal-content').innerHTML = content;
  $('#modal-backdrop').classList.remove('hidden');
  $('#modal-close').onclick = closeModal;
  $('#modal-backdrop').onclick = e => { if (e.target === $('#modal-backdrop')) closeModal(); };
}
function closeModal() { $('#modal-backdrop').classList.add('hidden'); }
function openDeploy(type) {
  const db = state.databases.find(item => item.id === type);
  if (!db) return;
  showModal(`<div class="engine-icon ${db.color}">${escapeHtml(db.icon)}</div><h2 id="modal-title">Deploy ${escapeHtml(db.name)}</h2><p class="modal-subtitle">A secure password is generated automatically. The container will restart with Docker.</p><form id="deploy-form"><div class="form-grid"><div class="field"><label for="container-name">Container name</label><input id="container-name" name="name" value="${type}-p2p" required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" maxlength="40"></div><div class="field"><label for="database-name">Database name</label><input id="database-name" name="database" value="${type === 'redis' ? '0' : 'p2p'}" required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" maxlength="40"></div><div class="field"><label for="username">Username</label><input id="username" name="username" value="${type === 'redis' ? 'default' : 'p2p'}" required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" maxlength="40"></div><div class="field"><label for="port">Public port</label><input id="port" name="port" type="number" value="${db.port}" min="1" max="65535" required></div><div class="field wide"><label for="host">Connection host</label><input id="host" name="host" value="${escapeHtml(location.hostname || 'db-host')}" required><span class="field-hint">Shown in your connection URL. Use this server’s public IP or domain when connecting remotely.</span></div><div class="form-warning">⚠ The database port is published on all network interfaces. Restrict access with your VPS firewall; never expose database ports openly to the internet.</div></div><div class="modal-error" id="deploy-error"></div><div class="modal-actions"><button class="cancel-btn" type="button" id="cancel-deploy">Cancel</button><button class="primary-btn modal-submit" type="submit">Deploy container <span>↗</span></button></div></form>`);
  $('#cancel-deploy').onclick = closeModal;
  $('#deploy-form').onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries()); payload.type = type; payload.port = Number(payload.port);
    const submit = event.currentTarget.querySelector('[type="submit"]');
    submit.disabled = true; submit.textContent = 'Starting container…';
    $('#deploy-error').textContent = '';
    try {
      const result = await api('/api/installations', { method: 'POST', body: JSON.stringify(payload) });
      sessionStorage.setItem(`connection:${result.name}`, result.connectionString);
      renderResult(result); await refreshInstallations();
    } catch (error) { $('#deploy-error').textContent = error.message; submit.disabled = false; submit.innerHTML = 'Deploy container <span>↗</span>'; }
  };
}
function renderResult(result) {
  const db = state.databases.find(item => item.id === result.type);
  showModal(`<div class="result-title"><div class="engine-icon ${db.color}">${escapeHtml(db.icon)}</div><div><h2 id="modal-title">Database is launching</h2><p>${escapeHtml(result.name)} · ${escapeHtml(db.name)} · Port ${result.port}</p></div></div><div class="success-mark"><span>●</span> Container created successfully</div><div class="connection-box"><label>CONNECTION STRING</label><div class="connection-row"><code id="connection-string">${escapeHtml(result.connectionString)}</code><button id="copy-connection">Copy</button></div></div><div class="credential-grid"><div class="credential"><label>USERNAME</label><code>${escapeHtml(result.username)}</code><button data-copy="${escapeHtml(result.username)}" title="Copy username">⧉</button></div><div class="credential"><label>PASSWORD</label><code>${escapeHtml(result.password)}</code><button data-copy="${escapeHtml(result.password)}" title="Copy password">⧉</button></div><div class="credential"><label>DATABASE</label><code>${escapeHtml(result.database)}</code><button data-copy="${escapeHtml(result.database)}" title="Copy database">⧉</button></div><div class="credential"><label>IMAGE</label><code>${escapeHtml(result.image)}</code></div></div><div class="result-warning">Save this connection string somewhere secure. It is kept in this browser tab for convenience and is not stored by the server. Initial database startup may take a few seconds.</div><button class="primary-btn result-done" id="result-done">Done</button>`);
  $('#copy-connection').onclick = () => copy(result.connectionString);
  document.querySelectorAll('.credential [data-copy]').forEach(button => button.onclick = () => copy(button.dataset.copy));
  $('#result-done').onclick = () => { closeModal(); switchView('overview'); };
}
async function copy(value) {
  try { await navigator.clipboard.writeText(value); toast('Copied to clipboard'); }
  catch { const input = document.createElement('textarea'); input.value = value; document.body.append(input); input.select(); document.execCommand('copy'); input.remove(); toast('Copied to clipboard'); }
}
async function confirmRemove(name) {
  if (!confirm(`Remove the ${name} container? Its Docker volume and data will be kept.`)) return;
  try { await api(`/api/installations/${encodeURIComponent(name)}`, { method: 'DELETE' }); sessionStorage.removeItem(`connection:${name}`); toast('Container removed. Data volume was kept.'); await refreshInstallations(); }
  catch (error) { toast(error.message); }
}
$('#login-form').onsubmit = async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button');
  button.disabled = true; $('#login-error').textContent = '';
  try { await unlock($('#panel-token').value.trim()); }
  catch (error) { $('#login-error').textContent = error.message; }
  finally { button.disabled = false; }
};
$('#logout').onclick = lock;
document.querySelectorAll('.nav-item').forEach(item => item.onclick = () => switchView(item.dataset.view));
['top-install', 'hero-install', 'empty-install'].forEach(id => $('#' + id).onclick = () => switchView('databases'));
$('#refresh').onclick = refreshInstallations;
$('#server-time').textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date());
if (state.token) unlock(state.token).catch(() => { $('#login-screen').classList.remove('hidden'); });
else $('#login-screen').classList.remove('hidden');
