import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminRouter } from './admin.js';
import type { RequestLogStore } from './request-log.js';
import type { ServiceManager } from './manager.js';
import type { RouteRegistry } from '../registry.js';
import { renderTemplate, type TemplateContext } from '../template.js';
import { DEFAULT_SERVICE_ID } from '../types.js';
import type { RequestCondition, RouteRequest, RouteResponse, Route } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

export interface MainAppOptions {
  mainPort: number;
  /** 共享请求日志存储（主端口分发 + 管理 API 读取） */
  logs?: RequestLogStore;
}

/** Mock 分发的可选依赖：请求日志与 {{$id}} 自增计数器 */
export interface DispatchDeps {
  /** 缺省时不记录日志 */
  logs?: RequestLogStore;
  /** key = routeId，同一 app 内共享；缺省时各 dispatch 自建 */
  idCounters?: Map<string, number>;
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

/** 深度相等比对（json 类型条件用） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  return ak.length === bk.length && ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** 归一化为布尔值；无法识别返回 undefined */
function asBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

/**
 * 校验单条条件；返回失败原因，通过返回 null。
 * - key 缺失：required 为 false（选填）时通过，否则失败；
 * - 期望值为空串：仅要求 key 存在（存在性匹配）；
 * - type 决定比对方式：string 字符串化比对（缺省）/ number 数值比对 / boolean 布尔比对 / json 深度相等。
 */
function checkCondition(cond: RequestCondition, actual: unknown): string | null {
  if (actual === undefined) {
    return cond.required === false ? null : `缺少（期望 ${cond.value}）`;
  }
  const expected = cond.value;
  if (expected === '') return null;
  const shown = actualText(actual) ?? 'undefined';
  const mismatch = `期望 ${expected}，实际 ${shown}`;
  switch (cond.type) {
    case 'number': {
      const actualNum = Number(actual);
      const expectedNum = Number(expected);
      if (!Number.isFinite(actualNum) || actualNum !== expectedNum) return mismatch;
      return null;
    }
    case 'boolean': {
      const expectedBool = asBoolean(expected);
      if (expectedBool === undefined || asBoolean(actual) !== expectedBool) return mismatch;
      return null;
    }
    case 'json': {
      let expectedJson: unknown;
      try {
        expectedJson = JSON.parse(expected);
      } catch {
        return `期望值不是合法 JSON：${expected}`;
      }
      if (!deepEqual(actual, expectedJson)) return mismatch;
      return null;
    }
    default: {
      if (actualText(actual) !== expected) return mismatch;
      return null;
    }
  }
}

/** 校验一组条件是否全部满足；返回第一条失败原因（带来源前缀），全部通过返回 null */
function checkConditions(
  request: RouteRequest,
  headers: (key: string) => string | undefined,
  query: (key: string) => string | undefined,
  jsonBody: () => Record<string, unknown> | undefined,
): string | null {
  for (const cond of request.headers ?? []) {
    const reason = checkCondition(cond, headers(cond.key));
    if (reason) return `请求头 ${cond.key} ${reason}`;
  }
  for (const cond of request.query ?? []) {
    const reason = checkCondition(cond, query(cond.key));
    if (reason) return `查询参数 ${cond.key} ${reason}`;
  }
  const bodyConditions = request.body ?? [];
  if (bodyConditions.length > 0) {
    const body = jsonBody();
    if (!body) {
      /* 全部为选填条件时，body 缺失视为字段缺失（逐条按选填语义通过） */
      if (bodyConditions.every((c) => c.required === false)) return null;
      return '请求体缺失或非 JSON，无法匹配 body 条件';
    }
    for (const cond of bodyConditions) {
      const reason = checkCondition(cond, lookupPath(body, cond.key));
      if (reason) return `请求体字段 ${cond.key} ${reason}`;
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
 * 2. 全局场景集 activeVariant 非空时：在 variants 中按 name 查找，命中则直接采用其响应（绕过其 match 条件）；
 * 3. 未指定场景集或场景集未命中时按顺序尝试 variants，第一个条件全部通过的生效；
 * 4. 无变体命中时走默认 response。
 * 返回值携带命中的变体名（默认响应用 null）。
 */
export function resolveRouteResponse(
  route: Route,
  sources: ReturnType<typeof conditionSources>,
  activeVariant: string | null = null,
): { ok: true; response: RouteResponse; variant: string | null } | { ok: false; error: string } {
  if (route.requireMatch && route.request) {
    const reason = checkConditions(route.request, sources.headers, sources.query, sources.jsonBody);
    if (reason) return { ok: false, error: `请求条件不满足：${reason}` };
  }
  if (activeVariant) {
    const forced = (route.variants ?? []).find((variant) => variant.name === activeVariant);
    if (forced) return { ok: true, response: forced.response, variant: forced.name };
  }
  for (const variant of route.variants ?? []) {
    if (!variant.match || checkConditions(variant.match, sources.headers, sources.query, sources.jsonBody) === null) {
      return { ok: true, response: variant.response, variant: variant.name };
    }
  }
  return { ok: true, response: route.response, variant: null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 将 Express 请求头展平为 Record<string, string>（保留原始键名，数组值逗号拼接） */
function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') result[key] = value;
    else if (Array.isArray(value)) result[key] = value.join(', ');
  }
  return result;
}

/** 将 req.query 展平为 Record<string, string>（数组取首个，语义与 conditionSources.query 一致） */
function flattenQuery(query: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      if (value[0] !== undefined) result[key] = String(value[0]);
    } else if (value !== undefined && value !== null) {
      result[key] = String(value);
    }
  }
  return result;
}

export function createDispatch(registry: RouteRegistry, serviceId: string, deps?: DispatchDeps): express.RequestHandler {
  const idCounters = deps?.idCounters ?? new Map<string, number>();
  return async (req, res) => {
    const start = Date.now();
    let status = 200;
    let error: string | undefined;
    let matched: { routeId: string; variant: string | null } | null = null;
    let proxied = false;
    let proxyStatus: number | undefined;
    let proxyBody: string | undefined;

    /** 写入一条请求日志（未注入 logs 时忽略）；query / bodyPreview 仅在非空时记录 */
    const writeLog = () => {
      if (!deps?.logs) return;
      const query = flattenQuery(req.query as Record<string, unknown>);
      deps.logs.push({
        id: randomUUID(),
        ts: start,
        serviceId,
        method: req.method,
        path: req.path,
        matched,
        ...(proxied ? { proxied: true } : {}),
        status,
        ...(error !== undefined ? { error } : {}),
        durationMs: Date.now() - start,
        ...(Object.keys(query).length > 0 ? { query } : {}),
        ...(req.body !== undefined ? { bodyPreview: JSON.stringify(req.body).slice(0, 500) } : {}),
        ...(proxyStatus !== undefined ? { proxyStatus } : {}),
        ...(proxyBody !== undefined ? { proxyBody } : {}),
      });
    };

    const route = registry.find(serviceId, req.method, req.path);

    // ---- 未命中：配置了代理目标则转发上游，否则 404 ----
    if (!route) {
      const proxyTarget = registry.getService(serviceId)?.proxyTarget;
      if (!proxyTarget) {
        status = 404;
        res.status(404).json({ ok: false, error: `未注册接口: ${req.method} ${req.path}` });
        writeLog();
        return;
      }
      const headers = flattenHeaders(req.headers);
      delete headers.host;
      delete headers['content-length'];
      const body =
        req.method === 'GET' || req.method === 'HEAD'
          ? undefined
          : req.body !== undefined
            ? JSON.stringify(req.body)
            : undefined;
      try {
        const upstream = await fetch(`${proxyTarget.replace(/\/+$/, '')}${req.originalUrl}`, {
          method: req.method,
          headers,
          body,
        });
        const text = await upstream.text();
        status = upstream.status;
        proxied = true;
        proxyStatus = upstream.status;
        proxyBody = text.slice(0, 5000);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        if (parsed !== undefined) {
          res.status(status).json(parsed);
        } else {
          const contentType = upstream.headers.get('content-type');
          if (contentType) res.type(contentType);
          res.status(status).send(text);
        }
      } catch (err) {
        status = 502;
        proxied = true;
        error = `代理请求失败：${(err as Error).message}`;
        res.status(502).json({ ok: false, error });
      }
      writeLog();
      return;
    }

    // ---- 命中：解析最终响应（全局场景集可强制指定变体）----
    const result = resolveRouteResponse(route, conditionSources(req), registry.getSettings().activeVariant ?? null);
    matched = { routeId: route.id, variant: null };
    if (!result.ok) {
      status = 400;
      error = result.error;
      res.status(400).json({ ok: false, error: result.error });
      writeLog();
      return;
    }
    matched = { routeId: route.id, variant: result.variant };

    // ---- 故障注入：命中概率时返回 500（仍先执行延迟）----
    const injectFailure =
      route.failureRate !== undefined && route.failureRate > 0 && Math.random() * 100 < route.failureRate;

    // ---- 延迟：固定 delayMs + 随机抖动 0..jitterMs ----
    const jitter = route.jitterMs !== undefined && route.jitterMs > 0 ? Math.floor(Math.random() * (route.jitterMs + 1)) : 0;
    const totalDelay = (route.delayMs ?? 0) + jitter;
    if (totalDelay > 0) await sleep(totalDelay);

    if (injectFailure) {
      status = 500;
      res.status(500).json({ ok: false, error: '模拟故障注入' });
      writeLog();
      return;
    }

    // ---- 模板渲染（{{$id}} 使用 app 内共享的路由级计数器）----
    let idCounter = idCounters.get(route.id) ?? 0;
    const rendered = renderTemplate(result.response.body, {
      query: flattenQuery(req.query as Record<string, unknown>),
      headers: flattenHeaders(req.headers),
      body: req.body,
      routeId: route.id,
      nextId: () => {
        idCounter += 1;
        idCounters.set(route.id, idCounter);
        return idCounter;
      },
    } satisfies TemplateContext);

    if (result.response.contentType) {
      res.type(result.response.contentType);
    }
    status = result.response.status;
    res.status(status).json(rendered);
    writeLog();
  };
}

export function createApp(registry: RouteRegistry, manager: ServiceManager, options: MainAppOptions): express.Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // 主端口分发共享的 {{$id}} 计数器（key = routeId）
  const deps: DispatchDeps = { logs: options.logs, idCounters: new Map<string, number>() };

  // ---- 管理 API ----
  app.use('/__polymock', createAdminRouter(registry, manager, { mainPort: options.mainPort, logs: options.logs }));

  // ---- Web UI 静态资源 ----
  app.use(express.static(PUBLIC_DIR));

  // ---- Mock 接口分发（默认服务 = 主端口）----
  app.use(createDispatch(registry, DEFAULT_SERVICE_ID, deps));

  return app;
}

export function createRouteApp(registry: RouteRegistry, serviceId: string, deps?: DispatchDeps): express.Express {
  const app = express();
  app.use(createDispatch(registry, serviceId, deps));
  return app;
}
