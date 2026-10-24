<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  deleteRoute,
  deleteService,
  fetchMeta,
  fetchRoutes,
  fetchServices,
  fetchSettings,
  fetchWsConnections,
  getAdminToken,
  setAdminToken,
  updateRouteFlags,
  updateSettings,
} from './api';
import EmbedTest from './components/EmbedTest.vue';
import OpenApiImport from './components/OpenApiImport.vue';
import RequestLogPanel from './components/RequestLogPanel.vue';
import RouteForm from './components/RouteForm.vue';
import ServicePanel from './components/ServicePanel.vue';
import WsDebugPanel from './components/WsDebugPanel.vue';
import WsRouteForm from './components/WsRouteForm.vue';
import { clampDrawerWidth, clearDrawerWidth, loadDrawerWidth, saveDrawerWidth } from './utils';
import type { PolyMockMode, Route, ServiceInfo, ToastKind, ViewName, WsConnectionSnapshot } from './types';

const VIEW_KEY = 'polymock:view';
const SIDEBAR_MIN = 120;
const SIDEBAR_MAX = 480;
const POLL_INTERVAL = 15000;

/* ---------- 视图切换（localStorage 记忆） ---------- */

function readInitialView(): ViewName {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'routes' || saved === 'ws-debug' || saved === 'embed' || saved === 'logs') return saved;
  } catch {
    /* 忽略 */
  }
  return 'routes';
}

const view = ref<ViewName>(readInitialView());

function switchView(name: ViewName) {
  view.value = name;
  try {
    localStorage.setItem(VIEW_KEY, name);
  } catch {
    /* 忽略存储失败 */
  }
}

/* ---------- Toast 通知 ---------- */

let toastTimer: ReturnType<typeof setTimeout> | undefined;
const toast = ref<{ message: string; kind: ToastKind; visible: boolean }>({
  message: '',
  kind: 'ok',
  visible: false,
});

function showToast(message: string, kind: ToastKind = 'ok') {
  clearTimeout(toastTimer);
  toast.value = { message, kind, visible: true };
  toastTimer = setTimeout(() => {
    toast.value.visible = false;
  }, 2600);
}

/* ---------- 管理令牌（后端设置 POLYMOCK_ADMIN_TOKEN 时才需要） ---------- */

const tokenOpen = ref(false);
const tokenDraft = ref('');
/** 是否已保存令牌：侧边栏入口直接显示，避免用户反复试错 */
const hasToken = ref(getAdminToken() !== '');

function openTokenDialog() {
  tokenDraft.value = getAdminToken();
  tokenOpen.value = true;
}

function saveToken() {
  setAdminToken(tokenDraft.value.trim());
  hasToken.value = getAdminToken() !== '';
  tokenOpen.value = false;
  showToast(hasToken.value ? '管理令牌已保存' : '管理令牌已清除');
  /* 保存后立刻重连，覆盖此前 401 导致的数据加载失败 */
  void loadAll();
  void loadSettings();
}

function clearToken() {
  tokenDraft.value = '';
  saveToken();
}

/* ---------- 数据加载与轮询 ---------- */

const services = ref<ServiceInfo[]>([]);
const routes = ref<Route[]>([]);
/** 运行模式（后端 /meta 决定）：port 独立端口；path basePath 前缀 */
const mode = ref<PolyMockMode>('port');
const mainPort = ref(0);
const expanded = ref(new Set<string>());
const statusState = ref<boolean | null>(null); // null=连接中
const statusText = ref('连接中');
const routeCountText = ref('0 个接口');
/** WS 连接快照（侧边栏计数与卡片连接数 chip 共用） */
const wsConnections = ref<WsConnectionSnapshot[]>([]);
const wsConnectionCount = computed(() => wsConnections.value.length);
/** WS 路由 id → 活跃连接数（0 的路由不渲染 chip） */
const wsConnectionsByRoute = computed(() => {
  const map: Record<string, number> = {};
  for (const conn of wsConnections.value) {
    map[conn.routeId] = (map[conn.routeId] ?? 0) + 1;
  }
  return map;
});

let autoOpenDone = false;

async function loadServices() {
  const data = await fetchServices();
  if (!autoOpenDone) {
    autoOpenDone = true;
    for (const svc of data.services) {
      if (svc.isDefault) expanded.value.add(svc.id);
    }
  }
  services.value = data.services;
}

async function loadRoutes() {
  const data = await fetchRoutes();
  routes.value = data.routes;
}

async function loadWsConnections() {
  try {
    wsConnections.value = (await fetchWsConnections()).connections;
  } catch {
    wsConnections.value = [];
  }
}

async function loadAll() {
  try {
    const meta = await fetchMeta();
    mode.value = meta.mode;
    mainPort.value = meta.mainPort;
    await loadServices();
    await loadRoutes();
    await loadWsConnections();
    routeCountText.value = `${routes.value.length} 个接口`;
    statusState.value = true;
    statusText.value = `${routes.value.length} 个接口在线`;
  } catch {
    statusState.value = false;
    statusText.value = '服务连接失败';
  }
}

let pollTimer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  void loadAll();
  void loadSettings();
  drawerWidth.value = loadDrawerWidth(window.innerWidth);
  pollTimer = setInterval(() => {
    if (!document.hidden) void loadAll();
  }, POLL_INTERVAL);
  document.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  clearInterval(pollTimer);
  document.removeEventListener('keydown', onKeydown);
  document.body.style.overflow = '';
});

/* ---------- 服务分组操作 ---------- */

function toggleService(serviceId: string) {
  if (expanded.value.has(serviceId)) expanded.value.delete(serviceId);
  else expanded.value.add(serviceId);
}

async function removeService(svc: ServiceInfo) {
  if (!window.confirm(`删除服务「${svc.name}」及属于它的 ${svc.count} 个接口？`)) return;
  try {
    await deleteService(svc.id);
    showToast(`已删除服务「${svc.name}」`);
    void loadAll();
  } catch (err) {
    showToast((err as Error).message, 'err');
  }
}

/* ---------- 接口编辑 / 删除 ---------- */

const editingRoute = ref<Route | null>(null);
const drawerOpen = ref(false);

function openCreate() {
  editingRoute.value = null;
  drawerOpen.value = true;
}

/** 按协议分流：WS 接口走 WS 编辑抽屉，HTTP 接口走原表单 */
function editRoute(route: Route) {
  if (route.protocol === 'ws') {
    editWsRoute(route);
    return;
  }
  editingRoute.value = route;
  drawerOpen.value = true;
}

function closeDrawer() {
  drawerOpen.value = false;
  editingRoute.value = null;
}

function onFormChanged() {
  void loadAll();
  closeDrawer();
}

/* ---------- WS 接口编辑抽屉 ---------- */

const wsEditingRoute = ref<Route | null>(null);
const wsDrawerOpen = ref(false);

function openWsCreate() {
  wsEditingRoute.value = null;
  wsDrawerOpen.value = true;
}

function editWsRoute(route: Route) {
  wsEditingRoute.value = route;
  wsDrawerOpen.value = true;
}

function closeWsDrawer() {
  wsDrawerOpen.value = false;
  wsEditingRoute.value = null;
}

function onWsFormChanged() {
  void loadAll();
  closeWsDrawer();
}

/* ---------- WS 调试台跳转 ---------- */

const wsFocusRouteId = ref<string | null>(null);

function gotoWsDebug(route: Route) {
  wsFocusRouteId.value = route.id;
  switchView('ws-debug');
}

/* ---------- 抽屉宽度拖拽（左缘手柄，localStorage 记忆） ---------- */

const drawerPanelEl = ref<HTMLElement | null>(null);
const drawerRzEl = ref<HTMLElement | null>(null);
/** null = 使用 CSS 默认宽度 */
const drawerWidth = ref<number | null>(null);

function resetDrawerWidth() {
  drawerWidth.value = null;
  clearDrawerWidth();
}

function onDrawerRzDown(event: PointerEvent) {
  event.preventDefault();
  const handle = drawerRzEl.value;
  const panel = drawerPanelEl.value;
  if (!handle || !panel) return;

  const startX = event.clientX;
  const startW = drawerWidth.value ?? panel.offsetWidth;

  handle.setPointerCapture(event.pointerId);
  handle.classList.add('active');
  document.body.classList.add('drawer-resizing');

  const onMove = (ev: PointerEvent) => {
    drawerWidth.value = clampDrawerWidth(startW + (startX - ev.clientX), window.innerWidth);
  };
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    handle.classList.remove('active');
    document.body.classList.remove('drawer-resizing');
    if (drawerWidth.value !== null) saveDrawerWidth(drawerWidth.value);
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

function onDrawerRzKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const base = drawerWidth.value ?? drawerPanelEl.value?.offsetWidth ?? 0;
  if (!base) return;
  drawerWidth.value = clampDrawerWidth(base + (event.key === 'ArrowLeft' ? -16 : 16), window.innerWidth);
  saveDrawerWidth(drawerWidth.value);
}

/* ---------- OpenAPI 导入抽屉 ---------- */

const importOpen = ref(false);

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (tokenOpen.value) {
    tokenOpen.value = false;
    return;
  }
  if (importOpen.value) {
    importOpen.value = false;
    return;
  }
  if (wsDrawerOpen.value) {
    closeWsDrawer();
    return;
  }
  if (drawerOpen.value) closeDrawer();
}

/* 任一抽屉打开时锁定背景滚动 */
watch(
  () => drawerOpen.value || importOpen.value || tokenOpen.value || wsDrawerOpen.value,
  (open) => {
    document.body.style.overflow = open ? 'hidden' : '';
  },
);

/* ---------- 接口停用 / 启用 ---------- */

async function toggleDisableRoute(route: Route) {
  try {
    await updateRouteFlags(route.id, { disabled: !route.disabled });
    showToast(`${route.disabled ? '已启用' : '已停用'} ${route.method} ${route.path}`);
    void loadAll();
  } catch (err) {
    showToast((err as Error).message, 'err');
  }
}

/* ---------- 全局场景集 ---------- */

const globalVariant = ref('');

/* 当前所有接口的变体名去重列表（routes 变化后自动同步） */
const variantNames = computed(() => {
  const names = new Set<string>();
  for (const route of routes.value) {
    for (const variant of route.variants ?? []) {
      if (variant.name) names.add(variant.name);
    }
  }
  return [...names];
});

async function loadSettings() {
  try {
    const data = await fetchSettings();
    globalVariant.value = data.settings.activeVariant ?? '';
  } catch {
    /* 读取失败保持「默认响应」 */
  }
}

async function onGlobalVariantChange() {
  try {
    await updateSettings({ activeVariant: globalVariant.value || null });
    showToast('全局场景已切换');
  } catch (err) {
    showToast((err as Error).message, 'err');
  }
}

async function removeRoute(route: Route) {
  if (!window.confirm(`删除接口 ${route.method} ${route.path}？删除后无法恢复`)) return;
  try {
    await deleteRoute(route);
    showToast(`已删除 ${route.method} ${route.path}`);
    if (editingRoute.value?.id === route.id) editingRoute.value = null;
    void loadAll();
  } catch (err) {
    showToast((err as Error).message, 'err');
  }
}

/* ---------- 侧边栏宽度拖拽 ---------- */

const sidebarRzEl = ref<HTMLElement | null>(null);

function onSidebarRzDown(event: PointerEvent) {
  event.preventDefault();
  const handle = sidebarRzEl.value;
  const sidebar = handle?.closest<HTMLElement>('.sidebar');
  if (!handle || !sidebar) return;

  const startX = event.clientX;
  const startW = sidebar.offsetWidth;

  handle.setPointerCapture(event.pointerId);
  handle.classList.add('active');
  document.body.classList.add('sidebar-resizing');

  const onMove = (ev: PointerEvent) => {
    const w = Math.min(Math.max(startW + ev.clientX - startX, SIDEBAR_MIN), SIDEBAR_MAX);
    document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
  };
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    handle.classList.remove('active');
    document.body.classList.remove('sidebar-resizing');
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">◈</span>
        <div class="brand-text">
          <span class="brand-name">PolyMock</span>
          <span class="brand-sub">本地接口模拟</span>
        </div>
      </div>

      <nav class="nav" aria-label="视图切换">
        <button
          type="button"
          class="nav-item"
          :class="{ active: view === 'routes' }"
          @click="switchView('routes')"
        >
          <span class="nav-icon">⌗</span>
          <span>接口管理</span>
        </button>
        <button
          type="button"
          class="nav-item ws"
          :class="{ active: view === 'ws-debug' }"
          @click="switchView('ws-debug')"
        >
          <span class="nav-icon">⇄</span>
          <span>WS 调试台</span>
          <span v-if="wsConnectionCount > 0" class="nav-badge">{{ wsConnectionCount }}</span>
        </button>
        <button
          type="button"
          class="nav-item"
          :class="{ active: view === 'embed' }"
          @click="switchView('embed')"
        >
          <span class="nav-icon">⛶</span>
          <span>嵌入测试</span>
        </button>
        <button
          type="button"
          class="nav-item"
          :class="{ active: view === 'logs' }"
          @click="switchView('logs')"
        >
          <span class="nav-icon">≣</span>
          <span>请求日志</span>
        </button>
      </nav>

      <div class="variant-box">
        <label class="variant-label" for="global-variant">全局场景</label>
        <select id="global-variant" v-model="globalVariant" @change="onGlobalVariantChange">
          <option value="">默认响应</option>
          <option v-for="name in variantNames" :key="name" :value="name">{{ name }}</option>
        </select>
      </div>

      <div class="sidebar-foot">
        <div class="foot-row">
          <span class="status-dot" :class="{ on: statusState === true, off: statusState === false }"></span>
          <span>{{ statusText }}</span>
        </div>
        <div class="foot-row">
          <span class="status-dot ws"></span>
          <span>{{ wsConnectionCount > 0 ? `${wsConnectionCount} 个 WS 连接` : '无活跃 WS 连接' }}</span>
        </div>
        <div class="foot-row dim">
          <span>HTTP + WS</span>
          <span class="meta-sep">·</span>
          <span>{{ routeCountText }}</span>
        </div>
        <button type="button" class="token-entry" :class="{ on: hasToken }" @click="openTokenDialog">
          <span>⚿ 管理令牌</span>
          <em>{{ hasToken ? '已设置' : '未设置' }}</em>
        </button>
      </div>

      <div
        ref="sidebarRzEl"
        class="sidebar-rz"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        title="拖拽调整侧边栏宽度"
        @pointerdown="onSidebarRzDown"
      ></div>
    </aside>

    <main class="main">
      <!-- 接口管理 -->
      <section id="view-routes" class="view" :hidden="view !== 'routes'">
        <div class="layout">
          <div class="view-toolbar">
            <button type="button" class="import-openapi-btn" @click="importOpen = true">
              ⇩ 导入 OpenAPI
            </button>
            <button type="button" class="add-ws-btn" @click="openWsCreate">
              <span class="submit-plus">＋</span> 新增 WS 接口
            </button>
            <button type="button" class="add-route-btn" @click="openCreate">
              <span class="submit-plus">＋</span> 新增接口
            </button>
          </div>

          <ServicePanel
            :services="services"
            :routes="routes"
            :expanded="expanded"
            :mode="mode"
            :main-port="mainPort"
            :ws-connections="wsConnectionsByRoute"
            :notify="showToast"
            @toggle="toggleService"
            @remove="removeService"
            @edit="editRoute"
            @remove-route="removeRoute"
            @toggle-disable="toggleDisableRoute"
            @goto-debug="gotoWsDebug"
            @changed="loadAll"
          />
        </div>
      </section>

      <!-- WS 调试台 -->
      <WsDebugPanel
        :active="view === 'ws-debug'"
        :routes="routes"
        :services="services"
        :mode="mode"
        :main-port="mainPort"
        :focus-route-id="wsFocusRouteId"
        :notify="showToast"
        @focus-consumed="wsFocusRouteId = null"
      />

      <!-- 嵌入测试 -->
      <EmbedTest :active="view === 'embed'" :notify="showToast" />

      <!-- 请求日志 -->
      <section id="view-logs" class="view" :hidden="view !== 'logs'">
        <div class="layout">
          <RequestLogPanel :active="view === 'logs'" :notify="showToast" :services="services" @changed="loadAll" />
        </div>
      </section>
    </main>
  </div>

  <!-- 新增/编辑接口抽屉 -->
  <div v-show="drawerOpen">
    <div class="drawer-mask" @click="closeDrawer"></div>
    <aside
      ref="drawerPanelEl"
      class="drawer-panel"
      :style="drawerWidth === null ? undefined : { width: `${drawerWidth}px` }"
      role="dialog"
      aria-modal="true"
      aria-label="接口编辑表单"
    >
      <div
        ref="drawerRzEl"
        class="drawer-rz"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整抽屉宽度，双击恢复默认"
        title="拖拽调整宽度，双击恢复默认"
        tabindex="0"
        @pointerdown="onDrawerRzDown"
        @dblclick="resetDrawerWidth"
        @keydown="onDrawerRzKeydown"
      ></div>
      <RouteForm
        :services="services"
        :editing="editingRoute"
        :mode="mode"
        :notify="showToast"
        :active-variant="globalVariant"
        @changed="onFormChanged"
        @cancel-edit="closeDrawer"
      />
    </aside>
  </div>

  <!-- 新增/编辑 WS 接口抽屉 -->
  <div v-show="wsDrawerOpen">
    <div class="drawer-mask" @click="closeWsDrawer"></div>
    <aside
      class="drawer-panel"
      role="dialog"
      aria-modal="true"
      aria-label="WS 接口编辑表单"
    >
      <WsRouteForm
        :services="services"
        :editing="wsEditingRoute"
        :mode="mode"
        :main-port="mainPort"
        :notify="showToast"
        @changed="onWsFormChanged"
        @cancel-edit="closeWsDrawer"
      />
    </aside>
  </div>

  <!-- OpenAPI 导入抽屉 -->
  <OpenApiImport
    v-show="importOpen"
    :notify="showToast"
    :services="services"
    :mode="mode"
    @close="importOpen = false"
    @imported="loadAll"
  />

  <!-- 管理令牌设置 -->
  <div v-if="tokenOpen" class="token-mask" @click.self="tokenOpen = false">
    <div class="token-dialog" role="dialog" aria-modal="true" aria-label="管理令牌">
      <div class="token-head">
        <h2>管理令牌</h2>
        <button type="button" class="drawer-close" title="关闭" aria-label="关闭令牌设置" @click="tokenOpen = false">×</button>
      </div>
      <p class="hint">
        后端设置 <code>POLYMOCK_ADMIN_TOKEN</code> 后，管理 API 需携带该令牌。令牌只保存在本机浏览器，不会写入配置文件。
      </p>
      <label class="token-field" for="f-admin-token">
        令牌
        <input
          id="f-admin-token"
          v-model="tokenDraft"
          type="password"
          placeholder="留空表示不使用令牌"
          spellcheck="false"
          autocomplete="off"
          autofocus
        >
      </label>
      <div class="token-actions">
        <button type="button" class="token-save" @click="saveToken">保存</button>
        <button v-if="hasToken" type="button" class="token-clear" @click="clearToken">清除</button>
      </div>
    </div>
  </div>

  <div v-if="toast.visible" class="toast" :class="toast.kind">{{ toast.message }}</div>
</template>

<style scoped>
/* 视图工具条两个按钮的间距 */
.view-toolbar {
  gap: 10px;
}

/* WS 主色按钮：紫 #8250df，与 WS 卡片 / 调试台一致 */
.add-ws-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 18px;
  border: 1px solid rgba(130, 80, 223, 0.45);
  border-radius: 8px;
  cursor: pointer;
  font-family: var(--sans);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 1px;
  color: #8250df;
  background: rgba(130, 80, 223, 0.08);
  transition: filter 0.15s, background 0.15s;
}

.add-ws-btn:hover {
  filter: brightness(1.05);
  background: rgba(130, 80, 223, 0.14);
}

/* 侧边栏 WS 调试台导航项：激活态用 WS 紫 */
.nav-item.ws.active {
  background: rgba(130, 80, 223, 0.1);
  border-color: rgba(130, 80, 223, 0.35);
  color: #8250df;
}

.nav-badge {
  margin-left: auto;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(130, 80, 223, 0.12);
  color: #8250df;
}

/* 侧边栏底部 WS 连接状态点：WS 紫 */
.status-dot.ws {
  background: #8250df;
  box-shadow: 0 0 0 3px rgba(130, 80, 223, 0.12);
}

/* 次要按钮：视觉参考 .cancel-btn */
.import-openapi-btn {
  padding: 9px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: none;
  color: var(--text-dim);
  font-family: var(--sans);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.import-openapi-btn:hover {
  color: var(--text);
  border-color: var(--text-dim);
}

/* 侧边栏全局场景选择：贴在 sidebar-foot 上方 */
.variant-box {
  margin-top: auto;
  padding: 12px 14px 10px;
  border-top: 1px solid var(--line);
  display: grid;
  gap: 6px;
}

/* 原底部状态块的 auto 外边距由 variant-box 接管，保持两者贴底 */
.sidebar-foot {
  margin-top: 0;
}

.variant-label {
  font-size: 12px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--text-dim);
}

.variant-box select {
  width: 100%;
  padding: 7px 10px;
  font-size: 12px;
}

/* 侧边栏「管理令牌」入口：与状态行同字号，已设置时用强调色 */
.token-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 2px -8px -2px;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: none;
  color: var(--text-dim);
  font-family: var(--sans);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s;
}

.token-entry:hover {
  border-color: var(--line-strong);
  color: var(--text);
}

.token-entry em {
  font-style: normal;
  color: var(--text-faint);
}

.token-entry.on em {
  color: var(--accent-strong);
  font-weight: 600;
}

/* 管理令牌弹窗：仅一个输入框，居中轻量对话框 */
.token-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: rgba(28, 39, 51, 0.42);
  animation: fade-in 0.2s ease both;
}

.token-dialog {
  display: grid;
  gap: 12px;
  width: min(420px, calc(100vw - 32px));
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 18px 48px rgba(28, 39, 51, 0.18);
}

.token-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.token-head h2 {
  margin: 0;
  font-size: 14px;
  color: var(--text);
}

.token-dialog .hint {
  margin: 0;
  line-height: 1.6;
}

.token-dialog code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-soft);
  font-family: var(--mono);
  font-size: 11px;
}

.token-field {
  display: grid;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
}

.token-field input {
  font-size: 13px;
}

.token-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.token-save {
  padding: 7px 16px;
  border: 1px solid var(--accent);
  border-radius: 7px;
  background: var(--accent);
  color: #fff;
  font-family: var(--sans);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.token-save:hover {
  background: var(--accent-strong);
}

.token-clear {
  padding: 7px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: none;
  color: var(--text-dim);
  font-family: var(--sans);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.token-clear:hover {
  color: var(--danger);
  border-color: var(--danger);
}

/* 与 sidebar-foot 一致：窄屏下隐藏 */
@media (max-width: 900px) {
  .variant-box {
    display: none;
  }
}
</style>
