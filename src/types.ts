export const DEFAULT_SERVICE_ID = 'default';

export interface RouteResponse {
  status: number;
  contentType?: string;
  body: unknown;
}

/** 单条请求匹配条件（key 精确比对，value 字符串化比对） */
export interface RequestCondition {
  key: string;
  value: string;
}

/** 接口的预期请求条件：headers 不区分大小写、query 参数、JSON body 点路径 */
export interface RouteRequest {
  query?: RequestCondition[];
  headers?: RequestCondition[];
  body?: RequestCondition[];
}

/** 同一接口下的响应变体：按数组顺序匹配，第一个条件全部通过的生效 */
export interface ResponseVariant {
  id: string;
  name: string;
  match?: RouteRequest;
  response: RouteResponse;
}

export interface Service {
  id: string;
  name: string;
  port: number;
  createdAt: number;
}

export interface Route {
  id: string;
  serviceId: string;
  protocol: 'http';
  method: string;
  path: string;
  name?: string;
  response: RouteResponse;
  /** 默认响应的前置条件；仅 requireMatch 为 true 时作为接口准入门槛参与校验 */
  request?: RouteRequest;
  /** 开启后：所有请求必须满足 request 条件才能访问该接口（优先于变体），否则返回 400 */
  requireMatch?: boolean;
  /** 响应变体，按数组顺序优先于默认响应匹配 */
  variants?: ResponseVariant[];
  createdAt: number;
}

export interface PersistedState {
  version: 1;
  services: Service[];
  routes: Route[];
}
