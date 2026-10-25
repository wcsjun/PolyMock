import { randomUUID } from 'node:crypto';
import type {
  BodyMatchMode,
  CallbackTemplate,
  ConditionMatch,
  ConditionType,
  RequestCondition,
  ResponseHeader,
  ResponseVariant,
  Route,
  RouteAuth,
  RouteCallback,
  RouteRequest,
  WsBehavior,
  WsMessage,
  WsOnMessage,
} from '../types.js';
import { CALLBACK_DELAY_MAX, CALLBACK_JITTER_MAX, CALLBACK_METHODS } from '../types.js';

/**
 * 路由注册请求的纯校验层（自 admin.ts 整段搬移，只搬不改）：
 * admin 路由 handler 与 app.ts 分发层共用，无 Express 依赖，可独立单测。
 */

/** 校验代理目标 host 是否在白名单内（大小写不敏感，按 hostname 比对，忽略端口）；管理端与转发前共用 */
export function isHostAllowed(target: string, allowHosts: string[]): boolean {
  let hostname: string;
  try {
    hostname = new URL(target).hostname;
  } catch {
    return false;
  }
  return allowHosts.some((host) => host.trim().toLowerCase() === hostname.toLowerCase());
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const CONDITION_TYPES: readonly ConditionType[] = ['string', 'number', 'boolean', 'json', 'array'];

/** 条件匹配操作符（显式语义，可选字段）：exists 存在 / equals 等于 / nonEmpty 非空 / regex 正则 */
const CONDITION_MATCHES: readonly ConditionMatch[] = ['exists', 'equals', 'nonEmpty', 'regex'];

/** body 匹配策略：subset 字段包含（缺省）/ deepEqual 完整 JSON 相等 / textEqual 原文全文相等 */
const BODY_MATCH_MODES: readonly BodyMatchMode[] = ['subset', 'deepEqual', 'textEqual'];

/** 请求准入失败码白名单：400（缺省）/ 404（隐藏接口）/ 422 */
const GATE_STATUSES: readonly number[] = [400, 404, 422];

/** 归一化一组条件行：key trim、过滤空 key 行；数组内对象不合法时报错 */
export function parseConditionList(raw: unknown, label: string): ParseResult<RequestCondition[]> {
  if (!Array.isArray(raw)) return { ok: false, error: `${label} 需为数组` };
  const list: RequestCondition[] = [];
  for (const row of raw) {
    const key = (row as RequestCondition)?.key;
    const value = (row as RequestCondition)?.value;
    if (typeof key !== 'string' || typeof value !== 'string') {
      return { ok: false, error: `${label} 中每项需包含字符串 key 与 value` };
    }
    const type = (row as RequestCondition).type;
    if (type !== undefined && !CONDITION_TYPES.includes(type)) {
      return { ok: false, error: `${label} 中 type 需为 ${CONDITION_TYPES.join(' / ')}` };
    }
    const required = (row as RequestCondition).required;
    if (required !== undefined && typeof required !== 'boolean') {
      return { ok: false, error: `${label} 中 required 需为布尔值` };
    }
    const match = (row as RequestCondition).match;
    if (match !== undefined && !CONDITION_MATCHES.includes(match)) {
      return { ok: false, error: `${label} 中 match 需为 ${CONDITION_MATCHES.join(' / ')}` };
    }
    const trimmed = key.trim();
    if (trimmed) {
      const condition: RequestCondition = { key: trimmed, value };
      if (type !== undefined && type !== 'string') condition.type = type;
      if (required === false) condition.required = false;
      if (match !== undefined) condition.match = match;
      list.push(condition);
    }
  }
  return { ok: true, value: list };
}

/**
 * 解析请求条件组（query / headers / body + body 匹配策略）；未提供或全空时返回空对象。
 * bodyMatch 非 subset 时要求 bodyRaw 一并提供：deepEqual 需为合法 JSON、textEqual 需为非空原文；
 * subset（缺省）下不保留 bodyRaw，避免留下不生效的配置。
 */
export function parseRouteRequest(raw: unknown): ParseResult<RouteRequest> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'request 需为对象（可含 query / headers / body 数组）' };
  }
  const source = raw as Record<string, unknown>;
  const result: RouteRequest = {};
  for (const field of ['query', 'headers', 'body'] as const) {
    const rawList = source[field];
    if (rawList === undefined) continue;
    const parsed = parseConditionList(rawList, `request.${field}`);
    if (!parsed.ok) return parsed;
    if (parsed.value.length > 0) result[field] = parsed.value;
  }

  const bodyMatch = source.bodyMatch;
  if (bodyMatch !== undefined && (typeof bodyMatch !== 'string' || !BODY_MATCH_MODES.includes(bodyMatch as BodyMatchMode))) {
    return { ok: false, error: `request.bodyMatch 需为 ${BODY_MATCH_MODES.join(' / ')}` };
  }
  const bodyRaw = source.bodyRaw;
  if (bodyRaw !== undefined && typeof bodyRaw !== 'string') {
    return { ok: false, error: 'request.bodyRaw 需为字符串' };
  }
  const mode = bodyMatch as BodyMatchMode | undefined;
  if (mode === 'deepEqual' || mode === 'textEqual') {
    const expected = bodyRaw ?? '';
    if (!expected.trim()) {
      return { ok: false, error: `request.bodyMatch 为 ${mode} 时必须提供 request.bodyRaw（期望的${mode === 'deepEqual' ? '完整 JSON' : '原文'}）` };
    }
    if (mode === 'deepEqual') {
      try {
        JSON.parse(expected);
      } catch {
        return { ok: false, error: 'request.bodyRaw 需为合法的 JSON（完整 JSON 相等）' };
      }
    }
    result.bodyMatch = mode;
    result.bodyRaw = expected;
  }
  return { ok: true, value: result };
}

/** JSON 类 Content-Type 判定：未声明按 JSON 处理（缺省行为不变）；application/json、text/json、*+json 视为 JSON（忽略参数与大小写） */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return true;
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json' || mediaType === 'text/json' || mediaType.endsWith('+json');
}

/** 响应的生效 Content-Type：自定义响应头中的 Content-Type 优先于 contentType 字段；对未经校验的原始输入保持容错 */
export function effectiveResponseContentType(response: { contentType?: unknown; headers?: unknown } | undefined): string | undefined {
  const headers = Array.isArray(response?.headers) ? (response?.headers as unknown[]) : [];
  const headerCt = headers
    .filter((h): h is Record<string, unknown> => h !== null && typeof h === 'object')
    .find((h) => typeof h.key === 'string' && h.key.trim().toLowerCase() === 'content-type')
    ?.value;
  const headerText = typeof headerCt === 'string' ? headerCt.trim() : '';
  const fieldText = typeof response?.contentType === 'string' ? response.contentType.trim() : '';
  return headerText || fieldText || undefined;
}

/** 解析响应体：JSON 模式（缺省）字符串按 JSON 解析、其余透传，含模板占位符的文本按「占位符替换为 null」容忍校验；文本模式（生效 Content-Type 非 JSON）要求字符串并原样存储 */
export function parseResponseBody(raw: unknown, label: string, jsonMode: boolean): ParseResult<unknown> {
  if (typeof raw !== 'string') {
    return jsonMode
      ? { ok: true, value: raw }
      : { ok: false, error: `${label} 的生效 Content-Type 为非 JSON 类型，body 需为文本字符串` };
  }
  if (!jsonMode) return { ok: true, value: raw };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    if (raw.includes('{{')) {
      try {
        JSON.parse(raw.replace(/\{\{[^{}]*\}\}/g, 'null'));
        return { ok: true, value: raw };
      } catch {
        /* 原样报错 */
      }
    }
    return { ok: false, error: `${label} 的 body 不是合法的 JSON` };
  }
}

/** 响应头黑名单：逐跳头与报文长度由 Express/Node 托管，自定义后必然破坏响应 */
const FORBIDDEN_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'host',
]);

/** 解析自定义响应头列表：key trim 且禁含空白/冒号，value 禁含换行；同名多条按多值头处理，空列表归一为 undefined */
export function parseResponseHeaders(raw: unknown, label: string): ParseResult<ResponseHeader[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: `${label} 的 headers 需为数组` };
  const list: ResponseHeader[] = [];
  for (const [index, item] of raw.entries()) {
    const key = (item as ResponseHeader)?.key;
    const value = (item as ResponseHeader)?.value;
    if (typeof key !== 'string' || typeof value !== 'string') {
      return { ok: false, error: `${label} 的 headers[${index}] 需包含字符串 key 与 value` };
    }
    const trimmed = key.trim();
    if (!trimmed || /\s/.test(trimmed) || trimmed.includes(':')) {
      return { ok: false, error: `${label} 的 headers[${index}] key 不能为空，且不能含空白或冒号` };
    }
    if (/[\r\n]/.test(value)) {
      return { ok: false, error: `${label} 的 headers[${index}] value 不能包含换行` };
    }
    if (FORBIDDEN_RESPONSE_HEADERS.has(trimmed.toLowerCase())) {
      return { ok: false, error: `${label} 的响应头 "${trimmed}" 由服务端托管，不可自定义` };
    }
    list.push({ key: trimmed, value });
  }
  return { ok: true, value: list.length > 0 ? list : undefined };
}

/** 解析响应变体列表并分配 id */
export function parseVariants(raw: unknown): ParseResult<ResponseVariant[]> {
  if (!Array.isArray(raw)) return { ok: false, error: 'variants 需为数组' };
  const list: ResponseVariant[] = [];
  for (const item of raw) {
    const name = (item as ResponseVariant)?.name;
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, error: '每个变体需提供非空的 name' };
    }
    let match: RouteRequest | undefined;
    if (item.match !== undefined && item.match !== null) {
      const parsed = parseRouteRequest(item.match);
      if (!parsed.ok) return { ok: false, error: `变体「${name.trim()}」：${parsed.error}` };
      match = parsed.value;
    }
    let body: unknown = item.response?.body;
    const bodyParsed = parseResponseBody(body, `变体「${name.trim()}」`, isJsonContentType(effectiveResponseContentType(item.response)));
    if (!bodyParsed.ok) return bodyParsed;
    body = bodyParsed.value;
    const headersParsed = parseResponseHeaders(item.response?.headers, `变体「${name.trim()}」`);
    if (!headersParsed.ok) return headersParsed;
    const callbackParsed = parseRouteCallback(item.response?.callback, `变体「${name.trim()}」的 response.callback`);
    if (!callbackParsed.ok) return callbackParsed;
    list.push({
      id: randomUUID(),
      name: name.trim(),
      match,
      response: {
        status: typeof item.response?.status === 'number' ? item.response.status : 200,
        contentType: typeof item.response?.contentType === 'string' ? item.response.contentType : undefined,
        ...(headersParsed.value ? { headers: headersParsed.value } : {}),
        ...(callbackParsed.value ? { callback: callbackParsed.value } : {}),
        body,
      },
    });
  }
  return { ok: true, value: list };
}

/** 解析路由行为字段（disabled / delayMs / jitterMs / failureRate / crud / renderRequest / gateStatus）；未提供的字段不出现在结果中 */
export function parseBehaviorFields(
  raw: unknown,
): ParseResult<Pick<Route, 'disabled' | 'delayMs' | 'jitterMs' | 'failureRate' | 'crud' | 'renderRequest' | 'gateStatus'>> {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: '请求体需为 JSON 对象' };
  }
  const source = raw as Record<string, unknown>;
  const result: Pick<Route, 'disabled' | 'delayMs' | 'jitterMs' | 'failureRate' | 'crud' | 'renderRequest' | 'gateStatus'> = {};
  if (source.disabled !== undefined) {
    if (typeof source.disabled !== 'boolean') {
      return { ok: false, error: 'disabled 需为布尔值' };
    }
    result.disabled = source.disabled;
  }
  for (const field of ['delayMs', 'jitterMs'] as const) {
    const value = source[field];
    if (value !== undefined) {
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 60000) {
        return { ok: false, error: `${field} 需为 0-60000 的整数` };
      }
      result[field] = value as number;
    }
  }
  if (source.failureRate !== undefined) {
    if (typeof source.failureRate !== 'number' || !Number.isFinite(source.failureRate) || source.failureRate < 0 || source.failureRate > 100) {
      return { ok: false, error: 'failureRate 需为 0-100 的数字' };
    }
    result.failureRate = source.failureRate;
  }
  if (source.crud !== undefined) {
    if (typeof source.crud !== 'boolean') {
      return { ok: false, error: 'crud 需为布尔值' };
    }
    result.crud = source.crud;
  }
  if (source.renderRequest !== undefined) {
    if (typeof source.renderRequest !== 'boolean') {
      return { ok: false, error: 'renderRequest 需为布尔值' };
    }
    result.renderRequest = source.renderRequest;
  }
  if (source.gateStatus !== undefined) {
    if (typeof source.gateStatus !== 'number' || !GATE_STATUSES.includes(source.gateStatus)) {
      return { ok: false, error: 'gateStatus 需为 400 / 404 / 422' };
    }
    result.gateStatus = source.gateStatus as Route['gateStatus'];
  }
  return { ok: true, value: result };
}

/** 解析路由级认证配置：null 表示清除；type 需为 apikey / bearer，value 需为非空字符串，apikey 可选自定义 header 名 */
export function parseRouteAuth(raw: unknown): ParseResult<RouteAuth | undefined> {
  if (raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'auth 需为对象（type / value）' };
  }
  const source = raw as Record<string, unknown>;
  if (source.type !== 'apikey' && source.type !== 'bearer') {
    return { ok: false, error: 'auth.type 需为 apikey 或 bearer' };
  }
  if (typeof source.value !== 'string' || !source.value.trim()) {
    return { ok: false, error: 'auth.value 需为非空字符串' };
  }
  let header: string | undefined;
  if (source.header !== undefined) {
    if (typeof source.header !== 'string' || !source.header.trim()) {
      return { ok: false, error: 'auth.header 需为非空字符串' };
    }
    header = source.header.trim();
  }
  return { ok: true, value: { type: source.type, value: source.value, ...(header !== undefined ? { header } : {}) } };
}

/** 校验 path 段格式：非空段要么为字面量，要么为 :参数名（: 后非空） */
export function validatePathSegments(routePath: string): string | null {
  for (const segment of routePath.split('/')) {
    if (!segment) continue;
    if (segment.startsWith(':') && segment.length === 1) {
      return `path 段 "${segment}" 非法：参数段需为 :参数名`;
    }
  }
  return null;
}

/* ---------- WS 路由（protocol = 'ws'）专属解析 ---------- */

/** WS 回包策略白名单 */
const WS_ONMESSAGE_MODES: readonly WsOnMessage['mode'][] = ['echo', 'fixed', 'sequence', 'none'];

/** WS 路由拒收的 HTTP 专属字段：避免在 WS 路由上留下不生效的「死字段」 */
const WS_FORBIDDEN_FIELDS: readonly string[] = [
  'response', 'request', 'requireMatch', 'gateStatus', 'variants', 'sequence',
  'crud', 'delayMs', 'jitterMs', 'failureRate', 'renderRequest', 'callback',
];

/** 消息体：字符串原样保留（发送时做模板渲染，JSON 文本亦按字符串发送），其余透传 */
export function parseWsMessageBody(body: unknown, label: string): ParseResult<unknown> {
  if (body === undefined || body === null) return { ok: false, error: `${label} 缺少 body` };
  return { ok: true, value: body };
}

/** 单条 WS 消息：body 必填，delayMs 可选 0-60000 整数 */
export function parseWsMessage(raw: unknown, label: string): ParseResult<WsMessage> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${label} 需为对象（delayMs / body）` };
  }
  const source = raw as Record<string, unknown>;
  const bodyResult = parseWsMessageBody(source.body, label);
  if (!bodyResult.ok) return bodyResult;
  if (source.delayMs !== undefined) {
    if (!Number.isInteger(source.delayMs) || (source.delayMs as number) < 0 || (source.delayMs as number) > 60000) {
      return { ok: false, error: `${label} 的 delayMs 需为 0-60000 的整数` };
    }
  }
  const delayMs = source.delayMs as number | undefined;
  return { ok: true, value: { body: bodyResult.value, ...(delayMs !== undefined && delayMs > 0 ? { delayMs } : {}) } };
}

/** WS 行为配置：onOpen 消息列表 / loopOnOpen / onMessage 回包策略 / interval 定时推送；空配置归一为 undefined */
export function parseWsBehavior(raw: unknown): ParseResult<WsBehavior | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'ws 需为对象（onOpen / loopOnOpen / onMessage / interval）' };
  }
  const source = raw as Record<string, unknown>;
  const result: WsBehavior = {};

  if (source.loopOnOpen !== undefined && typeof source.loopOnOpen !== 'boolean') {
    return { ok: false, error: 'ws.loopOnOpen 需为布尔值' };
  }
  if (source.onOpen !== undefined) {
    if (!Array.isArray(source.onOpen)) return { ok: false, error: 'ws.onOpen 需为数组' };
    const messages: WsMessage[] = [];
    for (const [index, item] of source.onOpen.entries()) {
      const parsed = parseWsMessage(item, `ws.onOpen[${index}]`);
      if (!parsed.ok) return parsed;
      messages.push(parsed.value);
    }
    if (messages.length > 0) {
      result.onOpen = messages;
      if (source.loopOnOpen === true) result.loopOnOpen = true;
    } else if (source.loopOnOpen === true) {
      return { ok: false, error: 'ws.loopOnOpen 需与非空 ws.onOpen 配合使用' };
    }
  } else if (source.loopOnOpen === true) {
    return { ok: false, error: 'ws.loopOnOpen 需与非空 ws.onOpen 配合使用' };
  }
  if (source.onMessage !== undefined) {
    if (typeof source.onMessage !== 'object' || source.onMessage === null || Array.isArray(source.onMessage)) {
      return { ok: false, error: 'ws.onMessage 需为对象（mode / replies）' };
    }
    const onMessage = source.onMessage as Record<string, unknown>;
    if (typeof onMessage.mode !== 'string' || !WS_ONMESSAGE_MODES.includes(onMessage.mode as WsOnMessage['mode'])) {
      return { ok: false, error: `ws.onMessage.mode 需为 ${WS_ONMESSAGE_MODES.join(' / ')}` };
    }
    const mode = onMessage.mode as WsOnMessage['mode'];
    if (mode === 'fixed' || mode === 'sequence') {
      if (!Array.isArray(onMessage.replies) || onMessage.replies.length === 0) {
        return { ok: false, error: `ws.onMessage.mode 为 ${mode} 时需提供非空数组 replies` };
      }
      result.onMessage = { mode, replies: [...onMessage.replies] };
    } else if (Array.isArray(onMessage.replies) && onMessage.replies.length > 0) {
      /* echo / none 不消费 replies：拒收避免留下不生效的配置 */
      return { ok: false, error: `ws.onMessage.mode 为 ${mode} 时不使用 replies，请移除该字段` };
    } else {
      result.onMessage = { mode };
    }
  }
  if (source.interval !== undefined) {
    if (typeof source.interval !== 'object' || source.interval === null || Array.isArray(source.interval)) {
      return { ok: false, error: 'ws.interval 需为对象（everyMs / body）' };
    }
    const interval = source.interval as Record<string, unknown>;
    if (!Number.isInteger(interval.everyMs) || (interval.everyMs as number) < 100 || (interval.everyMs as number) > 60000) {
      return { ok: false, error: 'ws.interval.everyMs 需为 100-60000 的整数' };
    }
    const bodyResult = parseWsMessageBody(interval.body, 'ws.interval');
    if (!bodyResult.ok) return bodyResult;
    result.interval = { everyMs: interval.everyMs as number, body: bodyResult.value };
  }
  const configured = result.onOpen !== undefined || result.onMessage !== undefined || result.interval !== undefined;
  return { ok: true, value: configured ? result : undefined };
}

/** WS 路由体中第一个出现的 HTTP 专属字段（400 拒收用） */
export function firstWsForbiddenField(body: Record<string, unknown>): string | undefined {
  return WS_FORBIDDEN_FIELDS.find((field) => body[field] !== undefined);
}

/** 解析序列响应列表：每项 status 100-599 整数，body 走 parseResponseBody */
export function parseSequence(raw: unknown): ParseResult<Array<{ status: number; body: unknown; headers?: ResponseHeader[] }>> {
  if (!Array.isArray(raw)) return { ok: false, error: 'sequence 需为数组' };
  const list: Array<{ status: number; body: unknown; headers?: ResponseHeader[] }> = [];
  for (const [index, item] of raw.entries()) {
    if (item === null || typeof item !== 'object') {
      return { ok: false, error: `sequence[${index}] 需为对象` };
    }
    const status = (item as { status?: unknown }).status;
    if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) {
      return { ok: false, error: `sequence[${index}] 的 status 需为 100-599 的整数` };
    }
    const stepJsonMode = isJsonContentType(effectiveResponseContentType({ headers: (item as { headers?: unknown }).headers }));
    const bodyParsed = parseResponseBody((item as { body?: unknown }).body, `sequence[${index}]`, stepJsonMode);
    if (!bodyParsed.ok) return bodyParsed;
    const headersParsed = parseResponseHeaders((item as { headers?: unknown }).headers, `sequence[${index}]`);
    if (!headersParsed.ok) return headersParsed;
    list.push({ status: status as number, body: bodyParsed.value, ...(headersParsed.value ? { headers: headersParsed.value } : {}) });
  }
  return { ok: true, value: list };
}

/* ---------- 异步回调（route.response.callback / 回调模板）解析 ---------- */

/** 解析回调 URL：必填字符串，http/https 协议（模板占位符允许出现在 path/query 位置，host 需为字面量） */
function parseCallbackUrl(raw: unknown, label: string): ParseResult<string> {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: `${label} 的 url 为必填字符串` };
  }
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: `${label} 的 url 需为 http(s) 地址` };
    }
  } catch {
    return { ok: false, error: `${label} 的 url 需为合法的 http(s) URL` };
  }
  return { ok: true, value: trimmed };
}

/** 回调延迟/抖动字段范围校验（0-max 整数） */
function parseCallbackRange(raw: unknown, label: string, field: string, max: number): ParseResult<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Number.isInteger(raw) || (raw as number) < 0 || (raw as number) > max) {
    return { ok: false, error: `${label} 的 ${field} 需为 0-${max} 的整数` };
  }
  return { ok: true, value: raw as number };
}

/**
 * 解析路由/变体响应上的回调配置（双模式二选一）；undefined/null 表示未配置。
 * 引用模式仅做结构校验，模板是否存在由持有 registry 的 admin 层校验（纯函数层不做 IO）。
 */
export function parseRouteCallback(raw: unknown, label: string): ParseResult<RouteCallback | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${label} 需为对象（引用模式 template / 内联模式 url 等）` };
  }
  const source = raw as Record<string, unknown>;

  if (source.template !== undefined) {
    if (typeof source.template !== 'string' || !source.template.trim()) {
      return { ok: false, error: `${label} 的 template 需为非空字符串` };
    }
    if (source.bodyOverride !== undefined && typeof source.bodyOverride !== 'string') {
      return { ok: false, error: `${label} 的 bodyOverride 需为字符串` };
    }
    const extra = Object.keys(source).find((key) => key !== 'template' && key !== 'bodyOverride');
    if (extra) {
      return { ok: false, error: `${label} 为引用模式时仅支持 template 与 bodyOverride，出现多余字段：${extra}` };
    }
    const ref: RouteCallback = { template: source.template.trim() };
    if (typeof source.bodyOverride === 'string') ref.bodyOverride = source.bodyOverride;
    return { ok: true, value: ref };
  }

  const urlParsed = parseCallbackUrl(source.url, label);
  if (!urlParsed.ok) return urlParsed;
  let method: string | undefined;
  if (source.method !== undefined) {
    if (typeof source.method !== 'string' || !CALLBACK_METHODS.includes(source.method.toUpperCase())) {
      return { ok: false, error: `${label} 的 method 需为 ${CALLBACK_METHODS.join(' / ')}` };
    }
    method = source.method.toUpperCase();
  }
  const headersParsed = parseResponseHeaders(source.headers, label);
  if (!headersParsed.ok) return headersParsed;
  if (source.contentType !== undefined && (typeof source.contentType !== 'string' || !source.contentType.trim())) {
    return { ok: false, error: `${label} 的 contentType 需为非空字符串` };
  }
  if (source.body !== undefined && typeof source.body !== 'string') {
    return { ok: false, error: `${label} 的 body 需为字符串（支持模板占位符）` };
  }
  const delayParsed = parseCallbackRange(source.delayMs, label, 'delayMs', CALLBACK_DELAY_MAX);
  if (!delayParsed.ok) return delayParsed;
  const jitterParsed = parseCallbackRange(source.jitterMs, label, 'jitterMs', CALLBACK_JITTER_MAX);
  if (!jitterParsed.ok) return jitterParsed;

  const inline: Extract<RouteCallback, { url: string }> = { url: urlParsed.value };
  if (method !== undefined) inline.method = method;
  if (headersParsed.value) inline.headers = headersParsed.value;
  if (typeof source.contentType === 'string') inline.contentType = source.contentType.trim();
  if (typeof source.body === 'string') inline.body = source.body;
  if (delayParsed.value !== undefined) inline.delayMs = delayParsed.value;
  if (jitterParsed.value !== undefined) inline.jitterMs = jitterParsed.value;
  return { ok: true, value: inline };
}

/** 解析回调模板的新建/更新输入（name/url 必填；headers 复用响应头规则，禁托管头） */
export function parseCallbackTemplateInput(raw: unknown): ParseResult<Omit<CallbackTemplate, 'id' | 'createdAt'>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '请求体需为 JSON 对象' };
  }
  const source = raw as Record<string, unknown>;
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (!name) return { ok: false, error: '模板名称不能为空' };
  const urlParsed = parseCallbackUrl(source.url, '回调模板');
  if (!urlParsed.ok) return urlParsed;
  let method: string | undefined;
  if (source.method !== undefined) {
    if (typeof source.method !== 'string' || !CALLBACK_METHODS.includes(source.method.toUpperCase())) {
      return { ok: false, error: `method 需为 ${CALLBACK_METHODS.join(' / ')}` };
    }
    method = source.method.toUpperCase();
  }
  const headersParsed = parseResponseHeaders(source.headers, '回调模板');
  if (!headersParsed.ok) return headersParsed;
  if (source.contentType !== undefined && (typeof source.contentType !== 'string' || !source.contentType.trim())) {
    return { ok: false, error: 'contentType 需为非空字符串' };
  }
  if (source.body !== undefined && typeof source.body !== 'string') {
    return { ok: false, error: 'body 需为字符串（模板渲染，留空表示回调无请求体）' };
  }
  const delayParsed = parseCallbackRange(source.delayMs, '回调模板', 'delayMs', CALLBACK_DELAY_MAX);
  if (!delayParsed.ok) return delayParsed;
  const jitterParsed = parseCallbackRange(source.jitterMs, '回调模板', 'jitterMs', CALLBACK_JITTER_MAX);
  if (!jitterParsed.ok) return jitterParsed;

  const result: Omit<CallbackTemplate, 'id' | 'createdAt'> = { name, url: urlParsed.value };
  if (method !== undefined) result.method = method;
  if (headersParsed.value) result.headers = headersParsed.value;
  if (typeof source.contentType === 'string') result.contentType = source.contentType.trim();
  if (typeof source.body === 'string') result.body = source.body;
  if (delayParsed.value !== undefined) result.delayMs = delayParsed.value;
  if (jitterParsed.value !== undefined) result.jitterMs = jitterParsed.value;
  return { ok: true, value: result };
}
