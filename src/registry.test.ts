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

  it('请求条件与校验开关可持久化往返', () => {
    const registry = new RouteRegistry();
    const request = { headers: [{ key: 'X-Token', value: 'abc' }], query: [{ key: 'id', value: '1' }], body: [{ key: 'user.id', value: '1' }] };
    const route = registry.add(SVC, 'GET', '/api/guard', baseResponse, undefined, request, true);

    expect(route.requireMatch).toBe(true);
    const restored = new RouteRegistry(registry.toJSON());
    const back = restored.find(SVC, 'GET', '/api/guard');
    expect(back?.requireMatch).toBe(true);
    expect(back?.request).toEqual(request);

    const cleared = restored.update(back!.id, { request: {}, requireMatch: false });
    expect(cleared.ok && cleared.route.request).toEqual({});
    expect(cleared.ok && cleared.route.requireMatch).toBe(false);
  });

  it('响应变体可持久化往返且 id 保持稳定', () => {
    const registry = new RouteRegistry();
    const variants = [
      { id: 'v-1', name: '管理员', match: { headers: [{ key: 'X-Role', value: 'admin' }] }, response: { status: 200, body: { role: 'admin' } } },
      { id: 'v-2', name: '游客', response: { status: 403, body: { role: 'guest' } } },
    ];
    const route = registry.add(SVC, 'GET', '/api/variant', baseResponse, undefined, undefined, false, variants);

    const restored = new RouteRegistry(registry.toJSON());
    const back = restored.find(SVC, 'GET', '/api/variant');
    expect(back?.variants).toHaveLength(2);
    expect(back?.variants?.[0].id).toBe('v-1');
    expect(back?.variants?.[0].match?.headers?.[0]).toEqual({ key: 'X-Role', value: 'admin' });
    expect(back?.variants?.[1].response.status).toBe(403);

    const replaced = restored.update(route.id, { variants: [variants[1]] });
    expect(replaced.ok && replaced.route.variants).toEqual([variants[1]]);
  });

  it('find 跳过禁用路由，findAny 不过滤', () => {
    const registry = new RouteRegistry();
    const route = registry.add(SVC, 'GET', '/api/off', baseResponse);
    expect(registry.update(route.id, { disabled: true }).ok).toBe(true);

    expect(registry.find(SVC, 'GET', '/api/off')).toBeUndefined();
    expect(registry.findAny(SVC, 'GET', '/api/off')).toBeDefined();
    expect(registry.findAny(SVC, 'GET', '/api/off')?.disabled).toBe(true);

    registry.update(route.id, { disabled: false });
    expect(registry.find(SVC, 'GET', '/api/off')).toBeDefined();
  });

  it('update 支持延迟 / 抖动 / 故障注入等行为字段并持久化往返', () => {
    const registry = new RouteRegistry();
    const route = registry.add(SVC, 'GET', '/api/behavior', baseResponse, undefined, undefined, false, undefined, {
      delayMs: 100,
      jitterMs: 50,
      failureRate: 25,
    });
    expect(route.delayMs).toBe(100);
    expect(route.jitterMs).toBe(50);
    expect(route.failureRate).toBe(25);

    const updated = registry.update(route.id, { failureRate: 0, disabled: true });
    expect(updated.ok && updated.route.failureRate).toBe(0);
    expect(updated.ok && updated.route.disabled).toBe(true);
    expect(updated.ok && updated.route.delayMs).toBe(100);

    const restored = new RouteRegistry(registry.toJSON());
    const back = restored.findAny(SVC, 'GET', '/api/behavior');
    expect(back?.disabled).toBe(true);
    expect(back?.delayMs).toBe(100);
    expect(back?.jitterMs).toBe(50);
    expect(back?.failureRate).toBe(0);
  });

  it('updateService 可合并名称与代理目标，toJSON 携带 proxyTarget', () => {
    const registry = new RouteRegistry();
    registry.addService('用户服务', 9001, 'user');
    expect(registry.updateService('nope', { name: '不存在' })).toBe(false);

    expect(registry.updateService('user', { proxyTarget: 'http://localhost:3000' })).toBe(true);
    expect(registry.getService('user')?.proxyTarget).toBe('http://localhost:3000');
    expect(registry.toJSON().services.find((s) => s.id === 'user')?.proxyTarget).toBe('http://localhost:3000');

    expect(registry.updateService('user', { name: '改名服务', proxyTarget: undefined })).toBe(true);
    expect(registry.getService('user')?.name).toBe('改名服务');
    expect(registry.getService('user')?.proxyTarget).toBeUndefined();
    expect(registry.toJSON().services.find((s) => s.id === 'user')?.proxyTarget).toBeUndefined();
  });

  it('settings 可设置、触发 change、持久化并从构造还原', () => {
    const registry = new RouteRegistry();
    expect(registry.getSettings()).toEqual({});

    let changed = 0;
    registry.on('change', () => {
      changed += 1;
    });
    registry.setSettings({ activeVariant: '异常场景' });
    expect(registry.getSettings().activeVariant).toBe('异常场景');
    expect(changed).toBe(1);

    const restored = new RouteRegistry(registry.toJSON());
    expect(restored.getSettings()).toEqual({ activeVariant: '异常场景' });

    restored.setSettings({ activeVariant: null });
    expect(restored.getSettings().activeVariant).toBeNull();
    expect(new RouteRegistry(restored.toJSON()).getSettings()).toEqual({ activeVariant: null });
  });
});
describe('路径参数匹配与形状冲突', () => {
  it('findWithParams 按段匹配提取参数，find 返回对应路由', () => {
    const registry = new RouteRegistry();
    registry.add('default', 'GET', '/api/users/:id', { status: 200, body: { id: '{{params.id}}' } });
    const found = registry.findWithParams('default', 'GET', '/api/users/42');
    expect(found?.route.path).toBe('/api/users/:id');
    expect(found?.params).toEqual({ id: '42' });
    expect(registry.find('default', 'GET', '/api/users/42')?.path).toBe('/api/users/:id');
  });

  it('精确路由优先于模式路由；段数或字面量不一致不命中', () => {
    const registry = new RouteRegistry();
    registry.add('default', 'GET', '/api/users/:id', { status: 200, body: 'pattern' });
    registry.add('default', 'GET', '/api/users/42', { status: 200, body: 'exact' });
    expect(registry.find('default', 'GET', '/api/users/42')?.path).toBe('/api/users/42');
    expect(registry.find('default', 'GET', '/api/users/43')?.path).toBe('/api/users/:id');
    expect(registry.find('default', 'GET', '/api/users/42/extra')).toBeUndefined();
    expect(registry.find('default', 'GET', '/api/orders/42')).toBeUndefined();
  });

  it('禁用的模式路由不参与匹配', () => {
    const registry = new RouteRegistry();
    const route = registry.add('default', 'GET', '/api/users/:id', { status: 200, body: '' });
    registry.update(route.id, { disabled: true });
    expect(registry.findWithParams('default', 'GET', '/api/users/1')).toBeUndefined();
  });

  it('findShapeConflict 检测形状冲突（参数归一化），excludeId 排除自身', () => {
    const registry = new RouteRegistry();
    const pattern = registry.add('default', 'GET', '/api/users/:id', { status: 200, body: '' });
    expect(registry.findShapeConflict('default', 'GET', '/api/users/42')?.id).toBe(pattern.id);
    expect(registry.findShapeConflict('default', 'GET', '/api/users/42', pattern.id)).toBeUndefined();
    expect(registry.findShapeConflict('default', 'GET', '/api/users/42/posts')).toBeUndefined();
  });

  it('update 检测形状冲突并保留原路由', () => {
    const registry = new RouteRegistry();
    const pattern = registry.add('default', 'GET', '/api/users/:id', { status: 200, body: 'p' });
    const exact = registry.add('default', 'PUT', '/api/users/42', { status: 200, body: 'e' });
    const result = registry.update(exact.id, { method: 'GET' });
    expect(result).toMatchObject({ ok: false, error: 'conflict', conflict: { id: pattern.id } });
  });

  it('behavior 支持 sequence 与 crud 并持久化', () => {
    const registry = new RouteRegistry();
    const route = registry.add(
      'default', 'GET', '/api/x', { status: 200, body: 'a' },
      'x', undefined, undefined, undefined,
      { sequence: [{ status: 200, body: 's1' }], crud: false },
    );
    expect(route.sequence).toEqual([{ status: 200, body: 's1' }]);
    const updated = registry.update(route.id, { sequence: [], crud: true });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.route.sequence).toEqual([]);
      expect(updated.route.crud).toBe(true);
    }
    const restored = new RouteRegistry(registry.toJSON());
    expect(restored.find('default', 'GET', '/api/x')?.crud).toBe(true);
    expect(restored.find('default', 'GET', '/api/x')?.sequence).toEqual([]);
  });
});
