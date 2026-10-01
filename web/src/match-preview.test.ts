import { describe, expect, it } from 'vitest';
import { matchCondition, matchRequest, parseHeaderLines, parseQueryString, previewOutcome, type PreviewRoute } from './match-preview';

/** 快捷构造预览路由：缺省 GET /api/hello、无准入、无分支 */
function route(overrides: Partial<PreviewRoute> = {}): PreviewRoute {
  return {
    method: 'GET',
    path: '/api/hello',
    pathPattern: '/api/hello',
    disabled: false,
    requireMatch: false,
    gateStatus: 400,
    variants: [],
    sequence: [],
    defaultResponse: { status: 200, body: { hello: true } },
    ...overrides,
  };
}

/** 快捷构造预览请求 */
function req(overrides: Partial<Parameters<typeof previewOutcome>[1]> = {}) {
  return { method: 'GET', path: '/api/hello', query: {}, headers: {}, bodyText: '', ...overrides };
}

describe('parseQueryString / parseHeaderLines', () => {
  it('查询串忽略前导 ?、空段与重复键（取首个）', () => {
    expect(parseQueryString('?a=1&b=&=x&&a=2')).toEqual({ a: '1', b: '' });
    expect(parseQueryString('flag')).toEqual({ flag: '' });
  });

  it('请求头按行解析，键小写、忽略空行与无冒号行', () => {
    expect(parseHeaderLines('X-Token: abc\n\nAuthorization: Bearer t\nbroken\nX-Token: zzz')).toEqual({
      'x-token': 'abc',
      authorization: 'Bearer t',
    });
  });
});

describe('matchCondition 条件语义（与后端一致）', () => {
  it('显式操作符：存在 / 非空 / 等于空串 / 正则', () => {
    expect(matchCondition({ key: 'a', value: '', match: 'exists' }, '')).toBeNull();
    expect(matchCondition({ key: 'a', value: '', match: 'exists' }, undefined)).toContain('缺少');
    expect(matchCondition({ key: 'a', value: '', match: 'nonEmpty' }, '')).toContain('非空');
    expect(matchCondition({ key: 'a', value: '', match: 'nonEmpty' }, 'x')).toBeNull();
    expect(matchCondition({ key: 'a', value: '', match: 'equals' }, '')).toBeNull();
    expect(matchCondition({ key: 'a', value: '', match: 'equals' }, 'x')).toContain('期望');
    expect(matchCondition({ key: 'a', value: '^cn-\\w+$', match: 'regex' }, 'cn-north')).toBeNull();
    expect(matchCondition({ key: 'a', value: '^cn-\\w+$', match: 'regex' }, 'us-east')).toContain('正则');
    expect(matchCondition({ key: 'a', value: '([', match: 'regex' }, 'x')).toContain('不是合法正则');
  });

  it('无操作符时保持历史语义：空 value = 仅要求存在，required=false 缺失放行', () => {
    expect(matchCondition({ key: 'a', value: '' }, 'anything')).toBeNull();
    expect(matchCondition({ key: 'a', value: '1' }, undefined)).toContain('缺少');
    expect(matchCondition({ key: 'a', value: '1', required: false }, undefined)).toBeNull();
    expect(matchCondition({ key: 'a', value: '1', type: 'number' }, '1')).toBeNull();
    expect(matchCondition({ key: 'a', value: '1', type: 'number' }, '2')).toContain('期望');
  });
});

/** JSON Content-Type 请求头（后端只在此类头下解析 body，与预览语义一致） */
const JSON_CT = { 'content-type': 'application/json' };

describe('matchRequest body 策略', () => {
  it('subset：点路径子集匹配，选填条件在 body 缺失时放行', () => {
    const request = { body: [{ key: 'user.id', value: '1' }, { key: 'coupon', value: 'x', required: false }] };
    expect(matchRequest(request, req({ headers: JSON_CT, bodyText: '{"user":{"id":1}}' }))).toBeNull();
    expect(matchRequest(request, req({ headers: JSON_CT, bodyText: '{"user":{"id":2}}' }))).toContain('user.id');
    expect(matchRequest({ body: [{ key: 'coupon', value: 'x', required: false }] }, req())).toBeNull();
  });

  it('deepEqual：字段顺序无关，缺字段 / 多字段不命中', () => {
    const request = { bodyMatch: 'deepEqual' as const, bodyRaw: '{"status":"PAID","orderId":"1001"}' };
    expect(matchRequest(request, req({ method: 'POST', headers: JSON_CT, bodyText: '{"orderId":"1001","status":"PAID"}' }))).toBeNull();
    expect(matchRequest(request, req({ method: 'POST', headers: JSON_CT, bodyText: '{"orderId":"1001","status":"PAID","x":1}' }))).toContain('完整 JSON');
    expect(matchRequest(request, req({ method: 'POST', headers: JSON_CT, bodyText: '{"orderId":"1001"}' }))).toContain('完整 JSON');
    expect(matchRequest(request, req({ method: 'POST', headers: JSON_CT, bodyText: '' }))).toContain('请求体缺失');
  });

  it('textEqual：逐字符比对（空格与顺序都影响结果）', () => {
    const request = { bodyMatch: 'textEqual' as const, bodyRaw: '{"status":"PAID"}' };
    expect(matchRequest(request, req({ method: 'POST', headers: JSON_CT, bodyText: '{"status":"PAID"}' }))).toBeNull();
    expect(matchRequest(request, req({ method: 'POST', headers: JSON_CT, bodyText: '{ "status": "PAID" }' }))).toContain('原文');
    /* 非 JSON 文本同样按原文比对（显式非 JSON Content-Type 时后端由中间件捕获原文） */
    expect(matchRequest(request, req({ method: 'POST', headers: { 'content-type': 'text/plain' }, bodyText: 'hello' }))).toContain('原文');
  });
});

describe('Content-Type 语义（与后端一致）', () => {
  it('未声明或非 JSON Content-Type 时 body 不参与解析匹配（即使原文是合法 JSON）', () => {
    const request = { bodyMatch: 'deepEqual' as const, bodyRaw: '{"a":1}' };
    expect(matchRequest(request, req({ method: 'POST', bodyText: '{"a":1}' }))).toContain('请求体缺失');
    expect(matchRequest(request, req({ method: 'POST', headers: { 'content-type': 'text/plain' }, bodyText: '{"a":1}' }))).toContain('请求体缺失');
    expect(matchRequest(request, req({ method: 'POST', headers: JSON_CT, bodyText: '{"a":1}' }))).toBeNull();
    /* *+json 后缀同样按 JSON 解析（忽略参数） */
    expect(matchRequest(request, req({ method: 'POST', headers: { 'content-type': 'application/vnd.api+json; charset=utf-8' }, bodyText: '{"a":1}' }))).toBeNull();
  });

  it('subset 条件同样要求 JSON Content-Type', () => {
    const request = { body: [{ key: 'a', value: '1' }] };
    expect(matchRequest(request, req({ method: 'POST', bodyText: '{"a":1}' }))).toContain('请求体缺失');
    expect(matchRequest(request, req({ method: 'POST', headers: JSON_CT, bodyText: '{"a":1}' }))).toBeNull();
  });

  it('textEqual：未声明 Content-Type 或 text/json 时原文不可用（与后端捕获行为一致）', () => {
    const request = { bodyMatch: 'textEqual' as const, bodyRaw: 'raw-body' };
    expect(matchRequest(request, req({ method: 'POST', bodyText: 'raw-body' }))).toContain('原文不可用');
    expect(matchRequest(request, req({ method: 'POST', headers: { 'content-type': 'text/json' }, bodyText: 'raw-body' }))).toContain('原文不可用');
    expect(matchRequest(request, req({ method: 'POST', headers: { 'content-type': 'text/plain' }, bodyText: 'raw-body' }))).toBeNull();
  });

  it('非法或顶层标量 JSON 被解析器 400 拒绝（先于路径匹配与准入）', () => {
    /* 顶层标量：strict 模式只收对象/数组 */
    const scalar = previewOutcome(route(), req({ headers: JSON_CT, bodyText: '"abc"' }));
    expect(scalar.status).toBe(400);
    expect(scalar.title).toContain('解析失败');
    expect(scalar.responded).toBe(false);
    /* 非法 JSON：即使路径不匹配，也是 400 先于 404 */
    const invalid = previewOutcome(route(), req({ path: '/api/other', headers: JSON_CT, bodyText: '{bad' }));
    expect(invalid.status).toBe(400);
    expect(invalid.steps[0].title).toBe('请求体解析');
    /* 顶层数组是合法的（strict 允许对象/数组），照常进入分发 */
    const arr = previewOutcome(route(), req({ headers: JSON_CT, bodyText: '[1,2]' }));
    expect(arr.status).toBe(200);
  });
});

describe('previewOutcome 解释路径', () => {
  it('路径 / 方法不匹配返回 404，停用接口同样按未注册处理', () => {
    expect(previewOutcome(route(), req({ path: '/api/other' })).status).toBe(404);
    expect(previewOutcome(route(), req({ method: 'POST' })).status).toBe(404);
    const disabled = previewOutcome(route({ disabled: true }), req());
    expect(disabled.status).toBe(404);
    expect(disabled.title).toContain('已停用');
  });

  it('路径参数路由命中并在 trace 中展示参数', () => {
    const result = previewOutcome(route({ path: '/api/users/:id', pathPattern: '/api/users/:id' }), req({ path: '/api/users/7' }));
    expect(result.status).toBe(200);
    expect(result.steps[0].detail).toContain('id=7');
  });

  it('认证失败返回 401，且不再评估准入与分支', () => {
    const result = previewOutcome(
      route({ auth: { type: 'apikey', value: 'k' }, requireMatch: true, request: { query: [{ key: 'a', value: '1', match: 'equals' }] } }),
      req(),
    );
    expect(result.status).toBe(401);
    expect(result.responded).toBe(false);
    expect(result.steps.map((s) => s.title)).toEqual(['路径', '认证']);

    const bearer = previewOutcome(route({ auth: { type: 'bearer', value: 't' } }), req({ headers: { authorization: 'Bearer t' } }));
    expect(bearer.status).toBe(200);
  });

  it('准入失败按 gateStatus 返回并跳过分支评估', () => {
    const guarded = route({
      requireMatch: true,
      gateStatus: 404,
      request: { headers: [{ key: 'X-Token', value: 'abc', match: 'equals' }] },
    });
    const blocked = previewOutcome(guarded, req());
    expect(blocked.status).toBe(404);
    expect(blocked.responded).toBe(false);
    expect(blocked.steps.map((s) => `${s.title}:${s.status}`)).toEqual(['路径:ok', '请求准入:blocked', '响应分支:skipped']);

    const passed = previewOutcome(guarded, req({ headers: { 'x-token': 'abc' } }));
    expect(passed.status).toBe(200);
    expect(passed.steps[1].detail).toContain('全部通过');
  });

  it('序列响应优先于分支与默认响应', () => {
    const result = previewOutcome(
      route({
        sequence: [{ status: 202, body: { step: 1 } }],
        variants: [{ name: '命中分支', response: { status: 200, body: { v: 1 } } }],
      }),
      req(),
    );
    expect(result.status).toBe(202);
    expect(result.variant).toBe('序列#1');
    expect(result.title).toContain('序列响应');
  });

  it('全局场景集强制命中变体（绕过条件）', () => {
    const result = previewOutcome(
      route({
        activeVariant: '已付款',
        variants: [
          { name: '已付款', match: { query: [{ key: 'state', value: 'PAID', match: 'equals' }] }, response: { status: 200, body: { paid: true } } },
          { name: '已取消', response: { status: 409, body: { canceled: true } } },
        ],
      }),
      req({ query: { state: 'CANCELED' } }),
    );
    expect(result.variant).toBe('已付款');
    expect(result.title).toContain('全局场景集');
  });

  it('分支按顺序匹配，全不命中回落默认响应', () => {
    const variants = [
      { name: '已付款', match: { query: [{ key: 'state', value: 'PAID', match: 'equals' as const }] }, response: { status: 200, body: { paid: true } } },
      { name: '已取消', match: { query: [{ key: 'state', value: 'CANCELED', match: 'equals' as const }] }, response: { status: 409, body: { canceled: true } } },
    ];
    const paid = previewOutcome(route({ variants }), req({ query: { state: 'PAID' } }));
    expect(paid.status).toBe(200);
    expect(paid.variant).toBe('已付款');

    const canceled = previewOutcome(route({ variants }), req({ query: { state: 'CANCELED' } }));
    expect(canceled.status).toBe(409);
    expect(canceled.variant).toBe('已取消');

    const fallback = previewOutcome(route({ variants }), req({ query: { state: 'X' } }));
    expect(fallback.variant).toBeNull();
    expect(fallback.title).toContain('默认响应');
    expect(fallback.steps.filter((s) => s.status === 'skipped')).toHaveLength(2);
  });
});
