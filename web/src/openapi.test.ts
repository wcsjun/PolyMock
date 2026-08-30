import { describe, expect, it } from 'vitest';
import { parseOpenApi } from './openapi';

/** 覆盖 $ref / 数组采样 / date-time / enum / 201 / 多段路径参数的示例文档 */
const DOC = JSON.stringify({
  openapi: '3.0.0',
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/User' } },
              },
            },
          },
        },
      },
      post: {
        summary: '创建用户',
        responses: {
          '201': { content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
        },
      },
    },
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        responses: {
          '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
        },
      },
    },
    '/pets/{petId}/toys/{toyId}': {
      get: {
        summary: '宠物玩具',
        responses: {
          default: {
            content: {
              'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      User: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          role: { enum: ['admin', 'user'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
});

/** User schema 的采样结果（createdAt 为动态 ISO 时间，单独断言） */
function expectUserSample(body: unknown): void {
  expect(body).toEqual({
    id: 0,
    name: 'string',
    role: 'admin',
    createdAt: (body as { createdAt: string }).createdAt,
  });
  expect((body as { createdAt: string }).createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  expect(Number.isNaN(Date.parse((body as { createdAt: string }).createdAt))).toBe(false);
}

describe('parseOpenApi', () => {
  it('合法文档：$ref 解析、数组采样、date-time、enum、serviceId 填入', () => {
    const result = parseOpenApi(DOC, { serviceId: 'svc-a' });
    expect(result.truncated).toBe(false);
    expect(result.skipped).toEqual([]);
    expect(result.created.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /users',
      'POST /users',
      'GET /users/:id',
      'GET /pets/:petId/toys/:toyId',
    ]);

    const listUsers = result.created[0];
    expect(listUsers.payload.serviceId).toBe('svc-a');
    expect(listUsers.payload.name).toBe('listUsers');
    expect(listUsers.payload.response.status).toBe(200);
    // 数组采样：body 为 [sample]
    const listBody = JSON.parse(listUsers.payload.response.body);
    expect(Array.isArray(listBody)).toBe(true);
    expectUserSample(listBody[0]);
  });

  it('POST 201 状态码映射与 summary 命名', () => {
    const result = parseOpenApi(DOC);
    const createUser = result.created[1];
    expect(createUser.method).toBe('POST');
    expect(createUser.payload.response.status).toBe(201);
    expect(createUser.payload.name).toBe('创建用户');
    expectUserSample(JSON.parse(createUser.payload.response.body));
  });

  it('路径参数 {id} 转换为 :id（多段各自转换），default 响应状态码取 200', () => {
    const result = parseOpenApi(DOC);
    expect(result.created[2].payload.path).toBe('/users/:id');
    const toys = result.created[3];
    expect(toys.payload.path).toBe('/pets/:petId/toys/:toyId');
    expect(toys.payload.response.status).toBe(200);
    expect(JSON.parse(toys.payload.response.body)).toEqual({ ok: false });
  });

  it('名称回退：无 operationId/summary 时取 "METHOD 原始路径"', () => {
    const doc = JSON.stringify({
      openapi: '3.0.0',
      paths: { '/things/{thingId}': { get: { responses: {} } } },
    });
    const result = parseOpenApi(doc);
    expect(result.created[0].payload.name).toBe('GET /things/{thingId}');
    expect(result.created[0].payload.path).toBe('/things/:thingId');
  });

  it('非法 JSON throw（中文消息）', () => {
    expect(() => parseOpenApi('{ not json')).toThrow('JSON 解析失败，请检查文档格式');
  });

  it('缺少 openapi 字段 throw', () => {
    expect(() => parseOpenApi('{"paths":{}}')).toThrow('不是有效的 OpenAPI 文档：缺少 openapi 字段');
  });

  it('maxRoutes 截断', () => {
    const result = parseOpenApi(DOC, { maxRoutes: 2 });
    expect(result.created).toHaveLength(2);
    expect(result.truncated).toBe(true);
    // 全量解析不截断
    expect(parseOpenApi(DOC).created).toHaveLength(4);
  });

  it('转换后路径非法进入 skipped；无 schema 时响应体为 { message: "ok" }', () => {
    const doc = JSON.stringify({
      openapi: '3.0.0',
      paths: {
        '/bad/{': { get: { responses: {} } }, // 未闭合的花括号
        '/ok': { get: { responses: {} } },
      },
    });
    const result = parseOpenApi(doc);
    expect(result.created).toHaveLength(1);
    expect(result.created[0].payload.path).toBe('/ok');
    expect(JSON.parse(result.created[0].payload.response.body)).toEqual({ message: 'ok' });
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].method).toBe('GET');
    expect(result.skipped[0].path).toBe('/bad/{');
    expect(typeof result.skipped[0].reason).toBe('string');
  });
});
