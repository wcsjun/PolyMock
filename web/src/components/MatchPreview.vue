<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PreviewRoute } from '../match-preview';
import { parseHeaderLines, parseQueryString, previewOutcome } from '../match-preview';

const props = defineProps<{
  /** 由表单当前状态推导的路由草稿 */
  route: PreviewRoute;
  /** 表单里的方法与路径（测试请求的初始值） */
  formMethod: string;
  formPath: string;
}>();

const testPath = ref('');
const testQuery = ref('');
const testHeaders = ref('');
const testBody = ref('');
/* 用户改过路径后不再跟随表单自动同步，避免边改边被覆盖 */
const pathTouched = ref(false);

function resetRequest() {
  testPath.value = props.formPath.trim() || '/';
  testQuery.value = '';
  testHeaders.value = '';
  testBody.value = '';
  pathTouched.value = false;
}

watch(
  () => props.formPath,
  (value) => {
    if (!pathTouched.value) testPath.value = value.trim() || '/';
  },
  { immediate: true },
);

const outcome = computed(() =>
  previewOutcome(props.route, {
    method: props.formMethod,
    path: testPath.value.trim() || '/',
    query: parseQueryString(testQuery.value),
    headers: parseHeaderLines(testHeaders.value),
    bodyText: testBody.value,
  }),
);

/** 响应 body 预览：字符串原样、其余 JSON 缩进；超长截断 */
const bodyText = computed(() => {
  const body = outcome.value.body;
  if (body === undefined) return '';
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  return text.length > 600 ? `${text.slice(0, 600)}\n…（已截断）` : text;
});

const STEP_TAGS: Record<string, { label: string; cls: string }> = {
  ok: { label: '通过', cls: 'trace-ok' },
  blocked: { label: '拦截', cls: 'trace-bad' },
  skipped: { label: '跳过', cls: 'trace-skip' },
  info: { label: '—', cls: 'trace-skip' },
};
</script>

<template>
  <div class="preview">
    <div class="preview-request">
      <span class="preview-method">{{ props.formMethod.toUpperCase() }}</span>
      <input
        v-model="testPath"
        class="preview-path"
        type="text"
        spellcheck="false"
        aria-label="测试请求路径"
        @input="pathTouched = true"
      >
      <button type="button" class="mini-btn" @click="resetRequest">重置</button>
    </div>

    <div class="preview-inputs">
      <label class="preview-field">
        <span>Query</span>
        <input v-model="testQuery" type="text" placeholder="tenantId=acme&amp;page=1" spellcheck="false" aria-label="测试查询参数">
      </label>
      <label class="preview-field">
        <span>Headers</span>
        <textarea v-model="testHeaders" rows="2" placeholder="X-Token: abc" spellcheck="false" aria-label="测试请求头"></textarea>
      </label>
      <label class="preview-field">
        <span>Body</span>
        <textarea v-model="testBody" rows="3" placeholder='{ "status": "PAID" }' spellcheck="false" aria-label="测试请求体"></textarea>
      </label>
    </div>

    <div class="preview-result" :class="{ fail: !outcome.responded }">
      <div class="result-head">
        <span class="result-title">{{ outcome.title }}</span>
        <span class="status-pill">HTTP {{ outcome.status }}</span>
      </div>
      <ol class="trace">
        <li v-for="(step, i) in outcome.steps" :key="i" class="trace-item">
          <span class="trace-num">{{ i + 1 }}</span>
          <span class="trace-text"><strong>{{ step.title }}</strong>{{ step.detail }}</span>
          <span :class="STEP_TAGS[step.status].cls">{{ STEP_TAGS[step.status].label }}</span>
        </li>
      </ol>
      <pre v-if="bodyText" class="preview-body">{{ bodyText }}</pre>
    </div>

    <p class="preview-note">
      本地推演，不发送真实请求：顺序为「路径 → 认证 → 请求准入 → 序列响应 → 全局场景集 → 分支 → 默认响应」。
      延迟与故障注入按概率生效，这里不体现。
    </p>
  </div>
</template>

<style scoped>
.preview {
  display: grid;
  gap: 10px;
}

.preview-request {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preview-method {
  flex: none;
  color: var(--accent-strong);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
}

.preview-path {
  flex: 1;
  min-width: 0;
  padding: 7px 9px !important;
  font-family: var(--mono);
  font-size: 12px !important;
}

.preview-inputs {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}

.preview-field {
  display: grid;
  gap: 4px;
  color: var(--text-dim);
  font-size: 12px;
}

.preview-field input,
.preview-field textarea {
  font-family: var(--mono);
  font-size: 12px;
  padding: 7px 9px;
}

.preview-field textarea {
  resize: vertical;
  /* 覆盖全局 textarea 的 140px 下限，保持预览卡片紧凑 */
  min-height: 52px;
}

.preview-result {
  padding: 11px;
  border: 1px solid rgba(14, 159, 93, 0.3);
  border-radius: 9px;
  background: var(--accent-dim);
}

.preview-result.fail {
  border-color: rgba(183, 121, 31, 0.36);
  background: rgba(183, 121, 31, 0.08);
}

.result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.result-title {
  color: var(--accent-strong);
  font-size: 13px;
  font-weight: 700;
}

.preview-result.fail .result-title {
  color: #b7791f;
}

.status-pill {
  padding: 3px 7px;
  border-radius: 5px;
  background: #fff;
  color: inherit;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
}

.trace {
  display: grid;
  gap: 6px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.trace-item {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: start;
  gap: 7px;
  color: var(--text-dim);
  font-size: 12px;
}

.trace-num {
  width: 19px;
  height: 19px;
  border-radius: 50%;
  background: #fff;
  color: var(--accent-strong);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 19px;
  text-align: center;
}

.trace-text {
  min-width: 0;
  word-break: break-word;
}

.trace-text strong {
  margin-right: 5px;
  color: var(--text);
}

.trace-ok { color: var(--accent-strong); font-size: 11px; font-weight: 700; white-space: nowrap; }
.trace-bad { color: #b7791f; font-size: 11px; font-weight: 700; white-space: nowrap; }
.trace-skip { color: var(--text-faint); font-size: 11px; white-space: nowrap; }

.preview-body {
  margin: 10px 0 0;
  padding: 9px;
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: #fff;
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
}

.preview-note {
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.6;
}
</style>
