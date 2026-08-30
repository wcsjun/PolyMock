<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { NotifyFn, Route } from '../types';
import { buildCurl, buildFetchSnippet, conditionSummary, copyText, formatBody, routeCardStyle, routeUrl } from '../utils';

const props = defineProps<{
  route: Route;
  index: number;
  port: number;
  notify: NotifyFn;
}>();

const emit = defineEmits<{
  edit: [route: Route];
  remove: [route: Route];
  /** 拨动卡片上的停用开关时触发（不调 API，由 App 层负责持久化与刷新） */
  'toggle-disable': [route: Route];
}>();

const cardStyle = computed(() => routeCardStyle(props.route.method, props.index));
const bodyPreview = computed(() => formatBody(props.route.response.body));
const variants = computed(() => props.route.variants ?? []);

/* ---------- 复制菜单：地址 / curl / fetch ---------- */

type CopyKind = 'url' | 'curl' | 'fetch';

/** 各菜单项复制成功后的提示文案 */
const COPY_SUCCESS: Record<CopyKind, string> = {
  url: '已复制地址',
  curl: '已复制 curl',
  fetch: '已复制 fetch 代码',
};

const copyMenuOpen = ref(false);
const copyWrap = ref<HTMLElement | null>(null);

function toggleCopyMenu() {
  copyMenuOpen.value = !copyMenuOpen.value;
}

/** 按菜单项复制对应片段并提示 */
async function copySnippet(kind: CopyKind) {
  copyMenuOpen.value = false;
  const url = routeUrl(props.port, props.route.path);
  const text = kind === 'url' ? url
    : kind === 'curl' ? buildCurl(url, props.route.method)
    : buildFetchSnippet(url, props.route.method);
  const ok = await copyText(text);
  props.notify(ok ? COPY_SUCCESS[kind] : '复制失败，请手动复制', ok ? 'ok' : 'err');
}

/* 点击菜单外部 / 按 Esc 时关闭；监听在 onBeforeUnmount 清理 */
function onDocPointerDown(event: MouseEvent) {
  if (copyMenuOpen.value && !copyWrap.value?.contains(event.target as Node)) {
    copyMenuOpen.value = false;
  }
}

function onDocKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') copyMenuOpen.value = false;
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onDocKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('keydown', onDocKeydown);
});

/* 浏览器只能直接发起 GET，其余方法不提供此入口 */
const canOpenInBrowser = computed(() => props.route.method === 'GET');

function openInBrowser() {
  window.open(routeUrl(props.port, props.route.path), '_blank', 'noopener');
}
</script>

<template>
  <article class="route-card" :class="{ 'disabled-card': route.disabled === true }" :style="cardStyle">
    <div v-if="route.name" class="route-title" :title="route.name">{{ route.name }}</div>
    <div class="route-row">
      <span class="method-badge">{{ route.method }}</span>
      <span class="route-path" :title="route.path">{{ route.path }}</span>
      <span ref="copyWrap" class="route-copy-wrap">
        <button
          type="button"
          class="route-copy"
          title="复制地址 / curl / fetch"
          aria-haspopup="menu"
          :aria-expanded="copyMenuOpen"
          :aria-label="`复制 ${route.method} ${route.path} 的地址或代码片段`"
          @click="toggleCopyMenu"
        >
          ⧉
        </button>
        <div v-if="copyMenuOpen" class="copy-menu" role="menu">
          <button type="button" role="menuitem" @click="copySnippet('url')">复制地址</button>
          <button type="button" role="menuitem" @click="copySnippet('curl')">复制 curl</button>
          <button type="button" role="menuitem" @click="copySnippet('fetch')">复制 fetch</button>
        </div>
      </span>
      <button
        v-if="canOpenInBrowser"
        type="button"
        class="route-test"
        title="在新标签页打开（GET）"
        :aria-label="`在新标签页打开 ${route.method} ${route.path}`"
        @click="openInBrowser"
      >
        ↗
      </button>
      <button
        type="button"
        class="route-edit"
        title="编辑接口"
        :aria-label="`编辑 ${route.method} ${route.path}`"
        @click="emit('edit', route)"
      >
        ✎
      </button>
      <button
        type="button"
        class="route-remove"
        title="删除接口"
        :aria-label="`删除 ${route.method} ${route.path}`"
        @click="emit('remove', route)"
      >
        ×
      </button>
    </div>
    <div class="route-meta">
      <span class="route-status" :class="{ bad: route.response.status >= 400 }">HTTP {{ route.response.status }}</span>
      <span>application/json</span>
      <span v-if="variants.length" class="route-chip">{{ variants.length }} 个变体</span>
      <span v-if="route.requireMatch" class="route-chip guard">需匹配</span>
      <span v-if="route.disabled" class="route-chip off">已停用</span>
      <span v-if="route.delayMs" class="route-chip">延迟 {{ route.delayMs }}ms</span>
      <span v-if="route.jitterMs" class="route-chip">抖动 ±{{ route.jitterMs }}ms</span>
      <span v-if="route.failureRate" class="route-chip">故障 {{ route.failureRate }}%</span>
      <label class="switch-row switch-field route-disable" title="停用后接口返回 404">
        <span class="switch-text">
          <span class="switch-title">停用</span>
        </span>
        <input
          type="checkbox"
          class="switch-input"
          :checked="route.disabled === true"
          :aria-label="`停用 ${route.method} ${route.path}`"
          @change="emit('toggle-disable', route)"
        >
        <span class="switch-ui" aria-hidden="true"></span>
      </label>
    </div>

    <div v-if="variants.length" class="variant-list">
      <div v-for="(v, i) in variants" :key="v.id" class="variant-item">
        <span class="variant-index">#{{ i + 1 }}</span>
        <span class="variant-label" :title="v.name">{{ v.name }}</span>
        <span v-for="line in conditionSummary(v.match)" :key="line" class="variant-cond">{{ line }}</span>
        <span class="variant-status" :class="{ bad: v.response.status >= 400 }">HTTP {{ v.response.status }}</span>
      </div>
    </div>

    <pre class="route-body">{{ bodyPreview }}</pre>
  </article>
</template>

<style scoped>
/* 复制按钮 + 弹出菜单的定位锚点（菜单绝对定位于按钮下方右对齐） */
.route-copy-wrap {
  position: relative;
  display: inline-flex;
  flex: none;
  margin-left: auto;
}

/* 为弹出的复制菜单提供定位上下文，保证菜单覆盖在卡片内容之上 */
.route-row {
  position: relative;
}

.route-chip {
  padding: 1px 7px;
  border-radius: 4px;
  background: var(--bg-soft);
  border: 1px solid var(--line);
  color: var(--text-dim);
}

.route-chip.guard {
  color: var(--warn);
  border-color: rgba(183, 121, 31, 0.4);
  background: rgba(183, 121, 31, 0.08);
}

.variant-list {
  margin-top: 8px;
  display: grid;
  gap: 6px;
}

.variant-item {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
  padding: 5px 8px;
  border: 1px dashed var(--line);
  border-radius: 6px;
  background: var(--bg-soft);
}

.variant-index {
  flex: none;
  color: var(--text-faint);
  font-weight: 700;
}

.variant-label {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text);
}

.variant-cond {
  padding: 0 6px;
  border-radius: 4px;
  background: var(--bg);
  border: 1px solid var(--line);
  color: var(--text-dim);
  white-space: nowrap;
}

.variant-status {
  margin-left: auto;
  color: var(--text-faint);
  white-space: nowrap;
}

.variant-status.bad {
  color: var(--danger);
}
</style>
