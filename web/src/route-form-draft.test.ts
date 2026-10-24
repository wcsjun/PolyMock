import { describe, expect, it } from 'vitest';
import type { Route } from './types';
import {
  DEFAULT_SCENE_ID,
  backfillDraft,
  buildAuthPayload,
  buildResponseHeaders,
  buildRoutePayload,
  defaultScene,
  emptyRows,
  newScene,
  sceneIsJsonMode,
  type RouteFormSubmitInput,
  type SceneDraft,
} from './route-form-draft';

/** 快捷构造完整 Route（回填测试用） */
function routeOf(overrides: Partial<Route> & Pick<Route, 'id' | 'serviceId' | 'method' | 'path'>): Route {
  return { protocol: 'http', response: { status: 200, body: {} }, createdAt: 0, ...overrides };
}

/** 快捷构造提交输入（默认一个默认响应，无分支） */
function submitInput(overrides: Partial<RouteFormSubmitInput> = {}): RouteFormSubmitInput {
  return {
    editing: false,
    serviceId: 'svc',
    name: '查询订单',
    method: 'GET',
    path: '/api/orders',
    gate: { on: false, rows: [], bodyMatch: 'subset', bodyRaw: '', status: 400 },
    scenes: [defaultScene()],
    customHeadersOn: false,
    delayMs: '',
    jitterMs: '',
    failureRate: '',
    disabled: false,
    crud: false,
    renderRequest: true,
    auth: { type: 'none', value: '', header: '' },
    ...overrides,
  };
}

/** 快捷构造一个分支草稿 */
function sceneOf(overrides: Partial<SceneDraft> & Pick<SceneDraft, 'name'>): SceneDraft {
  return { ...newScene(overrides.name), ...overrides };
}

describe('分支草稿模型', () => {
  it('emptyRows 三组条件为空数组；newScene 缺省 subset 策略 + 200 状态', () => {
    expect(emptyRows()).toEqual({ query: [], headers: [], body: [] });
    const scene = newScene('分支 1');
    expect(scene).toMatchObject({
      name: '分支 1',
      tab: 'query',
      rows: { query: [], headers: [], body: [] },
      bodyMatch: 'subset',
      bodyRaw: '',
      status: 200,
      headerRows: [],
      bodyText: '',
      invalid: false,
    });
    expect(scene.localId).toBeGreaterThan(0);
  });

  it('defaultScene 固定 localId 0，名称「默认响应」', () => {
    expect(defaultScene()).toMatchObject({ localId: DEFAULT_SCENE_ID, name: '默认响应', status: 200 });
  });
});

describe('backfillDraft 编辑回填', () => {
  it('完整 Route：准入 / 场景 / 高级选项 / 序列 / 认证逐区回填', () => {
    const route = routeOf({
      id: 'r1',
      serviceId: 'svc',
      name: '查询订单',
      method: 'POST',
      path: '/api/orders',
      request: {
        query: [{ key: 'tenantId', value: 'acme' }],
        headers: [{ key: 'X-Role', value: 'admin' }],
        body: [{ key: 'status', value: 'PAID' }],
        bodyMatch: 'deepEqual',
        bodyRaw: '{"status":"PAID"}',
      },
      requireMatch: true,
      gateStatus: 404,
      response: { status: 200, body: { ok: true }, headers: [{ key: 'X-Trace', value: '1' }] },
      variants: [
        {
          id: 'v1',
          name: '已支付',
          match: { query: [{ key: 'status', value: 'PAID' }] },
          response: { status: 201, body: { paid: true } },
        },
      ],
      delayMs: 300,
      jitterMs: 100,
      failureRate: 5,
      disabled: true,
      sequence: [{ status: 200, body: { step: 1 } }],
      crud: true,
      renderRequest: false,
      auth: { type: 'apikey', value: 'secret', header: 'X-Key' },
    });

    const draft = backfillDraft(route);
    expect(draft.name).toBe('查询订单');
    expect(draft.method).toBe('POST');
    expect(draft.path).toBe('/api/orders');
    expect(draft.gate).toEqual({
      on: true,
      rows: [
        { key: 'tenantId', value: 'acme', type: 'string', required: true, enabled: true, match: 'equals', source: 'query' },
        { key: 'X-Role', value: 'admin', type: 'string', required: true, enabled: true, match: 'equals', source: 'headers' },
        { key: 'status', value: 'PAID', type: 'string', required: true, enabled: true, match: 'equals', source: 'body' },
      ],
      bodyMatch: 'deepEqual',
      bodyRaw: '{"status":"PAID"}',
      status: 404,
    });
    expect(draft.scenes).toHaveLength(2);
    const [def, variant] = draft.scenes;
    expect(def.localId).toBe(DEFAULT_SCENE_ID);
    expect(def).toMatchObject({ status: 200, bodyText: JSON.stringify({ ok: true }, null, 2), headerRows: [{ key: 'X-Trace', value: '1' }] });
    expect(variant).toMatchObject({ name: '已支付', status: 201, bodyText: JSON.stringify({ paid: true }, null, 2) });
    expect(variant.rows.query).toEqual([{ key: 'status', value: 'PAID', type: 'string', required: true, enabled: true, match: 'equals' }]);
    expect(draft.customHeadersOn).toBe(true);
    expect(draft.advanced).toEqual({ delayMs: 300, jitterMs: 100, failureRate: 5, disabled: true });
    expect(draft.sequence.on).toBe(true);
    expect(JSON.parse(draft.sequence.text)).toEqual([{ status: 200, body: { step: 1 } }]);
    expect(draft.crud).toBe(true);
    expect(draft.renderRequest).toBe(false);
    expect(draft.auth).toEqual({ type: 'apikey', value: 'secret', header: 'X-Key' });
  });

  it('最小 Route（WS / 旧数据）：response 缺省按空响应回填，各开关落缺省值', () => {
    const draft = backfillDraft(routeOf({ id: 'r2', serviceId: 'svc', method: 'WS', path: '/ws/x', response: undefined }));
    expect(draft.scenes[0]).toMatchObject({ status: 200, bodyText: 'null', headerRows: [] });
    expect(draft.gate).toEqual({ on: false, rows: [], bodyMatch: 'subset', bodyRaw: '', status: 400 });
    expect(draft.customHeadersOn).toBe(false);
    expect(draft.advanced).toEqual({ delayMs: '', jitterMs: '', failureRate: '', disabled: false });
    expect(draft.sequence).toEqual({ on: false, text: '[]' });
    expect(draft.crud).toBe(false);
    expect(draft.renderRequest).toBe(true);
    expect(draft.auth).toEqual({ type: 'none', value: '', header: '' });
  });
});

describe('buildRoutePayload 提交组装', () => {
  it('新建态：缺省语义不写入（request / requireMatch / gateStatus 400 / variants / 高级选项 / disabled）', () => {
    const payload = buildRoutePayload(submitInput());
    expect(payload).toEqual({
      serviceId: 'svc',
      method: 'GET',
      path: '/api/orders',
      name: '查询订单',
      response: { status: 200, body: '' },
    });
  });

  it('新建态：有值时携带（非 400 gateStatus / 高级选项数值 / 序列 / crud / 关闭 renderRequest / auth）', () => {
    const payload = buildRoutePayload(submitInput({
      gate: { on: true, rows: [], bodyMatch: 'deepEqual', bodyRaw: '{"a":1}', status: 404 },
      delayMs: 300,
      failureRate: 10,
      sequence: [{ status: 200, body: '{}' }],
      crud: true,
      renderRequest: false,
      auth: { type: 'apikey', value: ' secret ', header: ' X-Key ' },
    }));
    expect(payload.request).toEqual({ bodyMatch: 'deepEqual', bodyRaw: '{"a":1}' });
    expect(payload.requireMatch).toBe(true);
    expect(payload.gateStatus).toBe(404);
    expect(payload.delayMs).toBe(300);
    /* 空串 = 未设置：归一为 0 后在新建态删除（与原实现一致） */
    expect(payload.jitterMs).toBeUndefined();
    expect(payload.failureRate).toBe(10);
    expect(payload.sequence).toEqual([{ status: 200, body: '{}' }]);
    expect(payload.crud).toBe(true);
    expect(payload.renderRequest).toBe(false);
    expect(payload.auth).toEqual({ type: 'apikey', value: 'secret', header: 'X-Key' });
  });

  it('新建态：空串高级选项归一为 0（与 parseAdvancedValue 语义一致），auth 关闭时不携带', () => {
    const payload = buildRoutePayload(submitInput({ auth: { type: 'none', value: '', header: '' } }));
    expect(payload.delayMs).toBeUndefined();
    expect(payload.auth).toBeUndefined();
  });

  it('编辑态：始终携带 request（空条件归 {}）/ requireMatch / gateStatus / sequence [] / crud / disabled / auth null', () => {
    const payload = buildRoutePayload(submitInput({
      editing: true,
      editingRenderRequest: true,
      sequence: undefined,
      auth: { type: 'none', value: '', header: '' },
    }));
    expect(payload.request).toEqual({});
    expect(payload.requireMatch).toBe(false);
    expect(payload.gateStatus).toBe(400);
    expect(payload.sequence).toEqual([]);
    expect(payload.crud).toBe(false);
    expect(payload.disabled).toBe(false);
    expect(payload.delayMs).toBe(0);
    expect(payload.jitterMs).toBe(0);
    expect(payload.failureRate).toBe(0);
    expect(payload.auth).toBeNull();
  });

  it('编辑态：原路由显式关闭过 renderRequest 时恢复默认补写 true', () => {
    const restored = buildRoutePayload(submitInput({ editing: true, editingRenderRequest: false, renderRequest: true }));
    expect(restored.renderRequest).toBe(true);
    const keptOff = buildRoutePayload(submitInput({ editing: true, editingRenderRequest: false, renderRequest: false }));
    expect(keptOff.renderRequest).toBe(false);
  });

  it('分支场景：带条件的变体与自定义响应头，默认响应取 scenes[0]', () => {
    const def = { ...defaultScene(), status: 200, bodyText: '{"ok":1}', headerRows: [{ key: 'X-Def', value: 'd' }] };
    const branch = sceneOf({
      name: ' 已支付 ',
      status: 201,
      bodyText: ' {"paid":true} ',
      headerRows: [{ key: ' X-Trace ', value: '1' }, { key: '', value: 'skip' }],
      rows: { query: [{ key: 'status', value: 'PAID', type: 'string', required: true, enabled: true, match: 'equals' }], headers: [], body: [] },
    });
    const payload = buildRoutePayload(submitInput({
      editing: true,
      scenes: [def, branch],
      customHeadersOn: true,
    }));
    expect(payload.response).toEqual({ status: 200, headers: [{ key: 'X-Def', value: 'd' }], body: '{"ok":1}' });
    expect(payload.variants).toEqual([
      {
        name: '已支付',
        /* match 经 buildRouteRequest 组装：type=string / required=true 等行缺省值不写入 */
        match: { query: [{ key: 'status', value: 'PAID', match: 'equals' }] },
        response: { status: 201, headers: [{ key: 'X-Trace', value: '1' }], body: '{"paid":true}' },
      },
    ]);
  });

  it('未启用自定义响应头时场景 headerRows 不提交；空名称编辑态不覆盖 name', () => {
    const def = sceneOf({ name: '默认响应', bodyText: 'x', headerRows: [{ key: 'X-Def', value: 'd' }] });
    const noHeaders = buildRoutePayload(submitInput({ editing: true, scenes: [def], customHeadersOn: false }));
    expect(noHeaders.response).toEqual({ status: 200, body: 'x' });
    expect(noHeaders.response.headers).toBeUndefined();

    /* 新建态无条件写 name（提交前组件校验已保证非空）；编辑态仅在名称非空时覆盖 */
    expect(buildRoutePayload(submitInput({ name: '' })).name).toBe('');
    expect(buildRoutePayload(submitInput({ editing: true, name: '' })).name).toBeUndefined();
  });
});

describe('buildResponseHeaders / sceneIsJsonMode / buildAuthPayload', () => {
  it('buildResponseHeaders：过滤空 key 行，全空返回 undefined', () => {
    const scene = sceneOf({ name: 'x', headerRows: [{ key: ' A ', value: '1' }, { key: '', value: '2' }] });
    expect(buildResponseHeaders(scene)).toEqual([{ key: 'A', value: '1' }]);
    expect(buildResponseHeaders(sceneOf({ name: 'x', headerRows: [{ key: ' ', value: '2' }] }))).toBeUndefined();
  });

  it('sceneIsJsonMode：未启用响应头总开关恒 JSON；启用后由 Content-Type 行决定', () => {
    const jsonScene = sceneOf({ name: 'x', headerRows: [{ key: 'Content-Type', value: 'application/json' }] });
    const textScene = sceneOf({ name: 'x', headerRows: [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }] });
    expect(sceneIsJsonMode(jsonScene, false)).toBe(true);
    expect(sceneIsJsonMode(textScene, false)).toBe(true);
    expect(sceneIsJsonMode(jsonScene, true)).toBe(true);
    expect(sceneIsJsonMode(textScene, true)).toBe(false);
    expect(sceneIsJsonMode(sceneOf({ name: 'x' }), true)).toBe(true);
  });

  it('buildAuthPayload：none 为 null（清除语义），apikey 携带 trim 后的自定义 header', () => {
    expect(buildAuthPayload({ type: 'none', value: 'x', header: '' })).toBeNull();
    expect(buildAuthPayload({ type: 'bearer', value: ' tok ', header: '' })).toEqual({ type: 'bearer', value: 'tok' });
    expect(buildAuthPayload({ type: 'apikey', value: ' k ', header: ' X-Key ' })).toEqual({ type: 'apikey', value: 'k', header: 'X-Key' });
    expect(buildAuthPayload({ type: 'apikey', value: 'k', header: '  ' })).toEqual({ type: 'apikey', value: 'k' });
  });
});
