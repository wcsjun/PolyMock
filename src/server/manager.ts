import { createServer, type Server } from 'node:http';
import type { RouteRegistry } from '../registry.js';
import type { Service } from '../types.js';
import { createRouteApp } from './app.js';
import type { DispatchDeps } from './dispatch.js';
import type { WsGateway } from './ws-gateway.js';

export interface ServiceManagerLike {
  isRunning(serviceId: string): boolean;
  start(service: Service): Promise<void>;
  stop(serviceId: string): Promise<void>;
}

export interface ServiceManagerOptions {
  /** 单端口模式（路径模式）：不启动独立端口监听，所有服务经主端口 basePath 前缀分发 */
  singlePort?: boolean;
  /** 共享 WS 网关：附加到每个服务的 HTTP Server 处理 upgrade；stop 时销毁该服务全部连接 */
  gateway?: WsGateway;
}

/** stop() 的超时兜底毫秒：长连接未及时断开也保证端口最终释放 */
const STOP_TIMEOUT_MS = 3000;

export class ServiceManager implements ServiceManagerLike {
  private readonly servers = new Map<string, Server>();

  /** deps 透传给每个服务的 Mock 应用（请求日志与 {{$id}} 计数器） */
  constructor(
    private readonly registry: RouteRegistry,
    private readonly deps?: DispatchDeps,
    private readonly options?: ServiceManagerOptions,
  ) {}

  isRunning(serviceId: string): boolean {
    if (this.options?.singlePort) return this.registry.getService(serviceId) !== undefined;
    return this.servers.has(serviceId);
  }

  async start(service: Service): Promise<void> {
    if (this.options?.singlePort) return;
    if (this.servers.has(service.id)) return;
    const app = createRouteApp(this.registry, service.id, this.deps);
    /* app.listen 会藏起 http.Server 导致 upgrade 无人接管：显式 createServer 后挂 WS 网关再监听 */
    const server = createServer(app);
    this.options?.gateway?.attach(server, (req) => {
      const url = new URL(req.url ?? '/', 'http://polymock.local');
      return { serviceId: service.id, path: url.pathname };
    });
    await new Promise<void>((resolve, reject) => {
      server.on('error', (err) => {
        this.servers.delete(service.id);
        reject(err);
      });
      this.servers.set(service.id, server);
      server.listen(service.port, () => resolve());
    });
  }

  async stop(serviceId: string): Promise<void> {
    const server = this.servers.get(serviceId);
    if (!server) return;
    this.servers.delete(serviceId);
    /* 先销毁该服务的 WS 连接，否则挂着的长连接会让 server.close() 永久等待 */
    this.options?.gateway?.destroyForService(serviceId);
    await new Promise<void>((resolve) => {
      /* keep-alive 的 HTTP 连接同样会让 close() 一直等待：超时后强制断开全部残余连接，
         让 close 回调真正完成、端口确认释放（否则同端口重建服务会 EADDRINUSE） */
      const timer = setTimeout(() => server.closeAllConnections(), STOP_TIMEOUT_MS);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async startAll(services: Service[]): Promise<void> {
    for (const service of services) {
      await this.start(service).catch((err) => {
        console.error(`[PolyMock] 服务「${service.name}」(:${service.port}) 启动失败: ${(err as Error).message}`);
      });
    }
  }
}
