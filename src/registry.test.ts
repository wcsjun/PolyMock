import { describe, expect, it } from 'vitest';
import { RouteRegistry } from './registry.js';

const baseResponse = { status: 200, body: { ok: true } };

describe('RouteRegistry', () => {
  it('新增接口后可查找', () => {
    const registry = new RouteRegistry();
    registry.add('GET', '/api/hello', baseResponse);
    expect(registry.find('get', '/api/hello')).toBeDefined();
    expect(registry.find('GET', '/api/hello')?.method).toBe('GET');
  });

  it('方法名大小写不敏感，path 区分', () => {
    const registry = new RouteRegistry();
    registry.add('POST', '/api/a', baseResponse);
    expect(registry.find('post', '/api/a')).toBeDefined();
    expect(registry.find('GET', '/api/a')).toBeUndefined();
    expect(registry.find('POST', '/api/b')).toBeUndefined();
  });

  it('相同 method + path 覆盖注册', () => {
    const registry = new RouteRegistry();
    registry.add('GET', '/api/hello', baseResponse);
    registry.add('GET', '/api/hello', { status: 500, body: null });
    expect(registry.list()).toHaveLength(1);
    expect(registry.find('GET', '/api/hello')?.response.status).toBe(500);
  });

  it('删除接口', () => {
    const registry = new RouteRegistry();
    registry.add('GET', '/api/hello', baseResponse);
    expect(registry.remove('GET', '/api/hello')).toBe(true);
    expect(registry.remove('GET', '/api/hello')).toBe(false);
    expect(registry.list()).toHaveLength(0);
  });

  it('列表按注册顺序返回', () => {
    const registry = new RouteRegistry();
    registry.add('GET', '/api/1', baseResponse);
    registry.add('GET', '/api/2', baseResponse);
    expect(registry.list().map((r) => r.path)).toEqual(['/api/1', '/api/2']);
  });
});
