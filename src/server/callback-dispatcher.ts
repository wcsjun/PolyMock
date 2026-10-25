import { randomUUID } from 'node:crypto';
import { renderString, renderTemplateText, type TemplateContext } from '../template.js';
import type { RouteRegistry } from '../registry.js';
import type { RequestLogStore } from './request-log.js';
import { isHostAllowed, isJsonContentType } from './route-validation.js';
import {
  CALLBACK_MAX_DEPTH,
  CALLBACK_TIMEOUT_MS,
  type RequestLogEntry,
  type RouteCallback,
} from '../types.js';

/**
 * 出站回调执行器：命中分支携带 callback 时，在响应发送完成后按配置延迟异步发出一次 HTTP 回调（fire-and-forget）。
 * - 模板上下文为命中时快照（与响应模板同一份 ctx），延迟到期后用快照渲染，不再取现场；
 * - 模板无状态：引用模式在发送时解析模板当前配置（编辑模板对后续命中的回调生效）；
 * - 出站受代理白名单约束、10s 超时、不跟随重定向、失败只记日志不重试；
 * - 防自环：入站携带 X-PolyMock-Callback-Depth 达上限时跳过发送，出站携带深度 +1。
 */

const DEPTH_HEADER = 'x-polymock-callback-depth';
const DEPTH_HEADER_OUT = 'X-PolyMock-Callback-Depth';

/** 命中分支解析出的回调信封（引用模式展开模板，内联模式取自身）；body 已按 bodyOverride 覆盖 */
interface ResolvedCallback {
  url: string;
  method: string;
  headers?: Array<{ key: string; value: string }>;
  contentType?: string;
  body?: string;
  delayMs: number;
  jitterMs: number;
  templateId?: string;
  templateName?: string;
}

/** 引用模式展开模板取信封；模板不存在（引用悬空）返回 null */
function resolveCallbackConfig(callback: RouteCallback, registry: RouteRegistry): ResolvedCallback | null {
  if ('template' in callback) {
    const template = registry.getCallbackTemplate(callback.template);
    if (!template) return null;
    return {
      url: template.url,
      method: template.method ?? 'POST',
      ...(template.headers ? { headers: template.headers } : {}),
      ...(template.contentType ? { contentType: template.contentType } : {}),
      body: callback.bodyOverride ?? template.body,
      delayMs: template.delayMs ?? 1000,
      jitterMs: template.jitterMs ?? 0,
      templateId: template.id,
      templateName: template.name,
    };
  }
  return {
    url: callback.url,
    method: callback.method ?? 'POST',
    ...(callback.headers ? { headers: callback.headers } : {}),
    ...(callback.contentType ? { contentType: callback.contentType } : {}),
    body: callback.body,
    delayMs: callback.delayMs ?? 1000,
    jitterMs: callback.jitterMs ?? 0,
  };
}

/** 命中分支触发的回调任务：ctx 为命中时快照，fired 后不再读取请求现场 */
export interface CallbackHit {
  registry: RouteRegistry;
  logs?: RequestLogStore;
  /** 出站白名单（host 列表，复用代理白名单）；缺省不校验 */
  allowHosts?: string[];
  serviceId: string;
  routeId: string;
  /** 触发命中的源请求日志 id（未记录日志时为 null） */
  sourceLogId: string | null;
  callback: RouteCallback;
  ctx: TemplateContext;
  /** 命中时刻（Date.now()），发出延迟据此计算 */
  hitAt: number;
  /** 入站请求携带的回调深度，无则 0 */
  inboundDepth: number;
}

/** 写出站日志条目（未注入 logs 时忽略）；status 为对端响应码，未发出 / 失败为 0 且 error 说明原因 */
function writeOutboundLog(
  hit: CallbackHit,
  method: string,
  out: {
    target: string;
    status: number;
    error?: string;
    firedAfterMs: number;
    delayMs: number;
    elapsedMs?: number;
    requestBody?: string;
    requestHeaders?: Record<string, string>;
    templateId?: string;
    templateName?: string;
  },
): void {
  if (!hit.logs) return;
  const entry: RequestLogEntry = {
    id: randomUUID(),
    ts: Date.now(),
    serviceId: hit.serviceId,
    method,
    path: out.target,
    matched: null,
    status: out.status,
    direction: 'out',
    durationMs: out.elapsedMs ?? 0,
    ...(out.error !== undefined ? { error: out.error } : {}),
    ...(out.requestBody !== undefined ? { bodyPreview: out.requestBody.slice(0, 500) } : {}),
    callback: {
      ...(out.templateId ? { templateId: out.templateId, templateName: out.templateName } : {}),
      sourceLogId: hit.sourceLogId,
      routeId: hit.routeId,
      delayMs: out.delayMs,
      firedAfterMs: out.firedAfterMs,
      target: out.target,
      ...(out.requestBody !== undefined ? { requestBody: out.requestBody.slice(0, 65_536) } : {}),
      ...(out.requestHeaders ? { requestHeaders: out.requestHeaders } : {}),
    },
  };
  hit.logs.push(entry);
}

/** 到期后渲染并发起回调（fire-and-forget：任何失败只记日志，不影响任何响应路径） */
async function fireCallback(hit: CallbackHit, resolved: ResolvedCallback): Promise<void> {
  const firedAfterMs = Date.now() - hit.hitAt;

  // 防自环：入站深度已达上限时不再发送（回调目标指向 PolyMock 自身会形成链式循环）
  if (hit.inboundDepth >= CALLBACK_MAX_DEPTH) {
    writeOutboundLog(hit, resolved.method, {
      target: resolved.url,
      status: 0,
      error: `回调深度超限（入站深度 ${hit.inboundDepth} ≥ 上限 ${CALLBACK_MAX_DEPTH}），已跳过发送`,
      firedAfterMs,
      delayMs: resolved.delayMs,
      templateId: resolved.templateId,
      templateName: resolved.templateName,
    });
    return;
  }

  const target = renderString(resolved.url, hit.ctx);
  try {
    new URL(target);
  } catch {
    writeOutboundLog(hit, resolved.method, {
      target,
      status: 0,
      error: '渲染后的回调 URL 不是合法地址',
      firedAfterMs,
      delayMs: resolved.delayMs,
      templateId: resolved.templateId,
      templateName: resolved.templateName,
    });
    return;
  }

  // 白名单：与代理转发同一约束，设置 POLYMOCK_PROXY_ALLOW 后按 hostname 比对
  if (hit.allowHosts && hit.allowHosts.length > 0 && !isHostAllowed(target, hit.allowHosts)) {
    writeOutboundLog(hit, resolved.method, {
      target,
      status: 0,
      error: '回调目标不在白名单内',
      firedAfterMs,
      delayMs: resolved.delayMs,
      templateId: resolved.templateId,
      templateName: resolved.templateName,
    });
    return;
  }

  const headers: Record<string, string> = {};
  for (const header of resolved.headers ?? []) {
    headers[header.key] = header.value.includes('{{') ? renderString(header.value, hit.ctx) : header.value;
  }
  const isBodyfulMethod = resolved.method !== 'GET' && resolved.method !== 'HEAD';
  const hasBody = isBodyfulMethod && resolved.body !== undefined && resolved.body !== '';
  let bodyText: string | undefined;
  if (hasBody) {
    const contentType = resolved.contentType ?? 'application/json';
    headers['Content-Type'] = contentType;
    bodyText = isJsonContentType(contentType)
      ? renderTemplateText(resolved.body as string, hit.ctx)
      : renderString(resolved.body as string, hit.ctx);
  }
  headers[DEPTH_HEADER_OUT] = String(hit.inboundDepth + 1);

  const startedAt = Date.now();
  try {
    const upstream = await fetch(target, {
      method: resolved.method,
      headers,
      ...(bodyText !== undefined ? { body: bodyText } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    // 不消费响应体：尽快释放连接，状态码足够日志与联调判断
    void upstream.body?.cancel().catch(() => {});
    writeOutboundLog(hit, resolved.method, {
      target,
      status: upstream.status,
      firedAfterMs,
      delayMs: resolved.delayMs,
      elapsedMs: Date.now() - startedAt,
      requestBody: bodyText,
      requestHeaders: headers,
      templateId: resolved.templateId,
      templateName: resolved.templateName,
    });
  } catch (err) {
    const reason = (err as Error).name === 'TimeoutError' ? `回调超时（${CALLBACK_TIMEOUT_MS / 1000}s）` : (err as Error).message;
    writeOutboundLog(hit, resolved.method, {
      target,
      status: 0,
      error: `回调发送失败：${reason}`,
      firedAfterMs,
      delayMs: resolved.delayMs,
      elapsedMs: Date.now() - startedAt,
      requestBody: bodyText,
      requestHeaders: headers,
      templateId: resolved.templateId,
      templateName: resolved.templateName,
    });
  }
}

/**
 * 排程一次出站回调：响应发送完成后调用（不阻塞响应路径）。
 * 延迟 = delayMs + rand(0..jitterMs)；路由编辑 / 停用 / 删除不影响已排程回调（受理后不撤回）；
 * 进程退出时未到期回调自然丢弃（timer unref，不持久化、不做启动补偿）。
 */
export function scheduleHttpCallback(hit: CallbackHit): void {
  const resolved = resolveCallbackConfig(hit.callback, hit.registry);
  if (!resolved) {
    // 引用悬空（手改配置等）：按「无回调」处理，仅记日志说明原因
    const ref = 'template' in hit.callback ? hit.callback.template : '';
    writeOutboundLog(hit, 'POST', {
      target: ref,
      status: 0,
      error: `引用的回调模板 ${ref} 不存在（引用悬空），本次回调未发出`,
      firedAfterMs: 0,
      delayMs: 0,
      templateId: ref || undefined,
    });
    return;
  }
  const jitter = resolved.jitterMs > 0 ? Math.floor(Math.random() * (resolved.jitterMs + 1)) : 0;
  const timer = setTimeout(() => {
    void fireCallback(hit, resolved);
  }, resolved.delayMs + jitter);
  timer.unref();
}
