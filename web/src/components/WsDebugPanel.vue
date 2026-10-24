<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { fetchWsConnections } from '../api';
import type { NotifyFn, PolyMockMode, Route, ServiceInfo, WsConnectionSnapshot } from '../types';
import { serviceDisplaySuffix, wsUrl } from '../utils';

interface DebugFrame {
  ts: string;
  dir: 'out' | 'in' | 'sys';
  text: string;
}

const props = defineProps<{
  active: boolean;
  routes: Route[];
  services: ServiceInfo[];
  mode: PolyMockMode;
  mainPort: number;
  /** 外部请求选中的接口 id（卡片 ⇄ / 连接数 chip 跳转）；生效后由本组件自行清空 */
  focusRouteId?: string | null;
  notify: NotifyFn;
}>();

const emit = defineEmits<{
  /** 外部选中的接口已被消费（App 层据此复位 focusRouteId） */
  'focus-consumed': [];
}>();

const FRAME_LIMIT = 300;
const CONNECTION_POLL_MS = 2000;

/* ---------- 目标 WS 接口 ---------- */

const wsRoutes = computed(() => props.routes.filter((route) => route.protocol === 'ws'));
const selectedRouteId = ref('');
const selectedRoute = computed(() => wsRoutes.value.find((route) => route.id === selectedRouteId.value) ?? null);

/** 接口完整连接地址（含路径模式前缀），供下拉切换时回填 */
function routeWsUrl(route: Route): string {
  const svc = props.services.find((s) => s.id === route.serviceId);
  const prefix = props.mode === 'path' && svc && !svc.isDefault ? `/${svc.basePath ?? ''}` : '';
  const port = props.mode === 'path' || svc?.isDefault ? props.mainPort : svc?.port ?? props.mainPort;
  return wsUrl(port, `${prefix}${route.path}`);
}

function routeLabel(route: Route): string {
  const svc = props.services.find((s) => s.id === route.serviceId);
  const suffix = svc ? serviceDisplaySuffix(svc, props.mode) : '';
  return `${svc?.name ?? route.serviceId} · ${route.path}${route.disabled ? '（已停用）' : ''}（${suffix}）`;
}

/* ---------- 连接状态与帧时间线 ---------- */

const urlDraft = ref('');
const connState = ref<'idle' | 'connecting' | 'open' | 'closed'>('idle');
const frames = ref<DebugFrame[]>([]);
const connections = ref<WsConnectionSnapshot[]>([]);
const connectStartedAt = ref(0);

let socket: WebSocket | null = null;
/** 客户端主动断开标记：disconnect() 已记帧，onclose 不再重复补一条系统帧 */
let clientInitiatedClose = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;

function nowLabel(): string {
  return new Date().toTimeString().slice(0, 8);
}

function addFrame(dir: DebugFrame['dir'], text: string) {
  frames.value.push({ ts: nowLabel(), dir, text });
  if (frames.value.length > FRAME_LIMIT) {
    frames.value.splice(0, frames.value.length - FRAME_LIMIT);
  }
}

/* 切换接口：断开现有连接（避免帧串台）并回填地址。
   监听 id 而非 selectedRoute 的对象引用——App 轮询会整体替换 routes 数组，
   watch 对象引用会让用户正在编辑的连接地址（含 query / token）每 15 秒被重置 */
watch(selectedRouteId, (routeId) => {
  if (socket && (connState.value === 'open' || connState.value === 'connecting')) {
    disconnect(true);
  }
  const route = wsRoutes.value.find((item) => item.id === routeId);
  if (route) urlDraft.value = routeWsUrl(route);
});

function fillUrl() {
  if (selectedRoute.value) urlDraft.value = routeWsUrl(selectedRoute.value);
}

function connect() {
  const target = urlDraft.value.trim();
  if (!target) {
    props.notify('请先填写连接地址', 'err');
    return;
  }
  if (!/^wss?:\/\//.test(target)) {
    props.notify('连接地址需以 ws:// 或 wss:// 开头', 'err');
    return;
  }
  if (socket && (connState.value === 'open' || connState.value === 'connecting')) {
    props.notify('已有连接，请先断开', 'warn');
    return;
  }
  connState.value = 'connecting';
  connectStartedAt.value = Date.now();
  let opened = false;
  try {
    socket = new WebSocket(target);
  } catch (err) {
    connState.value = 'closed';
    addFrame('sys', `open 失败：${(err as Error).message}`);
    return;
  }
  socket.onopen = () => {
    opened = true;
    connState.value = 'open';
    addFrame('sys', `open 握手成功 101 · ${target}`);
  };
  socket.onmessage = (event) => {
    const text = typeof event.data === 'string' ? event.data : '[二进制帧]';
    addFrame('in', text);
  };
  socket.onclose = (event) => {
    connState.value = 'closed';
    if (!clientInitiatedClose) {
      addFrame('sys', opened ? `close ${event.code} 连接关闭` : `close ${event.code} 握手失败（未注册 / 已停用 → 404，认证失败 → 401）`);
    }
    socket = null;
    clientInitiatedClose = false;
  };
  socket.onerror = () => {
    /* close 事件随后到达，统一在 onclose 记录 */
  };
}

function disconnect(silent = false) {
  if (!socket) {
    connState.value = 'idle';
    return;
  }
  clientInitiatedClose = true;
  socket.close(1000);
  if (!silent) addFrame('sys', 'close 1000 客户端主动断开');
}

/* ---------- 发送消息 ---------- */

const sendDraft = ref('{"type":"ping"}');
const sendInvalid = computed(() => {
  const raw = sendDraft.value.trim();
  if (!raw) return false;
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
});

function send() {
  if (!socket || connState.value !== 'open') {
    props.notify('尚未连接', 'warn');
    return;
  }
  const text = sendDraft.value;
  if (!text.trim()) {
    props.notify('发送内容不能为空', 'err');
    return;
  }
  socket.send(text);
  addFrame('out', text);
}

const QUICK_FILLS: ReadonlyArray<{ label: string; text: string }> = [
  { label: '订阅示例', text: '{"type":"subscribe","channel":"orders"}' },
  { label: '非法文本示例', text: 'not-a-json' },
];

function fillQuick(text: string) {
  sendDraft.value = text;
}

/* ---------- 实时连接快照 ---------- */

async function pollConnections() {
  try {
    const data = await fetchWsConnections();
    connections.value = data.connections;
  } catch {
    /* 后端不可达时保持上一次快照 */
  }
}

/** 快照行的展示备注：与当前连接地址路径一致且建立于本次连接之后的标记为本页（path 模式需剥掉 basePath 前缀） */
function connTag(conn: WsConnectionSnapshot): string {
  const myPath = urlDraft.value.trim().replace(/^wss?:\/\/[^/]+/, '').split('?')[0];
  const svc = selectedRoute.value ? props.services.find((s) => s.id === selectedRoute.value?.serviceId) : undefined;
  const prefix = props.mode === 'path' && svc && !svc.isDefault ? `/${svc.basePath ?? ''}` : '';
  const expected = prefix && myPath.startsWith(prefix) ? myPath.slice(prefix.length) || '/' : myPath;
  if (conn.connectedAt >= connectStartedAt.value && expected && conn.path === expected) return '本页';
  return conn.remoteAddress;
}

onMounted(() => {
  selectedRouteId.value = wsRoutes.value[0]?.id ?? '';
  if (selectedRoute.value) urlDraft.value = routeWsUrl(selectedRoute.value);
  pollTimer = setInterval(() => {
    /* 页面切走或视图未激活时不轮询 */
    if (!props.active || document.hidden) return;
    void pollConnections();
  }, CONNECTION_POLL_MS);
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  disconnect(true);
});

watch(
  () => props.active,
  (active) => {
    if (active && !selectedRouteId.value) {
      selectedRouteId.value = wsRoutes.value[0]?.id ?? '';
    }
    if (active) void pollConnections();
  },
  { immediate: true },
);

/* 卡片 ⇄ / 连接数 chip 跳转：切换到指定接口并回填地址 */
watch(
  () => props.focusRouteId,
  (routeId) => {
    if (!routeId) return;
    if (wsRoutes.value.some((route) => route.id === routeId)) {
      if (socket && (connState.value === 'open' || connState.value === 'connecting')) disconnect(true);
      selectedRouteId.value = routeId;
      const route = wsRoutes.value.find((item) => item.id === routeId);
      if (route) urlDraft.value = routeWsUrl(route);
    }
    emit('focus-consumed');
  },
);
</script>

<template>
  <section id="view-ws-debug" class="view" :hidden="!active">
    <div class="layout">
      <section class="panel">
        <div class="panel-head">
          <h2>连接</h2>
          <span class="count-badge ws" :class="{ off: connState !== 'open' }">
            {{ connState === 'open' ? '已连接' : connState === 'connecting' ? '连接中…' : '未连接' }}
          </span>
        </div>
        <div class="ws-connect">
          <div class="field">
            <label for="dbg-route">目标 WS 接口</label>
            <select id="dbg-route" v-model="selectedRouteId">
              <option v-for="route in wsRoutes" :key="route.id" :value="route.id">{{ routeLabel(route) }}</option>
            </select>
          </div>
          <div class="field">
            <label for="dbg-url">连接地址</label>
            <input id="dbg-url" v-model="urlDraft" type="text" spellcheck="false" placeholder="ws://localhost:33233/ws/orders?orderId=A1001">
          </div>
          <div class="field">
            <label>&nbsp;</label>
            <button type="button" class="submit-btn" @click="connState === 'open' || connState === 'connecting' ? disconnect() : connect()">
              {{ connState === 'open' ? '断开' : connState === 'connecting' ? '连接中…' : '连接' }}
            </button>
          </div>
          <p class="full hint">
            认证与剧本在接口编辑抽屉里配置；浏览器无法携带自定义握手头，已配置认证的接口可在地址后附加 <code>?token=&lt;令牌&gt;</code>。帧时间线只保存在当前页面，不写进 HTTP 请求日志。
          </p>
        </div>
      </section>

      <p v-if="wsRoutes.length === 0" class="debug-empty hint">还没有 WS 接口——回到「接口管理」点击「＋ 新增 WS 接口」创建一个。</p>

      <div v-else class="debug-grid">
        <div class="debug-col">
          <section class="panel">
            <div class="panel-head"><h2>实时连接</h2><span class="count-badge ws">{{ connections.length }}</span></div>
            <div>
              <p v-if="connections.length === 0" class="debug-empty hint">暂无活跃连接（每 2 秒刷新）</p>
              <div v-for="conn in connections" :key="conn.id" class="conn-row">
                <span class="status-dot ws"></span>
                <span class="conn-id">{{ conn.id }}</span>
                <span>{{ connTag(conn) }}</span>
                <span class="conn-meta">↑{{ conn.framesOut }} ↓{{ conn.framesIn }}</span>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>发送消息</h2><span class="hint">JSON 自动校验</span></div>
            <div class="send-box">
              <textarea
                v-model="sendDraft"
                rows="5"
                spellcheck="false"
                :class="{ invalid: sendInvalid }"
                aria-label="发送内容"
              ></textarea>
              <div class="send-actions">
                <button type="button" class="submit-btn" @click="send">发送</button>
                <button v-for="item in QUICK_FILLS" :key="item.label" type="button" class="mini-btn" @click="fillQuick(item.text)">{{ item.label }}</button>
              </div>
              <p v-if="sendInvalid" class="field-error">不是合法 JSON：仍可发送（WS 允许任意文本），服务端按原文处理</p>
            </div>
          </section>
        </div>

        <section class="panel">
          <div class="panel-head">
            <h2>帧时间线</h2>
            <span class="label-row-ops">
              <button type="button" class="mini-btn" @click="frames = []">清空</button>
            </span>
          </div>
          <div class="frame-list">
            <p v-if="frames.length === 0" class="debug-empty hint">暂无帧——连接后 onOpen 推送、收发消息与定时推送都会出现在这里</p>
            <div v-for="(frame, i) in frames" :key="`${frame.ts}-${i}`" class="frame">
              <span class="frame-time">{{ frame.ts }}</span>
              <span class="frame-dir" :class="frame.dir">{{ frame.dir === 'sys' ? '⇄' : frame.dir === 'out' ? '↑' : '↓' }}</span>
              <span class="frame-body">{{ frame.text }}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ws-connect {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) auto;
  gap: 10px;
  padding: 14px 16px;
  align-items: end;
}

.ws-connect .field:last-of-type {
  min-width: 96px;
}

.ws-connect .full {
  grid-column: 1 / -1;
  margin: 0;
}

.debug-grid {
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.debug-col {
  display: grid;
  gap: 14px;
}

.debug-empty {
  padding: 12px 14px;
  margin: 0;
}

.conn-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
}

.conn-row:last-child {
  border-bottom: none;
}

.conn-row:hover {
  background: var(--bg-soft);
}

.conn-id {
  font-family: var(--mono);
  color: var(--text);
}

.conn-meta {
  color: var(--text-faint);
  margin-left: auto;
  font-family: var(--mono);
}

.frame-list {
  max-height: 560px;
  overflow: auto;
}

.frame {
  display: grid;
  grid-template-columns: 62px 24px minmax(0, 1fr);
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
  align-items: start;
}

.frame:hover {
  background: var(--bg-soft);
}

.frame-time {
  font-family: var(--mono);
  color: var(--text-faint);
}

.frame-dir {
  font-weight: 700;
  font-family: var(--mono);
}

.frame-dir.out {
  color: var(--accent-strong);
}

.frame-dir.in {
  color: #1f6feb;
}

.frame-dir.sys {
  color: var(--text-faint);
}

.frame-body {
  font-family: var(--mono);
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-all;
}

.send-box {
  padding: 14px 16px;
  display: grid;
  gap: 10px;
}

.send-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.send-actions .submit-btn {
  padding: 8px 22px;
  font-size: 12px;
}

@media (max-width: 1100px) {
  .debug-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .ws-connect {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
