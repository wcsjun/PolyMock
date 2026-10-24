import { describe, expect, it } from 'vitest';
import { isJsonContentType, parseResponseBody, parseRouteRequest, parseWsBehavior } from './route-validation.js';

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
