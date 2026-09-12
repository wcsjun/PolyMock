<script setup lang="ts">
import { ref, watch } from 'vue';
import { createRoute } from '../api';
import { parseOpenApi } from '../openapi';
import { serviceDisplaySuffix } from '../utils';
import type { NotifyFn, PolyMockMode, ServiceInfo } from '../types';

const props = defineProps<{
  notify: NotifyFn;
  services: ServiceInfo[];
  /** 运行模式：决定服务分组下拉的后缀展示（端口模式 :端口 / 路径模式 basePath 前缀） */
  mode: PolyMockMode;
}>();

const emit = defineEmits<{
  close: [];
  imported: [];
}>();

/* ---------- 抽屉内容状态 ---------- */

const serviceId = ref('default');
const specText = ref('');
const importing = ref(false);

const report = ref<ImportReport | null>(null);

interface ImportIssue {
  method: string;
  path: string;
  reason: string;
}

interface ImportReport {
  ok: number;
  issues: ImportIssue[];
  truncated: boolean;
}

/* 服务列表变化时保证选中项有效（默认选 default 服务） */
watch(
  () => props.services,
  (list) => {
    if (!list.some((svc) => svc.id === serviceId.value)) {
      serviceId.value = list.find((svc) => svc.isDefault)?.id ?? list[0]?.id ?? 'default';
    }
  },
  { immediate: true },
);

/* ---------- 导入（解析逻辑在 ../openapi.ts，纯函数，可独立单测） ---------- */

function failReport(reason: string) {
  report.value = { ok: 0, issues: [{ method: '-', path: '-', reason }], truncated: false };
  props.notify(reason, 'err');
}

async function startImport() {
  if (importing.value) return;
  const raw = specText.value.trim();
  if (!raw) {
    props.notify('请先粘贴 OpenAPI 3 的 JSON 文档', 'err');
    return;
  }
  if (!serviceId.value) {
    props.notify('没有可导入的服务分组', 'err');
    return;
  }

  let result: ReturnType<typeof parseOpenApi>;
  try {
    result = parseOpenApi(raw, { serviceId: serviceId.value });
  } catch (err) {
    failReport((err as Error).message);
    return;
  }

  importing.value = true;
  try {
    const issues: ImportIssue[] = [...result.skipped];
    let okCount = 0;
    for (const item of result.created) {
      try {
        await createRoute(item.payload);
        okCount += 1;
      } catch (err) {
        issues.push({ method: item.method, path: item.path, reason: (err as Error).message });
      }
    }
    report.value = { ok: okCount, issues, truncated: result.truncated };
    props.notify(
      okCount > 0
        ? `导入完成：成功 ${okCount} 条${issues.length ? `，失败/跳过 ${issues.length} 条` : ''}`
        : '未导入任何接口，请查看报告明细',
      okCount > 0 ? 'ok' : 'warn',
    );
    emit('imported');
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div>
    <div class="drawer-mask" @click="emit('close')"></div>
    <aside class="drawer-panel" role="dialog" aria-modal="true" aria-label="导入 OpenAPI">
      <section class="panel form-panel">
        <header class="panel-head">
          <h2>导入 OpenAPI</h2>
          <button type="button" class="drawer-close" title="关闭" aria-label="关闭导入抽屉" @click="emit('close')">×</button>
        </header>

        <div class="import-body">
          <div class="field">
            <label for="import-service">导入到服务</label>
            <select id="import-service" v-model="serviceId" class="import-service">
              <option v-for="svc in services" :key="svc.id" :value="svc.id">{{ svc.name }}（{{ serviceDisplaySuffix(svc, props.mode) }}）</option>
            </select>
            <p class="hint">解析在浏览器本地完成，仅支持 OpenAPI 3 的 JSON 文档；路径参数已自动转换为 :param 形式。</p>
          </div>

          <div class="field">
            <label for="import-spec">OpenAPI JSON</label>
            <textarea
              id="import-spec"
              v-model="specText"
              class="spec-input"
              placeholder='粘贴 OpenAPI 3 文档 JSON，例如 {"openapi": "3.0.0", "paths": { ... }}'
              spellcheck="false"
            ></textarea>
          </div>

          <button type="button" class="submit-btn" :disabled="importing" @click="startImport">
            {{ importing ? '导入中…' : '开始导入' }}
          </button>

          <div v-if="report" class="import-report" aria-live="polite">
            <p class="report-summary">
              成功 <b>{{ report.ok }}</b> 条
              <template v-if="report.issues.length">，失败/跳过 {{ report.issues.length }} 条</template>
              <template v-if="report.truncated">；接口总数超过 100 条，已截断</template>
            </p>
            <ul v-if="report.issues.length" class="report-list">
              <li v-for="(issue, index) in report.issues" :key="`${issue.method}-${issue.path}-${index}`">
                <span class="report-op">{{ issue.method }} {{ issue.path }}</span>
                <span class="report-reason">{{ issue.reason }}</span>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.import-body {
  padding: 18px;
  display: grid;
  gap: 16px;
}

/* 覆盖全局 select 的定宽，占满整行 */
.import-service {
  width: 100%;
}

.spec-input {
  min-height: 240px;
  font-size: 12px;
}

.import-report {
  display: grid;
  gap: 10px;
  padding: 12px 14px;
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
  background: var(--bg-soft);
}

.report-summary {
  font-size: 12px;
  color: var(--text-dim);
}

.report-summary b {
  color: var(--accent-strong);
}

.report-list {
  list-style: none;
  display: grid;
  gap: 6px;
  max-height: 220px;
  overflow: auto;
}

.report-list li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 11px;
}

.report-op {
  flex: none;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text);
}

.report-reason {
  color: var(--danger);
  word-break: break-all;
}
</style>
