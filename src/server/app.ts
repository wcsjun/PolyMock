import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminRouter } from './admin.js';
import type { ServiceManager } from './manager.js';
import type { RouteRegistry } from '../registry.js';
import { DEFAULT_SERVICE_ID } from '../types.js';
import type { RouteRequest, RouteResponse, Route } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

export interface MainAppOptions {
  mainPort: number;
}

/** 点路径取值：data.userId -> obj.data.userId；中间层非对象返回 undefined */
function lookupPath(obj: unknown, dotPath: string): unknown {
  let current: unknown = obj;
  for (const segment of dotPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 实际值字符串化；undefined 表示无法比对 */
function actualText(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 校验一组条件是否全部满足；返回第一条失败原因，全部通过返回 null */
function checkConditions(
  request: RouteRequest,
  headers: (key: string) => string | undefined,
  query: (key: string) => string | undefined,
  jsonBody: () => Record<string, unknown> | undefined,
): string | null {
  for (const cond of request.headers ?? []) {
    const actual = headers(cond.key);
    if (actual === undefined) return `缺少请求头 ${cond.key}=${cond.value}`;
    if (actual !== cond.value) return `请求头 ${cond.key} 期望 ${cond.value}，实际 ${actual}`;
  }
  for (const cond of request.query ?? []) {
    const actual = query(cond.key);
    if (actual === undefined) return `缺少查询参数 ${cond.key}=${cond.value}`;
    if (actual !== cond.value) return `查询参数 ${cond.key} 期望 ${cond.value}，实际 ${actual}`;
  }
  const bodyConditions = request.body ?? [];
  if (bodyConditions.length > 0) {
    const body = jsonBody();
    if (!body) return '请求体缺失或非 JSON，无法匹配 body 条件';
    for (const cond of bodyConditions) {
      const text = actualText(lookupPath(body, cond.key));
      if (text === null) return `请求体缺少字段 ${cond.key}（期望 ${cond.value}）`;
      if (text !== cond.value) return `请求体字段 ${cond.key} 期望 ${cond.value}，实际 ${text}`;
    }
  }
  return null;
}

/** 从 Express 请求提取三类比对源 */
function conditionSources(req: express.Request) {
  const queryMap = req.query as Record<string, unknown>;
  return {
    headers: (key: string) => req.get(key),
    query: (key: string) => {
      const value = queryMap[key];
      return Array.isArray(value) ? (value[0] !== undefined ? String(value[0]) : undefined) : value !== undefined ? String(value) : undefined;
    },
    jsonBody: () => {
      const body: unknown = req.body;
      return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
    },
  };
}

/**
 * 解析路由最终响应：
 * 1. requireMatch 开启时先做准入校验（route.request），不满足直接 400——该门槛优先于任何变体；
 * 2. 通过后按顺序尝试 variants，第一个条件全部通过的生效；
 * 3. 无变体命中时走默认 response。
 */
export function resolveRouteResponse(route: Route, sources: ReturnType<typeof conditionSources>): { ok: true; response: RouteResponse } | { ok: false; error: string } {
  if (route.requireMatch && route.request) {
    const reason = checkConditions(route.request, sources.headers, sources.query, sources.jsonBody);
    if (reason) return { ok: false, error: `请求条件不满足：${reason}` };
  }
  for (const variant of route.variants ?? []) {
    if (!variant.match || checkConditions(variant.match, sources.headers, sources.query, sources.jsonBody) === null) {
      return { ok: true, response: variant.response };
    }
  }
  return { ok: true, response: route.response };
}

export function createDispatch(registry: RouteRegistry, serviceId: string): express.RequestHandler {
  return (req, res) => {
    const route = registry.find(serviceId, req.method, req.path);
    if (!route) {
      res.status(404).json({ ok: false, error: `未注册接口: ${req.method} ${req.path}` });
      return;
    }
    const result = resolveRouteResponse(route, conditionSources(req));
    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }
    if (result.response.contentType) {
      res.type(result.response.contentType);
    }
    res.status(result.response.status).json(result.response.body);
  };
}

export function createApp(registry: RouteRegistry, manager: ServiceManager, options: MainAppOptions): express.Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // ---- 管理 API ----
  app.use('/__polymock', createAdminRouter(registry, manager, { mainPort: options.mainPort }));

  // ---- Web UI 静态资源 ----
  app.use(express.static(PUBLIC_DIR));

  // ---- Mock 接口分发（默认服务 = 主端口）----
  app.use(createDispatch(registry, DEFAULT_SERVICE_ID));

  return app;
}

export function createRouteApp(registry: RouteRegistry, serviceId: string): express.Express {
  const app = express();
  app.use(createDispatch(registry, serviceId));
  return app;
}
