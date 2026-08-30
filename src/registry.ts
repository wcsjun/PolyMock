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
import { SCHEMA_VERSION } from './types.js';

/** 路由响应行为字段（禁用/延迟/抖动/故障/序列/CRUD），可通过 add 的 behavior 与 update 的 patch 设置 */
export type RouteBehavior = Pick<Route, 'disabled' | 'delayMs' | 'jitterMs' | 'failureRate' | 'sequence' | 'crud'>;

/** 模式路径与实际路径段匹配；命中返回参数表，否则 undefined */
function matchSegments(patternPath: string, actualPath: string): Record<string, string> | undefined {
  const patternSegments = patternPath.split('/');
  const actualSegments = actualPath.split('/');
  if (patternSegments.length !== actualSegments.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    if (patternSegments[i].startsWith(':')) {
      params[patternSegments[i].slice(1)] = actualSegments[i];
    } else if (patternSegments[i] !== actualSegments[i]) {
      return undefined;
    }
  }
  return params;
}

/** 两条路径是否形状冲突：段数一致，且每对段中至少一个为参数段或字面量相等 */
function shapesConflict(a: string, b: string): boolean {
  const as = a.split('/');
  const bs = b.split('/');
  if (as.length !== bs.length) return false;
  return as.every((segment, i) => segment.startsWith(':') || bs[i].startsWith(':') || segment === bs[i]);
}

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
    patch: Partial<Pick<Route, 'serviceId' | 'method' | 'path' | 'name' | 'response' | 'request' | 'requireMatch' | 'variants' | 'disabled' | 'delayMs' | 'jitterMs' | 'failureRate' | 'sequence' | 'crud'>>,
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
    /* 形状冲突检查（含精确 key 占用，且覆盖路径参数互撞） */
    const shapeConflict = this.findShapeConflict(next.serviceId, next.method, next.path, id);
    if (shapeConflict) {
      return { ok: false, error: 'conflict', conflict: shapeConflict };
    }

    this.routes.delete(RouteRegistry.key(current.serviceId, current.method, current.path));
    this.routes.set(RouteRegistry.key(next.serviceId, next.method, next.path), next);
    this.emit('change');
    return { ok: true, route: next };
  }

  /** 精确查找（跳过已禁用的路由，禁用视为未注册） */
  find(serviceId: string, method: string, path: string): Route | undefined {
    return this.findWithParams(serviceId, method, path)?.route;
  }

  /** 查找路由并提取路径参数：先精确匹配，再按段匹配 :param 模式路由（均跳过禁用） */
  findWithParams(serviceId: string, method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    const upper = method.toUpperCase();
    const exact = this.routes.get(RouteRegistry.key(serviceId, upper, path));
    if (exact && !exact.disabled) return { route: exact, params: {} };
    const actualSegments = path.split('/');
    for (const route of this.routes.values()) {
      if (route.serviceId !== serviceId || route.method !== upper || route.disabled) continue;
      if (!route.path.includes(':')) continue;
      const params = matchSegments(route.path, path);
      if (params) return { route, params };
    }
    return undefined;
  }

  /** 形状冲突查找：与目标 path 存在匹配空间重叠的其他路由（excludeId 用于 update 排除自身） */
  findShapeConflict(serviceId: string, method: string, path: string, excludeId?: string): Route | undefined {
    const upper = method.toUpperCase();
    for (const route of this.routes.values()) {
      if (route.serviceId !== serviceId || route.method !== upper || route.id === excludeId) continue;
      if (shapesConflict(route.path, path)) return route;
    }
    return undefined;
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
    return { version: SCHEMA_VERSION, services: this.listServices(), routes: this.list(), settings: { ...this.settings } };
  }
}
