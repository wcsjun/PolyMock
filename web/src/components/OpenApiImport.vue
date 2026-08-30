<script setup lang="ts">
import { ref, watch } from 'vue';
import { createRoute } from '../api';
import type { NotifyFn, ServiceInfo } from '../types';

const props = defineProps<{
  notify: NotifyFn;
  services: ServiceInfo[];
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

/* ---------- OpenAPI 文档解析（纯前端，JSON only，无依赖） ---------- */

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const IMPORT_LIMIT = 100;
const SCHEMA_DEPTH_LIMIT = 10;

interface JsonSchema {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: unknown[];
  example?: unknown;
  default?: unknown;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }> | undefined;
}

interface OpenApiDoc {
  openapi?: unknown;
  paths?: Record<string, Record<string, OpenApiOperation | undefined> | undefined>;
}

interface OperationItem {
  method: string;
  path: string;
  name: string;
  status: number;
  schema?: JsonSchema;
}

/** JSON Pointer 解析 $ref（#/components/schemas/...），支持 ~0 ~1 转义 */
function resolveRef(ref: string, doc: OpenApiDoc): JsonSchema | undefined {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let node: unknown = doc;
  for (const raw of ref.slice(2).split('/')) {
    if (node === null || typeof node !== 'object') return undefined;
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = (node as Record<string, unknown>)[key];
  }
  return node && typeof node === 'object' ? (node as JsonSchema) : undefined;
}

/** 按采样规则由 schema 生成示例值；深度超限 / 循环引用返回 {} */
function sampleSchema(schema: JsonSchema | undefined, doc: OpenApiDoc, depth: number): unknown {
  if (!schema || typeof schema !== 'object' || depth > SCHEMA_DEPTH_LIMIT) return {};
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, doc);
    return resolved ? sampleSchema(resolved, doc, depth + 1) : {};
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case 'string':
      return schema.format === 'date' || schema.format === 'date-time'
        ? new Date().toISOString()
        : 'string';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [sampleSchema(schema.items, doc, depth + 1)];
    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        obj[key] = sampleSchema(child, doc, depth + 1);
      }
      return obj;
    }
    default:
      return {};
  }
}

/** 遍历 paths 收集可导入操作；含路径参数的跳过并记录，超过上限截断 */
function collectOperations(doc: OpenApiDoc): { items: OperationItem[]; truncated: boolean; issues: ImportIssue[] } {
  const items: OperationItem[] = [];
  const issues: ImportIssue[] = [];
  let truncated = false;
  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      if (path.includes('{')) {
        issues.push({ method: method.toUpperCase(), path, reason: '暂不支持路径参数' });
        continue;
      }
      if (items.length >= IMPORT_LIMIT) {
        return { items, truncated: true, issues };
      }
      const responses = op.responses ?? {};
      const resp = responses['200'] || responses['201'] || responses.default;
      items.push({
        method: method.toUpperCase(),
        path,
        name: op.operationId || op.summary || `${method.toUpperCase()} ${path}`,
        status: !responses['200'] && responses['201'] ? 201 : 200,
        schema: resp?.content?.['application/json']?.schema,
      });
    }
  }
  return { items, truncated, issues };
}

/* ---------- 导入 ---------- */

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

  let doc: OpenApiDoc;
  try {
    doc = JSON.parse(raw) as OpenApiDoc;
  } catch {
    failReport('JSON 解析失败，请检查文档格式');
    return;
  }
  if (!doc || typeof doc !== 'object' || !doc.openapi) {
    failReport('不是有效的 OpenAPI 文档：缺少 openapi 字段');
    return;
  }

  importing.value = true;
  try {
    const { items, truncated, issues } = collectOperations(doc);
    let okCount = 0;
    for (const item of items) {
      /* 无 schema 时默认响应体 { message: 'ok' } */
      const sampled = item.schema ? sampleSchema(item.schema, doc, 0) : { message: 'ok' };
      try {
        await createRoute({
          serviceId: serviceId.value,
          method: item.method,
          path: item.path,
          name: item.name,
          response: { status: item.status, body: JSON.stringify(sampled, null, 2) },
        });
        okCount += 1;
      } catch (err) {
        issues.push({ method: item.method, path: item.path, reason: (err as Error).message });
      }
    }
    report.value = { ok: okCount, issues, truncated };
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
              <option v-for="svc in services" :key="svc.id" :value="svc.id">{{ svc.name }}（:{{ svc.port }}）</option>
            </select>
            <p class="hint">解析在浏览器本地完成，仅支持 OpenAPI 3 的 JSON 文档；含路径参数的接口暂不支持。</p>
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
