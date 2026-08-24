import type { Express } from 'express';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { ServiceManager } from './manager.js';
import { RouteRegistry } from '../registry.js';
import { DEFAULT_SERVICE_ID } from '../types.js';
import { getFreePort, listen, type TestServer } from './test-utils.js';

// public/ 为 vite 构建产物（见 .gitignore），未执行 pnpm build 的全新克隆中不存在，此时跳过静态资源用例
const webUiBuilt = fs.existsSync(new URL('../../public/index.html', import.meta.url));

describe('createApp 集成测试', () => {
  let registry: RouteRegistry;
  let manager: ServiceManager;
  let app: Express;
  let server: TestServer;
  let freePort: number;
  let createdServiceId: string | undefined;

  beforeEach(async () => {
    registry = new RouteRegistry();
    registry.addService('默认服务', 8080, DEFAULT_SERVICE_ID);
    registry.add(DEFAULT_SERVICE_ID, 'GET', '/api/hello', { status: 200, body: { message: 'hi' } });
    manager = new ServiceManager(registry);
    app = createApp(registry, manager, { mainPort: 8080 });
    server = await listen(app);
    freePort = await getFreePort();
  });

  afterEach(async () => {
    if (createdServiceId) await manager.stop(createdServiceId);
    await server.close();
  });

  it('Mock 分发：已注册接口返回固定响应', async () => {
    const res = await fetch(`${server.baseUrl}/api/hello`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ message: 'hi' });
  });

  it('Mock 分发：未注册接口返回 404', async () => {
    const res = await fetch(`${server.baseUrl}/api/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it.skipIf(!webUiBuilt)('静态资源：根路径返回 Web UI', async () => {
    const res = await fetch(`${server.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('管理 API：列出服务分组', async () => {
    const res = await fetch(`${server.baseUrl}/__polymock/services`);
    const body = (await res.json()) as {
      ok: boolean;
      services: Array<{ id: string; isDefault: boolean; running: boolean; count: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.services).toHaveLength(1);
    expect(body.services[0]).toMatchObject({ id: DEFAULT_SERVICE_ID, isDefault: true, running: true, count: 1 });
  });

  it('管理 API：注册接口后立即可访问，删除后失效', async () => {
    const reg = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '临时接口', method: 'GET', path: '/api/temp', response: { status: 201, body: { temp: true } } }),
    });
    expect(reg.status).toBe(201);

    const hit = await fetch(`${server.baseUrl}/api/temp`);
    expect(hit.status).toBe(201);
    expect(await hit.json()).toEqual({ temp: true });

    const del = await fetch(`${server.baseUrl}/__polymock/routes?method=GET&path=/api/temp`, { method: 'DELETE' });
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);

    const gone = await fetch(`${server.baseUrl}/api/temp`);
    expect(gone.status).toBe(404);
  });

  it('管理 API：校验不合法参数', async () => {
    const res = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'GET', path: 'no-slash' }),
    });
    expect(res.status).toBe(400);
  });

  it('管理 API：新增接口必须填写名称', async () => {
    const res = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'GET', path: '/api/no-name' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('名称');
  });

  it('管理 API：新增接口携带名称，列表返回名称', async () => {
    const reg = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '查询用户', method: 'GET', path: '/api/named', response: { status: 200, body: {} } }),
    });
    expect(reg.status).toBe(201);
    expect(((await reg.json()) as { route: { name: string } }).route.name).toBe('查询用户');

    const list = await fetch(`${server.baseUrl}/__polymock/routes`);
    const body = (await list.json()) as { routes: Array<{ path: string; name?: string }> };
    const named = body.routes.find((r) => r.path === '/api/named');
    expect(named?.name).toBe('查询用户');
  });

  it('管理 API：更新名称，缺省名称时保留原值', async () => {
    const reg = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '旧名称', method: 'GET', path: '/api/renamed', response: { status: 200, body: {} } }),
    });
    const created = (await reg.json()) as { route: { id: string } };

    const upd = await fetch(`${server.baseUrl}/__polymock/routes/${created.route.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '新名称' }),
    });
    expect(upd.status).toBe(200);
    expect(((await upd.json()) as { route: { name: string } }).route.name).toBe('新名称');

    const upd2 = await fetch(`${server.baseUrl}/__polymock/routes/${created.route.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'POST' }),
    });
    expect(((await upd2.json()) as { route: { name: string } }).route.name).toBe('新名称');
  });

  it('管理 API：新增服务分组并在独立端口分发', async () => {
    const created = await fetch(`${server.baseUrl}/__polymock/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '测试服务', port: freePort }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { ok: boolean; service: { id: string } };
    expect(createdBody.ok).toBe(true);
    createdServiceId = createdBody.service.id;

    const reg = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serviceId: createdServiceId,
        name: '额外接口',
        method: 'GET',
        path: '/api/extra',
        response: { status: 200, body: { from: 'extra' } },
      }),
    });
    expect(reg.status).toBe(201);

    const hit = await fetch(`http://127.0.0.1:${freePort}/api/extra`);
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({ from: 'extra' });
  });

  // ---- B1/B2：请求条件、校验开关与响应变体 ----

  interface VariantInput {
    name: string;
    match?: Record<string, unknown>;
    response: { status?: number; body?: unknown };
  }

  async function registerRoute(payload: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { route: { id: string } }).route.id;
  }

  it('请求条件：requireMatch 开启后按 header/query/body 校验，缺失或不符合返回 400', async () => {
    await registerRoute({
      name: '受保护接口',
      method: 'POST',
      path: '/api/guarded',
      request: {
        headers: [{ key: 'X-Token', value: 'abc' }],
        query: [{ key: 'id', value: '1' }],
        body: [{ key: 'user.id', value: '1' }],
      },
      requireMatch: true,
      response: { status: 200, body: { ok: true } },
    });

    const hitUrl = `${server.baseUrl}/api/guarded?id=1`;
    const jsonHeaders = { 'content-type': 'application/json', 'x-token': 'abc' };

    const noHeader = await fetch(hitUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: { id: 1 } }) });
    expect(noHeader.status).toBe(400);
    expect(((await noHeader.json()) as { error: string }).error).toContain('X-Token');

    const badQuery = await fetch(`${server.baseUrl}/api/guarded?id=2`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ user: { id: 1 } }) });
    expect(badQuery.status).toBe(400);
    expect(((await badQuery.json()) as { error: string }).error).toContain('查询参数');

    const badBody = await fetch(hitUrl, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ user: { id: 9 } }) });
    expect(badBody.status).toBe(400);
    expect(((await badBody.json()) as { error: string }).error).toContain('user.id');

    const good = await fetch(hitUrl, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ user: { id: 1 } }) });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true });
  });

  it('请求条件：开关关闭时不校验，任何请求都拿到默认响应', async () => {
    await registerRoute({
      name: '宽松接口',
      method: 'GET',
      path: '/api/loose',
      request: { headers: [{ key: 'X-Token', value: 'abc' }] },
      requireMatch: false,
      response: { status: 200, body: { loose: true } },
    });
    const res = await fetch(`${server.baseUrl}/api/loose`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ loose: true });
  });

  it('响应变体：按 header 命中对应变体，全不命中回退默认响应', async () => {
    const variants: VariantInput[] = [
      { name: '管理员视角', match: { headers: [{ key: 'X-Role', value: 'admin' }] }, response: { body: { role: 'admin' } } },
      { name: '游客视角', match: { headers: [{ key: 'X-Role', value: 'guest' }] }, response: { status: 403, body: { role: 'guest' } } },
    ];
    await registerRoute({
      name: '多角色接口',
      method: 'GET',
      path: '/api/roles',
      variants,
      response: { status: 200, body: { role: 'default' } },
    });

    const admin = await fetch(`${server.baseUrl}/api/roles`, { headers: { 'X-Role': 'admin' } });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toEqual({ role: 'admin' });

    const guest = await fetch(`${server.baseUrl}/api/roles`, { headers: { 'X-Role': 'guest' } });
    expect(guest.status).toBe(403);
    expect(await guest.json()).toEqual({ role: 'guest' });

    const fallback = await fetch(`${server.baseUrl}/api/roles`);
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toEqual({ role: 'default' });
  });

  it('响应变体：支持 query 与 body 点路径条件，顺序优先取靠前者', async () => {
    const variants: VariantInput[] = [
      { name: '指定订单（顺序优先）', match: { query: [{ key: 'orderId', value: '100' }], headers: [{ key: 'X-Env', value: 'test' }] }, response: { body: { order: 'specific' } } },
      { name: '测试环境兜底', match: { headers: [{ key: 'X-Env', value: 'test' }] }, response: { body: { order: 'env-test' } } },
    ];
    await registerRoute({
      name: '订单查询',
      method: 'GET',
      path: '/api/orders',
      variants,
      response: { status: 200, body: { order: 'default' } },
    });

    const both = await fetch(`${server.baseUrl}/api/orders?orderId=100`, { headers: { 'X-Env': 'test' } });
    expect(await both.json()).toEqual({ order: 'specific' });

    const onlyEnv = await fetch(`${server.baseUrl}/api/orders?orderId=999`, { headers: { 'X-Env': 'test' } });
    expect(await onlyEnv.json()).toEqual({ order: 'env-test' });

    const none = await fetch(`${server.baseUrl}/api/orders?orderId=999`, { headers: { 'X-Env': 'prod' } });
    expect(await none.json()).toEqual({ order: 'default' });

    const byBody = await registerRoute({
      name: 'body 条件接口',
      method: 'POST',
      path: '/api/by-body',
      variants: [{ name: '大额订单', match: { body: [{ key: 'order.amount', value: '9999' }] }, response: { body: { level: 'vip' } } }],
      response: { status: 200, body: { level: 'normal' } },
    });

    const vip = await fetch(`${server.baseUrl}/api/by-body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: { amount: 9999 } }),
    });
    expect(vip.status).toBe(200);
    expect(await vip.json()).toEqual({ level: 'vip' });

    const normal = await fetch(`${server.baseUrl}/api/by-body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: { amount: 1 } }),
    });
    expect(await normal.json()).toEqual({ level: 'normal' });

    const missingBody = await fetch(`${server.baseUrl}/api/by-body`, { method: 'POST' });
    expect(await missingBody.json()).toEqual({ level: 'normal' });
  });

  it('响应变体：requireMatch 开启时默认响应也受条件约束；PUT 可整体替换变体', async () => {
    const created = await registerRoute({
      name: '严格变体接口',
      method: 'GET',
      path: '/api/strict-variant',
      request: { headers: [{ key: 'X-Token', value: 'abc' }] },
      requireMatch: true,
      variants: [{ name: '管理员', match: { headers: [{ key: 'X-Role', value: 'admin' }] }, response: { body: { role: 'admin' } } }],
      response: { status: 200, body: { role: 'default' } },
    });

    const denied = await fetch(`${server.baseUrl}/api/strict-variant`);
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toContain('X-Token');
    const allowedDefault = await fetch(`${server.baseUrl}/api/strict-variant`, { headers: { 'X-Token': 'abc' } });
    expect(await allowedDefault.json()).toEqual({ role: 'default' });

    const replaced = await fetch(`${server.baseUrl}/__polymock/routes/${created}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requireMatch: false,
        variants: [{ name: '新变体', match: { headers: [{ key: 'X-Role', value: 'root' }] }, response: { body: { role: 'root' } } }],
      }),
    });
    expect(replaced.status).toBe(200);
    const updated = ((await replaced.json()) as { route: { variants: Array<{ name: string; id: string }> } }).route;
    expect(updated.variants).toHaveLength(1);
    expect(updated.variants[0].name).toBe('新变体');

    const root = await fetch(`${server.baseUrl}/api/strict-variant`, { headers: { 'X-Role': 'root' } });
    expect(await root.json()).toEqual({ role: 'root' });

    /* 清空变体 + 关闭开关后回到旧行为 */
    const cleared = await fetch(`${server.baseUrl}/__polymock/routes/${created}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requireMatch: false, variants: [], request: {} }),
    });
    expect(cleared.status).toBe(200);

    const plain = await fetch(`${server.baseUrl}/api/strict-variant`);
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ role: 'default' });
  });

  it('校验顺序：requireMatch 门槛优先于变体，无条件变体不能绕过准入校验', async () => {
    await registerRoute({
      name: '门槛+兜底变体',
      method: 'GET',
      path: '/api/gate-vs-variant',
      request: { headers: [{ key: 'X-Token', value: 'abc' }] },
      requireMatch: true,
      variants: [
        { name: '管理员', match: { headers: [{ key: 'X-Role', value: 'admin' }] }, response: { body: { role: 'admin' } } },
        { name: '兜底（无条件）', response: { body: { role: 'catch-all' } } },
      ],
      response: { status: 200, body: { role: 'default' } },
    });

    /* 缺 X-Token：即使有无条件变体也必须 400 */
    const denied = await fetch(`${server.baseUrl}/api/gate-vs-variant`);
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toContain('X-Token');

    /* 通过门槛后：命中管理员变体 */
    const admin = await fetch(`${server.baseUrl}/api/gate-vs-variant`, { headers: { 'X-Token': 'abc', 'X-Role': 'admin' } });
    expect(await admin.json()).toEqual({ role: 'admin' });

    /* 通过门槛但未命中任何变体条件：落入无条件兜底变体 */
    const catchAll = await fetch(`${server.baseUrl}/api/gate-vs-variant`, { headers: { 'X-Token': 'abc' } });
    expect(await catchAll.json()).toEqual({ role: 'catch-all' });
  });

  it('管理 API：variants 与 request 参数不合法时返回 400', async () => {
    const badName = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '坏变体', method: 'GET', path: '/api/bad-variant', variants: [{ name: '  ', response: {} }] }),
    });
    expect(badName.status).toBe(400);

    const badRequestShape = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '坏条件', method: 'GET', path: '/api/bad-request', request: { headers: 'not-an-array' } }),
    });
    expect(badRequestShape.status).toBe(400);

    const badRequireMatch = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '坏开关', method: 'GET', path: '/api/bad-switch', requireMatch: 'yes' }),
    });
    expect(badRequireMatch.status).toBe(400);
  });
});