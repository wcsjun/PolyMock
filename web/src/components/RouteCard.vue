<script setup lang="ts">
import { computed } from 'vue';
import type { NotifyFn, Route } from '../types';
import { buildCurl, buildFetchSnippet, conditionSummary, copyText, formatBody, responseContentTypeLabel, routeCardStyle, routeUrl, toJavaEntity, truncateForPreview } from '../utils';
import { useCopyMenu } from '../composables/useCopyMenu';

/* 展示层截断阈值（B1 决策：截断只发生在卡片展示；编辑抽屉 bodyText 始终加载完整内容） */
const PREVIEW_LINE_CHARS = 160;
const PREVIEW_BLOCK_MAX_CHARS = 65536;
const PREVIEW_BLOCK_MAX_LINES = 2000;

const props = defineProps<{
  route: Route;
  index: number;
  port: number;
  /** 路径模式前缀：提供时 URL 为 http://host:{port}/{basePath}{path} */
  basePath?: string;
  notify: NotifyFn;
}>();

const emit = defineEmits<{
  edit: [route: Route];
  remove: [route: Route];
  /** 拨动卡片上的停用开关时触发（不调 API，由 App 层负责持久化与刷新） */
  'toggle-disable': [route: Route];
}>();

const cardStyle = computed(() => routeCardStyle(props.route.method, props.index));
/* WS 卡片由 WsRouteCard 渲染，本组件只接 HTTP 路由；response 兜底只为类型完整 */
const response = computed(() => props.route.response ?? { status: 200, body: null });
const bodyPreview = computed(() => formatBody(response.value.body));
/* 行数 / 字符数统计与 <pre> 截断共用一次计算：统计基于原始文本，DOM 只持有截断后的文本节点 */
const bodyStats = computed(() => truncateForPreview(bodyPreview.value, { maxChars: PREVIEW_BLOCK_MAX_CHARS, maxLines: PREVIEW_BLOCK_MAX_LINES }));
/* 折叠行的单行截断预览：压平空白后截到 160 字符（CSS ellipsis 只是视觉截断，DOM 文本节点必须封顶） */
const bodyPreviewLine = computed(() => truncateForPreview(bodyPreview.value.replace(/\s+/g, ' ').trim(), { maxChars: PREVIEW_LINE_CHARS }).text);
const bodyLineCount = computed(() => bodyStats.value.totalLines);
const bodyPreviewBlock = computed(() => {
  const stats = bodyStats.value;
  if (!stats.truncated) return stats.text;
  return `${stats.text}\n…（已截断，共 ${stats.totalLines} 行 / ${stats.totalChars} 字符，展开编辑可查看与修改完整内容）`;
});
const variants = computed(() => props.route.variants ?? []);
/* 生效响应 Content-Type：自定义响应头 Content-Type 优先于 contentType 字段（未设置显示缺省 application/json） */
const contentTypeLabel = computed(() => responseContentTypeLabel(props.route.response ?? {}));

/* ---------- 复制菜单：地址 / curl / fetch / Java 实体 ---------- */

type CopyKind = 'url' | 'curl' | 'fetch' | 'java';

/** 各菜单项复制成功后的提示文案 */
const COPY_SUCCESS: Record<CopyKind, string> = {
  url: '已复制地址',
  curl: '已复制 curl',
  fetch: '已复制 fetch 代码',
  java: '已复制 Java 实体',
};

/* 复制菜单开合行为共用 useCopyMenu（与 WsRouteCard 同一份逻辑） */
const { open: copyMenuOpen, wrapRef: copyWrap, toggle: toggleCopyMenu } = useCopyMenu();

/** Java 实体类名：优先接口名，为空时取路径最后一段（toJavaEntity 内部再做 PascalCase 清理） */
function javaEntityClassName(): string {
  const name = props.route.name?.trim();
  if (name) return name;
  return props.route.path.split('/').filter(Boolean).pop() ?? 'Entity';
}

/** 接口完整 URL：路径模式拼 basePath 前缀，端口模式直连服务端口 */
function fullUrl(): string {
  const prefix = props.basePath ? `/${props.basePath}` : '';
  return routeUrl(props.port, `${prefix}${props.route.path}`);
}

/** 按菜单项复制对应片段并提示 */
async function copySnippet(kind: CopyKind) {
  copyMenuOpen.value = false;
  const url = fullUrl();
  const text = kind === 'url' ? url
    : kind === 'curl' ? buildCurl(url, props.route.method)
    : kind === 'fetch' ? buildFetchSnippet(url, props.route.method)
    : toJavaEntity(javaEntityClassName(), response.value.body);
  const ok = await copyText(text);
  props.notify(ok ? COPY_SUCCESS[kind] : '复制失败，请手动复制', ok ? 'ok' : 'err');
}

/* 浏览器只能直接发起 GET，其余方法不提供此入口 */
const canOpenInBrowser = computed(() => props.route.method === 'GET');

function openInBrowser() {
  window.open(fullUrl(), '_blank', 'noopener');
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
          title="复制地址 / curl / fetch / Java 实体"
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
          <button type="button" role="menuitem" @click="copySnippet('java')">复制 Java 实体</button>
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
      <span class="route-status" :class="{ bad: response.status >= 400 }">HTTP {{ response.status }}</span>
      <span :title="`响应 Content-Type（自定义头 Content-Type 优先于 contentType 字段）`">{{ contentTypeLabel }}</span>
      <span v-if="variants.length" class="route-chip">{{ variants.length }} 个变体</span>
      <span v-if="route.requireMatch" class="route-chip guard">需匹配</span>
      <span v-if="route.renderRequest === false" class="route-chip off" title="已关闭请求体模板渲染：请求体按客户端原文参与条件匹配">原样请求体</span>
      <span v-if="route.auth" class="route-chip guard">认证 {{ route.auth.type === 'bearer' ? 'Bearer' : 'APIKey' }}</span>
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

    <!-- 变体列表与响应体同属内容区：与 WS 剧本详情同一套 <details> 折叠交互（折叠行不带预览，计数在 meta 行 chip 已有） -->
    <details v-if="variants.length" class="script-details variants-details">
      <summary>变体详情（{{ variants.length }} 个）</summary>
      <div class="variant-list">
        <div v-for="(v, i) in variants" :key="v.id" class="variant-item">
          <span class="variant-index">#{{ i + 1 }}</span>
          <span class="variant-label" :title="v.name">{{ v.name }}</span>
          <span v-for="line in conditionSummary(v.match)" :key="line" class="variant-cond">{{ line }}</span>
          <span class="variant-status" :class="{ bad: v.response.status >= 400 }">HTTP {{ v.response.status }}</span>
        </div>
      </div>
    </details>

    <!-- 统一折叠规则：内容区默认折叠，折叠行带单行截断预览（与 WS 剧本详情同一套 <details> 交互） -->
    <details class="script-details body-details">
      <summary>响应体（{{ bodyLineCount }} 行）<span class="preview" :title="`共 ${bodyStats.totalChars} 字符`">{{ bodyPreviewLine }}</span></summary>
      <pre class="route-body">{{ bodyPreviewBlock }}</pre>
    </details>
  </article>
</template>

<style scoped>
/* .route-copy-wrap / .route-row 定位锚点与 .route-chip 系列已提升为全局样式：与 WsRouteCard 共用 */
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
  font-size: 12px;
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
