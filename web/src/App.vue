<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { deleteRoute, deleteService, fetchRoutes, fetchServices } from './api';
import EmbedTest from './components/EmbedTest.vue';
import RouteForm from './components/RouteForm.vue';
import ServicePanel from './components/ServicePanel.vue';
import type { Route, ServiceInfo, ToastKind, ViewName } from './types';
import { routeUrl } from './utils';

const VIEW_KEY = 'polymock:view';
const SIDEBAR_MIN = 120;
const SIDEBAR_MAX = 480;
const POLL_INTERVAL = 15000;

/* ---------- 视图切换（localStorage 记忆） ---------- */

function readInitialView(): ViewName {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'routes' || saved === 'embed') return saved;
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

/* ---------- 数据加载与轮询 ---------- */

const services = ref<ServiceInfo[]>([]);
const routes = ref<Route[]>([]);
const expanded = ref(new Set<string>());
const statusState = ref<boolean | null>(null); // null=连接中
const statusText = ref('连接中');
const routeCountText = ref('0 个接口');

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

async function loadAll() {
  try {
    await loadServices();
    await loadRoutes();
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

function editRoute(route: Route) {
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

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && drawerOpen.value) closeDrawer();
}

/* 抽屉打开时锁定背景滚动 */
watch(drawerOpen, (open) => {
  document.body.style.overflow = open ? 'hidden' : '';
});

/* 从接口卡片直达嵌入测试：切换视图并加载该接口地址 */
const embedView = ref<InstanceType<typeof EmbedTest> | null>(null);

function testRoute(route: Route) {
  const svc = services.value.find((s) => s.id === route.serviceId);
  if (!svc) return;
  switchView('embed');
  embedView.value?.loadUrl(routeUrl(svc.port, route.path));
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
          class="nav-item"
          :class="{ active: view === 'embed' }"
          @click="switchView('embed')"
        >
          <span class="nav-icon">⛶</span>
          <span>嵌入测试</span>
        </button>
      </nav>

      <div class="sidebar-foot">
        <div class="foot-row">
          <span class="status-dot" :class="{ on: statusState === true, off: statusState === false }"></span>
          <span>{{ statusText }}</span>
        </div>
        <div class="foot-row dim">
          <span>HTTP 协议</span>
          <span class="meta-sep">·</span>
          <span>{{ routeCountText }}</span>
        </div>
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
            <button type="button" class="add-route-btn" @click="openCreate">
              <span class="submit-plus">＋</span> 新增接口
            </button>
          </div>

          <ServicePanel
            :services="services"
            :routes="routes"
            :expanded="expanded"
            :notify="showToast"
            @toggle="toggleService"
            @remove="removeService"
            @edit="editRoute"
            @remove-route="removeRoute"
            @test="testRoute"
            @changed="loadAll"
          />
        </div>
      </section>

      <!-- 嵌入测试 -->
      <EmbedTest ref="embedView" :active="view === 'embed'" :notify="showToast" />
    </main>
  </div>

  <!-- 新增/编辑接口抽屉 -->
  <div v-show="drawerOpen">
    <div class="drawer-mask" @click="closeDrawer"></div>
    <aside class="drawer-panel" role="dialog" aria-modal="true" aria-label="接口编辑表单">
      <RouteForm
        :services="services"
        :editing="editingRoute"
        :notify="showToast"
        @changed="onFormChanged"
        @cancel-edit="closeDrawer"
      />
    </aside>
  </div>

  <div v-if="toast.visible" class="toast" :class="toast.kind">{{ toast.message }}</div>
</template>
