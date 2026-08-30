<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { clearRequests, createRoute, fetchRequests, getAdminToken } from '../api';
import type { NotifyFn, RequestLogEntry, ServiceInfo } from '../types';
import { buildCurl, copyText, routeCardStyle } from '../utils';

const props = defineProps<{
  active: boolean;
  notify: NotifyFn;
  /** 服务列表：用于服务过滤下拉与「复制 curl」取端口；缺省 []（App.vue 接线时传入） */
  services?: ServiceInfo[];
}>();

const emit = defineEmits<{
  changed: [];
}>();

const POLL_INTERVAL = 2000;
/* 日志条数上限：与 fetchRequests 的 limit 一致 */
const LOG_LIMIT = 200;

const entries = ref<RequestLogEntry[]>([]);
const expandedId = ref<string | null>(null);

let pollTimer: ReturnType<typeof setInterval> | undefined;

/* 服务列表（prop 缺省时为空数组） */
const serviceList = computed(() => props.services ?? []);

/* ---------- 过滤（纯客户端） ---------- */

const filterStatus = ref<'all' | '2' | '4' | '5'>('all');
const filterService = ref('all');
const filterKeyword = ref('');

const filteredEntries = computed(() => {
  const keyword = filterKeyword.value.trim().toLowerCase();
  return entries.value.filter((entry) => {
    if (filterStatus.value !== 'all' && !String(entry.status).startsWith(filterStatus.value)) return false;
    if (filterService.value !== 'all' && entry.serviceId !== filterService.value) return false;
    if (keyword && !entry.path.toLowerCase().includes(keyword)) return false;
    return true;
  });
});

async function refresh() {
  try {
    const data = await fetchRequests({ limit: LOG_LIMIT });
    /* 保证新→旧展示顺序 */
    entries.value = [...data.requests].sort((a, b) => b.ts - a.ts);
  } catch {
    /* 拉取失败静默跳过，等待下一轮轮询 */
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!document.hidden) void refresh();
  }, POLL_INTERVAL);
}

/* ---------- SSE 实时推送（不可用时回落轮询） ---------- */

/* true = SSE 已连接（实时），false = 轮询模式 */
const liveMode = ref(false);
let eventSource: EventSource | undefined;

/** 尝试建立 SSE 连接；onopen 标记「实时」并停轮询，onerror 关闭并回落 2s 轮询 */
function connectEvents() {
  if (typeof EventSource === 'undefined') return;
  try {
    const params = new URLSearchParams({ limit: String(LOG_LIMIT) });
    const token = getAdminToken();
    if (token) params.set('token', token);
    const es = new EventSource(`/__polymock/events?${params.toString()}`);
    es.addEventListener('log', (event) => {
      try {
        const entry = JSON.parse((event as MessageEvent).data) as RequestLogEntry;
        /* 按 id 去重后前插（事件即最新），超出上限裁剪 */
        if (!entry?.id || entries.value.some((item) => item.id === entry.id)) return;
        entries.value = [entry, ...entries.value].slice(0, LOG_LIMIT);
      } catch {
        /* 忽略无法解析的事件帧 */
      }
    });
    es.onopen = () => {
      liveMode.value = true;
      stopPolling();
    };
    es.onerror = () => {
      /* 端点不存在 / 断连：关闭连接并回落到轮询 */
      closeEvents();
      liveMode.value = false;
      startPolling();
    };
    eventSource = es;
  } catch {
    /* 构造失败保持轮询模式 */
  }
}

function closeEvents() {
  eventSource?.close();
  eventSource = undefined;
}

/* 激活时拉取一次并优先尝试 SSE（失败自动回落轮询），失活/卸载时停止；页面隐藏时跳过轮询 */
watch(
  () => props.active,
  (active) => {
    stopPolling();
    closeEvents();
    if (active) {
      void refresh();
      startPolling();
      connectEvents();
    } else {
      expandedId.value = null;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  stopPolling();
  closeEvents();
});

/* ---------- 展示辅助 ---------- */

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 命中列文案：场景变体 / 默认响应 / 代理穿透 / 未命中 */
function hitText(entry: RequestLogEntry): string {
  if (entry.matched) return entry.matched.variant ? `场景·${entry.matched.variant}` : '默认响应';
  return entry.proxied ? '代理穿透' : '未命中';
}

function queryEntries(entry: RequestLogEntry): Array<[string, string]> {
  return Object.entries(entry.query ?? {});
}

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id;
}

/* ---------- 重放 / 复制 curl ---------- */

const replayingId = ref<string | null>(null);

/** 仅 GET 且非代理穿透的记录可重放 */
function canReplay(entry: RequestLogEntry): boolean {
  return entry.method === 'GET' && !entry.proxied;
}

/** 重放：按记录的路径与 query 重新发送 GET，提示状态码与耗时后刷新列表 */
async function replay(entry: RequestLogEntry) {
  if (!canReplay(entry) || replayingId.value) return;
  replayingId.value = entry.id;
  const started = performance.now();
  try {
    const query = new URLSearchParams(entry.query ?? {}).toString();
    const res = await fetch(`${location.origin}${entry.path}${query ? `?${query}` : ''}`);
    const cost = Math.round(performance.now() - started);
    props.notify(`重放 ${entry.path}：${res.status}（${cost} ms）`, res.ok ? 'ok' : 'err');
    await refresh();
  } catch (err) {
    props.notify(`重放失败：${(err as Error).message}`, 'err');
  } finally {
    replayingId.value = null;
  }
}

/** 复制该条日志的 curl：端口优先取所属服务配置，取不到回落当前页面端口 */
async function copyCurl(entry: RequestLogEntry) {
  const fallbackPort = Number(location.port) || 80;
  const port = serviceList.value.find((svc) => svc.id === entry.serviceId)?.port ?? fallbackPort;
  const query = new URLSearchParams(entry.query ?? {}).toString();
  const url = `http://${location.hostname}:${port}${entry.path}${query ? `?${query}` : ''}`;
  const ok = await copyText(buildCurl(url, entry.method));
  props.notify(ok ? '已复制 curl' : '复制失败，请手动复制', ok ? 'ok' : 'err');
}

/* ---------- 清空 / 保存为接口 ---------- */

async function clearAll() {
  if (!window.confirm('清空全部请求记录？')) return;
  try {
    await clearRequests();
    expandedId.value = null;
    await refresh();
    props.notify('已清空请求记录');
  } catch (err) {
    props.notify((err as Error).message, 'err');
  }
}

/** 把代理响应原文录制为新接口（服务/方法/路径取自该条日志） */
async function saveAsRoute(entry: RequestLogEntry) {
  if (!entry.proxyBody) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.proxyBody);
  } catch {
    props.notify('响应原文不是合法 JSON，无法保存为接口', 'err');
    return;
  }
  try {
    await createRoute({
      serviceId: entry.serviceId,
      method: entry.method,
      path: entry.path,
      name: `${entry.method} ${entry.path}（录制）`,
      response: {
        status: entry.proxyStatus ?? 200,
        body: JSON.stringify(parsed),
      },
    });
    props.notify(`已保存 ${entry.method} ${entry.path} 为接口`);
    emit('changed');
  } catch (err) {
    props.notify((err as Error).message, 'err');
  }
}
</script>

<template>
  <section class="panel logs-panel">
    <header class="panel-head">
      <h2>请求日志</h2>
      <div class="head-ops">
        <span class="count-badge">{{ entries.length }}</span>
        <button type="button" class="mini-btn" :disabled="!entries.length" @click="clearAll">清空</button>
      </div>
    </header>

    <!-- 过滤行：状态 / 服务 / 路径关键字（纯客户端过滤），右侧为实时模式标记 -->
    <div class="log-filters">
      <select v-model="filterStatus" class="filter-select" aria-label="按状态过滤">
        <option value="all">全部状态</option>
        <option value="2">2xx</option>
        <option value="4">4xx</option>
        <option value="5">5xx</option>
      </select>
      <select v-model="filterService" class="filter-select" aria-label="按服务过滤">
        <option value="all">全部服务</option>
        <option v-for="svc in serviceList" :key="svc.id" :value="svc.id">{{ svc.name }}</option>
      </select>
      <input v-model="filterKeyword" class="filter-keyword" type="text" placeholder="按路径过滤，如 /api/users" spellcheck="false">
      <span class="live-badge" :class="{ on: liveMode }" :title="liveMode ? 'SSE 实时推送已连接' : '按 2s 轮询刷新'">
        {{ liveMode ? '实时' : '轮询' }}
      </span>
    </div>

    <div v-if="filteredEntries.length" class="log-list">
      <div class="log-head">
        <span>时间</span>
        <span>方法</span>
        <span>服务</span>
        <span>路径</span>
        <span>状态</span>
        <span>命中</span>
        <span>耗时</span>
      </div>
      <template v-for="(entry, i) in filteredEntries" :key="entry.id">
        <button
          type="button"
          class="log-row"
          :class="{ open: expandedId === entry.id }"
          :style="routeCardStyle(entry.method, i)"
          :title="expandedId === entry.id ? '收起详情' : '展开详情'"
          @click="toggleExpand(entry.id)"
        >
          <span class="log-time">{{ formatTime(entry.ts) }}</span>
          <span class="method-badge">{{ entry.method }}</span>
          <span class="log-service" :title="entry.serviceId">{{ entry.serviceId }}</span>
          <span class="log-path" :title="entry.path">{{ entry.path }}</span>
          <span class="route-status" :class="{ bad: entry.status >= 400 }">{{ entry.status }}</span>
          <span class="log-hit" :class="{ miss: !entry.matched && !entry.proxied }">{{ hitText(entry) }}</span>
          <span class="log-dur">{{ entry.durationMs }} ms</span>
        </button>
        <div v-if="expandedId === entry.id" class="log-detail">
          <div class="detail-head-row">
            <span class="detail-label">操作</span>
            <div class="detail-ops">
              <button
                v-if="canReplay(entry)"
                type="button"
                class="mini-btn"
                :disabled="replayingId === entry.id"
                @click="replay(entry)"
              >
                {{ replayingId === entry.id ? '重放中…' : '重放' }}
              </button>
              <button type="button" class="mini-btn" @click="copyCurl(entry)">复制 curl</button>
            </div>
          </div>
          <div v-if="queryEntries(entry).length" class="detail-block">
            <span class="detail-label">Query</span>
            <div class="detail-chips">
              <span v-for="[key, value] in queryEntries(entry)" :key="key" class="detail-chip">{{ key }}={{ value }}</span>
            </div>
          </div>
          <div v-if="entry.bodyPreview" class="detail-block">
            <span class="detail-label">请求 Body</span>
            <pre class="detail-pre">{{ entry.bodyPreview }}</pre>
          </div>
          <div v-if="entry.error" class="detail-block">
            <span class="detail-label">错误</span>
            <p class="detail-error">{{ entry.error }}</p>
          </div>
          <div v-if="entry.proxied && entry.proxyBody" class="detail-block">
            <div class="detail-head-row">
              <span class="detail-label">响应原文</span>
              <button type="button" class="mini-btn" @click="saveAsRoute(entry)">保存为接口</button>
            </div>
            <pre class="detail-pre">{{ entry.proxyBody }}</pre>
          </div>
        </div>
      </template>
    </div>

    <div v-else class="log-empty">
      <div class="empty-glyph">≣</div>
      <p class="empty-title">{{ entries.length ? '没有符合过滤条件的记录' : '暂无请求记录，命中 Mock 的请求会显示在这里' }}</p>
    </div>
  </section>
</template>

<style scoped>
.head-ops {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mini-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ---------- 过滤行（状态 / 服务 / 路径关键字 + 实时标记） ---------- */
.log-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
}

.filter-select {
  flex: none;
  width: auto;
  padding: 6px 8px;
  font-size: 12px;
}

.filter-keyword {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  font-size: 12px;
}

.live-badge {
  flex: none;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--bg-soft);
  color: var(--text-faint);
  font-size: 11px;
  white-space: nowrap;
}

.live-badge.on {
  color: var(--accent-strong);
  border-color: rgba(14, 159, 93, 0.35);
  background: var(--accent-dim);
}

/* 详情操作按钮行（重放 / 复制 curl） */
.detail-ops {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ---------- 日志表格（grid 布局） ---------- */
.log-head,
.log-row {
  display: grid;
  grid-template-columns: 76px 72px 96px minmax(0, 1fr) 52px 112px 72px;
  gap: 10px;
  align-items: center;
}

.log-head {
  padding: 9px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-soft);
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--text-faint);
}

.log-row {
  width: 100%;
  padding: 9px 14px;
  border: none;
  border-bottom: 1px solid var(--line);
  background: none;
  color: inherit;
  font-family: var(--mono);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
}

.log-row:hover,
.log-row.open {
  background: var(--bg-soft);
}

.log-row .method-badge {
  justify-self: start;
}

.log-time,
.log-dur {
  color: var(--text-faint);
  font-size: 11px;
  white-space: nowrap;
}

.log-service {
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-path {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-hit {
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-hit.miss {
  color: var(--danger);
}

/* ---------- 展开详情 ---------- */
.log-detail {
  display: grid;
  gap: 12px;
  padding: 10px 14px 14px 24px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-soft);
}

.detail-block {
  display: grid;
  gap: 6px;
}

.detail-label {
  font-size: 11px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--text-dim);
}

.detail-head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.detail-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.detail-chip {
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--line);
  background: var(--bg);
  font-size: 11px;
  color: var(--text-dim);
  word-break: break-all;
}

.detail-pre {
  max-height: 200px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px dashed var(--line-strong);
  background: var(--bg);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
}

.detail-error {
  font-size: 12px;
  color: var(--danger);
}

/* ---------- 空状态 ---------- */
.log-empty {
  text-align: center;
  padding: 48px 20px;
}
</style>
