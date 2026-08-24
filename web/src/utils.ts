import type { CSSProperties } from 'vue';
import type { RequestCondition, RouteRequest } from './types';

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

/** 过滤空 key 行后组装 RouteRequest；三组全空时返回 undefined */
export function buildRouteRequest(
  query: RequestCondition[],
  headers: RequestCondition[],
  body: RequestCondition[],
): RouteRequest | undefined {
  const clean = (rows: RequestCondition[]) => rows.filter((r) => r.key.trim());
  const q = clean(query);
  const h = clean(headers);
  const b = clean(body);
  if (!q.length && !h.length && !b.length) return undefined;
  const request: RouteRequest = {};
  if (q.length) request.query = q;
  if (h.length) request.headers = h;
  if (b.length) request.body = b;
  return request;
}

/** 拆解 RouteRequest 为三组可编辑行（编辑回填用） */
export function splitRouteRequest(request?: RouteRequest): {
  query: RequestCondition[];
  headers: RequestCondition[];
  body: RequestCondition[];
} {
  return {
    query: [...(request?.query ?? [])],
    headers: [...(request?.headers ?? [])],
    body: [...(request?.body ?? [])],
  };
}

/** 条件摘要文案，如「Header X-Role=admin」；用于卡片变体列表 */
export function conditionSummary(request?: RouteRequest): string[] {
  if (!request) return ['无条件（总是命中）'];
  const parts: string[] = [];
  for (const c of request.headers ?? []) parts.push(`Header ${c.key}=${c.value}`);
  for (const c of request.query ?? []) parts.push(`Query ${c.key}=${c.value}`);
  for (const c of request.body ?? []) parts.push(`Body ${c.key}=${c.value}`);
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
