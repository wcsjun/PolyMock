import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { ServiceManager } from './manager.js';
import { RouteRegistry } from '../registry.js';
import { DEFAULT_SERVICE_ID } from '../types.js';
import { getFreePort, listen, type TestServer } from './test-utils.js';

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

  it('静态资源：根路径返回 Web UI', async () => {
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
});