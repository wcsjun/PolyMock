import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PersistedState, Route, RouteResponse, Service } from './types.js';

export class RouteRegistry extends EventEmitter {
  private readonly services = new Map<string, Service>();
  private readonly routes = new Map<string, Route>();

  constructor(state?: PersistedState) {
    super();
    for (const service of state?.services ?? []) {
      this.services.set(service.id, service);
    }
    for (const route of state?.routes ?? []) {
      this.routes.set(RouteRegistry.key(route.serviceId, route.method, route.path), route);
    }
  }

  private static key(serviceId: string, method: string, path: string): string {
    return `${serviceId}\u0000${method.toUpperCase()} ${path}`;
  }

  // ---------- 服务分组 ----------

  getService(id: string): Service | undefined {
    return this.services.get(id);
  }

  addService(name: string, port: number, id: string = randomUUID()): Service {
    const service: Service = { id, name, port, createdAt: Date.now() };
    this.services.set(id, service);
    this.emit('change');
    return service;
  }

  removeService(id: string): boolean {
    const removed = this.services.delete(id);
    if (removed) {
      for (const [key, route] of this.routes) {
        if (route.serviceId === id) this.routes.delete(key);
      }
      this.emit('change');
    }
    return removed;
  }

  listServices(): Service[] {
    return [...this.services.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  findServiceByPort(port: number): Service | undefined {
    return [...this.services.values()].find((s) => s.port === port);
  }

  // ---------- 接口 ----------

  add(serviceId: string, method: string, path: string, response: RouteResponse, name?: string): Route {
    const route: Route = {
      id: randomUUID(),
      serviceId,
      protocol: 'http',
      method: method.toUpperCase(),
      path,
      name,
      response,
      createdAt: Date.now(),
    };
    this.routes.set(RouteRegistry.key(serviceId, route.method, path), route);
    this.emit('change');
    return route;
  }

  remove(serviceId: string, method: string, path: string): boolean {
    const removed = this.routes.delete(RouteRegistry.key(serviceId, method, path));
    if (removed) this.emit('change');
    return removed;
  }

  update(
    id: string,
    patch: Partial<Pick<Route, 'serviceId' | 'method' | 'path' | 'name' | 'response'>>,
  ): { ok: true; route: Route } | { ok: false; error: 'not-found' } | { ok: false; error: 'conflict'; conflict: Route } {
    const current = [...this.routes.values()].find((r) => r.id === id);
    if (!current) return { ok: false, error: 'not-found' };

    const next: Route = {
      ...current,
      ...patch,
      method: (patch.method ?? current.method).toUpperCase(),
      id: current.id,
      createdAt: current.createdAt,
    };
    const nextKey = RouteRegistry.key(next.serviceId, next.method, next.path);
    const occupant = this.routes.get(nextKey);
    if (occupant && occupant.id !== id) {
      return { ok: false, error: 'conflict', conflict: occupant };
    }

    this.routes.delete(RouteRegistry.key(current.serviceId, current.method, current.path));
    this.routes.set(nextKey, next);
    this.emit('change');
    return { ok: true, route: next };
  }

  find(serviceId: string, method: string, path: string): Route | undefined {
    return this.routes.get(RouteRegistry.key(serviceId, method, path));
  }

  list(serviceId?: string): Route[] {
    const routes = serviceId
      ? [...this.routes.values()].filter((r) => r.serviceId === serviceId)
      : [...this.routes.values()];
    return routes.sort((a, b) => a.createdAt - b.createdAt);
  }

  toJSON(): PersistedState {
    return { version: 1, services: this.listServices(), routes: this.list() };
  }
}
