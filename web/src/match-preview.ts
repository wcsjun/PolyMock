/**
 * 「匹配预览」的纯前端解释器：按后端 resolveRouteResponse / checkCondition 的语义
 * 在浏览器里推演「路径 → 认证 → 请求准入 → 序列 / 场景集 / 分支 → 响应」的解释路径。
 * 仅用于表单内的即时反馈，不发送任何请求；语义需与 src/server/app.ts 保持一致。
 */
import type { RequestCondition, RouteRequest } from './types';

/** 测试请求（预览输入） */
export interface PreviewRequest {
  method: string;
  path: string;
  /** 查询参数（已解析为键值对） */
  query: Record<string, string>;
  /** 请求头（键统一小写） */
  headers: Record<string, string>;
  /** 请求体原文 */
  bodyText: string;
}

/** 预览用的分支定义（与提交态变体同构） */
export interface PreviewVariant {
  name: string;
  match?: RouteRequest;
  response: { status: number; body: unknown };
}

/** 预览用的路由草稿（由表单当前状态推导） */
export interface PreviewRoute {
  method: string;
  path: string;
  /** 路径参数模式（含 :param）时用于匹配与参数提取 */
  pathPattern: string;
  disabled: boolean;
  auth?: { type: 'apikey' | 'bearer'; value: string; header?: string };
  request?: RouteRequest;
  requireMatch: boolean;
  gateStatus: 400 | 404 | 422;
  variants: PreviewVariant[];
  sequence: Array<{ status: number; body: unknown }>;
  defaultResponse: { status: number; body: unknown };
  /** 全局场景集：非空时同名变体强制命中（绕过其条件） */
  activeVariant?: string;
}

export type PreviewStepStatus = 'ok' | 'blocked' | 'skipped' | 'info';

export interface PreviewStep {
  title: string;
  detail: string;
  status: PreviewStepStatus;
}

export interface PreviewOutcome {
  /** 最终状态码 */
  status: number;
  /** 结论标题，如「命中分支 · 已付款」 */
  title: string;
  steps: PreviewStep[];
  /** 命中响应的 body（未命中为 undefined） */
  body?: unknown;
  /** 命中的变体名（默认响应用 null） */
  variant: string | null;
  /** 是否已进入响应阶段（false 表示被 404 / 401 / 准入拦截） */
  responded: boolean;
}

/** 深度相等（与后端 deepEqual 同构） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  return ak.length === bk.length && ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** 点路径取值（与后端 lookupPath 同构） */
function lookupPath(obj: unknown, dotPath: string): unknown {
  let current: unknown = obj;
  for (const segment of dotPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 实际值字符串化（与后端 actualText 同构） */
function actualText(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function asBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

/**
 * 与后端 express.json 一致的「会解析」判定：仅 application/json 与 application/*+json
 *（忽略参数与大小写）；未声明 Content-Type 时后端不解析（req.body 为 undefined）。
 */
function isParsedJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

/**
 * 与后端一致的请求体原文可用性（textEqual 用）：application/json 与 *+json 由解析器 verify 顺带捕获，
 * 其余显式非 JSON Content-Type 由中间件捕获；未声明 Content-Type 或 text/json 时原文不可用。
 */
function isRawBodyAvailable(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return contentType.split(';', 1)[0].trim().toLowerCase() !== 'text/json';
}

/** 测试请求体的解析结果（与后端 express.json strict 模式对齐） */
type ParsedRequestBody =
  | { kind: 'skipped' } /* Content-Type 非 JSON 类或未声明：后端 req.body 为 undefined */
  | { kind: 'rejected' } /* JSON 类但原文非法或为顶层标量：后端 body 解析器直接 400，不进入路由分发 */
  | { kind: 'parsed'; value: unknown };

/** 解析测试请求体：Content-Type 为 JSON 类时才解析，且 strict 模式只收对象/数组（与后端一致） */
function parseRequestBody(bodyText: string, contentType: string | undefined): ParsedRequestBody {
  if (!isParsedJsonContentType(contentType)) return { kind: 'skipped' };
  const raw = bodyText.trim();
  if (!raw) return { kind: 'skipped' };
  if (raw[0] !== '{' && raw[0] !== '[') return { kind: 'rejected' };
  try {
    return { kind: 'parsed', value: JSON.parse(raw) };
  } catch {
    return { kind: 'rejected' };
  }
}

/** 按 type 比对（与后端 compareByType 同构） */
function compareByType(cond: RequestCondition, actual: unknown): string | null {
  const expected = cond.value;
  const shown = actualText(actual) ?? 'undefined';
  const mismatch = `期望 ${expected}，实际 ${shown}`;
  switch (cond.type) {
    case 'number': {
      const actualNum = Number(actual);
      const expectedNum = Number(expected);
      return !Number.isFinite(actualNum) || actualNum !== expectedNum ? mismatch : null;
    }
    case 'boolean': {
      const expectedBool = asBoolean(expected);
      return expectedBool === undefined || asBoolean(actual) !== expectedBool ? mismatch : null;
    }
    case 'json': {
      let expectedJson: unknown;
      try {
        expectedJson = JSON.parse(expected);
      } catch {
        return `期望值不是合法 JSON：${expected}`;
      }
      return deepEqual(actual, expectedJson) ? null : mismatch;
    }
    case 'array': {
      let expectedJson: unknown;
      try {
        expectedJson = JSON.parse(expected);
      } catch {
        return `期望值不是合法 JSON：${expected}`;
      }
      if (!Array.isArray(expectedJson)) return `期望值不是 JSON 数组：${expected}`;
      if (!Array.isArray(actual)) return mismatch;
      return expectedJson.every((item) => actual.some((elem) => deepEqual(elem, item))) ? null : mismatch;
    }
    default:
      return actualText(actual) !== expected ? mismatch : null;
  }
}

/** 按显式操作符比对（与后端 compareByMatch 同构） */
function compareByMatch(cond: RequestCondition, actual: unknown): string | null {
  switch (cond.match) {
    case 'exists':
      return null;
    case 'nonEmpty':
      return actual === null || actualText(actual) === '' ? `期望非空值，实际 ${actual === null ? 'null' : '空字符串'}` : null;
    case 'regex': {
      let pattern: RegExp;
      try {
        pattern = new RegExp(cond.value);
      } catch {
        return `期望值不是合法正则：${cond.value}`;
      }
      const text = actualText(actual);
      return text !== null && pattern.test(text) ? null : `期望匹配正则 ${cond.value}，实际 ${text ?? 'undefined'}`;
    }
    default:
      return compareByType(cond, actual);
  }
}

/** 校验单条条件（与后端 checkCondition 同构）；返回失败原因或 null */
export function matchCondition(cond: RequestCondition, actual: unknown): string | null {
  if (actual === undefined) return cond.required === false ? null : `缺少（期望 ${cond.value}）`;
  if (cond.match) return compareByMatch(cond, actual);
  if (cond.value === '') return null;
  return compareByType(cond, actual);
}

function textPreview(text: string): string {
  const literal = JSON.stringify(text) ?? '';
  return literal.length > 80 ? `${literal.slice(0, 79)}…` : literal;
}

/** 校验 body 条件组（与后端 checkBodyConditions 同构）；返回失败原因或 null */
export function matchBodyConditions(request: RouteRequest, req: PreviewRequest, jsonBody: unknown): string | null {
  const mode = request.bodyMatch ?? 'subset';
  if (mode === 'subset') {
    const rows = request.body ?? [];
    if (!rows.length) return null;
    const objectBody = jsonBody !== null && typeof jsonBody === 'object' && !Array.isArray(jsonBody) ? (jsonBody as Record<string, unknown>) : undefined;
    if (!objectBody) {
      if (rows.every((c) => c.required === false)) return null;
      return '请求体缺失或非 JSON，无法匹配 body 条件';
    }
    for (const cond of rows) {
      const reason = matchCondition(cond, lookupPath(objectBody, cond.key));
      if (reason) return `请求体字段 ${cond.key} ${reason}`;
    }
    return null;
  }

  const expectedRaw = request.bodyRaw ?? '';
  if (!expectedRaw) return null;
  if (mode === 'deepEqual') {
    let expected: unknown;
    try {
      expected = JSON.parse(expectedRaw);
    } catch {
      return `完整 JSON 期望值不是合法 JSON：${textPreview(expectedRaw)}`;
    }
    if (jsonBody === undefined) return '请求体缺失，无法做完整 JSON 比对';
    return deepEqual(jsonBody, expected)
      ? null
      : `请求体与期望的完整 JSON 不相等（期望 ${textPreview(expectedRaw)}，实际 ${textPreview(JSON.stringify(jsonBody) ?? 'undefined')}）`;
  }
  /* textEqual：原文可用性与后端捕获行为对齐（未声明 Content-Type / text/json 时后端拿不到原文） */
  if (!isRawBodyAvailable(req.headers['content-type'])) {
    return '请求体原文不可用（Content-Type 未声明或为 text/json 时后端不捕获原文）';
  }
  const actual = req.bodyText;
  return actual === expectedRaw ? null : `请求体原文与期望不一致（期望 ${textPreview(expectedRaw)}，实际 ${textPreview(actual)}）`;
}

/** 校验一组请求条件（与后端 checkConditions 同构）；返回第一条失败原因或 null */
export function matchRequest(request: RouteRequest | undefined, req: PreviewRequest): string | null {
  if (!request) return null;
  for (const cond of request.headers ?? []) {
    const reason = matchCondition(cond, req.headers[cond.key.toLowerCase()]);
    if (reason) return `请求头 ${cond.key} ${reason}`;
  }
  for (const cond of request.query ?? []) {
    const reason = matchCondition(cond, req.query[cond.key]);
    if (reason) return `查询参数 ${cond.key} ${reason}`;
  }
  /* 与后端一致：Content-Type 非 JSON 类（或未声明）时 req.body 为 undefined，body 条件按缺失处理 */
  const parsed = parseRequestBody(req.bodyText, req.headers['content-type']);
  return matchBodyConditions(request, req, parsed.kind === 'parsed' ? parsed.value : undefined);
}

/** 路径段匹配：模式路径含 :param 时提取参数；不匹配返回 undefined */
function matchPath(pattern: string, actual: string): Record<string, string> | undefined {
  const patternSegments = pattern.split('/');
  const actualSegments = actual.split('/');
  if (patternSegments.length !== actualSegments.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i += 1) {
    if (patternSegments[i].startsWith(':')) params[patternSegments[i].slice(1)] = actualSegments[i];
    else if (patternSegments[i] !== actualSegments[i]) return undefined;
  }
  return params;
}

/** 认证校验（与后端 checkAuth 同构）；返回失败原因或 null */
function checkAuth(auth: NonNullable<PreviewRoute['auth']>, req: PreviewRequest): string | null {
  if (auth.type === 'bearer') {
    const header = req.headers.authorization;
    if (header === undefined) return '缺少 Authorization 头';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return 'Authorization 头需为 Bearer <token> 形式';
    return match[1] === auth.value ? null : '令牌不正确';
  }
  const headerName = (auth.header ?? 'X-API-Key').toLowerCase();
  const key = req.headers[headerName];
  if (key === undefined) return `缺少 ${auth.header ?? 'X-API-Key'} 头`;
  return key === auth.value ? null : 'API Key 不正确';
}

/**
 * 推演一次请求的解释路径（顺序与后端分发一致）：
 * 请求体解析失败 400（先于路由）→ 停用 404 → 路径未匹配 404 → 认证 401 → 请求准入（gateStatus）→ 序列响应 → 全局场景集 → 分支顺序匹配 → 默认响应。
 */
export function previewOutcome(route: PreviewRoute, req: PreviewRequest): PreviewOutcome {
  const steps: PreviewStep[] = [];
  const label = `${req.method.toUpperCase()} ${req.path}`;

  /* 与后端一致：JSON 类 Content-Type 但请求体非法（或为顶层标量）时，body 解析器直接 400，先于路由匹配 */
  if (parseRequestBody(req.bodyText, req.headers['content-type']).kind === 'rejected') {
    steps.push({
      title: '请求体解析',
      detail: 'Content-Type 为 JSON 类，但请求体不是合法的对象/数组 JSON，被解析器拒绝（先于路径与准入）',
      status: 'blocked',
    });
    return { status: 400, title: '请求体解析失败 · 未进入分发', steps, variant: null, responded: false };
  }

  if (route.disabled) {
    steps.push({ title: '路径', detail: label, status: 'ok' });
    steps.push({ title: '接口状态', detail: '已停用：按未注册处理', status: 'blocked' });
    return { status: 404, title: '未注册接口 · 已停用', steps, variant: null, responded: false };
  }

  const params = matchPath(route.pathPattern, req.path);
  const methodMatched = req.method.toUpperCase() === route.method.toUpperCase();
  if (!methodMatched || !params) {
    steps.push({ title: '路径', detail: `${label} 与接口 ${route.method.toUpperCase()} ${route.pathPattern} 不匹配`, status: 'blocked' });
    return { status: 404, title: '未注册接口 · 路径不匹配', steps, variant: null, responded: false };
  }
  const paramNote = Object.keys(params).length ? `（${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(', ')}）` : '';
  steps.push({ title: '路径', detail: `${label}${paramNote}`, status: 'ok' });

  if (route.auth) {
    const authError = checkAuth(route.auth, req);
    if (authError) {
      steps.push({ title: '认证', detail: `模拟鉴权：${authError}`, status: 'blocked' });
      return { status: 401, title: '认证失败 · 未进入准入', steps, variant: null, responded: false };
    }
    steps.push({ title: '认证', detail: '模拟鉴权通过', status: 'ok' });
  }

  if (route.requireMatch && route.request) {
    const gateError = matchRequest(route.request, req);
    if (gateError) {
      steps.push({ title: '请求准入', detail: `未通过：${gateError}`, status: 'blocked' });
      steps.push({ title: '响应分支', detail: '不再评估', status: 'skipped' });
      return {
        status: route.gateStatus,
        title: `准入失败 · 未进入响应分支（HTTP ${route.gateStatus}）`,
        steps,
        variant: null,
        responded: false,
      };
    }
    steps.push({ title: '请求准入', detail: '共享条件全部通过', status: 'ok' });
  } else {
    steps.push({ title: '请求准入', detail: route.requireMatch ? '已开启但未配置条件（等价于不校验）' : '未开启', status: 'info' });
  }

  if (route.sequence.length > 0) {
    const first = route.sequence[0];
    steps.push({ title: '序列响应', detail: `按命中次序循环，预览第 1 步（HTTP ${first.status}）`, status: 'ok' });
    return { status: first.status, title: '序列响应 · 第 1 步', steps, body: first.body, variant: '序列#1', responded: true };
  }

  const forced = route.activeVariant ? route.variants.find((v) => v.name === route.activeVariant) : undefined;
  if (forced) {
    steps.push({ title: '全局场景集', detail: `强制命中「${forced.name}」（绕过其条件）`, status: 'ok' });
    return { status: forced.response.status, title: `全局场景集 · ${forced.name}`, steps, body: forced.response.body, variant: forced.name, responded: true };
  }

  for (const variant of route.variants) {
    const reason = variant.match ? matchRequest(variant.match, req) : null;
    if (!reason) {
      steps.push({ title: '响应分支', detail: `「${variant.name}」命中（HTTP ${variant.response.status}）`, status: 'ok' });
      return { status: variant.response.status, title: `命中分支 · ${variant.name}`, steps, body: variant.response.body, variant: variant.name, responded: true };
    }
    steps.push({ title: '响应分支', detail: `「${variant.name}」未命中：${reason}`, status: 'skipped' });
  }

  steps.push({ title: '默认响应', detail: `所有分支未命中，返回默认响应（HTTP ${route.defaultResponse.status}）`, status: 'ok' });
  return { status: route.defaultResponse.status, title: '未命中分支 · 默认响应', steps, body: route.defaultResponse.body, variant: null, responded: true };
}

/** 解析查询串（k=v&k2=v2，忽略空段；多次出现的键取首个，与后端 query 取值一致） */
export function parseQueryString(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of text.replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const index = pair.indexOf('=');
    const key = index === -1 ? pair : pair.slice(0, index);
    const value = index === -1 ? '' : pair.slice(index + 1);
    const trimmedKey = key.trim();
    if (trimmedKey && !(trimmedKey in result)) result[trimmedKey] = value;
  }
  return result;
}

/** 解析请求头多行文本（每行 K: V；键统一小写；忽略空行与无冒号行） */
export function parseHeaderLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(':');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim().toLowerCase();
    const value = trimmed.slice(index + 1).trim();
    if (key && !(key in result)) result[key] = value;
  }
  return result;
}
