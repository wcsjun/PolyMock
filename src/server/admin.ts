import express from 'express';
import { randomUUID } from 'node:crypto';
import type { ServiceManagerLike } from './manager.js';
import type { RequestLogStore } from './request-log.js';
import type { WsConnectionSnapshot, WsGateway } from './ws-gateway.js';
import type { RouteRegistry } from '../registry.js';
import {
  effectiveResponseContentType,
  firstWsForbiddenField,
  isHostAllowed,
  isJsonContentType,
  parseBehaviorFields,
  parseResponseHeaders,
  parseRouteAuth,
  parseRouteRequest,
  parseResponseBody,
  parseSequence,
  parseVariants,
  validatePathSegments,
  parseWsBehavior,
} from './route-validation.js';
import {
  DEFAULT_SERVICE_ID,
  slugifyBasePath,
  type RequestLogEntry,
  type ResponseVariant,
  type Route,
  type RouteAuth,
  type RouteRequest,
  type Service,
  type PolyMockMode,
  type WsBehavior,
} from '../types.js';

export interface AdminOptions {
  mainPort: number;
  /** 请求日志存储（/requests 端点读取与清空）；缺省时返回空列表 */
  logs?: RequestLogStore;
  /** 管理令牌：设置后所有 /__polymock 请求需携带 x-polymock-token 头或 ?token= 参数；缺省不校验 */
  adminToken?: string;
  /** 代理目标白名单（host 列表）：设置后 PUT proxy 与转发均要求目标 hostname 在白名单内；缺省不校验 */
  proxyAllowHosts?: string[];
  /** 运行模式：path 时创建服务免端口、按 basePath 前缀区分；缺省 port */
  mode?: PolyMockMode;
  /** 有状态 CRUD 共享存储（key = serviceId\0集合路径）：/crud 端点查看与清空；缺省时返回空列表 */
  crudStores?: Map<string, Map<string, Record<string, unknown>>>;
  /** 共享 WS 网关：/ws/connections 借此暴露连接快照；缺省返回空列表 */
  gateway?: WsGateway;
  /** 配置状态版本号读取器：注册表 change 时自增的内存态计数（不持久化，重启归零）；/meta 暴露给前端轮询跳过未变更数据，缺省恒 0 */
  stateVersion?: () => number;
}

/** 请求日志查询的缺省与上限条数 */
const DEFAULT_REQUESTS_LIMIT = 100;
const MAX_REQUESTS_LIMIT = 500;

/** SSE 心跳间隔（毫秒）：定期写注释行，防止代理/负载均衡断开空闲连接 */
const SSE_HEARTBEAT_MS = 25_000;

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

  // ---- 模式元信息（前端双模式适配依据；stateVersion 供轮询跳过未变更的路由全量拉取）----
  router.get('/meta', (_req, res) => {
    res.json({ ok: true, mode: options.mode ?? 'port', mainPort: options.mainPort, stateVersion: options.stateVersion?.() ?? 0 });
  });

  // ---- 服务分组管理 ----
  router.get('/services', (_req, res) => {
    res.json({
      ok: true,
      services: registry.listServices().map((service) => describeService(registry, manager, service)),
    });
  });

  router.post('/services', async (req, res) => {
    const body = req.body ?? {};
    const { name, port } = body;
    const serviceName = typeof name === 'string' ? name.trim() : '';

    if (!serviceName) {
      res.status(400).json({ ok: false, error: '服务名称不能为空' });
      return;
    }
    if (registry.listServices().some((s) => s.name === serviceName)) {
      res.status(409).json({ ok: false, error: `服务名称「${serviceName}」已存在` });
      return;
    }

    /* 路径模式：免端口，按 basePath 前缀区分服务；显式指定时精确校验（不做 slugify 清洗），未指定时按服务名自动生成并去重 */
    if (options.mode === 'path') {
      const requested = typeof body.basePath === 'string' ? body.basePath.trim() : '';
      if (requested) {
        const formatError = registry.validateBasePathFormat(requested);
        if (formatError) {
          res.status(400).json({ ok: false, error: formatError });
          return;
        }
        const conflict = registry.findBasePathConflict(requested);
        if (conflict) {
          res.status(409).json({ ok: false, error: conflict });
          return;
        }
        const service = registry.addService(serviceName, 0, undefined, requested);
        res.status(201).json({ ok: true, service });
        return;
      }
      const base = slugifyBasePath(serviceName) || `svc-${randomUUID().slice(0, 8)}`;
      let candidate = base;
      let n = 2;
      while (registry.validateBasePathFormat(candidate) !== null || registry.findBasePathConflict(candidate) !== null) {
        candidate = `${base}-${n++}`;
      }
      const service = registry.addService(serviceName, 0, undefined, candidate);
      res.status(201).json({ ok: true, service });
      return;
    }

    const servicePort = Number(port);
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
    if (!registry.removeService(serviceId)) {
      res.status(404).json({ ok: false, error: '服务不存在' });
      return;
    }
    res.json({ ok: true });
  });

  // ---- 服务 basePath（路径模式前缀）----
  router.put('/services/:id/basePath', (req, res) => {
    const serviceId = req.params.id;
    const service = registry.getService(serviceId);
    if (!service) {
      res.status(404).json({ ok: false, error: '服务不存在' });
      return;
    }
    if (serviceId === DEFAULT_SERVICE_ID) {
      res.status(400).json({ ok: false, error: '默认服务固定占用主端口根路径，不使用 basePath 前缀' });
      return;
    }
    const raw = (req.body as { basePath?: unknown } | undefined)?.basePath;
    const basePath = typeof raw === 'string' ? raw.trim() : '';
    const formatError = registry.validateBasePathFormat(basePath);
    if (formatError) {
      res.status(400).json({ ok: false, error: formatError });
      return;
    }
    const conflict = registry.findBasePathConflict(basePath, serviceId);
    if (conflict) {
      res.status(409).json({ ok: false, error: conflict });
      return;
    }
    registry.updateService(serviceId, { basePath });
    res.json({ ok: true, service: describeService(registry, manager, registry.getService(serviceId) as Service) });
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

  // ---- 有状态 CRUD 存储（内存态，重启即清）：查看与清空 ----
  router.get('/crud', (_req, res) => {
    const collections: Array<{ serviceId: string; collection: string; count: number; records: Record<string, unknown>[] }> = [];
    for (const [key, resources] of options.crudStores ?? []) {
      const sep = key.indexOf('\0');
      collections.push({ serviceId: key.slice(0, sep), collection: key.slice(sep + 1), count: resources.size, records: [...resources.values()] });
    }
    res.json({ ok: true, collections });
  });

  /* 按查询参数过滤清空：serviceId / collection 均可单独或组合指定，均缺省时清空全部；返回清理的资源条数 */
  router.delete('/crud', (req, res) => {
    const serviceId = typeof req.query.serviceId === 'string' && req.query.serviceId ? req.query.serviceId : undefined;
    const collection = typeof req.query.collection === 'string' && req.query.collection ? req.query.collection : undefined;
    let cleared = 0;
    for (const [key, resources] of options.crudStores ?? []) {
      const sep = key.indexOf('\0');
      if (serviceId !== undefined && key.slice(0, sep) !== serviceId) continue;
      if (collection !== undefined && key.slice(sep + 1) !== collection) continue;
      cleared += resources.size;
      resources.clear();
    }
    res.json({ ok: true, cleared });
  });

  // ---- WS 连接快照（只读）：调试台实时连接列表用 ----
  router.get('/ws/connections', (_req, res) => {
    const connections: WsConnectionSnapshot[] = options.gateway?.snapshot() ?? [];
    res.json({ ok: true, connections });
  });

  // ---- 管理 API（接口注册）----
  router.get('/routes', (req, res) => {
    const serviceId = typeof req.query.serviceId === 'string' ? req.query.serviceId : undefined;
    res.json({ ok: true, routes: registry.list(serviceId) });
  });

  router.post('/routes', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { serviceId, name, path: routePath, request, requireMatch, variants, sequence, auth } = body;
    const response = body.response as { body?: unknown; status?: unknown; contentType?: unknown; headers?: unknown } | undefined;
    const protocol = body.protocol;
    if (protocol !== undefined && protocol !== 'http' && protocol !== 'ws') {
      res.status(400).json({ ok: false, error: 'protocol 需为 http 或 ws' });
      return;
    }
    const isWs = protocol === 'ws';
    /* WS 接口的 method 固定为 WS：未提供时自动补齐 */
    const method = typeof body.method === 'string' && body.method ? body.method : isWs ? 'WS' : undefined;
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
    /* 路径模式：默认服务接口首段不可与任何服务 basePath 重合（会被前缀分发遮蔽，永远无法命中） */
    if (options.mode === 'path' && sid === DEFAULT_SERVICE_ID) {
      const firstSegment = routePath.split('/').filter(Boolean)[0];
      const shadowService = firstSegment ? registry.findServiceByBasePath(firstSegment) : undefined;
      if (shadowService) {
        res.status(409).json({ ok: false, error: `路径首段 "${firstSegment}" 已被服务「${shadowService.name}」的 basePath 占用，默认服务接口会因此被遮蔽` });
        return;
      }
    }

    // ---- WS 分支：method 固定 WS，独立校验，不要求 response 等 HTTP 字段 ----
    if (isWs) {
      if (method.toUpperCase() !== 'WS') {
        res.status(400).json({ ok: false, error: 'WS 接口的 method 固定为 WS，无需填写' });
        return;
      }
      const forbidden = firstWsForbiddenField(body);
      if (forbidden) {
        res.status(400).json({ ok: false, error: `WS 接口不支持 ${forbidden} 字段（HTTP 专属）` });
        return;
      }
      if (body.disabled !== undefined && typeof body.disabled !== 'boolean') {
        res.status(400).json({ ok: false, error: 'disabled 需为布尔值' });
        return;
      }
      let wsBehavior: WsBehavior | undefined;
      if (body.ws !== undefined) {
        const parsed = parseWsBehavior(body.ws);
        if (!parsed.ok) {
          res.status(400).json({ ok: false, error: parsed.error });
          return;
        }
        wsBehavior = parsed.value;
      }
      let wsAuth: RouteAuth | undefined;
      if (auth !== undefined) {
        const parsed = parseRouteAuth(auth);
        if (!parsed.ok) {
          res.status(400).json({ ok: false, error: parsed.error });
          return;
        }
        wsAuth = parsed.value;
      }
      const route = registry.addWs(sid, routePath, routeName, wsBehavior, {
        ...(body.disabled !== undefined ? { disabled: body.disabled as boolean } : {}),
        ...(wsAuth ? { auth: wsAuth } : {}),
      });
      res.status(201).json({ ok: true, route });
      return;
    }
    if (method.toUpperCase() === 'WS') {
      res.status(400).json({ ok: false, error: 'method WS 需以 protocol:"ws" 创建' });
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

    const bodyParsed = parseResponseBody(response?.body, 'response', isJsonContentType(effectiveResponseContentType(response)));
    if (!bodyParsed.ok) {
      res.status(400).json({ ok: false, error: bodyParsed.error });
      return;
    }
    const headersParsed = parseResponseHeaders(response?.headers, 'response');
    if (!headersParsed.ok) {
      res.status(400).json({ ok: false, error: headersParsed.error });
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
      status: typeof response?.status === 'number' ? response.status : 200,
      contentType: typeof response?.contentType === 'string' ? response.contentType : undefined,
      ...(headersParsed.value ? { headers: headersParsed.value } : {}),
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
    if (!registry.remove(serviceId, method, routePath)) {
      res.status(404).json({ ok: false, error: '接口不存在' });
      return;
    }
    res.json({ ok: true });
  });

  router.put('/routes/:id', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { serviceId, name, method, path: routePath, request, requireMatch, variants, sequence, auth } = body;
    const response = body.response as { body?: unknown; status?: unknown; contentType?: unknown; headers?: unknown } | undefined;
    const patch: Partial<Pick<Route, 'serviceId' | 'method' | 'path' | 'name' | 'response' | 'request' | 'requireMatch' | 'variants' | 'disabled' | 'delayMs' | 'jitterMs' | 'failureRate' | 'sequence' | 'crud' | 'auth' | 'ws'>> = {};

    /* 当前路由的协议决定分支校验：WS 路由拒收 HTTP 专属字段，HTTP 路由拒收 ws 字段 */
    const current = registry.findById(req.params.id);
    const isWs = current?.protocol === 'ws';

    if (body.protocol !== undefined) {
      res.status(400).json({ ok: false, error: 'protocol 不可变更（HTTP / WS 接口需各自新建）' });
      return;
    }
    if (isWs) {
      const forbidden = firstWsForbiddenField(body);
      if (forbidden) {
        res.status(400).json({ ok: false, error: `WS 接口不支持 ${forbidden} 字段（HTTP 专属）` });
        return;
      }
      if (method !== undefined && (typeof method !== 'string' || method.toUpperCase() !== 'WS')) {
        res.status(400).json({ ok: false, error: 'WS 接口的 method 固定为 WS' });
        return;
      }
    } else if (current && typeof method === 'string' && method.toUpperCase() === 'WS') {
      res.status(400).json({ ok: false, error: 'method WS 需以 protocol:"ws" 创建' });
      return;
    }
    if (body.ws !== undefined) {
      if (current && current.protocol !== 'ws') {
        res.status(400).json({ ok: false, error: '仅 WS 接口支持 ws 字段' });
        return;
      }
      /* null 表示清除 ws 配置 */
      const parsed = body.ws === null ? { ok: true as const, value: undefined } : parseWsBehavior(body.ws);
      if (!parsed.ok) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      patch.ws = parsed.value;
    }

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
      const bodyParsed = parseResponseBody(response?.body, 'response', isJsonContentType(effectiveResponseContentType(response)));
      if (!bodyParsed.ok) {
        res.status(400).json({ ok: false, error: bodyParsed.error });
        return;
      }
      const headersParsed = parseResponseHeaders(response?.headers, 'response');
      if (!headersParsed.ok) {
        res.status(400).json({ ok: false, error: headersParsed.error });
        return;
      }
      patch.response = {
        status: typeof response?.status === 'number' ? response.status : 200,
        contentType: typeof response?.contentType === 'string' ? response.contentType : undefined,
        ...(headersParsed.value ? { headers: headersParsed.value } : {}),
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
      res.status(400).json({ ok: false, error: '没有可更新的字段（serviceId / name / method / path / response / request / requireMatch / gateStatus / variants / disabled / delayMs / jitterMs / failureRate / sequence / crud / auth / ws）' });
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