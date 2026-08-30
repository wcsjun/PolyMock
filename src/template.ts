/**
 * 响应体模板渲染（纯函数，无 IO）。
 *
 * 深度遍历响应体，仅处理字符串值中的 {{...}} 占位符：
 * - {{query.键}}   请求查询参数
 * - {{header.名}}  请求头（大小写不敏感）
 * - {{body.点路径}} 请求体点路径取值
 * - {{$id}}        路由级自增序号
 * - {{$now}}       当前时间 ISO 字符串
 * - {{$int(min,max)}} 闭区间随机整数
 *
 * 取不到值或语法不识别时占位符原样保留；非字符串叶子与结构原样返回，不突变入参。
 */

export interface TemplateContext {
  query: Record<string, string>;
  /** 键为原始请求头名，查找时大小写不敏感 */
  headers: Record<string, string>;
  body: unknown;
  routeId: string;
  /** 路由级自增（{{$id}} 用） */
  nextId: () => number;
}

/** 点路径取值：user.id -> obj.user.id；中间层非对象返回 undefined */
function lookupPath(obj: unknown, dotPath: string): unknown {
  let current: unknown = obj;
  for (const segment of dotPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 叶子值字符串化；undefined 表示取不到值（占位符原样保留） */
function stringifyLeaf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 解析单个占位符表达式；无法解析返回 undefined */
function resolveExpr(expr: string, ctx: TemplateContext): string | undefined {
  if (expr === '$id') return String(ctx.nextId());
  if (expr === '$now') return new Date().toISOString();
  const intMatch = /^\$int\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/.exec(expr);
  if (intMatch) {
    const min = Number(intMatch[1]);
    const max = Number(intMatch[2]);
    if (min > max) return undefined;
    return String(min + Math.floor(Math.random() * (max - min + 1)));
  }
  if (expr.startsWith('query.')) {
    return stringifyLeaf(ctx.query[expr.slice('query.'.length)]);
  }
  if (expr.startsWith('header.')) {
    const name = expr.slice('header.'.length).toLowerCase();
    for (const [key, value] of Object.entries(ctx.headers)) {
      if (key.toLowerCase() === name) return stringifyLeaf(value);
    }
    return undefined;
  }
  if (expr.startsWith('body.')) {
    return stringifyLeaf(lookupPath(ctx.body, expr.slice('body.'.length)));
  }
  return undefined;
}

/** 替换字符串中的全部占位符；无法解析的保持原样 */
function renderString(text: string, ctx: TemplateContext): string {
  return text.replace(/\{\{([^{}]+)\}\}/g, (match, raw: string) => {
    const resolved = resolveExpr(raw.trim(), ctx);
    return resolved === undefined ? match : resolved;
  });
}

/** 深度渲染响应体；非字符串叶子与结构原样返回（不突变入参） */
export function renderTemplate(body: unknown, ctx: TemplateContext): unknown {
  if (typeof body === 'string') return renderString(body, ctx);
  if (Array.isArray(body)) return body.map((item) => renderTemplate(item, ctx));
  if (body !== null && typeof body === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      out[key] = renderTemplate(value, ctx);
    }
    return out;
  }
  return body;
}
