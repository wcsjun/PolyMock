import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  PersistedState,
  ResponseVariant,
  Route,
  RouteRequest,
  RouteResponse,
  Service,
} from './types.js';

/** 路由响应行为字段（禁用 / 延迟 / 抖动 / 故障注入），可通过 add 的 behavior 与 update 的 patch 设置 */
export type RouteBehavior = Pick<Route, 'disabled' | 'delayMs' | 'jitterMs' | 'failureRate'>;

export class RouteRegistry extends EventEmitter {
  private readonly services = new Map<string, Service>();
  private readonly routes = new Map<string, Route>();
  private settings: { activeVariant?: string | null } = {};

  constructor(state?: PersistedState) {
    super();
    for (const service of state?.services ?? []) {
      this.services.set(service.id, service);
    }
    for (const route of state?.routes ?? []) {
      this.routes.set(RouteRegistry.key(route.serviceId, route.method, route.path), route);
    }
    if (state?.settings) {
      this.settings = { ...state.settings };
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

  /** 更新服务分组（名称 / 代理目标）；服务不存在返回 false */
  updateService(id: string, patch: Partial<Pick<Service, 'name' | 'proxyTarget'>>): boolean {
    const current = this.services.get(id);
    if (!current) return false;
    this.services.set(id, { ...current, ...patch });
    this.emit('change');
    return true;
  }

  listServices(): Service[] {
    return [...this.services.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  findServiceByPort(port: number): Service | undefined {
    return [...this.services.values()].find((s) => s.port === port);
  }

  // ---------- 接口 ----------

  add(
    serviceId: string,
    method: string,
    path: string,
    response: RouteResponse,
    name?: string,
    request?: RouteRequest,
    requireMatch?: boolean,
    variants?: ResponseVariant[],
    behavior?: RouteBehavior,
  ): Route {
    const route: Route = {
      id: randomUUID(),
      serviceId,
      protocol: 'http',
      method: method.toUpperCase(),
      path,
      name,
      response,
      request,
      requireMatch,
      variants,
      createdAt: Date.now(),
      ...behavior,
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
    patch: Partial<Pick<Route, 'serviceId' | 'method' | 'path' | 'name' | 'response' | 'request' | 'requireMatch' | 'variants' | 'disabled' | 'delayMs' | 'jitterMs' | 'failureRate'>>,
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

  /** 精确查找（跳过已禁用的路由，禁用视为未注册） */
  find(serviceId: string, method: string, path: string): Route | undefined {
    const route = this.routes.get(RouteRegistry.key(serviceId, method, path));
    return route?.disabled ? undefined : route;
  }

  /** 不过滤禁用状态的查找（默认路由播种 / 管理场景用，避免禁用后被重新播种） */
  findAny(serviceId: string, method: string, path: string): Route | undefined {
    return this.routes.get(RouteRegistry.key(serviceId, method, path));
  }

  list(serviceId?: string): Route[] {
    const routes = serviceId
      ? [...this.routes.values()].filter((r) => r.serviceId === serviceId)
      : [...this.routes.values()];
    return routes.sort((a, b) => a.createdAt - b.createdAt);
  }

  // ---------- 全局设置 ----------

  getSettings(): { activeVariant?: string | null } {
    return { ...this.settings };
  }

  setSettings(patch: { activeVariant?: string | null }): void {
    this.settings = { ...this.settings, ...patch };
    this.emit('change');
  }

  toJSON(): PersistedState {
    return { version: 1, services: this.listServices(), routes: this.list(), settings: { ...this.settings } };
  }
}
