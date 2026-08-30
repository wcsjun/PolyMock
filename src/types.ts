export const DEFAULT_SERVICE_ID = 'default';

export interface RouteResponse {
  status: number;
  contentType?: string;
  body: unknown;
}

/** 条件值比对方式；缺省按 string 字符串化比对（兼容旧数据） */
export type ConditionType = 'string' | 'number' | 'boolean' | 'json';

/** 单条请求匹配条件（key 精确比对，value 字符串化比对） */
export interface RequestCondition {
  key: string;
  value: string;
  /** 比对方式；json 表示期望值为 JSON 字面量并做深度相等比对 */
  type?: ConditionType;
  /** 必填：请求缺少该 key 即条件失败；false 时 key 缺失视为通过（存在才比对）。缺省 true */
  required?: boolean;
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
  /** 代理转发目标（如 http://localhost:3000）：未命中 Mock 接口时转发到该地址；缺省不代理 */
  proxyTarget?: string;
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
  /** 禁用后不再参与 Mock 匹配（视为未注册，可走代理） */
  disabled?: boolean;
  /** 固定延迟毫秒数（0-60000 整数） */
  delayMs?: number;
  /** 随机抖动毫秒上限（0-60000 整数），实际延迟 = delayMs + rand(0..jitterMs) */
  jitterMs?: number;
  /** 故障注入概率百分比（0-100），命中时返回 500 */
  failureRate?: number;
  createdAt: number;
}

export interface PersistedState {
  version: 1;
  services: Service[];
  routes: Route[];
  /** 全局设置（缺省兜底为空对象） */
  settings?: { activeVariant?: string | null };
}

/** 单条 Mock 请求日志（id 使用 randomUUID） */
export interface RequestLogEntry {
  id: string;
  ts: number;
  serviceId: string;
  method: string;
  path: string;
  /** 命中的路由与变体名（默认响应为 null；未命中任何路由为 null） */
  matched: { routeId: string; variant: string | null } | null;
  /** 是否走了代理转发 */
  proxied?: boolean;
  status: number;
  /** 失败原因（requireMatch 未通过 / 代理请求失败） */
  error?: string;
  durationMs: number;
  query?: Record<string, string>;
  /** 请求体预览（JSON 序列化后截断） */
  bodyPreview?: string;
  /** 上游响应状态码（代理时） */
  proxyStatus?: number;
  /** 上游响应体预览（截断，代理时） */
  proxyBody?: string;
}
