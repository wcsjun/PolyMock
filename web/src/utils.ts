import type { CSSProperties } from 'vue';
import type { ConditionRow, ConditionType, PolyMockMode, RequestCondition, ResponseHeader, RouteRequest } from './types';

export const METHOD_COLORS: Record<string, string> = {
  GET: '#0e9f5d',
  POST: '#1f6feb',
  PUT: '#b7791f',
  PATCH: '#8250df',
  DELETE: '#cf222e',
};

export function methodColor(method: string): string {
  return METHOD_COLORS[method] || '#5b6b7c';
}

/** 服务分组的展示后缀：端口模式显示 :端口；路径模式显示 basePath 前缀（默认服务占用根路径，显示 /） */
export function serviceDisplaySuffix(svc: { port: number; isDefault: boolean; basePath?: string }, mode: PolyMockMode): string {
  if (mode !== 'path') return `:${svc.port}`;
  return svc.isDefault ? '/' : `/${svc.basePath ?? ''}`;
}

/** 对应原 app.js 的 formatBody()：字符串原样展示，其余格式化缩进 */
export function formatBody(body: unknown): string {
  if (body === undefined) return '{}';
  if (typeof body === 'string') return body;
  return JSON.stringify(body, null, 2);
}

/** 表格行 → 提交条件：过滤未启用与空 key 行；type=string、required=true 为缺省值不写入 */
export function rowsToConditions(rows: ConditionRow[]): RequestCondition[] {
  const list: RequestCondition[] = [];
  for (const row of rows) {
    const key = row.key.trim();
    if (!row.enabled || !key) continue;
    const condition: RequestCondition = { key, value: row.value };
    if (row.type !== 'string') condition.type = row.type;
    if (!row.required) condition.required = false;
    list.push(condition);
  }
  return list;
}

/** 提交条件 → 表格行（编辑回填，缺省值补全） */
export function conditionsToRows(conditions?: RequestCondition[]): ConditionRow[] {
  return (conditions ?? []).map((condition) => ({
    key: condition.key,
    value: condition.value,
    type: condition.type ?? 'string',
    required: condition.required !== false,
    enabled: true,
  }));
}

/** 过滤空 key 行后组装 RouteRequest；三组全空时返回 undefined */
export function buildRouteRequest(
  query: ConditionRow[],
  headers: ConditionRow[],
  body: ConditionRow[],
): RouteRequest | undefined {
  const q = rowsToConditions(query);
  const h = rowsToConditions(headers);
  const b = rowsToConditions(body);
  if (!q.length && !h.length && !b.length) return undefined;
  const request: RouteRequest = {};
  if (q.length) request.query = q;
  if (h.length) request.headers = h;
  if (b.length) request.body = b;
  return request;
}

/** 拆解 RouteRequest 为三组可编辑行（编辑回填用） */
export function splitRouteRequest(request?: RouteRequest): {
  query: ConditionRow[];
  headers: ConditionRow[];
  body: ConditionRow[];
} {
  return {
    query: conditionsToRows(request?.query),
    headers: conditionsToRows(request?.headers),
    body: conditionsToRows(request?.body),
  };
}

/* ---------- Body 页签的 JSON 编辑器互转（Postman 风格） ---------- */

/** 条件行 → 期望 JSON 子集：启用行按点路径展开成嵌套对象，叶子值按类型还原 */
export function bodyRowsToJsonValue(rows: ConditionRow[]): unknown {
  const enabled = rows.filter((row) => row.enabled && row.key.trim());
  const root: Record<string, unknown> = {};
  for (const row of enabled) {
    const parts = row.key.trim().split('.');
    let node: Record<string, unknown> = root;
    for (const part of parts.slice(0, -1)) {
      const existing = node[part];
      if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
        node[part] = {};
      }
      node = node[part] as Record<string, unknown>;
    }
    let value: unknown;
    if (row.value === '') value = '';
    else if (row.type === 'number') {
      const num = Number(row.value);
      value = Number.isNaN(num) ? row.value : num;
    } else if (row.type === 'boolean') value = row.value === 'true';
    else if (row.type === 'json' || row.type === 'array') {
      try {
        value = JSON.parse(row.value);
      } catch {
        value = row.value;
      }
    } else value = row.value;
    node[parts[parts.length - 1]] = value;
  }
  return root;
}

/** 期望 JSON 子集 → 条件行：叶子字段生成点路径行，类型按字面量推断，默认必填启用 */
export function jsonValueToBodyRows(value: unknown): ConditionRow[] {
  const rows: ConditionRow[] = [];
  const walk = (node: unknown, path: string) => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        walk(child, path ? `${path}.${key}` : key);
      }
      return;
    }
    let type: ConditionType = 'string';
    let text: string;
    if (typeof node === 'number') {
      type = 'number';
      text = String(node);
    } else if (typeof node === 'boolean') {
      type = 'boolean';
      text = String(node);
    } else if (node === null) {
      type = 'json';
      text = 'null';
    } else if (Array.isArray(node) || typeof node === 'object') {
      type = 'json';
      text = JSON.stringify(node);
    } else {
      text = String(node);
    }
    rows.push({ key: path, value: text, type, required: true, enabled: true });
  };
  walk(value, '');
  return rows;
}

/** 条件摘要文案，如「Header X-Role=admin」；用于卡片变体列表 */export function conditionSummary(request?: RouteRequest): string[] {
  if (!request) return ['无条件（总是命中）'];
  const format = (label: string, condition: RequestCondition): string => {
    const base = condition.value === '' ? `${label} ${condition.key} 存在` : `${label} ${condition.key}=${condition.value}`;
    const tags: string[] = [];
    if (condition.type && condition.type !== 'string') tags.push(condition.type);
    if (condition.required === false) tags.push('选填');
    return tags.length ? `${base}（${tags.join('·')}）` : base;
  };
  const parts: string[] = [];
  for (const c of request.headers ?? []) parts.push(format('Header', c));
  for (const c of request.query ?? []) parts.push(format('Query', c));
  for (const c of request.body ?? []) parts.push(format('Body', c));
  return parts.length ? parts : ['无条件（总是命中）'];
}

/** 拼接接口的完整 Mock 地址（与控制台同主机，端口取所属服务端口） */
export function routeUrl(port: number, path: string): string {
  return `http://${location.hostname}:${port}${path}`;
}

/* ---------- 代码片段生成（卡片复制菜单用） ---------- */

/** 校验响应 body 文本：合法 JSON，或含模板占位符且占位符替换为 null 后为合法 JSON（值位置占位符场景） */
export function isTemplateJsonValid(text: string): boolean {
  const raw = text.trim();
  if (!raw) return true;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    /* 尝试模板容忍解析 */
  }
  if (raw.includes('{{')) {
    try {
      JSON.parse(raw.replace(/\{\{[^{}]*\}\}/g, 'null'));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** 生成 curl 片段；GET/HEAD 省略 -X（curl 默认即 GET） */
export function buildCurl(url: string, method: string): string {
  return method === 'GET' || method === 'HEAD' ? `curl '${url}'` : `curl -X ${method} '${url}'`;
}

/** 生成 fetch 代码片段；GET/HEAD 省略 options（fetch 默认即 GET） */
export function buildFetchSnippet(url: string, method: string): string {
  if (method === 'GET' || method === 'HEAD') return `fetch('${url}')`;
  return `fetch('${url}', {\n  method: '${method}',\n})`;
}

/** 复制文本到剪贴板；非安全上下文回落 execCommand */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export interface CardStyle extends CSSProperties {
  '--method-color': string;
}

export function routeCardStyle(method: string, index: number): CardStyle {
  return {
    '--method-color': methodColor(method),
    animationDelay: `${Math.min(index * 40, 240)}ms`,
  };
}

/* ---------- 序列响应草稿（RouteForm 编辑 ⇄ 提交） ---------- */

/** 序列响应单步（提交态）：body 统一为字符串原样提交，由后端解析模板/JSON；可选自定义响应头 */
export interface SequenceStep {
  status: number;
  body: string;
  headers?: ResponseHeader[];
}

export type SequenceParseResult =
  | { ok: true; value: SequenceStep[] }
  | { ok: false; error: string };

/**
 * 解析「序列响应」草稿文本：要求 JSON 数组，每项含数字 status 与 body（headers 可选）
 * - body 为字符串时原样保留（后端会解析）；其余类型 JSON.stringify 转为字符串
 * - headers 为数组时逐项要求非空字符串 key 与字符串 value（trim 后入库），空数组省略
 * - 空文本 / 非法 JSON / 非数组 / 空序列 / 步骤缺字段 / status 非 100-599 整数均返回 ok:false
 */
export function parseSequenceDraft(text: string): SequenceParseResult {
  const raw = text.trim();
  if (!raw) return { ok: false, error: '序列响应内容为空，请填写 JSON 数组' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: '序列响应不是合法的 JSON' };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: '序列响应必须是 JSON 数组' };
  if (!parsed.length) return { ok: false, error: '序列响应至少需要一步' };
  const value: SequenceStep[] = [];
  for (const [index, item] of parsed.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `第 ${index + 1} 步必须是对象` };
    }
    const record = item as Record<string, unknown>;
    if (typeof record.status !== 'number' || !Number.isInteger(record.status) || record.status < 100 || record.status > 599) {
      return { ok: false, error: `第 ${index + 1} 步的 status 必须是 100-599 的整数` };
    }
    if (!('body' in record)) return { ok: false, error: `第 ${index + 1} 步缺少 body` };
    let headers: ResponseHeader[] | undefined;
    if (record.headers !== undefined && record.headers !== null) {
      if (!Array.isArray(record.headers)) return { ok: false, error: `第 ${index + 1} 步的 headers 必须是数组` };
      const rows: ResponseHeader[] = [];
      for (const [hIndex, row] of record.headers.entries()) {
        const key = (row as ResponseHeader)?.key;
        const headerValue = (row as ResponseHeader)?.value;
        if (typeof key !== 'string' || !key.trim() || typeof headerValue !== 'string') {
          return { ok: false, error: `第 ${index + 1} 步的 headers[${hIndex}] 需包含非空 key 与字符串 value` };
        }
        rows.push({ key: key.trim(), value: headerValue });
      }
      if (rows.length) headers = rows;
    }
    value.push({ status: record.status, body: typeof record.body === 'string' ? record.body : JSON.stringify(record.body), ...(headers ? { headers } : {}) });
  }
  return { ok: true, value };
}

/** 尝试把字符串解析为 JSON 值，失败（或空串）返回原字符串 */
function tryParseJson(text: string): unknown {
  const raw = text.trim();
  if (!raw) return text;
  try {
    return JSON.parse(raw);
  } catch {
    return text;
  }
}

/** 序列响应回填：把存储态（body 为任意值）转为展示友好的草稿文本；body 为 JSON 字符串时解析为对象便于编辑 */
export function sequenceToDraftText(sequence?: Array<{ status: number; body: unknown; headers?: ResponseHeader[] }>): string {
  const steps = (sequence ?? []).map((step) => ({
    status: step.status,
    body: typeof step.body === 'string' ? tryParseJson(step.body) : step.body,
    ...(step.headers?.length ? { headers: step.headers } : {}),
  }));
  return JSON.stringify(steps, null, 2);
}

/* ---------- Java 实体生成（卡片复制菜单用） ---------- */

/** ISO date-time 形态的字符串（注释里提示可映射为 LocalDateTime） */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** 把任意字符串转为合法 Java 类名：按非字母数字切段后逐段首字母大写拼接；数字开头补下划线，空结果回落 Entity */
function pascalClassName(raw: string): string {
  const name = String(raw)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  if (!name) return 'Entity';
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** 字段名保持原样，仅把非 Java 标识符字符替换为下划线；数字开头补下划线前缀 */
function javaFieldName(raw: string): string {
  const name = String(raw).replace(/[^A-Za-z0-9_$]/g, '_');
  if (!name) return '_';
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** JSON 标量 → Java 类型：整数值 Integer、小数 Double、布尔 Boolean、字符串 String、null Object */
function javaScalarType(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Double';
  if (typeof value === 'boolean') return 'Boolean';
  if (typeof value === 'string') return 'String';
  return 'Object';
}

/** 标量字段的示例值注释；ISO 时间字符串附加 LocalDateTime 提示 */
function scalarComment(value: unknown): string {
  let comment = `示例值: ${JSON.stringify(value) ?? 'null'}`;
  if (typeof value === 'string' && ISO_DATETIME_RE.test(value)) {
    comment += '（ISO 时间字符串，可映射为 LocalDateTime）';
  }
  return comment;
}

/** 生成中的 Java 字段描述 */
interface JavaFieldDraft {
  name: string;
  type: string;
  comment: string;
  /** 嵌套静态类（对象字段 / 对象数组的对象元素） */
  nested?: JavaClassDraft;
}

/** 生成中的 Java 类描述 */
interface JavaClassDraft {
  name: string;
  fields: JavaFieldDraft[];
}

/** 单个字段推导：对象→嵌套类、数组→List（取首元素）、空对象→Map、标量按类型映射 */
function buildJavaField(key: string, value: unknown): JavaFieldDraft {
  const name = javaFieldName(key);
  /* 嵌套对象 → public static class（字段名 PascalCase + Info 后缀），递归展开 */
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) {
      return { name, type: 'java.util.Map<String, Object>', comment: '结构: 空对象，键值对映射' };
    }
    const nested: JavaClassDraft = { name: `${pascalClassName(key)}Info`, fields: [] };
    for (const [childKey, childValue] of entries) {
      nested.fields.push(buildJavaField(childKey, childValue));
    }
    return { name, type: nested.name, comment: `结构: 嵌套对象，见 ${nested.name}`, nested };
  }
  /* 数组取首元素推导元素类型；元素为对象时同样生成嵌套类 */
  if (Array.isArray(value)) {
    const first = value[0];
    if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
      const nested: JavaClassDraft = { name: `${pascalClassName(key)}Info`, fields: [] };
      for (const [childKey, childValue] of Object.entries(first as Record<string, unknown>)) {
        nested.fields.push(buildJavaField(childKey, childValue));
      }
      return { name, type: `java.util.List<${nested.name}>`, comment: `结构: 数组，元素对象见 ${nested.name}`, nested };
    }
    if (first === undefined) {
      return { name, type: 'java.util.List<Object>', comment: '结构: 空数组' };
    }
    const elemType = javaScalarType(first);
    return { name, type: `java.util.List<${elemType}>`, comment: `结构: 数组，元素类型 ${elemType}` };
  }
  return { name, type: javaScalarType(value), comment: scalarComment(value) };
}

/** 渲染类体：字段块在前（之间空行），嵌套静态类在后；返回不带类声明外壳的行 */
function renderClassBody(draft: JavaClassDraft, depth: number): string[] {
  const indent = '    '.repeat(depth);
  const blocks: string[][] = [];
  for (const field of draft.fields) {
    blocks.push([`${indent}/** ${field.comment} */`, `${indent}private ${field.type} ${field.name};`]);
  }
  for (const field of draft.fields) {
    if (!field.nested) continue;
    blocks.push([
      `${indent}@Data`,
      `${indent}public static class ${field.nested.name} {`,
      ...renderClassBody(field.nested, depth + 1),
      `${indent}}`,
    ]);
  }
  const lines: string[] = [];
  for (const block of blocks) {
    if (lines.length) lines.push('');
    lines.push(...block);
  }
  return lines;
}

/**
 * 根据接口响应 JSON 生成 Java 实体类代码（Lombok @Data 风格，嵌套对象生成静态内部类，数组取首元素推导 List<T>）
 * - 类名 PascalCase 化（非法字符剔除）；字段名保持原样，非法标识符字符转下划线
 * - 类型映射：string→String（ISO date-time 注释提示可用 LocalDateTime）、整数→Integer、小数→Double、
 *   boolean→Boolean、null→Object、对象→嵌套 public static class（PascalCase + Info 后缀，递归）、
 *   数组→java.util.List<元素类型>（元素为对象时嵌套类）、空对象→java.util.Map<String, Object>
 * - body 为 JSON 字符串时先解析；根值非对象（数组/标量）时包装为单个 data 字段；无字段时生成空类
 * - 生成完整文件内容：package 声明省略，直接 import lombok.Data + 类
 */
export function toJavaEntity(className: string, body: unknown): string {
  let root: unknown = body;
  if (typeof root === 'string') root = tryParseJson(root);
  const cls: JavaClassDraft = { name: pascalClassName(className), fields: [] };
  if (root !== null && typeof root === 'object' && !Array.isArray(root)) {
    for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
      cls.fields.push(buildJavaField(key, value));
    }
  } else {
    /* 根值不是对象（数组/标量/null）：包装为 data 字段 */
    cls.fields.push(buildJavaField('data', root));
  }
  const lines = ['import lombok.Data;', '', `@Data`, `public class ${cls.name} {`, ...renderClassBody(cls, 1), '}'];
  return `${lines.join('\n')}\n`;
}

/* ---------- 接口编辑抽屉宽度 ---------- */

/** 抽屉宽度下限；上限为视口宽度 × DRAWER_VIEWPORT_RATIO（与 .drawer-panel 的 CSS max-width 兜底一致） */
export const DRAWER_MIN_WIDTH = 560;
export const DRAWER_VIEWPORT_RATIO = 0.94;

const DRAWER_WIDTH_KEY = 'polymock:drawer-width';

/** 钳制抽屉宽度到 [DRAWER_MIN_WIDTH, 视口×DRAWER_VIEWPORT_RATIO]，四舍五入取整 */
export function clampDrawerWidth(width: number, viewportWidth: number): number {
  const max = Math.max(DRAWER_MIN_WIDTH, Math.floor(viewportWidth * DRAWER_VIEWPORT_RATIO));
  return Math.min(Math.max(Math.round(width), DRAWER_MIN_WIDTH), max);
}

/** 读取持久化的抽屉宽度；无记录 / 非法值 / 存储不可用时返回 null（用 CSS 默认宽度） */
export function loadDrawerWidth(viewportWidth: number): number | null {
  try {
    const raw = localStorage.getItem(DRAWER_WIDTH_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return clampDrawerWidth(parsed, viewportWidth);
  } catch {
    return null;
  }
}

/** 持久化抽屉宽度；存储不可用（隐私模式等）时静默忽略 */
export function saveDrawerWidth(width: number): void {
  try {
    localStorage.setItem(DRAWER_WIDTH_KEY, String(width));
  } catch {
    /* 忽略存储失败 */
  }
}

/** 清除持久化的抽屉宽度（恢复 CSS 默认宽度） */
export function clearDrawerWidth(): void {
  try {
    localStorage.removeItem(DRAWER_WIDTH_KEY);
  } catch {
    /* 忽略存储失败 */
  }
}
