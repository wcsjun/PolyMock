const METHOD_COLORS = {
  GET: '#3ddc84',
  POST: '#58a6ff',
  PUT: '#f0a63e',
  PATCH: '#bc8cff',
  DELETE: '#f85149',
};

const $ = (sel) => document.querySelector(sel);

const routesEl = $('#routes');
const emptyEl = $('#empty');
const countBadge = $('#count-badge');
const routeCount = $('#route-count');
const form = $('#route-form');
const bodyInput = $('#f-body');
const bodyError = $('#body-error');
const statusDot = $('#status-dot');
const statusText = $('#status-text');
const toastEl = $('#toast');

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

function formatBody(body) {
  if (body === undefined) return '{}';
  if (typeof body === 'string') return body;
  return JSON.stringify(body, null, 2);
}

function renderRoutes(routes) {
  routesEl.innerHTML = '';
  emptyEl.hidden = routes.length > 0;

  routes.forEach((route, i) => {
    const color = METHOD_COLORS[route.method] || '#7c8a9c';

    const card = document.createElement('article');
    card.className = 'route-card';
    card.style.setProperty('--method-color', color);
    card.style.animationDelay = `${Math.min(i * 40, 240)}ms`;

    const statusClass = route.response.status >= 400 ? 'bad' : '';
    const bodyPreview = formatBody(route.response.body);

    card.innerHTML = `
      <div class="route-row">
        <span class="method-badge">${route.method}</span>
        <span class="route-path" title="${route.path}">${escapeHtml(route.path)}</span>
        <button class="route-remove" title="删除接口" aria-label="删除 ${route.method} ${route.path}">×</button>
      </div>
      <div class="route-meta">
        <span class="route-status ${statusClass}">HTTP ${route.response.status}</span>
        <span>application/json</span>
      </div>
      <pre class="route-body">${escapeHtml(bodyPreview)}</pre>
    `;

    card.querySelector('.route-remove').addEventListener('click', () => removeRoute(route));
    routesEl.appendChild(card);
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

async function loadRoutes() {
  try {
    const data = await api('/__polymock/routes');
    renderRoutes(data.routes);
    countBadge.textContent = data.routes.length;
    routeCount.textContent = `${data.routes.length} 个接口`;
    setStatus(true, `${data.routes.length} 个接口在线`);
  } catch (err) {
    setStatus(false, '服务连接失败');
  }
}

function setStatus(ok, text) {
  statusDot.className = `status-dot ${ok ? 'on' : 'off'}`;
  statusText.textContent = text;
}

async function removeRoute(route) {
  const query = new URLSearchParams({ method: route.method, path: route.path });
  try {
    await api(`/__polymock/routes?${query}`, { method: 'DELETE' });
    showToast(`已删除 ${route.method} ${route.path}`);
    loadRoutes();
  } catch (err) {
    showToast(err.message, 'err');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const method = $('#f-method').value;
  const path = $('#f-path').value.trim();
  const status = Number($('#f-status').value) || 200;

  if (!path.startsWith('/')) {
    showToast('path 必须以 / 开头', 'err');
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

  const submitBtn = form.querySelector('.submit-btn');
  submitBtn.disabled = true;
  try {
    await api('/__polymock/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, path, response: { status, body: rawBody } }),
    });
    form.reset();
    $('#f-status').value = '200';
    showToast(`已注册 ${method} ${path}`);
    loadRoutes();
    $('#f-path').focus();
  } catch (err) {
    showToast(err.message, 'err');
  } finally {
    submitBtn.disabled = false;
  }
});

loadRoutes();
setInterval(loadRoutes, 15000);
