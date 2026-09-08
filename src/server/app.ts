import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminRouter, isHostAllowed } from './admin.js';
import type { RequestLogStore } from './request-log.js';
import type { ServiceManager } from './manager.js';
import type { RouteRegistry } from '../registry.js';
import { renderTemplate, renderTemplateText, type TemplateContext } from '../template.js';
import { DEFAULT_SERVICE_ID } from '../types.js';
import type { RequestCondition, RouteRequest, RouteResponse, Route, RouteAuth } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

export interface MainAppOptions {
  mainPort: number;
  /** 共享请求日志存储（主端口分发 + 管理 API 读取） */
  logs?: RequestLogStore;
  /** 管理令牌：设置后 /__polymock 全部接口需鉴权；缺省不校验 */
  adminToken?: string;
  /** 代理目标白名单（host 列表）：设置后管理端与转发均要求目标 hostname 在白名单内；缺省不校验 */
  proxyAllowHosts?: string[];
}

/** Mock 分发的可选依赖：请求日志与 {{$id}} 自增计数器 */
export interface DispatchDeps {
  /** 缺省时不记录日志 */
  logs?: RequestLogStore;
  /** key = routeId，同一 app 内共享；缺省时各 dispatch 自建 */
  idCounters?: Map<string, number>;
  /** 序列响应命中计数（key = routeId）；缺省时各 dispatch 自建 */
  seqCounters?: Map<string, number>;
  /** 有状态 CRUD 资源集合（key = routeId，内层 key = 资源 id）；缺省时各 dispatch 自建 */
  crudStores?: Map<string, Map<string, Record<string, unknown>>>;
  /** CRUD 自动生成 id 的自增计数（key = routeId）；缺省时各 dispatch 自建 */
  crudCounters?: Map<string, number>;
  /** 代理目标白名单（host 列表）：设置后转发前再次校验，不在白名单返回 502；缺省不校验 */
  proxyAllowHosts?: string[];
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

/** 校验路由级认证（模拟后端鉴权）；通过返回 null，失败返回 401 错误原因 */
function checkAuth(auth: RouteAuth, req: express.Request): string | null {
  if (auth.type === 'bearer') {
    const header = req.get('authorization');
    if (header === undefined) return '缺少 Authorization 头';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return 'Authorization 头需为 Bearer <token> 形式';
    if (match[1] !== auth.value) return '令牌不正确';
    return null;
  }
  const headerName = auth.header ?? 'X-API-Key';
  const key = req.get(headerName);
  if (key === undefined) return `缺少 ${headerName} 头`;
  if (key !== auth.value) return 'API Key 不正确';
  return null;
}

/**
 * 校验单条条件；返回失败原因，通过返回 null。
 * - key 缺失：required 为 false（选填）时通过，否则失败；
 * - 期望值为空串：仅要求 key 存在（存在性匹配）；
 * - type 决定比对方式：string 字符串化比对（缺省）/ number 数值比对 / boolean 布尔比对 / json 深度相等 /
 *   array 包含匹配（期望值为 JSON 数组字面量，实际数组需包含其全部元素，无序，逐元素深度相等）。
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
    case 'array': {
      let expectedJson: unknown;
      try {
        expectedJson = JSON.parse(expected);
      } catch {
        return `期望值不是合法 JSON：${expected}`;
      }
      if (!Array.isArray(expectedJson)) return `期望值不是 JSON 数组：${expected}`;
      if (!Array.isArray(actual)) return mismatch;
      const containsAll = expectedJson.every((item) => actual.some((elem) => deepEqual(elem, item)));
      if (!containsAll) return mismatch;
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
 * 2. route.sequence 非空时按命中次序循环取响应（优先于场景集/变体/默认）；
 * 3. 全局场景集 activeVariant 非空时：在 variants 中按 name 查找，命中则直接采用其响应（绕过其 match 条件）；
 * 4. 未指定场景集或场景集未命中时按顺序尝试 variants，第一个条件全部通过的生效；
 * 5. 无变体命中时走默认 response。
 * 返回值携带命中的变体名（默认响应用 null；序列响应用 序列#n）。
 */
export function resolveRouteResponse(
  route: Route,
  sources: ReturnType<typeof conditionSources>,
  activeVariant: string | null = null,
  seq?: { take: () => number },
): { ok: true; response: RouteResponse; variant: string | null } | { ok: false; error: string } {
  if (route.requireMatch && route.request) {
    const reason = checkConditions(route.request, sources.headers, sources.query, sources.jsonBody);
    if (reason) return { ok: false, error: `请求条件不满足：${reason}` };
  }
  if (route.sequence && route.sequence.length > 0) {
    const index = seq ? seq.take() : 0;
    const item = route.sequence[index % route.sequence.length];
    return { ok: true, response: item, variant: `序列#${index + 1}` };
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

/**
 * 有状态 CRUD 处理（route.crud = true 时替代普通响应选择）：
 * - 集合路由（无参数段）：GET 返回全部、POST 创建（无 id 时自动生成 rec-N）；
 * - 条目路由（含参数段，取第一个参数为资源 id）：GET/PUT/PATCH/DELETE 按 id 存取，PUT/PATCH 浅合并。
 * 返回待响应的状态码与响应体。
 */
function crudOutcome(
  route: Route,
  params: Record<string, string>,
  req: express.Request,
  stores: Map<string, Map<string, Record<string, unknown>>>,
  counters: Map<string, number>,
): { status: number; body: unknown } {
  /* 集合键 = 去掉参数段后的路径：同一集合的 GET/POST/PUT/DELETE 路由共享资源存储 */
  const collectionKey = route.path.split('/').filter((segment) => segment && !segment.startsWith(':')).join('/');
  let resources = stores.get(collectionKey);
  if (!resources) {
    resources = new Map();
    stores.set(collectionKey, resources);
  }
  const segments = route.path.split('/');
  const idParamName = segments.find((segment) => segment.startsWith(':'))?.slice(1) ?? 'id';
  const isItemRoute = segments.some((segment) => segment.startsWith(':'));
  const recordId = params[idParamName];

  switch (req.method) {
    case 'GET': {
      if (!isItemRoute) return { status: 200, body: [...resources.values()] };
      const item = recordId !== undefined ? resources.get(recordId) : undefined;
      return item
        ? { status: 200, body: item }
        : { status: 404, body: { ok: false, error: '资源不存在' } };
    }
    case 'POST': {
      const body: unknown = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { status: 400, body: { ok: false, error: '请求体需为 JSON 对象' } };
      }
      const record: Record<string, unknown> = { ...(body as Record<string, unknown>) };
      if (record.id === undefined) {
        const next = (counters.get(collectionKey) ?? 0) + 1;
        counters.set(collectionKey, next);
        record.id = `rec-${next}`;
      }
      resources.set(String(record.id), record);
      return { status: 201, body: record };
    }
    case 'PUT':
    case 'PATCH': {
      const existing = recordId !== undefined ? resources.get(recordId) : undefined;
      if (!existing) return { status: 404, body: { ok: false, error: '资源不存在' } };
      const body: unknown = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { status: 400, body: { ok: false, error: '请求体需为 JSON 对象' } };
      }
      const merged: Record<string, unknown> = { ...existing, ...(body as Record<string, unknown>), id: existing.id };
      resources.set(recordId, merged);
      return { status: 200, body: merged };
    }
    case 'DELETE': {
      if (recordId !== undefined) resources.delete(recordId);
      return { status: 200, body: { ok: true } };
    }
    default:
      return { status: 405, body: { ok: false, error: 'CRUD 接口仅支持 GET/POST/PUT/PATCH/DELETE' } };
  }
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
  const seqCounters = deps?.seqCounters ?? new Map<string, number>();
  const crudStores = deps?.crudStores ?? new Map<string, Map<string, Record<string, unknown>>>();
  const crudCounters = deps?.crudCounters ?? new Map<string, number>();
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

    const found = registry.findWithParams(serviceId, req.method, req.path);
    const route = found?.route;
    const routeParams = found?.params ?? {};

    // ---- 未命中：配置了代理目标则转发上游，否则 404 ----
    if (!route) {
      const proxyTarget = registry.getService(serviceId)?.proxyTarget;
      if (!proxyTarget) {
        status = 404;
        res.status(404).json({ ok: false, error: `未注册接口: ${req.method} ${req.path}` });
        writeLog();
        return;
      }
      /* 白名单兜底校验：即使代理目标绕过管理端写入（如旧配置文件），转发前仍需在白名单内 */
      if (deps?.proxyAllowHosts && deps.proxyAllowHosts.length > 0 && !isHostAllowed(proxyTarget, deps.proxyAllowHosts)) {
        status = 502;
        proxied = true;
        error = '代理目标不在白名单内';
        res.status(502).json({ ok: false, error });
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

    // ---- 命中：路由级认证校验（模拟后端鉴权；401 优先于 requireMatch 门槛，CRUD 路由同样生效）----
    if (route.auth) {
      const authError = checkAuth(route.auth, req);
      if (authError) {
        status = 401;
        error = `认证失败：${authError}`;
        if (route.auth.type === 'bearer') res.set('WWW-Authenticate', 'Bearer');
        res.status(401).json({ ok: false, error });
        writeLog();
        return;
      }
    }

    // ---- 命中：有状态 CRUD 路由（requireMatch 门槛仍生效，延迟/故障同样作用）----
    if (route.crud) {
      const sources = conditionSources(req);
      if (route.requireMatch && route.request) {
        const reason = checkConditions(route.request, sources.headers, sources.query, sources.jsonBody);
        if (reason) {
          status = 400;
          error = `请求条件不满足：${reason}`;
          res.status(400).json({ ok: false, error });
          writeLog();
          return;
        }
      }
      const jitter = route.jitterMs !== undefined && route.jitterMs > 0 ? Math.floor(Math.random() * (route.jitterMs + 1)) : 0;
      const totalDelay = (route.delayMs ?? 0) + jitter;
      if (totalDelay > 0) await sleep(totalDelay);
      if (route.failureRate !== undefined && route.failureRate > 0 && Math.random() * 100 < route.failureRate) {
        status = 500;
        res.status(500).json({ ok: false, error: '模拟故障注入' });
        writeLog();
        return;
      }
      const outcome = crudOutcome(route, routeParams, req, crudStores, crudCounters);
      status = outcome.status;
      res.status(status).json(outcome.body);
      writeLog();
      return;
    }

    // ---- 命中：解析最终响应（requireMatch 门槛 → 序列响应 → 场景集强制变体 → 条件变体 → 默认）----
    const seq =
      route.sequence && route.sequence.length > 0
        ? {
            take: () => {
              const index = seqCounters.get(route.id) ?? 0;
              seqCounters.set(route.id, index + 1);
              return index;
            },
          }
        : undefined;
    const result = resolveRouteResponse(route, conditionSources(req), registry.getSettings().activeVariant ?? null, seq);
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
    const templateCtx: TemplateContext = {
      query: flattenQuery(req.query as Record<string, unknown>),
      headers: flattenHeaders(req.headers),
      params: routeParams,
      body: req.body,
      routeId: route.id,
      nextId: () => {
        idCounter += 1;
        idCounters.set(route.id, idCounter);
        return idCounter;
      },
    };
    let rendered: unknown;
    if (typeof result.response.body === 'string' && result.response.body.includes('{{')) {
      /* 模板文本 body（占位符可出现在值位置）：文本级替换后是合法 JSON 则按 JSON 响应，否则按文本响应 */
      const text = renderTemplateText(result.response.body, templateCtx);
      try {
        rendered = JSON.parse(text);
      } catch {
        rendered = text;
      }
    } else {
      rendered = renderTemplate(result.response.body, templateCtx);
    }

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

  // 主端口分发共享的计数器与状态存储（key = routeId）
  const deps: DispatchDeps = {
    logs: options.logs,
    idCounters: new Map<string, number>(),
    seqCounters: new Map<string, number>(),
    crudStores: new Map<string, Map<string, Record<string, unknown>>>(),
    crudCounters: new Map<string, number>(),
    proxyAllowHosts: options.proxyAllowHosts,
  };

  // ---- 管理 API ----
  app.use('/__polymock', createAdminRouter(registry, manager, {
    mainPort: options.mainPort,
    logs: options.logs,
    adminToken: options.adminToken,
    proxyAllowHosts: options.proxyAllowHosts,
  }));

  // ---- Web UI 静态资源 ----
  app.use(express.static(PUBLIC_DIR));

  // ---- Mock 接口分发（默认服务 = 主端口）----
  app.use(createDispatch(registry, DEFAULT_SERVICE_ID, deps));

  return app;
}

export function createRouteApp(registry: RouteRegistry, serviceId: string, deps?: DispatchDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(createDispatch(registry, serviceId, deps));
  return app;
}
