/** 与后端 src/types.ts 及 /__polymock 管理 API 返回结构保持一致的前端类型 */

export type ToastKind = 'ok' | 'err' | 'warn';

export type NotifyFn = (message: string, kind?: ToastKind) => void;

/** 运行模式（后端 PolyMockMode 镜像）：port 独立端口；path 主端口 basePath 前缀 */
export type PolyMockMode = 'port' | 'path';

/** GET /__polymock/meta 返回的运行模式元信息 */
export interface MockMeta {
  mode: PolyMockMode;
  mainPort: number;
}

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
  /** 路由级认证：配置后请求需携带正确凭证（401 优先于 requireMatch 门槛） */
  auth?: RouteAuth;
  /** 响应变体，按数组顺序优先于默认响应匹配 */
  variants?: ResponseVariant[];
  /** 停用后不参与匹配，请求按未注册处理（404） */
  disabled?: boolean;
  /** 固定延迟毫秒数（0-60000），命中后延迟返回 */
  delayMs?: number;
  /** 随机抖动毫秒数（0-60000），实际延迟 = delayMs + rand(0, jitterMs) */
  jitterMs?: number;
  /** 故障注入百分比（0-100），命中概率返回 500 */
  failureRate?: number;
  /** 序列响应：按命中次序循环返回（优先于场景集/变体/默认响应，requireMatch 门槛之后） */
  sequence?: Array<{ status: number; body: unknown }>;
  /** 有状态 CRUD：路径需含 :id 参数，服务内存维护资源集合（重启清空） */
  crud?: boolean;
  createdAt: number;
}

/** 接口响应定义（后端 RouteResponse 镜像） */
export interface RouteResponse {
  status: number;
  contentType?: string;
  body: unknown;
}

/** 路由级认证配置（后端 RouteAuth 镜像）：模拟后端鉴权，未携带正确凭证返回 401 */
export interface RouteAuth {
  /** 认证方式：apikey = 自定义 header 携带密钥；bearer = Authorization: Bearer <token> */
  type: 'apikey' | 'bearer';
  /** 期望的密钥 / 令牌值（精确比对） */
  value: string;
  /** 仅 apikey 有效：携带密钥的 header 名（缺省 X-API-Key） */
  header?: string;
}

/** 条件值比对方式（后端 ConditionType 镜像）；缺省 string 字符串化比对 */
export type ConditionType = 'string' | 'number' | 'boolean' | 'json' | 'array';

/** 单条请求匹配条件（key 精确比对，value 字符串化比对） */
export interface RequestCondition {
  key: string;
  value: string;
  /** 比对方式；json 表示期望值为 JSON 字面量并做深度相等比对；array 表示期望值为 JSON 数组字面量并做包含匹配（实际数组需包含全部期望元素，无序） */
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
  /** 代理穿透目标：未命中请求转发到该地址 */
  proxyTarget?: string;
  /** 路径模式前缀：/{basePath}/** 经主端口分发到该服务 */
  basePath?: string;
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
  disabled?: boolean;
  delayMs?: number;
  jitterMs?: number;
  failureRate?: number;
  sequence?: Array<{ status: number; body: string }>;
  crud?: boolean;
  /** 路由级认证：编辑态传 null 清除；新建态仅在开启时携带 */
  auth?: RouteAuth | null;
}

/** 请求日志条目（运行时态，不持久化）；matched 为 null 表示未命中（404 或代理穿透） */
export interface RequestLogEntry {
  id: string;
  ts: number;
  serviceId: string;
  method: string;
  path: string;
  matched: { routeId: string; variant: string | null } | null;
  /** 走代理穿透返回 */
  proxied?: boolean;
  status: number;
  /** 未命中原因（400 准入失败等） */
  error?: string;
  durationMs: number;
  query?: Record<string, string>;
  /** 请求 body 摘要（截断） */
  bodyPreview?: string;
  /** 代理响应状态码 */
  proxyStatus?: number;
  /** 代理响应原文（截断），用于「保存为接口」 */
  proxyBody?: string;
}

/** 全局设置（持久化到 polymock.config.json） */
export interface MockSettings {
  /** 全局场景集：设置后所有拥有同名变体的接口强制命中该变体（绕过其条件） */
  activeVariant?: string | null;
}

export type ViewName = 'routes' | 'embed' | 'logs';
