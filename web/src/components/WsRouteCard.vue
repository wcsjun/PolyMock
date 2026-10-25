<script setup lang="ts">
import { computed } from 'vue';
import type { NotifyFn, Route } from '../types';
import { buildWsSnippet, copyText, formatBody, routeCardStyle, truncateForPreview, wsSummary, wsUrl } from '../utils';
import { useCopyMenu } from '../composables/useCopyMenu';

/* 剧本步骤载荷的展示截断上限（B1 决策：只截卡片展示，编辑抽屉全量） */
const STEP_PAYLOAD_CHARS = 160;

const props = defineProps<{
  route: Route;
  index: number;
  port: number;
  /** 路径模式前缀：提供时连接地址为 ws://host:{port}/{basePath}{path} */
  basePath?: string;
  /** 该路由当前活跃连接数（轮询快照派生；0 不渲染 chip） */
  connections: number;
  notify: NotifyFn;
}>();

const emit = defineEmits<{
  edit: [route: Route];
  remove: [route: Route];
  /** 拨动卡片上的停用开关时触发（不调 API，由 App 层负责持久化与刷新） */
  'toggle-disable': [route: Route];
  /** 跳转到 WS 调试台并选中该接口 */
  'goto-debug': [route: Route];
}>();

const cardStyle = computed(() => routeCardStyle(props.route.method, props.index));

/* ---------- 摘要与剧本 ---------- */

const summary = computed(() => wsSummary(props.route));
const onOpen = computed(() => props.route.ws?.onOpen ?? []);
const interval = computed(() => props.route.ws?.interval);
/** 剧本步数 = onOpen 条数 + 定时 1 步；0 时不渲染折叠详情 */
const stepCount = computed(() => onOpen.value.length + (interval.value ? 1 : 0));
const intervalLabel = computed(() => (interval.value ? (interval.value.everyMs >= 1000 ? `每 ${Math.round(interval.value.everyMs / 1000)}s` : `每 ${interval.value.everyMs}ms`) : ''));

/** 剧本步骤帧内容：字符串原样展示，其余缩进 JSON；压平后截断（大 payload 不进 DOM 文本节点与 :title） */
function stepPayload(body: unknown): string {
  return truncateForPreview(formatBody(body).replace(/\s+/g, ' '), { maxChars: STEP_PAYLOAD_CHARS }).text;
}

/* 折叠详情的步骤行：每步 payload 只计算一次，文本节点与 :title 共用同一截断文本 */
const openSteps = computed(() => onOpen.value.map((message) => ({ delayMs: message.delayMs ?? 0, payload: stepPayload(message.body) })));
const intervalStep = computed(() => (interval.value ? { payload: stepPayload(interval.value.body) } : null));

/* ---------- 复制菜单：ws 地址 / JS 连接代码 ---------- */

type CopyKind = 'url' | 'snippet';

const COPY_SUCCESS: Record<CopyKind, string> = {
  url: '已复制 ws 地址',
  snippet: '已复制连接代码',
};

/* 复制菜单开合行为共用 useCopyMenu（与 RouteCard 同一份逻辑） */
const { open: copyMenuOpen, wrapRef: copyWrap, toggle: toggleCopyMenu } = useCopyMenu();

function fullWsUrl(): string {
  const prefix = props.basePath ? `/${props.basePath}` : '';
  return wsUrl(props.port, `${prefix}${props.route.path}`);
}

async function copySnippet(kind: CopyKind) {
  copyMenuOpen.value = false;
  const url = fullWsUrl();
  const ok = await copyText(kind === 'url' ? url : buildWsSnippet(url));
  props.notify(ok ? COPY_SUCCESS[kind] : '复制失败，请手动复制', ok ? 'ok' : 'err');
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
          title="复制 ws 地址 / 连接代码"
          aria-haspopup="menu"
          :aria-expanded="copyMenuOpen"
          :aria-label="`复制 ${route.method} ${route.path} 的连接地址或代码`"
          @click="toggleCopyMenu"
        >
          ⧉
        </button>
        <div v-if="copyMenuOpen" class="copy-menu" role="menu">
          <button type="button" role="menuitem" @click="copySnippet('url')">复制 ws 地址</button>
          <button type="button" role="menuitem" @click="copySnippet('snippet')">复制连接代码</button>
        </div>
      </span>
      <button
        type="button"
        class="route-test"
        title="在 WS 调试台打开"
        :aria-label="`在 WS 调试台打开 ${route.method} ${route.path}`"
        @click="emit('goto-debug', route)"
      >
        ⇄
      </button>
      <button
        type="button"
        class="route-edit"
        title="编辑 WS 接口"
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
      <span class="ws-summary" :title="summary">{{ summary }}</span>
      <span v-if="route.auth" class="route-chip guard" :title="`握手需携带 ${route.auth.type === 'bearer' ? 'Authorization: Bearer' : route.auth.header ?? 'X-API-Key'}`">认证</span>
      <span v-if="route.disabled" class="route-chip off">已停用</span>
      <button
        v-if="connections > 0"
        type="button"
        class="route-chip live"
        title="查看实时连接"
        @click="emit('goto-debug', route)"
      >● {{ connections }} 个连接</button>
      <label class="switch-row switch-field route-disable" title="停用后新握手返回 404，现有连接以 1012 关闭">
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

    <details v-if="stepCount > 0" class="script-details">
      <summary>剧本详情（{{ stepCount }} 步）</summary>
      <div class="step-list">
        <div v-for="(step, i) in openSteps" :key="`open-${i}`" class="step-item">
          <span class="step-index">#{{ i + 1 }}</span>
          <span class="step-when">+{{ step.delayMs }}ms</span>
          <span class="step-payload" :title="step.payload">{{ step.payload }}</span>
        </div>
        <div v-if="intervalStep" class="step-item">
          <span class="step-index">⏱</span>
          <span class="step-when">{{ intervalLabel }}</span>
          <span class="step-payload" :title="intervalStep.payload">{{ intervalStep.payload }}</span>
        </div>
      </div>
      <div class="script-usage">连接地址  {{ fullWsUrl() }}<template v-if="route.auth">
握手校验  {{ route.auth.type === 'bearer' ? 'Bearer' : route.auth.header ?? 'X-API-Key' }}（令牌只在编辑抽屉中配置与显示；浏览器无法携带自定义握手头，可在地址后附加 ?token=<令牌>）</template>
失败语义  未注册 / 已停用 → 404 关闭；认证失败 → 401 关闭；均不进入 HTTP 分发</div>
    </details>
  </article>
</template>
