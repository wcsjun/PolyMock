import type { CSSProperties } from 'vue';
import type { ConditionRow, RequestCondition, RouteRequest } from './types';

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

/** 条件摘要文案，如「Header X-Role=admin」；用于卡片变体列表 */
export function conditionSummary(request?: RouteRequest): string[] {
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

export interface CardStyle extends CSSProperties {
  '--method-color': string;
}

export function routeCardStyle(method: string, index: number): CardStyle {
  return {
    '--method-color': methodColor(method),
    animationDelay: `${Math.min(index * 40, 240)}ms`,
  };
}
