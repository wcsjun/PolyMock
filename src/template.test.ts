import { describe, expect, it } from 'vitest';
import { renderTemplate, type TemplateContext } from './template.js';

function makeContext(overrides: Partial<TemplateContext> = {}): TemplateContext {
  let id = 0;
  return {
    query: {},
    headers: {},
    body: undefined,
    routeId: 'route-1',
    nextId: () => ++id,
    ...overrides,
  };
}

describe('renderTemplate', () => {
  it('query 占位符替换为查询参数值', () => {
    const ctx = makeContext({ query: { token: 'abc123' } });
    expect(renderTemplate({ token: '{{query.token}}', fixed: 'x' }, ctx)).toEqual({ token: 'abc123', fixed: 'x' });
  });

  it('header 占位符大小写不敏感（保留原始键名）', () => {
    const ctx = makeContext({ headers: { 'X-Token': 'secret', 'content-type': 'application/json' } });
    expect(renderTemplate({ a: '{{header.x-token}}', b: '{{header.CONTENT-TYPE}}' }, ctx)).toEqual({
      a: 'secret',
      b: 'application/json',
    });
  });

  it('body 点路径取值：嵌套对象、数组下标、对象叶子 JSON 序列化', () => {
    const ctx = makeContext({ body: { user: { id: 1, tags: ['a', 'b'] } } });
    expect(
      renderTemplate({ uid: '{{body.user.id}}', first: '{{body.user.tags.0}}', whole: '{{body.user}}' }, ctx),
    ).toEqual({ uid: '1', first: 'a', whole: '{"id":1,"tags":["a","b"]}' });
  });

  it('$id 调用 nextId 递增，多次渲染共享同一计数器', () => {
    const ctx = makeContext();
    expect(renderTemplate({ a: '{{$id}}', b: '{{$id}}' }, ctx)).toEqual({ a: '1', b: '2' });
    expect(renderTemplate(['{{$id}}'], ctx)).toEqual(['3']);
  });

  it('$now 返回可解析的 ISO 时间字符串', () => {
    const before = Date.now() - 1000;
    const result = renderTemplate({ ts: '{{$now}}' }, makeContext());
    const value = (result as { ts: string }).ts;
    expect(typeof value).toBe('string');
    expect(Date.parse(value)).not.toBeNaN();
    expect(Date.parse(value)).toBeGreaterThanOrEqual(before);
  });

  it('$int 返回闭区间内的随机整数', () => {
    const ctx = makeContext();
    for (let i = 0; i < 50; i += 1) {
      const result = renderTemplate({ n: '{{$int(3,7)}}' }, ctx) as { n: string };
      const value = Number(result.n);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
    }
    expect(renderTemplate({ n: '{{$int(5,5)}}' }, makeContext())).toEqual({ n: '5' });
  });

  it('嵌套对象与数组内的占位符均被替换，非字符串叶子原样保留', () => {
    const ctx = makeContext({ query: { a: 'A', b: 'B' } });
    const template = {
      list: ['{{query.a}}', { deep: '{{query.b}}' }],
      count: 42,
      enabled: true,
      empty: null,
      missing: undefined,
    };
    const rendered = renderTemplate(template, ctx) as Record<string, unknown>;
    expect(rendered.list).toEqual(['A', { deep: 'B' }]);
    expect(rendered.count).toBe(42);
    expect(rendered.enabled).toBe(true);
    expect(rendered.empty).toBeNull();
    expect(rendered.missing).toBeUndefined();
  });

  it('同一字符串内可混合多个占位符与普通文本', () => {
    const ctx = makeContext({ query: { token: 'tk' }, headers: { 'X-Lang': 'zh' } });
    expect(renderTemplate({ auth: 'Bearer {{query.token}} ({{header.x-lang}})' }, ctx)).toEqual({
      auth: 'Bearer tk (zh)',
    });
  });

  it('取不到值或语法不识别时占位符原样保留', () => {
    const ctx = makeContext({ query: {}, headers: {}, body: {} });
    const template = {
      unknown: '{{unknown}}',
      missingQuery: '{{query.nope}}',
      missingHeader: '{{header.nope}}',
      missingBody: '{{body.a.b}}',
      badInt: '{{$int(a,b)}}',
      keepWhitespace: '{{ unknown }}',
    };
    expect(renderTemplate(template, ctx)).toEqual(template);
  });

  it('不突变入参对象', () => {
    const ctx = makeContext({ query: { a: 'A' } });
    const template = { s: '{{query.a}}', nested: { arr: ['{{query.a}}', 1] } };
    const snapshot = JSON.parse(JSON.stringify(template));
    renderTemplate(template, ctx);
    expect(template).toEqual(snapshot);
  });
});
