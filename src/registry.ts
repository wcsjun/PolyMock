import { randomUUID } from 'node:crypto';
import type { Route, RouteResponse } from './types.js';

export class RouteRegistry {
  private readonly routes = new Map<string, Route>();

  private static key(method: string, path: string): string {
    return `${method.toUpperCase()} ${path}`;
  }

  add(method: string, path: string, response: RouteResponse): Route {
    const route: Route = {
      id: randomUUID(),
      protocol: 'http',
      method: method.toUpperCase(),
      path,
      response,
      createdAt: Date.now(),
    };
    this.routes.set(RouteRegistry.key(route.method, route.path), route);
    return route;
  }

  remove(method: string, path: string): boolean {
    return this.routes.delete(RouteRegistry.key(method, path));
  }

  find(method: string, path: string): Route | undefined {
    return this.routes.get(RouteRegistry.key(method, path));
  }

  list(): Route[] {
    return [...this.routes.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}
