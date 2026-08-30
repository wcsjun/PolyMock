import type { Server } from 'node:http';
import type { RouteRegistry } from '../registry.js';
import type { Service } from '../types.js';
import { createRouteApp, type DispatchDeps } from './app.js';

export interface ServiceManagerLike {
  isRunning(serviceId: string): boolean;
  start(service: Service): Promise<void>;
  stop(serviceId: string): Promise<void>;
}

export class ServiceManager implements ServiceManagerLike {
  private readonly servers = new Map<string, Server>();

  /** deps 透传给每个服务的 Mock 应用（请求日志与 {{$id}} 计数器） */
  constructor(
    private readonly registry: RouteRegistry,
    private readonly deps?: DispatchDeps,
  ) {}

  isRunning(serviceId: string): boolean {
    return this.servers.has(serviceId);
  }

  async start(service: Service): Promise<void> {
    if (this.servers.has(service.id)) return;
    const app = createRouteApp(this.registry, service.id, this.deps);
    await new Promise<void>((resolve, reject) => {
      const server = app.listen(service.port, () => resolve());
      server.on('error', (err) => {
        this.servers.delete(service.id);
        reject(err);
      });
      this.servers.set(service.id, server);
    });
  }

  async stop(serviceId: string): Promise<void> {
    const server = this.servers.get(serviceId);
    if (!server) return;
    this.servers.delete(serviceId);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async startAll(services: Service[]): Promise<void> {
    for (const service of services) {
      await this.start(service).catch((err) => {
        console.error(`[PolyMock] 服务「${service.name}」(:${service.port}) 启动失败: ${(err as Error).message}`);
      });
    }
  }
}
