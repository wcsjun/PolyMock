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
  /** 命中本响应后异步发出的回调配置（默认响应与每个变体各自可配）；序列 / CRUD / WS 路由不支持 */
  callback?: RouteCallback;
}

/** 回调方法白名单（与 HTTP Mock 方法解耦，缺省 POST） */
export const CALLBACK_METHODS: readonly string[] = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'];

/** 回调出站超时（毫秒，固定值不做配置项）与防自环深度上限 */
export const CALLBACK_TIMEOUT_MS = 10_000;
export const CALLBACK_MAX_DEPTH = 5;

/** 回调延迟上下限（毫秒）；缺省 1000 贴近真实异步处理节奏 */
export const CALLBACK_DELAY_MIN = 0;
export const CALLBACK_DELAY_MAX = 60_000;
export const CALLBACK_JITTER_MAX = 30_000;

/**
 * 路由/变体上的异步回调配置，双模式二选一：
 * - 引用模式（含 template 字段）：信封（URL / 方法 / 头 / 延迟 / 抖动 / 默认载荷）由全局回调模板统一管理，仅可覆盖载荷；
 * - 内联模式：完整配置，不依赖模板。
 */
export type RouteCallback =
  | { template: string; bodyOverride?: string }
  | {
      url: string;
      method?: string;
      headers?: ResponseHeader[];
      contentType?: string;
      body?: string;
      delayMs?: number;
      jitterMs?: number;
    };

/** 全局回调模板（配置文件顶层 callbacks 数组）：跨服务复用的出站通知定义，模板无状态，载荷上下文来自每次命中的请求快照 */
export interface CallbackTemplate {
  id: string;
  /** 展示名，全局唯一（管理端校验冲突 409） */
  name: string;
  url: string;
  method?: string;
  headers?: ResponseHeader[];
  contentType?: string;
  /** 默认载荷（模板渲染；引用方可通过 bodyOverride 整体覆盖） */
  body?: string;
  delayMs?: number;
  jitterMs?: number;
  createdAt: number;
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

/** 条件匹配操作符（显式语义）；缺省时沿用历史语义：required 控制 key 缺失是否通过、value 为空串表示「仅要求存在」 */
export type ConditionMatch = 'exists' | 'equals' | 'nonEmpty' | 'regex';

/** 单条请求匹配条件（key 精确比对，value 字符串化比对） */
export interface RequestCondition {
  key: string;
  value: string;
  /** 比对方式；json 表示期望值为 JSON 字面量并做深度相等比对；array 表示期望值为 JSON 数组字面量并做包含匹配（实际数组需包含全部期望元素，无序） */
  type?: ConditionType;
  /** 必填：请求缺少该 key 即条件失败；false 时 key 缺失视为通过（存在才比对）。缺省 true */
  required?: boolean;
  /**
   * 匹配操作符（新增，可选）：exists 只要求 key 存在；equals 显式等值比对（此时 value 空串表示「等于空字符串」）；
   * nonEmpty 要求存在且非空（空字符串 / null 视为空）；regex 期望值按正则匹配字符串化后的实际值。
   * 缺省时保持历史语义（value 为空串 = 仅要求存在），旧配置无需迁移。
   */
  match?: ConditionMatch;
}

/** body 整体匹配策略（新增，可选）：缺省 subset 逐条条件子集匹配 */
export type BodyMatchMode = 'subset' | 'deepEqual' | 'textEqual';

/** 接口的预期请求条件：headers 不区分大小写、query 参数、JSON body 点路径 */
export interface RouteRequest {
  query?: RequestCondition[];
  headers?: RequestCondition[];
  body?: RequestCondition[];
  /**
   * body 匹配策略（新增，可选）：subset（缺省）= 逐条 body 条件按点路径子集匹配；
   * deepEqual = 请求体与 bodyRaw 解析出的 JSON 深度相等（body 条件行被忽略）；textEqual = 请求体原文与 bodyRaw 逐字符相等。
   */
  bodyMatch?: BodyMatchMode;
  /** bodyMatch 为 deepEqual 时是期望的完整 JSON 文本；为 textEqual 时是期望的原文文本；subset 时忽略 */
  bodyRaw?: string;
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

/** WS 连接后推送的单条消息：字符串原样发送（支持模板），其余 JSON 序列化后发送 */
export interface WsMessage {
  /** 相对上一条（首条相对连接建立）的延迟毫秒，0-60000，缺省 0 */
  delayMs?: number;
  body: unknown;
}

/** WS 回包策略：echo 原样回显 / fixed 固定回包（取第一条）/ sequence 按收到的消息次序循环取用 / none 不回包 */
export interface WsOnMessage {
  mode: 'echo' | 'fixed' | 'sequence' | 'none';
  /** fixed / sequence 模式的回包内容；echo / none 下不存储 */
  replies?: unknown[];
}

/** WS 路由专属行为配置（protocol = 'ws' 时生效） */
export interface WsBehavior {
  /** 连接成功后按序推送 */
  onOpen?: WsMessage[];
  /** 循环播放整个 onOpen 序列，缺省 false */
  loopOnOpen?: boolean;
  /** 收到消息时的回包策略；缺省不回包 */
  onMessage?: WsOnMessage;
  /** 定时推送：连接关闭或路由变更时定时器一并销毁 */
  interval?: { everyMs: number; body: unknown };
}

export interface Route {
  id: string;
  serviceId: string;
  /** 协议：http = HTTP Mock（缺省）；ws = WebSocket Mock（method 固定 'WS'，upgrade 网关专用） */
  protocol: 'http' | 'ws';
  method: string;
  path: string;
  name?: string;
  /** HTTP Mock 响应；WS 路由不使用（其行为配置在 ws 字段） */
  response?: RouteResponse;
  /** WS 专属行为配置；HTTP 路由不使用 */
  ws?: WsBehavior;
  /** 默认响应的前置条件；仅 requireMatch 为 true 时作为接口准入门槛参与校验 */
  request?: RouteRequest;
  /** 开启后：所有请求必须满足 request 条件才能访问该接口（优先于变体），否则按 gateStatus 返回 */
  requireMatch?: boolean;
  /** 请求准入（requireMatch）失败时返回的状态码（新增，可选）：400（缺省）/ 404（隐藏接口）/ 422 */
  gateStatus?: 400 | 404 | 422;
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
  /** 请求体模板渲染：**默认开启**，显式 false 关闭。开启时请求体（对象/数组/字符串）里的模板占位符在匹配前渲染，渲染结果参与条件匹配、响应模板与日志预览 */
  renderRequest?: boolean;
  createdAt: number;
}

/** 配置文件当前 schema 版本（loadState/toJSON 统一引用，升版本时在此递增并扩展 migrate） */
export const SCHEMA_VERSION = 2;

export interface PersistedState {
  version: 2;
  services: Service[];
  routes: Route[];
  /** 全局回调模板（v0.4.0 新增，纯追加字段不升 schema 版本；缺省视为空列表） */
  callbacks?: CallbackTemplate[];
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
  /** 上游响应 Content-Type（代理时），「保存为接口」据此判定 JSON/文本模式 */
  proxyContentType?: string;
  /** WS 连接级信息（method = 'WS' 的日志条目携带）；帧级不持久化 */
  ws?: { connectionId: string; framesIn: number; framesOut: number; closeCode?: number };
  /** 日志方向：缺省 'in'（入站请求）；出站回调条目为 'out'（与入站共享环形缓冲与 SSE 推送） */
  direction?: 'in' | 'out';
  /** 出站回调专属信息（direction = 'out' 时携带）；status 为对端响应码，失败时为 0 且 error 说明原因 */
  callback?: {
    /** 引用的回调模板（内联模式不携带） */
    templateId?: string;
    templateName?: string;
    /** 触发命中的源请求日志 id */
    sourceLogId: string | null;
    routeId: string;
    /** 排程延迟（含抖动后的实际值，毫秒） */
    delayMs: number;
    /** 从命中到实际发出的间隔（毫秒；白名单拒绝 / 深度超限 / 模板悬空未发出时为 0） */
    firedAfterMs: number;
    /** 渲染后的完整目标 URL */
    target: string;
    /** 渲染后的请求体（截断至 65536 字符；「重发此回调」按已存载荷原样发送，不重新渲染） */
    requestBody?: string;
    /** 实际发出的请求头（含 Content-Type 与深度头；重发按已存头原样发送） */
    requestHeaders?: Record<string, string>;
  };
}
