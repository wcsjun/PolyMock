/**
 * 响应体模板渲染（纯函数，无 IO）。
 *
 * 深度遍历响应体，仅处理字符串值中的 {{...}} 占位符：
 * - {{query.键}}   请求查询参数
 * - {{header.名}}  请求头（大小写不敏感）
 * - {{body.点路径}} 请求体点路径取值
 * - {{params.名}}  路径参数（如 /api/users/:id 的 {{params.id}}）
 * - {{$id}}        路由级自增序号
 * - {{$now}}       当前时间 ISO 字符串
 * - {{$int(min,max)}} 闭区间随机整数
 * - {{$name}} / {{$ename}} / {{$email}} / {{$phone}} / {{$city}} / {{$word}} / {{$bool}}
 *   内置假数据函数族（中文友好，无外部依赖）
 *
 * 取不到值或语法不识别时占位符原样保留；非字符串叶子与结构原样返回，不突变入参。
 */

export interface TemplateContext {
  query: Record<string, string>;
  /** 键为原始请求头名，查找时大小写不敏感 */
  headers: Record<string, string>;
  /** 路径参数（如 /api/users/:id 命中 /api/users/42 时为 { id: '42' }） */
  params?: Record<string, string>;
  body: unknown;
  routeId: string;
  /** 路由级自增（{{$id}} 用） */
  nextId: () => number;
}

/* ---------- 假数据函数族的数据池（内置，中文友好） ---------- */

const NAME_SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '胡', '朱', '高', '林', '何', '郭', '马', '罗'];
const NAME_GIVENS = ['伟', '芳', '娜', '敏', '静', '磊', '军', '洋', '勇', '艳', '杰', '涛', '明', '超', '秀英', '霞', '平', '刚', '桂英', '梓萱', '子轩', '雨桐', '浩然', '欣怡', '俊杰', '思远', '天佑', '雪', '婷', '宇'];
const EN_FIRST = ['James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'David', 'Elizabeth', 'William', 'Susan', 'Richard', 'Jessica', 'Thomas', 'Sarah'];
const EN_LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Martin', 'Lee', 'Clark'];
const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '重庆', '苏州', '天津', '长沙', '郑州', '青岛', '合肥', '福州', '厦门', '昆明', '大连'];
const WORDS = ['订单', '用户', '商品', '库存', '支付', '物流', '优惠券', '积分', '会员', '消息', '通知', '报表', '结算', '退款', '发票', '审批', '合同', '项目', '任务', '日历', '相册', '收藏', '购物车', '地址', '发票抬头'];

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function randomDigits(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += Math.floor(Math.random() * 10);
  return out;
}

/** 假数据占位符：返回 undefined 表示不识别 */
function resolveFake(expr: string): string | undefined {
  switch (expr) {
    case '$name':
      return pick(NAME_SURNAMES) + pick(NAME_GIVENS);
    case '$ename':
      return `${pick(EN_FIRST)} ${pick(EN_LAST)}`;
    case '$email':
      return `${pick(EN_FIRST).toLowerCase()}.${randomDigits(4)}@example.com`;
    case '$phone':
      return `1${pick(['3', '5', '7', '8', '9'])}${randomDigits(9)}`;
    case '$city':
      return pick(CITIES);
    case '$word':
      return pick(WORDS);
    case '$bool':
      return Math.random() < 0.5 ? 'true' : 'false';
    default:
      return undefined;
  }
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
  const fake = resolveFake(expr);
  if (fake !== undefined) return fake;
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
  if (expr.startsWith('params.')) {
    return stringifyLeaf(ctx.params?.[expr.slice('params.'.length)]);
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

/** 文本级模板渲染：字符串内的占位符注入文本，值位置的占位符注入 JSON 字面量（非字面量值注入带引号字符串） */
export function renderTemplateText(text: string, ctx: TemplateContext): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    /* 字符串内的转义序列原样保留 */
    if (inString && ch === '\\') {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2);
      if (end !== -1) {
        const expr = text.slice(i + 2, end).trim();
        const value = resolveExpr(expr, ctx);
        if (value === undefined) {
          out += text.slice(i, end + 2);
        } else if (inString) {
          out += value;
        } else {
          /* 值位置：值本身是合法 JSON 字面量（数字/布尔/null/JSON）则原样注入，否则注入带引号字符串 */
          try {
            JSON.parse(value);
            out += value;
          } catch {
            out += JSON.stringify(value);
          }
        }
        i = end + 2;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
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
