/**
 * OpenAPI 3 文档解析（纯函数模块，无 DOM / 无副作用，可在 Node 环境单测）。
 *
 * 仅支持 JSON 文档：
 * - 遍历 paths 下 get/post/put/patch/delete 操作；
 * - 路径参数 {id} 段转换为 PolyMock 的 :id 形式（多段各自转换，如
 *   /pets/{petId}/toys/{toyId} → /pets/:petId/toys/:toyId）；
 * - 响应取 responses['200'] || ['201'] || default 的 application/json schema；
 * - schema 采样：$ref 解析（#/components/schemas，JSON Pointer 转义，深度上限 10）、
 *   example/default 优先、enum 取第一、string（date/date-time → ISO 时间）、
 *   number/integer → 0、boolean → false、array → [sample]、object → properties 遍历；
 * - 无 schema 时响应体默认 { message: 'ok' }；
 * - 超过 maxRoutes（缺省 100）截断并标记 truncated。
 */
import type { RoutePayload } from './types';

/** 单条跳过记录（导入报告的失败/跳过明细） */
export interface OpenApiSkipped {
  method: string;
  path: string;
  reason: string;
}

/** 解析结果：created 为待创建载荷（serviceId 已填入），组件只需逐条 createRoute */
export interface OpenApiParseResult {
  created: Array<{ payload: RoutePayload; method: string; path: string }>;
  skipped: OpenApiSkipped[];
  /** 接口总数超过 maxRoutes 被截断 */
  truncated: boolean;
}

export interface ParseOpenApiOptions {
  /** 目标服务分组 id；缺省 'default' */
  serviceId?: string;
  /** 创建条数上限；缺省 100 */
  maxRoutes?: number;
}

/* ---------- 内部类型 ---------- */

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const DEFAULT_MAX_ROUTES = 100;
const SCHEMA_DEPTH_LIMIT = 10;

interface JsonSchema {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: unknown[];
  example?: unknown;
  default?: unknown;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }> | undefined;
}

interface OpenApiDoc {
  openapi?: unknown;
  paths?: Record<string, Record<string, OpenApiOperation | undefined> | undefined>;
}

/** JSON Pointer 解析 $ref（#/components/schemas/...），支持 ~0 ~1 转义 */
function resolveRef(ref: string, doc: OpenApiDoc): JsonSchema | undefined {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let node: unknown = doc;
  for (const raw of ref.slice(2).split('/')) {
    if (node === null || typeof node !== 'object') return undefined;
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = (node as Record<string, unknown>)[key];
  }
  return node && typeof node === 'object' ? (node as JsonSchema) : undefined;
}

/** 按采样规则由 schema 生成示例值；深度超限 / 循环引用返回 {} */
function sampleSchema(schema: JsonSchema | undefined, doc: OpenApiDoc, depth: number): unknown {
  if (!schema || typeof schema !== 'object' || depth > SCHEMA_DEPTH_LIMIT) return {};
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, doc);
    return resolved ? sampleSchema(resolved, doc, depth + 1) : {};
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case 'string':
      return schema.format === 'date' || schema.format === 'date-time'
        ? new Date().toISOString()
        : 'string';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [sampleSchema(schema.items, doc, depth + 1)];
    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        obj[key] = sampleSchema(child, doc, depth + 1);
      }
      return obj;
    }
    default:
      return {};
  }
}

/** OpenAPI 路径模板 {id} → PolyMock :id（每段独立替换，空段交给路径校验兜底） */
function convertPathTemplate(path: string): string {
  return path.replace(/\{([^{}]*)\}/g, (_match, name: string) => `:${name}`);
}

/** 校验转换后的路由路径（与后端注册约束对齐）；非法返回原因 */
function validateRoutePath(path: string): string | null {
  if (!path.startsWith('/')) return 'path 需以 / 开头';
  if (/\s/.test(path)) return 'path 不能包含空白字符';
  if (path.includes('{') || path.includes('}')) return 'path 存在未闭合的 { } 路径参数表达式';
  if (/(^|\/):(?=$|\/)/.test(path)) return '路径参数名称不能为空';
  return null;
}

/**
 * 解析 OpenAPI 3 JSON 文本；文档非法时 throw Error（中文消息）。
 * 路径参数 {id} 转换为 :id 后不再跳过；skipped 仅保留转换后路径非法等场景。
 */
export function parseOpenApi(raw: string, opts?: ParseOpenApiOptions): OpenApiParseResult {
  let doc: OpenApiDoc;
  try {
    doc = JSON.parse(raw) as OpenApiDoc;
  } catch {
    throw new Error('JSON 解析失败，请检查文档格式');
  }
  if (!doc || typeof doc !== 'object' || !doc.openapi) {
    throw new Error('不是有效的 OpenAPI 文档：缺少 openapi 字段');
  }

  const serviceId = opts?.serviceId ?? 'default';
  const maxRoutes = opts?.maxRoutes ?? DEFAULT_MAX_ROUTES;
  const created: OpenApiParseResult['created'] = [];
  const skipped: OpenApiSkipped[] = [];

  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      if (created.length >= maxRoutes) {
        return { created, skipped, truncated: true };
      }
      const routePath = convertPathTemplate(path);
      const invalidReason = validateRoutePath(routePath);
      if (invalidReason) {
        skipped.push({ method: method.toUpperCase(), path, reason: invalidReason });
        continue;
      }
      const responses = op.responses ?? {};
      const resp = responses['200'] || responses['201'] || responses.default;
      /* 无 schema 时默认响应体 { message: 'ok' } */
      const sampled = resp?.content?.['application/json']?.schema
        ? sampleSchema(resp.content['application/json'].schema, doc, 0)
        : { message: 'ok' };
      const upperMethod = method.toUpperCase();
      created.push({
        method: upperMethod,
        path: routePath,
        payload: {
          serviceId,
          method: upperMethod,
          path: routePath,
          /* 名称取 operationId || summary || "METHOD 原始路径"（原始 path 含 {param}） */
          name: op.operationId || op.summary || `${upperMethod} ${path}`,
          response: {
            status: !responses['200'] && responses['201'] ? 201 : 200,
            body: JSON.stringify(sampled, null, 2),
          },
        },
      });
    }
  }
  return { created, skipped, truncated: false };
}
