const METHOD_COLORS = {
  GET: '#0e9f5d',
  POST: '#1f6feb',
  PUT: '#b7791f',
  PATCH: '#8250df',
  DELETE: '#cf222e',
};

const $ = (sel) => document.querySelector(sel);

const servicesEl = $('#services');
const svcCount = $('#svc-count');
const routeCount = $('#route-count');
const routeForm = $('#route-form');
const serviceForm = $('#service-form');
const bodyInput = $('#f-body');
const bodyError = $('#body-error');
const statusDot = $('#status-dot');
const statusText = $('#status-text');
const toastEl = $('#toast');

let services = [];
let routesCache = [];
let editingId = null;
let expanded = new Set();
let autoOpenDone = false;
let lastStateJson = '';
let toastTimer;

function showToast(message, kind = 'ok') {
  toastEl.textContent = message;
  toastEl.className = `toast ${kind}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function formatBody(body) {
  if (body === undefined) return '{}';
  if (typeof body === 'string') return body;
  return JSON.stringify(body, null, 2);
}

function setStatus(ok, text) {
  statusDot.className = `status-dot ${ok ? 'on' : 'off'}`;
  statusText.textContent = text;
}

/* ---------- 服务分组（内含接口列表） ---------- */

function renderServiceSelect() {
  const sel = $('#f-service');
  const current = sel.value;
  sel.innerHTML = services
    .map((s) => `<option value="${s.id}">${escapeHtml(s.name)} :${s.port}</option>`)
    .join('');
  if (current && services.some((s) => s.id === current)) sel.value = current;
}

function toggleService(id) {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  render();
}

function buildRouteCard(route, index) {
  const color = METHOD_COLORS[route.method] || '#5b6b7c';

  const card = document.createElement('article');
  card.className = 'route-card';
  card.style.setProperty('--method-color', color);
  card.style.animationDelay = `${Math.min(index * 40, 240)}ms`;

  const statusClass = route.response.status >= 400 ? 'bad' : '';
  const bodyPreview = formatBody(route.response.body);

  card.innerHTML = `
    ${route.name ? `<div class="route-title" title="${escapeHtml(route.name)}">${escapeHtml(route.name)}</div>` : ''}
    <div class="route-row">
      <span class="method-badge">${route.method}</span>
      <span class="route-path" title="${escapeHtml(route.path)}">${escapeHtml(route.path)}</span>
      <button class="route-edit" title="编辑接口" aria-label="编辑 ${route.method} ${route.path}">✎</button>
      <button class="route-remove" title="删除接口" aria-label="删除 ${route.method} ${route.path}">×</button>
    </div>
    <div class="route-meta">
      <span class="route-status ${statusClass}">HTTP ${route.response.status}</span>
      <span>application/json</span>
    </div>
    <pre class="route-body">${escapeHtml(bodyPreview)}</pre>
  `;

  card.querySelector('.route-edit').addEventListener('click', () => editRoute(route));
  card.querySelector('.route-remove').addEventListener('click', () => removeRoute(route));
  return card;
}

function render() {
  svcCount.textContent = services.length;

  const routesByService = new Map();
  for (const route of routesCache) {
    const list = routesByService.get(route.serviceId) ?? [];
    list.push(route);
    routesByService.set(route.serviceId, list);
  }

  servicesEl.innerHTML = '';
  for (const svc of services) {
    const routes = routesByService.get(svc.id) ?? [];
    const open = expanded.has(svc.id);

    const card = document.createElement('div');
    card.className = `service-card${open ? ' open' : ''}`;
    card.innerHTML = `
      <div class="service-head">
        <button type="button" class="service-toggle" aria-expanded="${open}">
          <span class="chevron">▸</span>
          <span class="service-main">
            <span class="service-name-row">
              <span class="service-name" title="${escapeHtml(svc.name)}">${escapeHtml(svc.name)}</span>
              ${svc.isDefault ? '<span class="service-tag">默认</span>' : ''}
            </span>
            <span class="service-port">:${svc.port}</span>
          </span>
          <span class="service-meta">
            <span class="service-dot ${svc.running ? 'on' : 'off'}" title="${svc.running ? '监听中' : '未监听'}"></span>
            <span>${routes.length} 个接口</span>
          </span>
        </button>
        ${svc.isDefault ? '<span class="service-remove-ph" aria-hidden="true"></span>' : '<button type="button" class="service-remove" title="删除服务及其接口">×</button>'}
      </div>
      <div class="service-routes"${open ? '' : ' hidden'}>
        ${routes.length === 0 ? '<p class="service-empty">该服务下还没有接口，可在右侧表单添加</p>' : ''}
      </div>
    `;

    card.querySelector('.service-toggle').addEventListener('click', () => toggleService(svc.id));
    const removeBtn = card.querySelector('.service-remove');
    if (removeBtn) removeBtn.addEventListener('click', () => removeService(svc));

    const routesEl = card.querySelector('.service-routes');
    routes.forEach((route, i) => routesEl.appendChild(buildRouteCard(route, i)));
    servicesEl.appendChild(card);
  }

  renderServiceSelect();
}

function renderIfChanged() {
  const json = JSON.stringify({ services, routes: routesCache });
  if (json === lastStateJson) return;
  lastStateJson = json;
  render();
}

async function loadServices() {
  const data = await api('/__polymock/services');
  if (!autoOpenDone) {
    autoOpenDone = true;
    for (const svc of data.services) {
      if (svc.isDefault) expanded.add(svc.id);
    }
  }
  services = data.services;
}

async function loadRoutes() {
  const data = await api('/__polymock/routes');
  routesCache = data.routes;
}

async function removeService(svc) {
  if (!confirm(`删除服务「${svc.name}」及属于它的 ${svc.count} 个接口？`)) return;
  try {
    await api(`/__polymock/services/${encodeURIComponent(svc.id)}`, { method: 'DELETE' });
    showToast(`已删除服务「${svc.name}」`);
    loadAll();
  } catch (err) {
    showToast(err.message, 'err');
  }
}

serviceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('#s-name').value.trim();
  const port = Number($('#s-port').value);

  if (!name) {
    showToast('请输入服务名称', 'err');
    return;
  }
  if (!port || port < 1 || port > 65535) {
    showToast('请输入 1-65535 之间的端口', 'err');
    return;
  }

  try {
    await api('/__polymock/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, port }),
    });
    serviceForm.reset();
    showToast(`已新增服务「${name}」(:${port})`);
    loadAll();
  } catch (err) {
    showToast(err.message, 'err');
  }
});

/* ---------- 编辑 ---------- */

function editRoute(route) {
  editingId = route.id;
  const sel = $('#f-service');
  if (services.some((s) => s.id === route.serviceId)) sel.value = route.serviceId;
  $('#f-name').value = route.name ?? '';
  $('#f-method').value = route.method;
  $('#f-path').value = route.path;
  $('#f-status').value = route.response.status;
  bodyInput.value = formatBody(route.response.body);
  bodyInput.classList.remove('invalid');
  bodyError.hidden = true;
  $('#submit-btn').innerHTML = '<span class="submit-plus">✓</span> 保存修改';
  $('#cancel-btn').hidden = false;
  $('#f-path').focus();
}

function resetForm() {
  const keepService = $('#f-service').value;
  editingId = null;
  routeForm.reset();
  $('#f-service').value = keepService;
  $('#f-status').value = '200';
  $('#submit-btn').innerHTML = '<span class="submit-plus">＋</span> 注册接口';
  $('#cancel-btn').hidden = true;
  bodyInput.classList.remove('invalid');
  bodyError.hidden = true;
}

$('#cancel-btn').addEventListener('click', resetForm);

async function removeRoute(route) {
  const query = new URLSearchParams({ method: route.method, path: route.path, serviceId: route.serviceId });
  try {
    await api(`/__polymock/routes?${query}`, { method: 'DELETE' });
    showToast(`已删除 ${route.method} ${route.path}`);
    loadAll();
  } catch (err) {
    showToast(err.message, 'err');
  }
}

routeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const serviceId = $('#f-service').value;
  const name = $('#f-name').value.trim();
  const method = $('#f-method').value;
  const path = $('#f-path').value.trim();
  const status = Number($('#f-status').value) || 200;

  if (!path.startsWith('/')) {
    showToast('path 必须以 / 开头', 'err');
    return;
  }

  if (!editingId && !name) {
    showToast('请输入接口名称', 'err');
    return;
  }

  const rawBody = bodyInput.value.trim();
  if (rawBody) {
    try {
      JSON.parse(rawBody);
      bodyInput.classList.remove('invalid');
      bodyError.hidden = true;
    } catch {
      bodyInput.classList.add('invalid');
      bodyError.hidden = false;
      showToast('body 不是合法的 JSON', 'err');
      return;
    }
  }

  const submitBtn = routeForm.querySelector('.submit-btn');
  submitBtn.disabled = true;
  try {
    const payload = { serviceId, method, path, response: { status, body: rawBody } };
    if (!editingId) payload.name = name;
    else if (name) payload.name = name;
    const url = editingId ? `/__polymock/routes/${editingId}` : '/__polymock/routes';
    await api(url, {
      method: editingId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    showToast(editingId ? `已更新 ${method} ${path}` : `已注册 ${method} ${path}`);
    resetForm();
    loadAll();
    $('#f-path').focus();
  } catch (err) {
    showToast(err.message, 'err');
  } finally {
    submitBtn.disabled = false;
  }
});

/* ---------- 视图切换 ---------- */

const VIEW_KEY = 'polymock:view';
const viewSections = {
  routes: $('#view-routes'),
  embed: $('#view-embed'),
};

function switchView(name) {
  if (!viewSections[name]) return;
  for (const [key, el] of Object.entries(viewSections)) el.hidden = key !== name;
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  try { localStorage.setItem(VIEW_KEY, name); } catch { /* 忽略存储失败 */ }
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    switchView(btn.dataset.view);
    if (btn.dataset.view === 'embed' && !embedBox.hidden) {
      clampEmbedSize();
      updateEmbedSizeLabel();
    }
  });
});

let initialView = 'routes';
try { initialView = localStorage.getItem(VIEW_KEY) || 'routes'; } catch { /* 忽略 */ }
switchView(initialView);

/* ---------- 嵌入测试 ---------- */

const embedForm = $('#embed-form');
const embedUrlInput = $('#embed-url');
const embedFrame = $('#embed-frame');
const embedBox = $('#embed-frame-box');
const embedEmpty = $('#embed-empty');
const embedSize = $('#embed-size');
const embedNote = $('#embed-note');
const embedOpenBtn = $('#embed-open');
const embedCloseBtn = $('#embed-close');
const embedStage = $('#embed-stage');

const EMBED_MIN_W = 320;
const EMBED_MIN_H = 240;

let currentEmbedUrl = '';

function normalizeUrl(raw) {
  const value = raw.trim();
  if (!value) return '';
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`;
}

function updateEmbedSizeLabel() {
  embedSize.textContent = `${embedBox.offsetWidth} × ${embedBox.offsetHeight}`;
}

function embedMaxSize() {
  const pad = getComputedStyle(embedStage);
  const padX = parseFloat(pad.paddingLeft) + parseFloat(pad.paddingRight);
  const padY = parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom);
  return {
    maxW: Math.max(EMBED_MIN_W, embedStage.clientWidth - padX),
    maxH: Math.max(EMBED_MIN_H, embedStage.clientHeight - padY),
  };
}

function clampEmbedSize() {
  const { maxW, maxH } = embedMaxSize();
  const w = Math.min(Math.max(embedBox.offsetWidth, EMBED_MIN_W), maxW);
  const h = Math.min(Math.max(embedBox.offsetHeight, EMBED_MIN_H), maxH);
  embedBox.style.width = `${w}px`;
  embedBox.style.height = `${h}px`;
}

embedForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = normalizeUrl(embedUrlInput.value);
  if (!url) {
    showToast('请输入要嵌入的页面地址', 'err');
    return;
  }
  currentEmbedUrl = url;
  embedFrame.src = url;
  embedEmpty.hidden = true;
  embedBox.hidden = false;
  embedNote.hidden = false;
  embedOpenBtn.hidden = false;
  clampEmbedSize();
  updateEmbedSizeLabel();
});

embedOpenBtn.addEventListener('click', () => {
  if (currentEmbedUrl) window.open(currentEmbedUrl, '_blank', 'noopener');
});

$('#embed-fill').addEventListener('click', () => {
  const { maxW, maxH } = embedMaxSize();
  embedBox.style.width = `${maxW}px`;
  embedBox.style.height = `${maxH}px`;
  updateEmbedSizeLabel();
});

embedCloseBtn.addEventListener('click', () => {
  embedFrame.src = 'about:blank';
  currentEmbedUrl = '';
  embedBox.hidden = true;
  embedEmpty.hidden = false;
  embedNote.hidden = true;
  embedOpenBtn.hidden = true;
});

document.querySelectorAll('.rz').forEach((handle) => {
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const dir = handle.dataset.dir;
    const startX = event.clientX;
    const startY = event.clientY;
    const startW = embedBox.offsetWidth;
    const startH = embedBox.offsetHeight;
    const { maxW, maxH } = embedMaxSize();

    handle.setPointerCapture(event.pointerId);
    embedBox.classList.add('resizing');

    const onMove = (ev) => {
      if (dir.includes('e')) {
        const w = Math.min(Math.max(startW + ev.clientX - startX, EMBED_MIN_W), maxW);
        embedBox.style.width = `${w}px`;
      }
      if (dir.includes('s')) {
        const h = Math.min(Math.max(startH + ev.clientY - startY, EMBED_MIN_H), maxH);
        embedBox.style.height = `${h}px`;
      }
      updateEmbedSizeLabel();
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      embedBox.classList.remove('resizing');
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
});

window.addEventListener('resize', () => {
  if (!embedBox.hidden && !viewSections.embed.hidden) {
    clampEmbedSize();
    updateEmbedSizeLabel();
  }
});

/* ---------- 侧边栏宽度拖拽 ---------- */

const SIDEBAR_MIN = 120;
const SIDEBAR_MAX = 480;
const sidebarRz = $('#sidebar-rz');

sidebarRz.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  const startX = event.clientX;
  const startW = document.querySelector('.sidebar').offsetWidth;

  sidebarRz.setPointerCapture(event.pointerId);
  sidebarRz.classList.add('active');
  document.body.classList.add('sidebar-resizing');

  const onMove = (ev) => {
    const w = Math.min(Math.max(startW + ev.clientX - startX, SIDEBAR_MIN), SIDEBAR_MAX);
    document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
  };
  const onUp = () => {
    sidebarRz.removeEventListener('pointermove', onMove);
    sidebarRz.removeEventListener('pointerup', onUp);
    sidebarRz.removeEventListener('pointercancel', onUp);
    sidebarRz.classList.remove('active');
    document.body.classList.remove('sidebar-resizing');
  };
  sidebarRz.addEventListener('pointermove', onMove);
  sidebarRz.addEventListener('pointerup', onUp);
  sidebarRz.addEventListener('pointercancel', onUp);
});

/* ---------- 启动 ---------- */

async function loadAll() {
  try {
    await loadServices();
    await loadRoutes();
    routeCount.textContent = `${routesCache.length} 个接口`;
    setStatus(true, `${routesCache.length} 个接口在线`);
    renderIfChanged();
  } catch (err) {
    setStatus(false, '服务连接失败');
  }
}

loadAll();
setInterval(() => { if (!document.hidden) loadAll(); }, 15000);