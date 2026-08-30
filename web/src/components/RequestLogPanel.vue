<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { clearRequests, createRoute, fetchRequests } from '../api';
import type { NotifyFn, RequestLogEntry } from '../types';
import { routeCardStyle } from '../utils';

const props = defineProps<{
  active: boolean;
  notify: NotifyFn;
}>();

const emit = defineEmits<{
  changed: [];
}>();

const POLL_INTERVAL = 2000;

const entries = ref<RequestLogEntry[]>([]);
const expandedId = ref<string | null>(null);

let pollTimer: ReturnType<typeof setInterval> | undefined;

async function refresh() {
  try {
    const data = await fetchRequests({ limit: 200 });
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

/* 激活时拉取并轮询，失活/卸载时停止；页面隐藏时跳过本轮 */
watch(
  () => props.active,
  (active) => {
    stopPolling();
    if (active) {
      void refresh();
      pollTimer = setInterval(() => {
        if (!document.hidden) void refresh();
      }, POLL_INTERVAL);
    } else {
      expandedId.value = null;
    }
  },
  { immediate: true },
);

onBeforeUnmount(stopPolling);

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

    <div v-if="entries.length" class="log-list">
      <div class="log-head">
        <span>时间</span>
        <span>方法</span>
        <span>服务</span>
        <span>路径</span>
        <span>状态</span>
        <span>命中</span>
        <span>耗时</span>
      </div>
      <template v-for="(entry, i) in entries" :key="entry.id">
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
      <p class="empty-title">暂无请求记录，命中 Mock 的请求会显示在这里</p>
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
