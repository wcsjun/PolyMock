import type { CallbackTemplate, CallbackTemplateInfo, CrudCollectionStore, MockMeta, MockSettings, RequestLogEntry, Route, RoutePayload, ServiceInfo, WsConnectionSnapshot, WsRoutePayload } from './types';

/** 管理令牌（可选）：后端设置 POLYMOCK_ADMIN_TOKEN 后，所有管理请求需携带该令牌 */
export function getAdminToken(): string {
  try {
    return localStorage.getItem('polymock:token') ?? '';
  } catch {
    return '';
  }
}

export function setAdminToken(token: string): void {
  try {
    if (token) localStorage.setItem('polymock:token', token);
    else localStorage.removeItem('polymock:token');
  } catch {
    /* 忽略存储失败 */
  }
}

/** 对应原 app.js 的 api()：非 2xx 时抛出后端 error 字段信息 */
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  const token = getAdminToken();
  if (token) headers.set('x-polymock-token', token);
  const res = await fetch(path, { ...options, headers });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    const message = data.error || `请求失败（${res.status}）`;
    /* 401 时补上控制台入口，避免用户只看到「需要令牌」却不知道去哪填 */
    throw new Error(res.status === 401 ? `${message}；可在左侧栏「管理令牌」中填写` : message);
  }
  return data as T;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

interface OkEnvelope {
  ok: true;
}

export function fetchServices(): Promise<{ ok: true; services: ServiceInfo[] }> {
  return api('/__polymock/services');
}

/** 运行模式元信息：前端据此切换端口/路径两种 UI */
export function fetchMeta(): Promise<{ ok: true } & MockMeta> {
  return api('/__polymock/meta');
}

export function fetchRoutes(): Promise<{ ok: true; routes: Route[] }> {
  return api('/__polymock/routes');
}

/** 新增服务：端口模式传 port；路径模式传 basePath（可缺省，后端自动生成） */
export function createService(name: string, port: number, basePath?: string): Promise<OkEnvelope> {
  const body = basePath !== undefined ? { name, basePath } : { name, port };
  return api('/__polymock/services', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** 修改服务 basePath 前缀（路径模式） */
export function updateServiceBasePath(id: string, basePath: string): Promise<OkEnvelope> {
  return api(`/__polymock/services/${encodeURIComponent(id)}/basePath`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ basePath }),
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

/** 新增 WS 接口（protocol:"ws" 分支，后端独立校验） */
export function createWsRoute(payload: WsRoutePayload): Promise<OkEnvelope> {
  return api('/__polymock/routes', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

/** 更新 WS 接口（patch 语义；ws 传 null 清除行为配置） */
export function updateWsRoute(id: string, payload: Partial<WsRoutePayload>): Promise<OkEnvelope> {
  return api(`/__polymock/routes/${encodeURIComponent(id)}`, {
    method: 'PUT',
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

/** 局部更新接口开关/延迟/故障字段（后端 PUT 支持 patch 语义） */
export function updateRouteFlags(
  id: string,
  patch: { disabled?: boolean; delayMs?: number; jitterMs?: number; failureRate?: number },
): Promise<OkEnvelope> {
  return api(`/__polymock/routes/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
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

/* ---------- 请求日志 ---------- */

export function fetchRequests(params?: { serviceId?: string; limit?: number }): Promise<{ ok: true; requests: RequestLogEntry[] }> {
  const query = new URLSearchParams();
  if (params?.serviceId) query.set('serviceId', params.serviceId);
  if (params?.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return api(`/__polymock/requests${qs ? `?${qs}` : ''}`);
}

export function clearRequests(): Promise<OkEnvelope> {
  return api('/__polymock/requests', { method: 'DELETE' });
}

/* ---------- 服务代理穿透 ---------- */

export function setProxy(serviceId: string, target: string | null): Promise<OkEnvelope> {
  return api(`/__polymock/services/${encodeURIComponent(serviceId)}/proxy`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ target }),
  });
}

/* ---------- 全局设置（场景集） ---------- */

export function fetchSettings(): Promise<{ ok: true; settings: MockSettings }> {
  return api('/__polymock/settings');
}

export function updateSettings(patch: MockSettings): Promise<OkEnvelope> {
  return api('/__polymock/settings', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
}

/* ---------- WS 连接快照（只读） ---------- */

/** GET /__polymock/ws/connections：当前全部活跃 WS 连接（调试台实时连接列表用） */
export function fetchWsConnections(): Promise<{ ok: true; connections: WsConnectionSnapshot[] }> {
  return api('/__polymock/ws/connections');
}

/* ---------- 有状态 CRUD 存储（内存态） ---------- */
export function fetchCrudStores(): Promise<{ ok: true; collections: CrudCollectionStore[] }> {
  return api('/__polymock/crud');
}

/** 清空 CRUD 集合存储；serviceId / collection 均缺省时清空全部，返回清理的资源条数 */
export function clearCrudStore(params?: { serviceId?: string; collection?: string }): Promise<{ ok: true; cleared: number }> {
  const query = new URLSearchParams();
  if (params?.serviceId) query.set('serviceId', params.serviceId);
  if (params?.collection) query.set('collection', params.collection);
  const qs = query.toString();
  return api(`/__polymock/crud${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
}

/* ---------- 异步回调（回调模板 CRUD + 出站重发） ---------- */

/** 回调模板的新建/更新输入（id / createdAt 由后端生成） */
export type CallbackTemplateInput = Omit<CallbackTemplate, 'id' | 'createdAt'>;

/** 回调模板列表（含引用位置 usage 与出站统计 stats） */
export function fetchCallbacks(): Promise<{ ok: true; callbacks: CallbackTemplateInfo[] }> {
  return api('/__polymock/callbacks');
}

export function createCallbackTemplate(input: CallbackTemplateInput): Promise<{ ok: true; template: CallbackTemplate }> {
  return api('/__polymock/callbacks', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

/** 更新回调模板；affected = 受影响分支数（编辑预警用） */
export function updateCallbackTemplate(
  id: string,
  input: CallbackTemplateInput,
): Promise<{ ok: true; template: CallbackTemplate; affected: number }> {
  return api(`/__polymock/callbacks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

export function deleteCallbackTemplate(id: string): Promise<OkEnvelope> {
  return api(`/__polymock/callbacks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 重发出站回调：按已存的渲染结果（目标/方法/头/载荷）原样发送，不重新渲染模板 */
export function resendCallbackEntry(logId: string): Promise<{ ok: true; status: number }> {
  return api(`/__polymock/requests/${encodeURIComponent(logId)}/resend`, { method: 'POST' });
}
