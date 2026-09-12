export const DEFAULT_SERVICE_ID = 'default';

/** 主服务（含 Web UI / 管理 API）默认端口：配置与环境变量均未指定时的兜底值 */
export const DEFAULT_PORT = 33233;

function isUsablePort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * 主端口解析（后端入口与前端 dev 代理共用同一规则）：
 * POLYMOCK_PORT 环境变量 > 配置文件 default 服务端口 > DEFAULT_PORT。
 * 环境变量空串视为未设置；非法端口（非 1-65535 整数）逐级回退。
 */
export function resolveMainPort(
  env: { POLYMOCK_PORT?: string },
  state: { services?: ReadonlyArray<{ id: string; port?: number }> },
): number {
  const fromEnv = env.POLYMOCK_PORT ? Number(env.POLYMOCK_PORT) : undefined;
  if (isUsablePort(fromEnv)) return fromEnv;
  const fromConfig = state.services?.find((s) => s.id === DEFAULT_SERVICE_ID)?.port;
  if (isUsablePort(fromConfig)) return fromConfig;
  return DEFAULT_PORT;
}

/** 运行模式：port = 各服务独立端口监听（缺省）；path = 所有服务经主端口 basePath 前缀分发（Docker 友好） */
export type PolyMockMode = 'port' | 'path';

/** 运行模式解析：仅 POLYMOCK_MODE=path 时为路径模式，其余（含未设置/非法值）回退 port */
export function resolveMode(env: { POLYMOCK_MODE?: string }): PolyMockMode {
  return env.POLYMOCK_MODE === 'path' ? 'path' : 'port';
}

/** 路径模式保留前缀：管理 API 与 Web UI 静态资源占用，不可用作服务 basePath */
export const RESERVED_BASE_PATHS: ReadonlySet<string> = new Set(['__polymock', 'assets']);

/** basePath 合法格式：小写字母或数字开头，仅含小写字母、数字、连字符 */
export const BASE_PATH_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 服务名转 basePath 候选：小写化、非 [a-z0-9] 连续段折叠为连字符、去首尾连字符；中文等无有效字符时返回空串 */
export function slugifyBasePath(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** 单条自定义响应头；同名多条按多值头处理（如多个 Set-Cookie） */
export interface ResponseHeader {
  key: string;
  value: string;
}

export interface RouteResponse {
  status: number;
  contentType?: string;
  /** 自定义响应头：在 contentType 之后应用（同名 Content-Type 覆盖 contentType 字段），值支持模板占位符 */
  headers?: ResponseHeader[];
  body: unknown;
}

/** 路由级认证配置：模拟后端鉴权，请求未携带正确凭证时返回 401 */
export interface RouteAuth {
  /** 认证方式：apikey = 自定义 header 携带密钥；bearer = Authorization: Bearer <token> */
  type: 'apikey' | 'bearer';
  /** 期望的密钥 / 令牌值（精确比对） */
  value: string;
  /** 仅 apikey 有效：携带密钥的 header 名（缺省 X-API-Key） */
  header?: string;
}

/** 条件值比对方式；缺省按 string 字符串化比对（兼容旧数据） */
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
  /** 路径模式前缀：/{basePath}/** 经主端口分发到该服务；缺省时启动自动补齐（ensureBasePaths） */
  basePath?: string;
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
  /** 路由级认证：配置后请求需携带正确凭证（401 优先于 requireMatch 门槛） */
  auth?: RouteAuth;
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
  /** 序列响应：按命中次序循环返回（优先于场景集/变体/默认响应，requireMatch 门槛之后），每步可带自定义响应头 */
  sequence?: Array<{ status: number; body: unknown; headers?: ResponseHeader[] }>;
  /** 有状态 CRUD：路径需含 :id 参数段，服务内存维护资源集合（重启清空） */
  crud?: boolean;
  createdAt: number;
}

/** 配置文件当前 schema 版本（loadState/toJSON 统一引用，升版本时在此递增并扩展 migrate） */
export const SCHEMA_VERSION = 2;

export interface PersistedState {
  version: 2;
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
