<script setup lang="ts">
import { computed } from 'vue';
import type { NotifyFn, Route } from '../types';
import { conditionSummary, copyText, formatBody, routeCardStyle, routeUrl } from '../utils';

const props = defineProps<{
  route: Route;
  index: number;
  port: number;
  notify: NotifyFn;
}>();

const emit = defineEmits<{
  edit: [route: Route];
  remove: [route: Route];
}>();

const cardStyle = computed(() => routeCardStyle(props.route.method, props.index));
const bodyPreview = computed(() => formatBody(props.route.response.body));
const variants = computed(() => props.route.variants ?? []);

async function copyUrl() {
  const ok = await copyText(routeUrl(props.port, props.route.path));
  props.notify(ok ? `已复制 ${props.route.method} ${props.route.path} 的地址` : '复制失败，请手动复制', ok ? 'ok' : 'err');
}

/* 浏览器只能直接发起 GET，其余方法不提供此入口 */
const canOpenInBrowser = computed(() => props.route.method === 'GET');

function openInBrowser() {
  window.open(routeUrl(props.port, props.route.path), '_blank', 'noopener');
}
</script>

<template>
  <article class="route-card" :style="cardStyle">
    <div v-if="route.name" class="route-title" :title="route.name">{{ route.name }}</div>
    <div class="route-row">
      <span class="method-badge">{{ route.method }}</span>
      <span class="route-path" :title="route.path">{{ route.path }}</span>
      <button
        type="button"
        class="route-copy"
        title="复制接口地址"
        :aria-label="`复制 ${route.method} ${route.path} 地址`"
        @click="copyUrl"
      >
        ⧉
      </button>
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
