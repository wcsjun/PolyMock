import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminRouter } from './admin.js';
import { captureJsonRawBody, captureNonJsonRawBody, createDispatch, type DispatchDeps } from './dispatch.js';
import type { RequestLogStore } from './request-log.js';
import type { ServiceManager } from './manager.js';
import type { RouteRegistry } from '../registry.js';
import type { WsGateway } from './ws-gateway.js';
import { DEFAULT_SERVICE_ID, type PolyMockMode } from '../types.js';
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
  /** 运行模式：path 时按服务 basePath 前缀经主端口分发；缺省 port（各服务独立端口） */
  mode?: PolyMockMode;
  /** 有状态 CRUD 共享存储（key = serviceId + 集合路径）：注入后与 ServiceManager 共用同一份，管理端 /crud 端点借此查看；缺省自建 */
  crudStores?: Map<string, Map<string, Record<string, unknown>>>;
  /** CRUD 自动生成 id 的自增计数（key 同 crudStores）；缺省自建 */
  crudCounters?: Map<string, number>;
  /** 共享 WS 网关：管理端 /ws/connections 借此暴露连接快照；缺省返回空列表 */
  gateway?: WsGateway;
}


export function createApp(registry: RouteRegistry, manager: ServiceManager, options: MainAppOptions): express.Express {
  const app = express();
  /* 非 JSON 请求体原文先捕获（JSON 请求由 express.json 的 verify 捕获），供 body 原文全文比对使用 */
  app.use(captureNonJsonRawBody);
  app.use(express.json({ limit: '10mb', verify: captureJsonRawBody }));

  /* 配置状态版本：注册表 change 自增的内存态计数（不持久化，重启归零），/meta 暴露给前端轮询跳过未变更数据 */
  let stateVersion = 0;
  registry.on('change', () => {
    stateVersion += 1;
  });

  // 主端口分发共享的计数器与状态存储（key = routeId；CRUD 存储键 = serviceId + 集合路径）
  const deps: DispatchDeps = {
    logs: options.logs,
    idCounters: new Map<string, number>(),
    seqCounters: new Map<string, number>(),
    crudStores: options.crudStores ?? new Map<string, Map<string, Record<string, unknown>>>(),
    crudCounters: options.crudCounters ?? new Map<string, number>(),
    proxyAllowHosts: options.proxyAllowHosts,
  };

  // ---- 管理 API ----
  app.use('/__polymock', createAdminRouter(registry, manager, {
    mainPort: options.mainPort,
    logs: options.logs,
    adminToken: options.adminToken,
    proxyAllowHosts: options.proxyAllowHosts,
    mode: options.mode,
    crudStores: deps.crudStores,
    gateway: options.gateway,
    stateVersion: () => stateVersion,
  }));

  // ---- 路径模式：/{basePath}/** 剥离前缀后分发到对应服务；未命中前缀回退后续处理（静态资源 / 默认服务）----
  if (options.mode === 'path') {
    const dispatchers = new Map<string, express.RequestHandler>();
    const dispatcherFor = (serviceId: string): express.RequestHandler => {
      let handler = dispatchers.get(serviceId);
      if (!handler) {
        handler = createDispatch(registry, serviceId, deps);
        dispatchers.set(serviceId, handler);
      }
      return handler;
    };
    app.use((req, res, next) => {
      const firstSegment = req.path.split('/')[1] ?? '';
      const service = firstSegment ? registry.findServiceByBasePath(firstSegment) : undefined;
      if (!service) {
        next();
        return;
      }
      /* 剥离 basePath 前缀后复用该服务的 dispatch；dispatch 未命中（next）时还原 url 继续走静态资源/默认分发 */
      const queryIndex = req.url.indexOf('?');
      const query = queryIndex >= 0 ? req.url.slice(queryIndex) : '';
      const rest = req.path.slice(firstSegment.length + 1) || '/';
      const originalUrl = req.originalUrl;
      req.url = rest + query;
      req.originalUrl = req.url;
      dispatcherFor(service.id)(req, res, () => {
        req.url = originalUrl;
        req.originalUrl = originalUrl;
        next();
      });
    });
  }

  // ---- Web UI 静态资源 ----
  app.use(express.static(PUBLIC_DIR));

  // ---- Mock 接口分发（默认服务 = 主端口）----
  app.use(createDispatch(registry, DEFAULT_SERVICE_ID, deps));

  return app;
}

export function createRouteApp(registry: RouteRegistry, serviceId: string, deps?: DispatchDeps): express.Express {
  const app = express();
  /* 与主 App 一致：先捕获非 JSON 请求体原文，再由 express.json 解析 JSON 请求体 */
  app.use(captureNonJsonRawBody);
  app.use(express.json({ limit: '10mb', verify: captureJsonRawBody }));
  app.use(createDispatch(registry, serviceId, deps));
  return app;
}

