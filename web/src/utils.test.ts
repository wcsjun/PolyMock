import { describe, expect, it, vi } from 'vitest';
import {
  buildCompanionRoutes,
  buildCurl,
  clampDrawerWidth,
  clearDrawerWidth,
  crudCollectionKey,
  groupCrudRoutes,
  isJsonContentType,
  isTemplateJsonValid,
  buildFetchSnippet,
  bodyRowsToJsonValue,
  buildRouteRequest,
  jsonValueToBodyRows,
  loadDrawerWidth,
  parseSequenceDraft,
  proxyTargetLabel,
  responseContentTypeLabel,
  saveDrawerWidth,
  sequenceToDraftText,
  serviceDisplaySuffix,
  splitRouteRequest,
  toJavaEntity,
} from './utils';
import type { ConditionRow, Route } from './types';

/** 快捷构造条件行：缺省 type=string / required=true / enabled=true */
function row(overrides: Partial<ConditionRow> & Pick<ConditionRow, 'key' | 'value'>): ConditionRow {
  return { type: 'string', required: true, enabled: true, ...overrides };
}

describe('buildCurl / buildFetchSnippet', () => {
  it('GET/HEAD 省略方法参数（curl 默认即 GET）', () => {
    expect(buildCurl('http://x/api', 'GET')).toBe("curl 'http://x/api'");
    expect(buildCurl('http://x/api', 'HEAD')).toBe("curl 'http://x/api'");
    expect(buildFetchSnippet('http://x/api', 'GET')).toBe("fetch('http://x/api')");
    expect(buildFetchSnippet('http://x/api', 'HEAD')).toBe("fetch('http://x/api')");
  });

  it('其他方法显式携带 -X / method', () => {
    expect(buildCurl('http://x/api', 'POST')).toBe("curl -X POST 'http://x/api'");
    expect(buildCurl('http://x/api', 'DELETE')).toBe("curl -X DELETE 'http://x/api'");
    expect(buildFetchSnippet('http://x/api', 'POST')).toBe("fetch('http://x/api', {\n  method: 'POST',\n})");
    expect(buildFetchSnippet('http://x/api', 'PUT')).toBe("fetch('http://x/api', {\n  method: 'PUT',\n})");
  });
});

describe('serviceDisplaySuffix 服务分组展示后缀', () => {
  it('端口模式显示 :端口', () => {
    expect(serviceDisplaySuffix({ port: 33233, isDefault: true }, 'port')).toBe(':33233');
    expect(serviceDisplaySuffix({ port: 3001, isDefault: false }, 'port')).toBe(':3001');
  });

  it('路径模式显示 basePath 前缀，默认服务为 /', () => {
    expect(serviceDisplaySuffix({ port: 0, isDefault: true }, 'path')).toBe('/');
    expect(serviceDisplaySuffix({ port: 0, isDefault: false, basePath: 'order' }, 'path')).toBe('/order');
    expect(serviceDisplaySuffix({ port: 0, isDefault: false }, 'path')).toBe('/');
  });
});

describe('buildRouteRequest ↔ splitRouteRequest', () => {
  it('过滤未启用与空 key 行；type=string / required=true 缺省值不写入', () => {
    const request = buildRouteRequest(
      [
        row({ key: 'page', value: '1', type: 'number', required: false }),
        row({ key: '   ', value: 'x' }), // 空 key 过滤
        row({ key: 'skip', value: '1', enabled: false }), // 未启用不参与
      ],
      [row({ key: 'X-Role', value: 'admin' })],
      [],
    );
    expect(request).toEqual({
      query: [{ key: 'page', value: '1', type: 'number', required: false }],
      headers: [{ key: 'X-Role', value: 'admin' }],
    });
  });

  it('三组全空返回 undefined；undefined 拆解为空数组', () => {
    expect(buildRouteRequest([], [], [])).toBeUndefined();
    expect(buildRouteRequest([row({ key: 'a', value: '1', enabled: false })], [], [])).toBeUndefined();
    expect(splitRouteRequest(undefined)).toEqual({ query: [], headers: [], body: [] });
  });

  it('往返：build → split 还原为可编辑行并补全缺省值（enabled=true）', () => {
    const request = buildRouteRequest(
      [row({ key: 'q', value: '1' })],
      [row({ key: 'X-Token', value: '{"a":1}', type: 'json', required: false })],
      [row({ key: 'id', value: '7', type: 'number' })],
    );
    const split = splitRouteRequest(request);
    expect(split.query).toEqual([row({ key: 'q', value: '1' })]);
    expect(split.headers).toEqual([row({ key: 'X-Token', value: '{"a":1}', type: 'json', required: false })]);
    expect(split.body).toEqual([row({ key: 'id', value: '7', type: 'number' })]);
    // 回填后的行再次 build，与原 request 深度一致（幂等）
    expect(buildRouteRequest(split.query, split.headers, split.body)).toEqual(request);
  });
});

describe('bodyRowsToJsonValue ↔ jsonValueToBodyRows', () => {
  it('启用行按类型还原：嵌套对象 / json 数组 / boolean / number / 空串；未启用行不参与', () => {
    const rows: ConditionRow[] = [
      row({ key: 'user.id', value: '1', type: 'number' }),
      row({ key: 'user.name', value: 'tom' }),
      row({ key: 'user.tags', value: '[1,2]', type: 'json' }),
      row({ key: 'ok', value: 'true', type: 'boolean' }),
      row({ key: 'note', value: '' }), // 空 value 保留空串
      row({ key: 'skip', value: 'x', enabled: false }),
    ];
    expect(bodyRowsToJsonValue(rows)).toEqual({
      user: { id: 1, name: 'tom', tags: [1, 2] },
      ok: true,
      note: '',
    });
  });

  it('number / json / array 非法值保留原字符串', () => {
    expect(bodyRowsToJsonValue([row({ key: 'a', value: 'abc', type: 'number' }), row({ key: 'b', value: '{bad', type: 'json' }), row({ key: 'c', value: 'oops', type: 'array' })])).toEqual({
      a: 'abc',
      b: '{bad',
      c: 'oops',
    });
  });

  it('array 类型按 JSON 数组还原（表格 → JSON 预览）', () => {
    expect(bodyRowsToJsonValue([row({ key: 'user.tags', value: '["hot", 1]', type: 'array' })])).toEqual({
      user: { tags: ['hot', 1] },
    });
  });

  it('往返：jsonValue → rows → jsonValue 保持一致；行缺省 required/enabled', () => {
    const value = { user: { id: 1, active: false }, tags: [1, 'a'], note: '', score: 3.5, missing: null };
    const rows = jsonValueToBodyRows(value);
    expect(rows.every((r) => r.required && r.enabled)).toBe(true);
    expect(bodyRowsToJsonValue(rows)).toEqual(value);
  });

  it('叶子类型推断：number / boolean / json(数组) / string', () => {
    expect(jsonValueToBodyRows({ a: 1, b: true, c: [1], d: 'x' })).toEqual([
      row({ key: 'a', value: '1', type: 'number' }),
      row({ key: 'b', value: 'true', type: 'boolean' }),
      row({ key: 'c', value: '[1]', type: 'json' }),
      row({ key: 'd', value: 'x' }),
    ]);
  });
});

describe('toJavaEntity', () => {
  it('基础类型映射：string/整数值 number/小数/boolean/null → String/Integer/Double/Boolean/Object', () => {
    const code = toJavaEntity('Demo', { str: 'a', int: 3, dbl: 3.5, flag: true, none: null });
    expect(code).toContain('private String str;');
    expect(code).toContain('private Integer int;');
    expect(code).toContain('private Double dbl;');
    expect(code).toContain('private Boolean flag;');
    expect(code).toContain('private Object none;');
  });

  it('嵌套对象生成静态内部类（PascalCase + Info 后缀）；数组取首元素推导 List，元素为对象时同样嵌套类', () => {
    const code = toJavaEntity('Order', { user: { id: 1 }, items: [{ id: 2 }], tags: ['a', 'b'] });
    expect(code).toContain('private UserInfo user;');
    expect(code).toContain('public static class UserInfo');
    expect(code).toContain('private java.util.List<ItemsInfo> items;');
    expect(code).toContain('public static class ItemsInfo');
    expect(code).toContain('private java.util.List<String> tags;');
  });

  it('空对象映射 Map；空数组映射 List<Object>；无字段生成空类', () => {
    const code = toJavaEntity('Meta', { meta: {}, empty: [] });
    expect(code).toContain('private java.util.Map<String, Object> meta;');
    expect(code).toContain('private java.util.List<Object> empty;');
    expect(toJavaEntity('Empty', {})).toContain('public class Empty {');
  });

  it('每个字段上方带示例值注释；ISO date-time 字符串提示可用 LocalDateTime', () => {
    const code = toJavaEntity('Note', { id: 1001, createdAt: '2026-08-30T10:00:00Z' });
    expect(code).toContain('/** 示例值: 1001 */');
    expect(code).toContain('LocalDateTime');
  });

  it('非法字符清理：类名 PascalCase 化，字段名非法字符转下划线（数字开头补前缀）', () => {
    const code = toJavaEntity('user-profile 2nd!', { 'first-name': 1, '2fa': true });
    expect(code).toContain('public class UserProfile2nd');
    expect(code).toContain('private Integer first_name;');
    expect(code).toContain('private Boolean _2fa;');
  });

  it('Lombok：顶部 import lombok.Data，类与嵌套类标注 @Data', () => {
    const code = toJavaEntity('Demo', { a: 1, sub: { b: 2 } });
    expect(code).toContain('import lombok.Data;');
    /* import 位于注解与类声明之前 */
    expect(code.indexOf('import lombok.Data;')).toBeLessThan(code.indexOf('@Data'));
    expect(code.indexOf('@Data')).toBeLessThan(code.indexOf('public class Demo'));
    expect(code).toContain('public static class SubInfo');
  });

  it('body 为 JSON 字符串时先解析；根值非对象时包装为 data 字段', () => {
    expect(toJavaEntity('Wrapped', '{"id":7}')).toContain('private Integer id;');
    expect(toJavaEntity('Scalar', [1, 2])).toContain('private java.util.List<Integer> data;');
  });
});

describe('parseSequenceDraft', () => {
  it('合法数组：对象 body JSON.stringify 为字符串，字符串 body 原样保留', () => {
    expect(parseSequenceDraft('[{"status":200,"body":{"a":1}},{"status":404,"body":"{\\"x\\":1}"}]')).toEqual({
      ok: true,
      value: [
        { status: 200, body: '{"a":1}' },
        { status: 404, body: '{"x":1}' },
      ],
    });
  });

  it('非法输入返回 ok:false：空文本 / 非法 JSON / 非数组 / 空数组 / 缺 status / status 越界 / 缺 body', () => {
    expect(parseSequenceDraft('   ').ok).toBe(false);
    expect(parseSequenceDraft('{bad').ok).toBe(false);
    expect(parseSequenceDraft('{"status":200}').ok).toBe(false);
    expect(parseSequenceDraft('[]').ok).toBe(false);
    expect(parseSequenceDraft('[{"body":"x"}]').ok).toBe(false);
    expect(parseSequenceDraft('[{"status":99,"body":"x"}]').ok).toBe(false);
    expect(parseSequenceDraft('[{"status":"200","body":"x"}]').ok).toBe(false);
    expect(parseSequenceDraft('[{"status":200}]').ok).toBe(false);
  });
});

describe('sequenceToDraftText', () => {
  it('回填：body 为 JSON 字符串时解析为对象展示，非 JSON 字符串原样；undefined 返回空数组文本', () => {
    const text = sequenceToDraftText([
      { status: 200, body: '{"a":1}' },
      { status: 404, body: 'plain text' },
      { status: 500, body: { ok: false } },
    ]);
    expect(JSON.parse(text)).toEqual([
      { status: 200, body: { a: 1 } },
      { status: 404, body: 'plain text' },
      { status: 500, body: { ok: false } },
    ]);
    expect(sequenceToDraftText(undefined)).toBe('[]');
  });
});

describe('isTemplateJsonValid', () => {
  it('合法 JSON 直接通过', () => {
    expect(isTemplateJsonValid('{"code": 0}')).toBe(true);
    expect(isTemplateJsonValid('')).toBe(true);
  });

  it('值位置占位符经容忍解析通过', () => {
    expect(isTemplateJsonValid('{"code": {{params.code}}}')).toBe(true);
  });

  it('字符串内占位符（本身已是合法 JSON）通过', () => {
    expect(isTemplateJsonValid('{"code": "{{params.code}}"}')).toBe(true);
  });

  it('结构破坏的文本不通过', () => {
    expect(isTemplateJsonValid('{"code": {{params.code')).toBe(false);
    expect(isTemplateJsonValid('not json')).toBe(false);
  });
});

describe('parseSequenceDraft / sequenceToDraftText 自定义响应头', () => {
  it('序列步骤可带 headers，提交与回填往返一致', () => {
    const draft = [
      { status: 200, body: { step: 1 }, headers: [{ key: ' X-Step ', value: 'first' }] },
      { status: 500, body: { step: 2 } },
    ];
    const parsed = parseSequenceDraft(JSON.stringify(draft));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value[0].headers).toEqual([{ key: 'X-Step', value: 'first' }]);
    expect(parsed.value[1].headers).toBeUndefined();
    expect(sequenceToDraftText(parsed.value)).toBe(
      JSON.stringify([{ status: 200, body: { step: 1 }, headers: [{ key: 'X-Step', value: 'first' }] }, { status: 500, body: { step: 2 } }], null, 2),
    );
  });

  it('headers 空数组省略、非数组与缺 key 报错', () => {
    const empty = parseSequenceDraft(JSON.stringify([{ status: 200, body: {}, headers: [] }]));
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value[0].headers).toBeUndefined();

    expect(parseSequenceDraft(JSON.stringify([{ status: 200, body: {}, headers: 'x' }])).ok).toBe(false);
    expect(parseSequenceDraft(JSON.stringify([{ status: 200, body: {}, headers: [{ key: '  ', value: 'x' }] }])).ok).toBe(false);
    expect(parseSequenceDraft(JSON.stringify([{ status: 200, body: {}, headers: [{ key: 'A' }] }])).ok).toBe(false);
  });
});

describe('clampDrawerWidth / 抽屉宽度持久化', () => {
  it('钳制到 [560, 视口×0.94]，四舍五入取整', () => {
    expect(clampDrawerWidth(400, 1920)).toBe(560);
    expect(clampDrawerWidth(1000, 1920)).toBe(1000);
    expect(clampDrawerWidth(9999, 1920)).toBe(Math.floor(1920 * 0.94));
    expect(clampDrawerWidth(600.4, 1920)).toBe(600);
  });

  it('视口极窄时上限不小于最小宽度', () => {
    expect(clampDrawerWidth(800, 500)).toBe(560);
    expect(clampDrawerWidth(300, 500)).toBe(560);
  });

  it('load/save/clear 读写 localStorage；无记录与非法值返回 null，超宽值按视口钳制', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    try {
      expect(loadDrawerWidth(1920)).toBeNull();
      saveDrawerWidth(1000);
      expect(loadDrawerWidth(1920)).toBe(1000);
      saveDrawerWidth(99999);
      expect(loadDrawerWidth(1920)).toBe(Math.floor(1920 * 0.94));
      saveDrawerWidth(-5);
      expect(loadDrawerWidth(1920)).toBeNull();
      saveDrawerWidth(900);
      clearDrawerWidth();
      expect(loadDrawerWidth(1920)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('localStorage 不可用时 load 返回 null，save/clear 静默不抛错', () => {
    vi.stubGlobal('localStorage', undefined);
    try {
      expect(loadDrawerWidth(1920)).toBeNull();
      expect(() => saveDrawerWidth(800)).not.toThrow();
      expect(() => clearDrawerWidth()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/* ---------- 有状态 CRUD：集合键 / 分组 / 配套路由 ---------- */

/** 快捷构造 Route（分组/配套路由测试用） */
function routeOf(overrides: Partial<Route> & Pick<Route, 'id' | 'serviceId' | 'method' | 'path'>): Route {
  return { protocol: 'http', response: { status: 200, body: {} }, createdAt: 0, ...overrides };
}

describe('有状态 CRUD 工具', () => {
  it('crudCollectionKey 去掉参数段得到集合键（与后端分库规则一致）', () => {
    expect(crudCollectionKey('/api/todos')).toBe('api/todos');
    expect(crudCollectionKey('/api/todos/:id')).toBe('api/todos');
    expect(crudCollectionKey('/api/todos/:todoId/comments/:cid')).toBe('api/todos/comments');
    expect(crudCollectionKey('/')).toBe('');
  });

  it('groupCrudRoutes 按服务+集合键聚类，仅收 crud 路由，组内保持顺序', () => {
    const routes = [
      routeOf({ id: '1', serviceId: 'svc-a', method: 'GET', path: '/api/todos', crud: true }),
      routeOf({ id: '2', serviceId: 'svc-a', method: 'GET', path: '/api/plain', name: '普通接口' }),
      routeOf({ id: '3', serviceId: 'svc-a', method: 'POST', path: '/api/todos', crud: true }),
      routeOf({ id: '4', serviceId: 'svc-a', method: 'GET', path: '/api/todos/:id', crud: true }),
      routeOf({ id: '5', serviceId: 'svc-b', method: 'GET', path: '/api/todos', crud: true }),
      routeOf({ id: '6', serviceId: 'svc-a', method: 'GET', path: '/api/archived', crud: true }),
    ];
    const groups = groupCrudRoutes(routes);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ serviceId: 'svc-a', collection: 'api/todos' });
    expect(groups[0].routes.map((r) => r.id)).toEqual(['1', '3', '4']);
    expect(groups[1]).toMatchObject({ serviceId: 'svc-b', collection: 'api/todos' });
    expect(groups[2]).toMatchObject({ serviceId: 'svc-a', collection: 'api/archived' });
  });

  it('buildCompanionRoutes 推导配套路由并排除主路由自身，名称追加标签', () => {
    const companions = buildCompanionRoutes('/api/todos', 'GET', '待办');
    expect(companions).toEqual([
      { method: 'POST', path: '/api/todos', name: '待办·创建', label: '创建' },
      { method: 'GET', path: '/api/todos/:id', name: '待办·详情', label: '详情' },
      { method: 'PUT', path: '/api/todos/:id', name: '待办·更新', label: '更新' },
      { method: 'DELETE', path: '/api/todos/:id', name: '待办·删除', label: '删除' },
    ]);

    /* 主路由是条目路径时：排除条目详情，补集合列表/创建 */
    const itemMains = buildCompanionRoutes('/api/todos/:id', 'GET', '待办');
    expect(itemMains.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/todos',
      'POST /api/todos',
      'PUT /api/todos/:id',
      'DELETE /api/todos/:id',
    ]);

    /* 空名称回落 CRUD 前缀 */
    expect(buildCompanionRoutes('/api/x', 'GET', '')[0].name).toBe('CRUD·创建');
  });
});

describe('proxyTargetLabel 代理目标展示简称', () => {
  it('提取 host:port，省略协议与路径', () => {
    expect(proxyTargetLabel('http://localhost:3000')).toBe('localhost:3000');
    expect(proxyTargetLabel('https://api.example.com/v1/x')).toBe('api.example.com');
    expect(proxyTargetLabel('http://127.0.0.1')).toBe('127.0.0.1');
  });

  it('非法 URL 原样返回，超长截断', () => {
    expect(proxyTargetLabel('not-a-url')).toBe('not-a-url');
    expect(proxyTargetLabel('averylongunparseabletargetvalue')).toBe('averylongunparseabletarg…');
  });
});

describe('isJsonContentType JSON 类 Content-Type 判定', () => {
  it('未声明按 JSON；JSON 类与 *+json 后缀命中（忽略参数与大小写）', () => {
    expect(isJsonContentType(undefined)).toBe(true);
    expect(isJsonContentType('')).toBe(true);
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true);
    expect(isJsonContentType('application/vnd.api+json')).toBe(true);
    expect(isJsonContentType('text/json')).toBe(true);
  });

  it('非 JSON 类型返回 false', () => {
    expect(isJsonContentType('text/html')).toBe(false);
    expect(isJsonContentType('text/plain; charset=gbk')).toBe(false);
    expect(isJsonContentType('application/xml')).toBe(false);
    expect(isJsonContentType('application/octet-stream')).toBe(false);
  });
});

describe('responseContentTypeLabel 响应生效 Content-Type 标签', () => {
  const route = (headers?: Array<{ key: string; value: string }>, contentType?: string) => ({ contentType, headers });

  it('自定义头 Content-Type 优先于 contentType 字段', () => {
    expect(responseContentTypeLabel(route([{ key: 'Content-Type', value: 'text/html' }], 'application/json'))).toBe('text/html');
    expect(responseContentTypeLabel(route([{ key: 'content-type', value: ' text/plain ' }]))).toBe('text/plain');
    expect(responseContentTypeLabel(route([{ key: 'X-Other', value: 'x' }], 'application/xml'))).toBe('application/xml');
  });

  it('均未设置显示缺省 application/json', () => {
    expect(responseContentTypeLabel(route())).toBe('application/json');
    expect(responseContentTypeLabel(route([], ''))).toBe('application/json');
  });
});
