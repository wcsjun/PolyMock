import { describe, expect, it } from 'vitest';
import { isJsonContentType, parseCallbackTemplateInput, parseResponseBody, parseRouteCallback, parseRouteRequest, parseWsBehavior } from './route-validation.js';

/* 校验层原先只能经 admin API 集成测试间接覆盖；拆分后可直接单测（parseWsBehavior 边界 + parseResponseBody 模板容忍优先） */

describe('parseResponseBody', () => {
  it('JSON 模式：字符串按 JSON 解析，非字符串透传', () => {
    expect(parseResponseBody('{"a":1}', 'response', true)).toEqual({ ok: true, value: { a: 1 } });
    expect(parseResponseBody({ a: 1 }, 'response', true)).toEqual({ ok: true, value: { a: 1 } });
  });

  it('JSON 模式：含模板占位符的文本容忍通过（占位符替换为 null 后合法）', () => {
    expect(parseResponseBody('{"code": {{params.code}}}', 'response', true)).toEqual({ ok: true, value: '{"code": {{params.code}}}' });
  });

  it('JSON 模式：结构破坏的占位符文本仍报错', () => {
    expect(parseResponseBody('{"code": {{params.code', 'response', true).ok).toBe(false);
    expect(parseResponseBody('not json', 'response', true).ok).toBe(false);
  });

  it('文本模式：要求字符串，非法输入报错', () => {
    expect(parseResponseBody('plain text', 'response', false)).toEqual({ ok: true, value: 'plain text' });
    expect(parseResponseBody({ a: 1 }, 'response', false).ok).toBe(false);
  });
});

describe('parseWsBehavior', () => {
  it('未提供 / 空配置归一为 undefined；非对象报错', () => {
    expect(parseWsBehavior(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseWsBehavior(null)).toEqual({ ok: true, value: undefined });
    expect(parseWsBehavior({})).toEqual({ ok: true, value: undefined });
    expect(parseWsBehavior('oops').ok).toBe(false);
  });

  it('onOpen 消息：body 必填，delayMs>0 保留、0 与缺省不写入', () => {
    const parsed = parseWsBehavior({ onOpen: [{ body: 'hi' }, { delayMs: 800, body: { a: 1 } }] });
    expect(parsed).toEqual({
      ok: true,
      value: { onOpen: [{ body: 'hi' }, { delayMs: 800, body: { a: 1 } }] },
    });
    expect(parseWsBehavior({ onOpen: [{ delayMs: -1, body: 'x' }] }).ok).toBe(false);
    expect(parseWsBehavior({ onOpen: [{ delayMs: 0, body: 'x' }] })).toEqual({ ok: true, value: { onOpen: [{ body: 'x' }] } });
    expect(parseWsBehavior({ onOpen: [{}] }).ok).toBe(false);
  });

  it('loopOnOpen 必须与非空 onOpen 配合；非布尔报错', () => {
    expect(parseWsBehavior({ onOpen: [{ body: 'hi' }], loopOnOpen: true })).toEqual({
      ok: true,
      value: { onOpen: [{ body: 'hi' }], loopOnOpen: true },
    });
    expect(parseWsBehavior({ loopOnOpen: true }).ok).toBe(false);
    expect(parseWsBehavior({ onOpen: [], loopOnOpen: true }).ok).toBe(false);
    expect(parseWsBehavior({ loopOnOpen: 'yes' }).ok).toBe(false);
  });

  it('onMessage：fixed / sequence 需非空 replies；echo / none 拒收 replies', () => {
    expect(parseWsBehavior({ onMessage: { mode: 'fixed', replies: ['a'] } })).toEqual({
      ok: true,
      value: { onMessage: { mode: 'fixed', replies: ['a'] } },
    });
    expect(parseWsBehavior({ onMessage: { mode: 'sequence', replies: [] } }).ok).toBe(false);
    expect(parseWsBehavior({ onMessage: { mode: 'echo', replies: ['a'] } }).ok).toBe(false);
    expect(parseWsBehavior({ onMessage: { mode: 'none' } })).toEqual({ ok: true, value: { onMessage: { mode: 'none' } } });
    expect(parseWsBehavior({ onMessage: { mode: 'oops' } }).ok).toBe(false);
  });

  it('interval：everyMs 需为 100-60000 整数且 body 必填', () => {
    expect(parseWsBehavior({ interval: { everyMs: 5000, body: 'tick' } })).toEqual({
      ok: true,
      value: { interval: { everyMs: 5000, body: 'tick' } },
    });
    expect(parseWsBehavior({ interval: { everyMs: 99, body: 'x' } }).ok).toBe(false);
    expect(parseWsBehavior({ interval: { everyMs: 60001, body: 'x' } }).ok).toBe(false);
    expect(parseWsBehavior({ interval: { everyMs: 1000 } }).ok).toBe(false);
  });
});

describe('parseRouteRequest / isJsonContentType（搬移后共用符号抽测）', () => {
  it('parseRouteRequest：deepEqual 需合法 JSON bodyRaw，textEqual 需非空原文', () => {
    expect(parseRouteRequest({ bodyMatch: 'deepEqual', bodyRaw: '{"a":1}' })).toEqual({
      ok: true,
      value: { bodyMatch: 'deepEqual', bodyRaw: '{"a":1}' },
    });
    expect(parseRouteRequest({ bodyMatch: 'deepEqual', bodyRaw: '{bad' }).ok).toBe(false);
    expect(parseRouteRequest({ bodyMatch: 'textEqual', bodyRaw: '   ' }).ok).toBe(false);
    expect(parseRouteRequest({ bodyMatch: 'subset', bodyRaw: '{"a":1}' })).toEqual({ ok: true, value: {} });
  });

  it('isJsonContentType：未声明按 JSON，*+json 后缀命中，忽略参数与大小写', () => {
    expect(isJsonContentType(undefined)).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('application/vnd.api+json')).toBe(true);
    expect(isJsonContentType('text/html')).toBe(false);
  });
});

describe('parseRouteCallback（双模式）', () => {
  it('未配置 / null 归一为 undefined', () => {
    expect(parseRouteCallback(undefined, 'response.callback')).toEqual({ ok: true, value: undefined });
    expect(parseRouteCallback(null, 'response.callback')).toEqual({ ok: true, value: undefined });
  });

  it('引用模式：template 必填 + 可选 bodyOverride；多余字段拒收', () => {
    expect(parseRouteCallback({ template: ' tpl-1 ' }, 'cb')).toEqual({ ok: true, value: { template: 'tpl-1' } });
    expect(parseRouteCallback({ template: 't', bodyOverride: '{"a":1}' }, 'cb')).toEqual({
      ok: true,
      value: { template: 't', bodyOverride: '{"a":1}' },
    });
    expect(parseRouteCallback({ template: '' }, 'cb')).toEqual({ ok: false, error: 'cb 的 template 需为非空字符串' });
    expect(parseRouteCallback({ template: 't', url: 'http://x' }, 'cb').ok).toBe(false);
    expect(parseRouteCallback({ template: 't', bodyOverride: 3 }, 'cb').ok).toBe(false);
  });

  it('内联模式：url 必填 http(s)，method 白名单（大小写归一）', () => {
    const parsed = parseRouteCallback({ url: 'http://127.0.0.1:9/n', method: 'get', delayMs: 100 }, 'cb');
    expect(parsed).toEqual({ ok: true, value: { url: 'http://127.0.0.1:9/n', method: 'GET', delayMs: 100 } });
    expect(parseRouteCallback({}, 'cb').ok).toBe(false);
    expect(parseRouteCallback({ url: 'ftp://x' }, 'cb').ok).toBe(false);
    expect(parseRouteCallback({ url: 'http://x', method: 'OPTIONS' }, 'cb').ok).toBe(false);
  });

  it('内联模式：延迟 / 抖动范围与字段类型校验', () => {
    expect(parseRouteCallback({ url: 'http://x', delayMs: 60001 }, 'cb').ok).toBe(false);
    expect(parseRouteCallback({ url: 'http://x', jitterMs: -1 }, 'cb').ok).toBe(false);
    expect(parseRouteCallback({ url: 'http://x', body: 123 }, 'cb').ok).toBe(false);
    expect(parseRouteCallback({ url: 'http://x', contentType: '' }, 'cb').ok).toBe(false);
    expect(parseRouteCallback({ url: 'http://x', headers: [{ key: 'A', value: 'b' }] }, 'cb').ok).toBe(true);
  });
});

describe('parseCallbackTemplateInput', () => {
  it('合法输入归一（name trim / method 大写 / 可选字段缺省不出现在结果中）', () => {
    const parsed = parseCallbackTemplateInput({ name: ' 支付通知 ', url: 'http://127.0.0.1:9/n', method: 'post', delayMs: 2000 });
    expect(parsed.ok).toBe(true);
    expect(parsed).toEqual({
      ok: true,
      value: { name: '支付通知', url: 'http://127.0.0.1:9/n', method: 'POST', delayMs: 2000 },
    });
  });

  it('name / url 必填，非法值拒收', () => {
    expect(parseCallbackTemplateInput({ url: 'http://x' }).ok).toBe(false);
    expect(parseCallbackTemplateInput({ name: 'x' }).ok).toBe(false);
    expect(parseCallbackTemplateInput({ name: 'x', url: 'notaurl' }).ok).toBe(false);
    expect(parseCallbackTemplateInput({ name: 'x', url: 'http://x', jitterMs: 30001 }).ok).toBe(false);
    expect(parseCallbackTemplateInput('str').ok).toBe(false);
  });
});
