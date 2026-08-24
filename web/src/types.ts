/** 与后端 src/types.ts 及 /__polymock 管理 API 返回结构保持一致的前端类型 */

export type ViewName = 'routes' | 'embed';

export type ToastKind = 'ok' | 'err' | 'warn';

export type NotifyFn = (message: string, kind?: ToastKind) => void;

/** GET /__polymock/routes 返回的接口定义 */
export interface Route {
  id: string;
  serviceId: string;
  protocol: 'http';
  method: string;
  path: string;
  name?: string;
  response: RouteResponse;
  createdAt: number;
}

/** 接口响应定义（后端 RouteResponse 镜像） */
export interface RouteResponse {
  status: number;
  contentType?: string;
  body: unknown;
}

/** GET /__polymock/services 返回的服务分组（含管理 API 派生字段） */
export interface ServiceInfo {
  id: string;
  name: string;
  port: number;
  createdAt: number;
  isDefault: boolean;
  running: boolean;
  count: number;
}

/** 新增/编辑接口时的请求体（body 为原始文本，由后端做 JSON 解析） */
export interface RoutePayload {
  serviceId: string;
  method: string;
  path: string;
  name?: string;
  response: { status: number; body: string };
}
