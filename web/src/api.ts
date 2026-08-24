import type { Route, RoutePayload, ServiceInfo } from './types';

/** 对应原 app.js 的 api()：非 2xx 时抛出后端 error 字段信息 */
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, options);
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data as T;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

interface OkEnvelope {
  ok: true;
}

export function fetchServices(): Promise<{ ok: true; services: ServiceInfo[] }> {
  return api('/__polymock/services');
}

export function fetchRoutes(): Promise<{ ok: true; routes: Route[] }> {
  return api('/__polymock/routes');
}

export function createService(name: string, port: number): Promise<OkEnvelope> {
  return api('/__polymock/services', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, port }),
  });
}

export function deleteService(id: string): Promise<OkEnvelope> {
  return api(`/__polymock/services/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function createRoute(payload: RoutePayload): Promise<OkEnvelope> {
  return api('/__polymock/routes', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export function updateRoute(id: string, payload: RoutePayload): Promise<OkEnvelope> {
  return api(`/__polymock/routes/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export function deleteRoute(route: Pick<Route, 'method' | 'path' | 'serviceId'>): Promise<OkEnvelope> {
  const query = new URLSearchParams({
    method: route.method,
    path: route.path,
    serviceId: route.serviceId,
  });
  return api(`/__polymock/routes?${query}`, { method: 'DELETE' });
}
