import { describe, expect, it, vi } from 'vitest';
import {
  buildCurl,
  clampDrawerWidth,
  clearDrawerWidth,
  isTemplateJsonValid,
  buildFetchSnippet,
  bodyRowsToJsonValue,
  buildRouteRequest,
  jsonValueToBodyRows,
  loadDrawerWidth,
  parseSequenceDraft,
  saveDrawerWidth,
  sequenceToDraftText,
  serviceDisplaySuffix,
  splitRouteRequest,
  toJavaEntity,
} from './utils';
import type { ConditionRow } from './types';

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
