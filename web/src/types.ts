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
  /** 默认响应的前置条件；仅 requireMatch 为 true 时作为接口准入门槛参与校验 */
  request?: RouteRequest;
  /** 开启后：所有请求必须满足 request 条件才能访问该接口（优先于变体），否则返回 400 */
  requireMatch?: boolean;
  /** 响应变体，按数组顺序优先于默认响应匹配 */
  variants?: ResponseVariant[];
  createdAt: number;
}

/** 接口响应定义（后端 RouteResponse 镜像） */
export interface RouteResponse {
  status: number;
  contentType?: string;
  body: unknown;
}

/** 条件值比对方式（后端 ConditionType 镜像）；缺省 string 字符串化比对 */
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

/** 条件表格行草稿：enabled 为纯前端状态，未启用的行不参与提交 */
export interface ConditionRow {
  key: string;
  value: string;
  type: ConditionType;
  required: boolean;
  enabled: boolean;
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
  request?: RouteRequest;
  requireMatch?: boolean;
  variants?: Array<{
    name: string;
    match?: RouteRequest;
    response: { status: number; body: string };
  }>;
}
