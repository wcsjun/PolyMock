import { describe, expect, it } from 'vitest';
import { RouteRegistry } from './registry.js';

const baseResponse = { status: 200, body: { ok: true } };
const SVC = 'default';

describe('RouteRegistry', () => {
  it('新增接口后可查找', () => {
    const registry = new RouteRegistry();
    registry.add(SVC, 'GET', '/api/hello', baseResponse);
    expect(registry.find(SVC, 'get', '/api/hello')).toBeDefined();
    expect(registry.find(SVC, 'GET', '/api/hello')?.method).toBe('GET');
  });

  it('方法名大小写不敏感，path 区分', () => {
    const registry = new RouteRegistry();
    registry.add(SVC, 'POST', '/api/a', baseResponse);
    expect(registry.find(SVC, 'post', '/api/a')).toBeDefined();
    expect(registry.find(SVC, 'GET', '/api/a')).toBeUndefined();
    expect(registry.find(SVC, 'POST', '/api/b')).toBeUndefined();
  });

  it('相同 method + path 覆盖注册', () => {
    const registry = new RouteRegistry();
    registry.add(SVC, 'GET', '/api/hello', baseResponse);
    registry.add(SVC, 'GET', '/api/hello', { status: 500, body: null });
    expect(registry.list()).toHaveLength(1);
    expect(registry.find(SVC, 'GET', '/api/hello')?.response.status).toBe(500);
  });

  it('删除接口', () => {
    const registry = new RouteRegistry();
    registry.add(SVC, 'GET', '/api/hello', baseResponse);
    expect(registry.remove(SVC, 'GET', '/api/hello')).toBe(true);
    expect(registry.remove(SVC, 'GET', '/api/hello')).toBe(false);
    expect(registry.list()).toHaveLength(0);
  });

  it('列表按注册顺序返回', () => {
    const registry = new RouteRegistry();
    registry.add(SVC, 'GET', '/api/1', baseResponse);
    registry.add(SVC, 'GET', '/api/2', baseResponse);
    expect(registry.list().map((r) => r.path)).toEqual(['/api/1', '/api/2']);
  });

  it('不同服务下相同 method + path 互不冲突', () => {
    const registry = new RouteRegistry();
    registry.addService('用户服务', 9001, 'user');
    registry.addService('订单服务', 9002, 'order');
    registry.add('user', 'GET', '/api/order', baseResponse);
    registry.add('order', 'GET', '/api/order', { status: 500, body: null });
    expect(registry.list()).toHaveLength(2);
    expect(registry.find('user', 'GET', '/api/order')?.response.status).toBe(200);
    expect(registry.find('order', 'GET', '/api/order')?.response.status).toBe(500);
  });

  it('list 可按服务过滤', () => {
    const registry = new RouteRegistry();
    registry.addService('用户服务', 9001, 'user');
    registry.add(SVC, 'GET', '/api/a', baseResponse);
    registry.add('user', 'GET', '/api/b', baseResponse);
    expect(registry.list(SVC).map((r) => r.path)).toEqual(['/api/a']);
    expect(registry.list('user').map((r) => r.path)).toEqual(['/api/b']);
  });

  it('删除服务时移除其下接口', () => {
    const registry = new RouteRegistry();
    registry.addService('用户服务', 9001, 'user');
    registry.add('user', 'GET', '/api/b', baseResponse);
    expect(registry.removeService('user')).toBe(true);
    expect(registry.list()).toHaveLength(0);
    expect(registry.find('user', 'GET', '/api/b')).toBeUndefined();
  });

  it('toJSON 后可完整还原（持久化）', () => {
    const registry = new RouteRegistry();
    registry.addService('用户服务', 9001, 'user');
    registry.add('user', 'GET', '/api/x', baseResponse);
    registry.add(SVC, 'GET', '/api/y', { status: 201, body: 'ok' });

    const restored = new RouteRegistry(registry.toJSON());
    expect(restored.listServices()).toHaveLength(1);
    expect(restored.list()).toHaveLength(2);
    expect(restored.find('user', 'GET', '/api/x')?.response.body).toEqual({ ok: true });
    expect(restored.find(SVC, 'GET', '/api/y')?.response.status).toBe(201);
  });

  it('更新响应内容与 path', () => {
    const registry = new RouteRegistry();
    const route = registry.add(SVC, 'GET', '/api/hello', baseResponse);
    const result = registry.update(route.id, { path: '/api/bye', response: { status: 500, body: 'err' } });
    expect(result.ok && result.route.path).toBe('/api/bye');
    expect(registry.find(SVC, 'GET', '/api/hello')).toBeUndefined();
    expect(registry.find(SVC, 'GET', '/api/bye')?.response.status).toBe(500);
    expect(registry.list()).toHaveLength(1);
  });

  it('更新时可移动服务分组，id 与 createdAt 保持不变', () => {
    const registry = new RouteRegistry();
    registry.addService('用户服务', 9001, 'user');
    const route = registry.add(SVC, 'GET', '/api/x', baseResponse);
    const result = registry.update(route.id, { serviceId: 'user', method: 'post' });
    expect(result.ok && result.route.serviceId).toBe('user');
    expect(result.ok && result.route.method).toBe('POST');
    expect(result.ok && result.route.id).toBe(route.id);
    expect(result.ok && result.route.createdAt).toBe(route.createdAt);
    expect(registry.find('user', 'POST', '/api/x')).toBeDefined();
    expect(registry.find(SVC, 'GET', '/api/x')).toBeUndefined();
  });

  it('更新与已有接口冲突时返回 conflict', () => {
    const registry = new RouteRegistry();
    const a = registry.add(SVC, 'GET', '/api/a', baseResponse);
    registry.add(SVC, 'GET', '/api/b', { status: 200, body: 'b' });
    const result = registry.update(a.id, { path: '/api/b' });
    expect(result).toEqual({ ok: false, error: 'conflict', conflict: expect.objectContaining({ path: '/api/b' }) });
  });

  it('更新不存在的接口返回 not-found', () => {
    const registry = new RouteRegistry();
    const result = registry.update('nope', { path: '/api/x' });
    expect(result).toEqual({ ok: false, error: 'not-found' });
  });

  it('新增接口可携带名称，名称可更新', () => {
    const registry = new RouteRegistry();
    const route = registry.add(SVC, 'GET', '/api/name', baseResponse, '查询用户');
    expect(route.name).toBe('查询用户');
    expect(registry.find(SVC, 'GET', '/api/name')?.name).toBe('查询用户');

    const result = registry.update(route.id, { name: '查询用户v2' });
    expect(result.ok && result.route.name).toBe('查询用户v2');

    const kept = registry.update(route.id, { path: '/api/name2' });
    expect(kept.ok && kept.route.name).toBe('查询用户v2');
  });
});