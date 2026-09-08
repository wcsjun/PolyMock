import express from 'express';
import { randomUUID } from 'node:crypto';
import type { ServiceManagerLike } from './manager.js';
import type { RequestLogStore } from './request-log.js';
import type { RouteRegistry } from '../registry.js';
import {
  DEFAULT_SERVICE_ID,
  type ConditionType,
  type RequestCondition,
  type RequestLogEntry,
  type ResponseVariant,
  type Route,
  type RouteAuth,
  type RouteRequest,
  type RouteResponse,
  type Service,
} from '../types.js';

export interface AdminOptions {
  mainPort: number;
  /** 请求日志存储（/requests 端点读取与清空）；缺省时返回空列表 */
  logs?: RequestLogStore;
  /** 管理令牌：设置后所有 /__polymock 请求需携带 x-polymock-token 头或 ?token= 参数；缺省不校验 */
  adminToken?: string;
  /** 代理目标白名单（host 列表）：设置后 PUT proxy 与转发均要求目标 hostname 在白名单内；缺省不校验 */
  proxyAllowHosts?: string[];
}

/** 请求日志查询的缺省与上限条数 */
const DEFAULT_REQUESTS_LIMIT = 100;
const MAX_REQUESTS_LIMIT = 500;

/** SSE 心跳间隔（毫秒）：定期写注释行，防止代理/负载均衡断开空闲连接 */
const SSE_HEARTBEAT_MS = 25_000;

/** 校验代理目标 host 是否在白名单内（大小写不敏感，按 hostname 比对，忽略端口）；管理端与转发前共用 */
export function isHostAllowed(target: string, allowHosts: string[]): boolean {
  let hostname: string;
  try {
    hostname = new URL(target).hostname;
  } catch {
    return false;
  }
  return allowHosts.some((host) => host.trim().toLowerCase() === hostname.toLowerCase());
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const CONDITION_TYPES: readonly ConditionType[] = ['string', 'number', 'boolean', 'json'];

/** 归一化一组条件行：key trim、过滤空 key 行；数组内对象不合法时报错 */
function parseConditionList(raw: unknown, label: string): ParseResult<RequestCondition[]> {
  if (!Array.isArray(raw)) return { ok: false, error: `${label} 需为数组` };
  const list: RequestCondition[] = [];
  for (const row of raw) {
    const key = (row as RequestCondition)?.key;
    const value = (row as RequestCondition)?.value;
    if (typeof key !== 'string' || typeof value !== 'string') {
      return { ok: false, error: `${label} 中每项需包含字符串 key 与 value` };
    }
    const type = (row as RequestCondition).type;
    if (type !== undefined && !CONDITION_TYPES.includes(type)) {
      return { ok: false, error: `${label} 中 type 需为 ${CONDITION_TYPES.join(' / ')}` };
    }
    const required = (row as RequestCondition).required;
    if (required !== undefined && typeof required !== 'boolean') {
      return { ok: false, error: `${label} 中 required 需为布尔值` };
    }
    const trimmed = key.trim();
    if (trimmed) {
      const condition: RequestCondition = { key: trimmed, value };
      if (type !== undefined && type !== 'string') condition.type = type;
      if (required === false) condition.required = false;
      list.push(condition);
    }
  }
  return { ok: true, value: list };
}

/** 解析请求条件组（query / headers / body）；未提供或全空时返回空对象 */
function parseRouteRequest(raw: unknown): ParseResult<RouteRequest> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'request 需为对象（可含 query / headers / body 数组）' };
  }
  const result: RouteRequest = {};
  for (const field of ['query', 'headers', 'body'] as const) {
    const rawList = (raw as Record<string, unknown>)[field];
    if (rawList === undefined) continue;
    const parsed = parseConditionList(rawList, `request.${field}`);
    if (!parsed.ok) return parsed;
    if (parsed.value.length > 0) result[field] = parsed.value;
  }
  return { ok: true, value: result };
}

/** 解析响应体：字符串按 JSON 解析，其余透传；含模板占位符的文本按「占位符替换为 null」容忍校验，原样存储由渲染层处理 */
function parseResponseBody(raw: unknown, label: string): ParseResult<unknown> {
  if (typeof raw !== 'string') return { ok: true, value: raw };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    if (raw.includes('{{')) {
      try {
        JSON.parse(raw.replace(/\{\{[^{}]*\}\}/g, 'null'));
        return { ok: true, value: raw };
      } catch {
        /* 原样报错 */
      }
    }
    return { ok: false, error: `${label} 的 body 不是合法的 JSON` };
  }
}

/** 解析响应变体列表并分配 id */
function parseVariants(raw: unknown): ParseResult<ResponseVariant[]> {
  if (!Array.isArray(raw)) return { ok: false, error: 'variants 需为数组' };
  const list: ResponseVariant[] = [];
  for (const item of raw) {
    const name = (item as ResponseVariant)?.name;
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, error: '每个变体需提供非空的 name' };
    }
    let match: RouteRequest | undefined;
    if (item.match !== undefined && item.match !== null) {
      const parsed = parseRouteRequest(item.match);
      if (!parsed.ok) return { ok: false, error: `变体「${name.trim()}」：${parsed.error}` };
      match = parsed.value;
    }
    let body: unknown = item.response?.body;
    const bodyParsed = parseResponseBody(body, `变体「${name.trim()}」`);
    if (!bodyParsed.ok) return bodyParsed;
    body = bodyParsed.value;
    list.push({
      id: randomUUID(),
      name: name.trim(),
      match,
      response: {
        status: typeof item.response?.status === 'number' ? item.response.status : 200,
        contentType: typeof item.response?.contentType === 'string' ? item.response.contentType : undefined,
        body,
      },
    });
  }
  return { ok: true, value: list };
}

/** 解析路由行为字段（disabled / delayMs / jitterMs / failureRate / crud）；未提供的字段不出现在结果中 */
function parseBehaviorFields(raw: unknown): ParseResult<Pick<Route, 'disabled' | 'delayMs' | 'jitterMs' | 'failureRate' | 'crud'>> {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: '请求体需为 JSON 对象' };
  }
  const source = raw as Record<string, unknown>;
  const result: Pick<Route, 'disabled' | 'delayMs' | 'jitterMs' | 'failureRate' | 'crud'> = {};
  if (source.disabled !== undefined) {
    if (typeof source.disabled !== 'boolean') {
      return { ok: false, error: 'disabled 需为布尔值' };
    }
    result.disabled = source.disabled;
  }
  for (const field of ['delayMs', 'jitterMs'] as const) {
    const value = source[field];
    if (value !== undefined) {
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 60000) {
        return { ok: false, error: `${field} 需为 0-60000 的整数` };
      }
      result[field] = value as number;
    }
  }
  if (source.failureRate !== undefined) {
    if (typeof source.failureRate !== 'number' || !Number.isFinite(source.failureRate) || source.failureRate < 0 || source.failureRate > 100) {
      return { ok: false, error: 'failureRate 需为 0-100 的数字' };
    }
    result.failureRate = source.failureRate;
  }
  if (source.crud !== undefined) {
    if (typeof source.crud !== 'boolean') {
      return { ok: false, error: 'crud 需为布尔值' };
    }
    result.crud = source.crud;
  }
  return { ok: true, value: result };
}

/** 解析路由级认证配置：null 表示清除；type 需为 apikey / bearer，value 需为非空字符串，apikey 可选自定义 header 名 */
function parseRouteAuth(raw: unknown): ParseResult<RouteAuth | undefined> {
  if (raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'auth 需为对象（type / value）' };
  }
  const source = raw as Record<string, unknown>;
  if (source.type !== 'apikey' && source.type !== 'bearer') {
    return { ok: false, error: 'auth.type 需为 apikey 或 bearer' };
  }
  if (typeof source.value !== 'string' || !source.value.trim()) {
    return { ok: false, error: 'auth.value 需为非空字符串' };
  }
  let header: string | undefined;
  if (source.header !== undefined) {
    if (typeof source.header !== 'string' || !source.header.trim()) {
      return { ok: false, error: 'auth.header 需为非空字符串' };
    }
    header = source.header.trim();
  }
  return { ok: true, value: { type: source.type, value: source.value, ...(header !== undefined ? { header } : {}) } };
}

/** 校验 path 段格式：非空段要么为字面量，要么为 :参数名（: 后非空） */
function validatePathSegments(routePath: string): string | null {
  for (const segment of routePath.split('/')) {
    if (!segment) continue;
    if (segment.startsWith(':') && segment.length === 1) {
      return `path 段 "${segment}" 非法：参数段需为 :参数名`;
    }
  }
  return null;
}

/** 解析序列响应列表：每项 status 100-599 整数，body 走 parseResponseBody */
function parseSequence(raw: unknown): ParseResult<Array<{ status: number; body: unknown }>> {
  if (!Array.isArray(raw)) return { ok: false, error: 'sequence 需为数组' };
  const list: Array<{ status: number; body: unknown }> = [];
  for (const [index, item] of raw.entries()) {
    if (item === null || typeof item !== 'object') {
      return { ok: false, error: `sequence[${index}] 需为对象` };
    }
    const status = (item as { status?: unknown }).status;
    if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) {
      return { ok: false, error: `sequence[${index}] 的 status 需为 100-599 的整数` };
    }
    const bodyParsed = parseResponseBody((item as { body?: unknown }).body, `sequence[${index}]`);
    if (!bodyParsed.ok) return bodyParsed;
    list.push({ status: status as number, body: bodyParsed.value });
  }
  return { ok: true, value: list };
}

/** 管理接口返回的服务对象：附加 isDefault / running / 接口数量 */
function describeService(registry: RouteRegistry, manager: ServiceManagerLike, service: Service) {
  return {
    ...service,
    isDefault: service.id === DEFAULT_SERVICE_ID,
    running: service.id === DEFAULT_SERVICE_ID ? true : manager.isRunning(service.id),
    count: registry.list(service.id).length,
  };
}

export function createAdminRouter(registry: RouteRegistry, manager: ServiceManagerLike, options: AdminOptions): express.Router {
  const router = express.Router();

  // ---- 管理令牌校验（全局中间件）：设置 adminToken 后所有请求需带 x-polymock-token 头或 ?token= 参数 ----
  // SSE（/events）无法携带自定义 header，同样接受 query token（EventSource 场景）
  router.use((req, res, next) => {
    if (!options.adminToken) {
      next();
      return;
    }
    const headerToken = req.get('x-polymock-token');
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (headerToken === options.adminToken || queryToken === options.adminToken) {
      next();
      return;
    }
    res.status(401).json({ ok: false, error: '需要管理令牌（x-polymock-token 头或 ?token= 参数）' });
  });

  // ---- 服务分组管理 ----
  router.get('/services', (_req, res) => {
    res.json({
      ok: true,
      services: registry.listServices().map((service) => describeService(registry, manager, service)),
    });
  });

  router.post('/services', async (req, res) => {
    const { name, port } = req.body ?? {};
    const serviceName = typeof name === 'string' ? name.trim() : '';
    const servicePort = Number(port);

    if (!serviceName) {
      res.status(400).json({ ok: false, error: '服务名称不能为空' });
      return;
    }
    if (!Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65535) {
      res.status(400).json({ ok: false, error: '端口需为 1-65535 的整数' });
      return;
    }
    if (servicePort === options.mainPort) {
      res.status(409).json({ ok: false, error: `端口 ${servicePort} 与主服务（默认服务）端口冲突` });
      return;
    }
    if (registry.findServiceByPort(servicePort)) {
      res.status(409).json({ ok: false, error: `端口 ${servicePort} 已被其他服务占用` });
      return;
    }
    if (registry.listServices().some((s) => s.name === serviceName)) {
      res.status(409).json({ ok: false, error: `服务名称「${serviceName}」已存在` });
      return;
    }

    const service = registry.addService(serviceName, servicePort);
    try {
      await manager.start(service);
    } catch (err) {
      registry.removeService(service.id);
      res.status(409).json({ ok: false, error: `端口 ${servicePort} 启动失败（可能已被占用）: ${(err as Error).message}` });
      return;
    }
    res.status(201).json({ ok: true, service });
  });

  router.delete('/services/:id', async (req, res) => {
    const serviceId = req.params.id;
    if (serviceId === DEFAULT_SERVICE_ID) {
      res.status(400).json({ ok: false, error: '默认服务不可删除' });
      return;
    }
    await manager.stop(serviceId);
    res.json({ ok: registry.removeService(serviceId) });
  });

  // ---- 服务代理转发 ----
  router.put('/services/:id/proxy', (req, res) => {
    const serviceId = req.params.id;
    if (!registry.getService(serviceId)) {
      res.status(404).json({ ok: false, error: '服务不存在' });
      return;
    }
    const target = (req.body as { target?: unknown } | undefined)?.target;
    if (typeof target !== 'string' && target !== null) {
      res.status(400).json({ ok: false, error: 'target 需为字符串或 null' });
      return;
    }
    /* null / 空串 = 清除代理；否则必须为合法 http(s) URL */
    let proxyTarget: string | undefined;
    if (typeof target === 'string' && target !== '') {
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        res.status(400).json({ ok: false, error: 'target 需为合法的 http(s) URL' });
        return;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        res.status(400).json({ ok: false, error: 'target 需为合法的 http(s) URL' });
        return;
      }
      /* 白名单校验：设置 proxyAllowHosts 后，target 的 hostname 必须在白名单内 */
      if (options.proxyAllowHosts && options.proxyAllowHosts.length > 0 && !isHostAllowed(target, options.proxyAllowHosts)) {
        res.status(400).json({ ok: false, error: '代理目标不在白名单内' });
        return;
      }
      proxyTarget = target;
    }
    if (!registry.updateService(serviceId, { proxyTarget })) {
      res.status(404).json({ ok: false, error: '服务不存在' });
      return;
    }
    const service = registry.getService(serviceId) as Service;
    res.json({ ok: true, service: describeService(registry, manager, service) });
  });

  // ---- 请求日志 ----
  router.get('/requests', (req, res) => {
    const serviceId = typeof req.query.serviceId === 'string' && req.query.serviceId ? req.query.serviceId : undefined;
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_REQUESTS_LIMIT) : DEFAULT_REQUESTS_LIMIT;
    res.json({ ok: true, requests: options.logs ? options.logs.list({ serviceId, limit }) : [] });
  });

  router.delete('/requests', (_req, res) => {
    options.logs?.clear();
    res.json({ ok: true });
  });

  // ---- 请求日志 SSE 实时推送（event: log，data 为日志条目 JSON）----
  router.get('/events', (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders();

    /* 新日志条目推送给客户端；JSON.stringify 输出不含换行，不会破坏 SSE 帧 */
    const onEntry = (entry: RequestLogEntry) => {
      res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    };
    options.logs?.on('entry', onEntry);

    /* 定期心跳注释行，防止空闲连接被中间层掐断 */
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, SSE_HEARTBEAT_MS);

    /* 客户端断开：移除监听并清理心跳定时器（req/res close 双保险，幂等） */
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      options.logs?.off('entry', onEntry);
      clearInterval(heartbeat);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  // ---- 全局设置（场景集）----
  router.get('/settings', (_req, res) => {
    res.json({ ok: true, settings: registry.getSettings() });
  });

  router.put('/settings', (req, res) => {
    const { activeVariant } = (req.body ?? {}) as { activeVariant?: unknown };
    if (typeof activeVariant !== 'string' && activeVariant !== null) {
      res.status(400).json({ ok: false, error: 'activeVariant 需为字符串或 null' });
      return;
    }
    /* 空串视为清除场景集 */
    const trimmed = typeof activeVariant === 'string' ? activeVariant.trim() : null;
    registry.setSettings({ activeVariant: trimmed ? trimmed : null });
    res.json({ ok: true, settings: registry.getSettings() });
  });

  // ---- 管理 API（接口注册）----
  router.get('/routes', (req, res) => {
    const serviceId = typeof req.query.serviceId === 'string' ? req.query.serviceId : undefined;
    res.json({ ok: true, routes: registry.list(serviceId) });
  });

  router.post('/routes', (req, res) => {
    const { serviceId, name, method, path: routePath, response, request, requireMatch, variants, sequence, auth } = req.body ?? {};
    if (typeof method !== 'string' || typeof routePath !== 'string' || !routePath.startsWith('/')) {
      res.status(400).json({ ok: false, error: 'method 与 path 均为必填字符串，path 需以 / 开头' });
      return;
    }
    const pathError = validatePathSegments(routePath);
    if (pathError) {
      res.status(400).json({ ok: false, error: pathError });
      return;
    }
    const routeName = typeof name === 'string' ? name.trim() : '';
    if (!routeName) {
      res.status(400).json({ ok: false, error: '接口名称不能为空' });
      return;
    }

    const sid = typeof serviceId === 'string' && serviceId ? serviceId : DEFAULT_SERVICE_ID;
    if (sid !== DEFAULT_SERVICE_ID && !registry.getService(sid)) {
      res.status(400).json({ ok: false, error: '服务分组不存在' });
      return;
    }
    /* 形状冲突检查（findShapeConflict 覆盖精确重复与路径参数互撞；已禁用路由同样占用形状） */
    const shapeConflict = registry.findShapeConflict(sid, method, routePath);
    if (shapeConflict) {
      res.status(409).json({ ok: false, error: `接口 ${method.toUpperCase()} ${routePath} 与已有接口 ${shapeConflict.method} ${shapeConflict.path} 形状冲突` });
      return;
    }
    if (requireMatch !== undefined && typeof requireMatch !== 'boolean') {
      res.status(400).json({ ok: false, error: 'requireMatch 需为布尔值' });
      return;
    }
    const behaviorParsed = parseBehaviorFields(req.body);
    if (!behaviorParsed.ok) {
      res.status(400).json({ ok: false, error: behaviorParsed.error });
      return;
    }

    let routeSequence: Array<{ status: number; body: unknown }> | undefined;
    if (sequence !== undefined) {
      const parsed = parseSequence(sequence);
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      routeSequence = parsed.value;
    }

    let routeAuth: RouteAuth | undefined;
    if (auth !== undefined) {
      const parsed = parseRouteAuth(auth);
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      routeAuth = parsed.value;
    }

    const bodyParsed = parseResponseBody(response?.body, 'response');
    if (!bodyParsed.ok) {
      res.status(400).json({ ok: false, error: bodyParsed.error });
      return;
    }

    let routeRequest: RouteRequest | undefined;
    if (request !== undefined) {
      const parsed = parseRouteRequest(request);
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      routeRequest = parsed.value;
    }

    let routeVariants: ResponseVariant[] | undefined;
    if (variants !== undefined) {
      const parsed = parseVariants(variants);
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      routeVariants = parsed.value;
    }

    const route = registry.add(sid, method, routePath, {
      status: response?.status ?? 200,
      contentType: typeof response?.contentType === 'string' ? response.contentType : undefined,
      body: bodyParsed.value,
    }, routeName, routeRequest, requireMatch, routeVariants, { ...behaviorParsed.value, sequence: routeSequence, auth: routeAuth });
    res.status(201).json({ ok: true, route });
  });

  router.delete('/routes', (req, res) => {
    const method = typeof req.query.method === 'string' ? req.query.method : '';
    const routePath = typeof req.query.path === 'string' ? req.query.path : '';
    const serviceId = typeof req.query.serviceId === 'string' && req.query.serviceId ? req.query.serviceId : DEFAULT_SERVICE_ID;
    if (!method || !routePath) {
      res.status(400).json({ ok: false, error: '缺少 method 或 path 参数' });
      return;
    }
    res.json({ ok: registry.remove(serviceId, method, routePath) });
  });

  router.put('/routes/:id', (req, res) => {
    const { serviceId, name, method, path: routePath, response, request, requireMatch, variants, sequence, auth } = req.body ?? {};
    const patch: Partial<Pick<Route, 'serviceId' | 'method' | 'path' | 'name' | 'response' | 'request' | 'requireMatch' | 'variants' | 'disabled' | 'delayMs' | 'jitterMs' | 'failureRate' | 'sequence' | 'crud' | 'auth'>> = {};

    if (serviceId !== undefined) {
      if (typeof serviceId !== 'string' || !serviceId) {
        res.status(400).json({ ok: false, error: 'serviceId 不合法' });
        return;
      }
      if (serviceId !== DEFAULT_SERVICE_ID && !registry.getService(serviceId)) {
        res.status(400).json({ ok: false, error: '服务分组不存在' });
        return;
      }
      patch.serviceId = serviceId;
    }
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ ok: false, error: '接口名称不合法' });
        return;
      }
      patch.name = name.trim();
    }
    if (method !== undefined) {
      if (typeof method !== 'string' || !method) {
        res.status(400).json({ ok: false, error: 'method 不合法' });
        return;
      }
      patch.method = method;
    }
    if (routePath !== undefined) {
      if (typeof routePath !== 'string' || !routePath.startsWith('/')) {
        res.status(400).json({ ok: false, error: 'path 需以 / 开头的字符串' });
        return;
      }
      const pathError = validatePathSegments(routePath);
      if (pathError) {
        res.status(400).json({ ok: false, error: pathError });
        return;
      }
      patch.path = routePath;
    }
    if (response !== undefined) {
      const bodyParsed = parseResponseBody(response?.body, 'response');
      if (!bodyParsed.ok) {
        res.status(400).json({ ok: false, error: bodyParsed.error });
        return;
      }
      patch.response = {
        status: response?.status ?? 200,
        contentType: typeof response?.contentType === 'string' ? response.contentType : undefined,
        body: bodyParsed.value,
      };
    }
    if (requireMatch !== undefined) {
      if (typeof requireMatch !== 'boolean') {
        res.status(400).json({ ok: false, error: 'requireMatch 需为布尔值' });
        return;
      }
      patch.requireMatch = requireMatch;
    }
    if (request !== undefined) {
      const parsed = parseRouteRequest(request);
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      patch.request = parsed.value;
    }
    if (variants !== undefined) {
      const parsed = parseVariants(variants);
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      patch.variants = parsed.value;
    }
    if (sequence !== undefined) {
      const parsed = parseSequence(sequence);
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      patch.sequence = parsed.value;
    }
    /* 认证：null 表示清除（patch.auth = undefined 覆盖旧值） */
    if (auth !== undefined) {
      const parsed = parseRouteAuth(auth);
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      patch.auth = parsed.value;
    }
    /* 行为字段（disabled / delayMs / jitterMs / failureRate / crud）可单独作为 patch */
    const behaviorParsed = parseBehaviorFields(req.body);
    if (!behaviorParsed.ok) {
      res.status(400).json({ ok: false, error: behaviorParsed.error });
      return;
    }
    Object.assign(patch, behaviorParsed.value);

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ ok: false, error: '没有可更新的字段（serviceId / name / method / path / response / request / requireMatch / variants / disabled / delayMs / jitterMs / failureRate / sequence / crud / auth）' });
      return;
    }

    const result = registry.update(req.params.id, patch);
    if (!result.ok) {
      if (result.error === 'not-found') {
        res.status(404).json({ ok: false, error: '接口不存在' });
      } else {
        const c = result.conflict;
        res.status(409).json({
          ok: false,
          error: `更新冲突：${c.method} ${c.path} 已存在于该服务分组`,
        });
      }
      return;
    }
    res.json({ ok: true, route: result.route });
  });

  return router;
}