import type { Server } from 'node:http';
import type { RouteRegistry } from './registry.js';
import type { Service } from './types.js';
import { createRouteApp } from './server.js';

export class ServiceManager {
  private readonly servers = new Map<string, Server>();

  constructor(private readonly registry: RouteRegistry) {}

  isRunning(serviceId: string): boolean {
    return this.servers.has(serviceId);
  }

  async start(service: Service): Promise<void> {
    if (this.servers.has(service.id)) return;
    const app = createRouteApp(this.registry, service.id);
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
