import type { Express } from 'express';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { ServiceManager } from './manager.js';
import { RequestLogStore } from './request-log.js';
import { RouteRegistry } from '../registry.js';
import { DEFAULT_SERVICE_ID, type RequestLogEntry } from '../types.js';
import { getFreePort, listen, type TestServer } from './test-utils.js';

// public/ 为 vite 构建产物（见 .gitignore），未执行 pnpm build 的全新克隆中不存在，此时跳过静态资源用例
const webUiBuilt = fs.existsSync(new URL('../../public/index.html', import.meta.url));

describe('createApp 集成测试', () => {
  let registry: RouteRegistry;
  let manager: ServiceManager;
  let app: Express;
  let server: TestServer;
  let freePort: number;
  let logs: RequestLogStore;
  let createdServiceId: string | undefined;

  beforeEach(async () => {
    registry = new RouteRegistry();
    registry.addService('默认服务', 8080, DEFAULT_SERVICE_ID);
    registry.add(DEFAULT_SERVICE_ID, 'GET', '/api/hello', { status: 200, body: { message: 'hi' } });
    logs = new RequestLogStore();
    manager = new ServiceManager(registry, { logs });
    app = createApp(registry, manager, { mainPort: 8080, logs });
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

  it('管理 API：删除不存在的接口返回 404', async () => {
    const del = await fetch(`${server.baseUrl}/__polymock/routes?method=GET&path=/api/never-registered`, { method: 'DELETE' });
    expect(del.status).toBe(404);
    const body = (await del.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('接口不存在');
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

  it('管理 API：删除服务后从列表消失，其接口一并删除', async () => {
    const created = await fetch(`${server.baseUrl}/__polymock/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '待删服务', port: freePort }),
    });
    expect(created.status).toBe(201);
    createdServiceId = ((await created.json()) as { service: { id: string } }).service.id;

    await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceId: createdServiceId, name: '附属接口', method: 'GET', path: '/api/doomed', response: { status: 200, body: {} } }),
    });

    const del = await fetch(`${server.baseUrl}/__polymock/services/${createdServiceId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);

    const services = ((await (await fetch(`${server.baseUrl}/__polymock/services`)).json()) as { services: Array<{ id: string }> }).services;
    expect(services.some((s) => s.id === createdServiceId)).toBe(false);

    const routes = ((await (await fetch(`${server.baseUrl}/__polymock/routes?serviceId=${createdServiceId}`)).json()) as { routes: unknown[] }).routes;
    expect(routes).toHaveLength(0);
    createdServiceId = undefined;
  });

  it('管理 API：删除不存在的服务返回 404', async () => {
    const del = await fetch(`${server.baseUrl}/__polymock/services/no-such-service`, { method: 'DELETE' });
    expect(del.status).toBe(404);
    const body = (await del.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('服务不存在');
  });

  it('独立端口服务：query 与 body 条件同时校验，JSON 请求体正常解析', async () => {
    const created = await fetch(`${server.baseUrl}/__polymock/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '独立条件服务', port: freePort }),
    });
    expect(created.status).toBe(201);
    createdServiceId = ((await created.json()) as { service: { id: string } }).service.id;

    await registerRoute({
      serviceId: createdServiceId,
      name: '条件接口',
      method: 'POST',
      path: '/api/svc-body',
      request: {
        query: [{ key: 'id', value: '1' }],
        body: [{ key: 'user.name', value: 'PolyMock' }],
      },
      requireMatch: true,
      response: { status: 200, body: { ok: true } },
    });

    /* query 与 body 条件同时满足：命中（此前因独立端口未解析 JSON 请求体而误报 400） */
    const hit = await fetch(`http://127.0.0.1:${freePort}/api/svc-body?id=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: { name: 'PolyMock' } }),
    });
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({ ok: true });

    /* 请求体缺失：仍按 requireMatch 语义返回 400 */
    const noBody = await fetch(`http://127.0.0.1:${freePort}/api/svc-body?id=1`, { method: 'POST' });
    expect(noBody.status).toBe(400);
    expect(((await noBody.json()) as { error: string }).error).toContain('请求体缺失');
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

  it('条件类型：number/boolean/json 按类型比对，选填与存在性匹配生效', async () => {
    await registerRoute({
      name: '类型比对接口',
      method: 'POST',
      path: '/api/typed',
      variants: [
        {
          name: '数值+布尔',
          match: {
            query: [{ key: 'page', value: '2', type: 'number' }],
            headers: [{ key: 'X-Flag', value: 'true', type: 'boolean' }],
            body: [
              { key: 'amount', value: '9999', type: 'number' },
              { key: 'active', value: 'true', type: 'boolean' },
            ],
          },
          response: { body: { hit: 'typed' } },
        },
        {
          name: 'JSON 深度相等',
          match: { body: [{ key: 'filter.tags', value: '["a","b"]', type: 'json' }] },
          response: { body: { hit: 'json' } },
        },
        {
          name: '存在性与选填',
          match: {
            body: [
              { key: 'remark', value: '', required: true },
              { key: 'coupon', value: 'x', required: false },
            ],
          },
          response: { body: { hit: 'exists' } },
        },
      ],
      response: { status: 200, body: { hit: 'default' } },
    });

    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${server.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    /* number/boolean：数字 9999、布尔 true 与字符串期望按类型比对通过 */
    const typed = await post('/api/typed?page=2', { amount: 9999, active: true }, { 'X-Flag': 'true' });
    expect(await typed.json()).toEqual({ hit: 'typed' });

    /* number 不匹配（9998）→ 该变体不命中 */
    const wrongNum = await post('/api/typed?page=2', { amount: 9998, active: true }, { 'X-Flag': 'true' });
    expect(await wrongNum.json()).toEqual({ hit: 'default' });

    /* json 深度相等 */
    const jsonHit = await post('/api/typed', { filter: { tags: ['a', 'b'] } });
    expect(await jsonHit.json()).toEqual({ hit: 'json' });

    /* json 数组顺序不同 → 不等 */
    const jsonMiss = await post('/api/typed', { filter: { tags: ['b', 'a'] } });
    expect(await jsonMiss.json()).toEqual({ hit: 'default' });

    /* 存在性匹配：remark 存在即可（值任意）；选填 coupon 缺失也通过 */
    const existsHit = await post('/api/typed', { remark: 'anything' });
    expect(await existsHit.json()).toEqual({ hit: 'exists' });

    /* 必填存在性：remark 缺失 → 不命中 */
    const existsMiss = await post('/api/typed', {});
    expect(await existsMiss.json()).toEqual({ hit: 'default' });

    /* 选填：coupon 存在但值不等 → 不命中 */
    const optionalMiss = await post('/api/typed', { remark: 'x', coupon: 'y' });
    expect(await optionalMiss.json()).toEqual({ hit: 'default' });

    /* 选填 body 条件 + 请求体缺失：全部按字段缺失通过 */
    const noBody = await fetch(`${server.baseUrl}/api/typed`, { method: 'POST' });
    expect(await noBody.json()).toEqual({ hit: 'default' });

    /* 注册后条件字段原样返回 */
    const list = await fetch(`${server.baseUrl}/__polymock/routes`);
    const routes = ((await list.json()) as { routes: Array<{ path: string; variants?: Array<{ match?: { body?: Array<Record<string, unknown>> } }> }> }).routes;
    const typedRoute = routes.find((r) => r.path === '/api/typed');
    expect(typedRoute?.variants?.[0].match?.body?.[0]).toMatchObject({ key: 'amount', value: '9999', type: 'number' });
    expect(typedRoute?.variants?.[2].match?.body?.[1]).toMatchObject({ key: 'coupon', required: false });
  });

  it('条件类型：array 包含匹配（无序子集，逐元素深度相等）', async () => {
    await registerRoute({
      name: '数组包含接口',
      method: 'POST',
      path: '/api/array-type',
      variants: [
        {
          name: '标签包含',
          match: { body: [{ key: 'tags', value: '["hot","new"]', type: 'array' }] },
          response: { body: { hit: 'contains' } },
        },
        {
          name: '期望值非数组',
          match: { body: [{ key: 'tags', value: '"hot"', type: 'array' }] },
          response: { body: { hit: 'bad-expected' } },
        },
        {
          name: '对象元素包含',
          match: { body: [{ key: 'users', value: '[{"id":1}]', type: 'array' }] },
          response: { body: { hit: 'nested' } },
        },
      ],
      response: { status: 200, body: { hit: 'default' } },
    });

    const post = (body: unknown) =>
      fetch(`${server.baseUrl}/api/array-type`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    /* 无序包含：实际数组多元素且顺序不同仍命中 */
    const hit = await post({ tags: ['new', 'free', 'hot'] });
    expect(await hit.json()).toEqual({ hit: 'contains' });

    /* 缺少任一期望元素 → 不命中；期望值非数组的变体也不命中 → 落入默认 */
    const miss = await post({ tags: ['hot', 'new2'] });
    expect(await miss.json()).toEqual({ hit: 'default' });

    /* 逐元素深度相等：包含 {id:1} 对象元素命中 */
    const nested = await post({ tags: ['x'], users: [{ id: 2 }, { id: 1 }] });
    expect(await nested.json()).toEqual({ hit: 'nested' });

    /* 实际值不是数组 → 不命中 */
    const notArray = await post({ tags: 'hot' });
    expect(await notArray.json()).toEqual({ hit: 'default' });

    /* 空期望数组：任意实际数组均满足包含 */
    await registerRoute({
      name: '空数组包含接口',
      method: 'POST',
      path: '/api/array-empty',
      variants: [
        {
          name: '空包含',
          match: { body: [{ key: 'tags', value: '[]', type: 'array' }] },
          response: { body: { hit: 'empty-ok' } },
        },
      ],
      response: { status: 200, body: { hit: 'default' } },
    });
    const emptyHit = await fetch(`${server.baseUrl}/api/array-empty`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: [] }),
    });
    expect(await emptyHit.json()).toEqual({ hit: 'empty-ok' });
  });

  it('管理 API：条件的 type/required 不合法时返回 400', async () => {
    const badType = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '坏类型', method: 'GET', path: '/api/bad-type', request: { headers: [{ key: 'a', value: 'b', type: 'regex' }] } }),
    });
    expect(badType.status).toBe(400);
    expect(((await badType.json()) as { error: string }).error).toContain('type');

    const badRequired = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '坏必填', method: 'GET', path: '/api/bad-required', request: { headers: [{ key: 'a', value: 'b', required: 'yes' }] } }),
    });
    expect(badRequired.status).toBe(400);
    expect(((await badRequired.json()) as { error: string }).error).toContain('required');
  });

  it('路由级认证：apikey/bearer 凭证校验生效，未配置接口不受影响', async () => {
    await registerRoute({
      name: 'apikey 接口',
      method: 'GET',
      path: '/api/apikey',
      response: { body: { ok: true } },
      auth: { type: 'apikey', value: 'sk-123' },
    });
    await registerRoute({
      name: '自定义头接口',
      method: 'GET',
      path: '/api/apikey-custom',
      response: { body: { ok: true } },
      auth: { type: 'apikey', value: 'ck-456', header: 'X-Custom-Key' },
    });
    await registerRoute({
      name: 'bearer 接口',
      method: 'GET',
      path: '/api/bearer',
      response: { body: { ok: true } },
      auth: { type: 'bearer', value: 'tk-789' },
    });

    /* 正确凭证放行 */
    const okApikey = await fetch(`${server.baseUrl}/api/apikey`, { headers: { 'X-API-Key': 'sk-123' } });
    expect(okApikey.status).toBe(200);
    const okCustom = await fetch(`${server.baseUrl}/api/apikey-custom`, { headers: { 'X-Custom-Key': 'ck-456' } });
    expect(okCustom.status).toBe(200);
    const okBearer = await fetch(`${server.baseUrl}/api/bearer`, { headers: { Authorization: 'Bearer tk-789' } });
    expect(okBearer.status).toBe(200);

    /* 缺失凭证 → 401 + JSON 错误体 */
    const missing = await fetch(`${server.baseUrl}/api/apikey`);
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { ok: boolean; error: string }).error).toContain('缺少');

    /* 错误凭证 → 401 */
    const wrong = await fetch(`${server.baseUrl}/api/apikey`, { headers: { 'X-API-Key': 'bad' } });
    expect(wrong.status).toBe(401);

    /* bearer：缺失 → 401 + WWW-Authenticate 头 */
    const noAuth = await fetch(`${server.baseUrl}/api/bearer`);
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toBe('Bearer');

    /* bearer：非 Bearer 形式 / 错误 token → 401 */
    const badForm = await fetch(`${server.baseUrl}/api/bearer`, { headers: { Authorization: 'Basic dXNlcg==' } });
    expect(badForm.status).toBe(401);
    const badToken = await fetch(`${server.baseUrl}/api/bearer`, { headers: { Authorization: 'Bearer wrong' } });
    expect(badToken.status).toBe(401);

    /* 未配置认证的接口行为不变 */
    const plain = await fetch(`${server.baseUrl}/api/hello`);
    expect(plain.status).toBe(200);
  });

  it('路由级认证：401 优先于 requireMatch 的 400，PUT auth:null 可清除', async () => {
    const id = await registerRoute({
      name: '门槛+认证接口',
      method: 'GET',
      path: '/api/gate-auth',
      requireMatch: true,
      request: { headers: [{ key: 'X-Token', value: 'abc' }] },
      response: { body: { ok: true } },
      auth: { type: 'apikey', value: 'sk-1' },
    });

    /* 无凭证且无 X-Token：401 优先于 400 */
    const unauth = await fetch(`${server.baseUrl}/api/gate-auth`);
    expect(unauth.status).toBe(401);

    /* 有凭证但缺 X-Token：落入 requireMatch 400 */
    const gated = await fetch(`${server.baseUrl}/api/gate-auth`, { headers: { 'X-API-Key': 'sk-1' } });
    expect(gated.status).toBe(400);

    /* 凭证与门槛齐备：200 */
    const both = await fetch(`${server.baseUrl}/api/gate-auth`, { headers: { 'X-API-Key': 'sk-1', 'X-Token': 'abc' } });
    expect(both.status).toBe(200);

    /* PUT auth:null 清除后：带门槛凭证可访问（认证已清除） */
    const cleared = await fetch(`${server.baseUrl}/__polymock/routes/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth: null }),
    });
    expect(cleared.status).toBe(200);
    const afterClear = await fetch(`${server.baseUrl}/api/gate-auth`, { headers: { 'X-Token': 'abc' } });
    expect(afterClear.status).toBe(200);
    /* 认证已清除但 requireMatch 门槛仍在：缺 X-Token 返回 400 而非 401 */
    const gateOnly = await fetch(`${server.baseUrl}/api/gate-auth`);
    expect(gateOnly.status).toBe(400);
  });

  it('路由级认证：CRUD 路由同样生效；管理 API auth 字段不合法返回 400', async () => {
    await registerRoute({
      name: '受保护集合',
      method: 'GET',
      path: '/api/crud-sec',
      crud: true,
      auth: { type: 'bearer', value: 'tk-c' },
    });
    const denied = await fetch(`${server.baseUrl}/api/crud-sec`);
    expect(denied.status).toBe(401);
    const allowed = await fetch(`${server.baseUrl}/api/crud-sec`, { headers: { Authorization: 'Bearer tk-c' } });
    expect(allowed.status).toBe(200);

    const badAuth = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '坏认证', method: 'GET', path: '/api/bad-auth', auth: { type: 'basic', value: 'x' } }),
    });
    expect(badAuth.status).toBe(400);
    expect(((await badAuth.json()) as { error: string }).error).toContain('auth.type');
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

  // ---- C1-C8：禁用 / 延迟 / 故障注入 / 模板 / 请求日志 / 场景集 / 代理 ----

  async function putRoute(id: string, payload: Record<string, unknown>): Promise<{ status: number; route?: { id: string; disabled?: boolean; delayMs?: number; failureRate?: number; sequence?: unknown; crud?: boolean } }> {
    const res = await fetch(`${server.baseUrl}/__polymock/routes/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as { ok: boolean; route?: { id: string; disabled?: boolean; delayMs?: number; failureRate?: number; sequence?: unknown; crud?: boolean } };
    return { status: res.status, route: body.route };
  }

  async function latestLog(): Promise<RequestLogEntry> {
    const res = await fetch(`${server.baseUrl}/__polymock/requests`);
    const body = (await res.json()) as { ok: boolean; requests: RequestLogEntry[] };
    expect(body.ok).toBe(true);
    expect(body.requests.length).toBeGreaterThan(0);
    return body.requests[0];
  }

  it('禁用接口后按未注册处理（404），恢复后可访问；PUT 支持只含 disabled 的 patch', async () => {
    const routeId = await registerRoute({
      name: '可禁用接口',
      method: 'GET',
      path: '/api/off',
      response: { status: 200, body: { on: true } },
    });

    const disabled = await putRoute(routeId, { disabled: true });
    expect(disabled.status).toBe(200);
    expect(disabled.route?.disabled).toBe(true);

    const gone = await fetch(`${server.baseUrl}/api/off`);
    expect(gone.status).toBe(404);

    const reEnabled = await putRoute(routeId, { disabled: false });
    expect(reEnabled.status).toBe(200);
    const back = await fetch(`${server.baseUrl}/api/off`);
    expect(back.status).toBe(200);
    expect(await back.json()).toEqual({ on: true });
  });

  it('failureRate=100 时注入 500 故障，error 含"模拟故障"', async () => {
    await registerRoute({
      name: '必故障接口',
      method: 'GET',
      path: '/api/failure',
      response: { status: 200, body: { fine: true } },
      failureRate: 100,
    });
    const res = await fetch(`${server.baseUrl}/api/failure`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain('模拟故障');
  });

  it('delayMs 延迟生效（实测耗时 >= 70ms）', async () => {
    await registerRoute({
      name: '慢接口',
      method: 'GET',
      path: '/api/slow',
      response: { status: 200, body: { slow: true } },
      delayMs: 80,
    });
    const start = Date.now();
    const res = await fetch(`${server.baseUrl}/api/slow`);
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(70);
  });

  it('模板占位符在响应中渲染（query 与 body）', async () => {
    await registerRoute({
      name: '模板接口',
      method: 'POST',
      path: '/api/template',
      response: { status: 200, body: { token: '{{query.token}}', echo: '{{body.name}}', seq: '{{$id}}' } },
    });
    const res = await fetch(`${server.baseUrl}/api/template?token=xyz`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '小明' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'xyz', echo: '小明', seq: '1' });
  });

  it('请求日志记录命中路由与变体，DELETE 清空', async () => {
    const routeId = await registerRoute({
      name: '日志接口',
      method: 'GET',
      path: '/api/logged',
      variants: [{ name: '管理员视角', match: { headers: [{ key: 'X-Role', value: 'admin' }] }, response: { body: { role: 'admin' } } }],
      response: { status: 200, body: { role: 'default' } },
    });

    const hit = await fetch(`${server.baseUrl}/api/logged?trace=1`, { headers: { 'X-Role': 'admin' } });
    expect(hit.status).toBe(200);

    const entry = await latestLog();
    expect(entry.matched).toEqual({ routeId, variant: '管理员视角' });
    expect(entry.status).toBe(200);
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/api/logged');
    expect(entry.serviceId).toBe(DEFAULT_SERVICE_ID);
    expect(entry.query).toEqual({ trace: '1' });
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);

    const cleared = await fetch(`${server.baseUrl}/__polymock/requests`, { method: 'DELETE' });
    expect(((await cleared.json()) as { ok: boolean }).ok).toBe(true);

    const after = await fetch(`${server.baseUrl}/__polymock/requests`);
    expect(((await after.json()) as { requests: unknown[] }).requests).toEqual([]);
  });

  it('全局场景集：activeVariant 强制命中变体响应，置空后恢复默认', async () => {
    const routeId = await registerRoute({
      name: '场景接口',
      method: 'GET',
      path: '/api/scenario',
      variants: [
        { name: '异常场景', match: { headers: [{ key: 'X-Never', value: 'impossible' }] }, response: { body: { scenario: 'error' } } },
      ],
      response: { status: 200, body: { scenario: 'default' } },
    });

    const normal = await fetch(`${server.baseUrl}/api/scenario`);
    expect(await normal.json()).toEqual({ scenario: 'default' });

    const put = await fetch(`${server.baseUrl}/__polymock/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activeVariant: '异常场景' }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { settings: { activeVariant: string } }).settings.activeVariant).toBe('异常场景');

    const forced = await fetch(`${server.baseUrl}/api/scenario`);
    expect(await forced.json()).toEqual({ scenario: 'error' });
    expect((await latestLog()).matched).toEqual({ routeId, variant: '异常场景' });

    const reset = await fetch(`${server.baseUrl}/__polymock/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activeVariant: null }),
    });
    expect(reset.status).toBe(200);
    const restored = await fetch(`${server.baseUrl}/api/scenario`);
    expect(await restored.json()).toEqual({ scenario: 'default' });
  });

  it('代理：未注册路径转发上游（JSON 与文本），日志 proxied=true', async () => {
    const upstreamPort = await getFreePort();
    const upstream = createServer((req, res) => {
      if (req.url === '/text') {
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('hello upstream');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ upstream: true, url: req.url }));
    });
    await new Promise<void>((resolve) => upstream.listen(upstreamPort, '127.0.0.1', () => resolve()));

    try {
      const put = await fetch(`${server.baseUrl}/__polymock/services/${DEFAULT_SERVICE_ID}/proxy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: `http://127.0.0.1:${upstreamPort}` }),
      });
      expect(put.status).toBe(200);
      expect(((await put.json()) as { service: { proxyTarget?: string } }).service.proxyTarget).toBe(`http://127.0.0.1:${upstreamPort}`);

      const jsonRes = await fetch(`${server.baseUrl}/from-upstream?a=1`);
      expect(jsonRes.status).toBe(200);
      expect(await jsonRes.json()).toEqual({ upstream: true, url: '/from-upstream?a=1' });

      const textRes = await fetch(`${server.baseUrl}/text`);
      expect(textRes.status).toBe(200);
      expect(textRes.headers.get('content-type')).toContain('text/plain');
      await expect(textRes.text()).resolves.toBe('hello upstream');

      const entry = await latestLog();
      expect(entry.matched).toBeNull();
      expect(entry.proxied).toBe(true);
      expect(entry.proxyStatus).toBe(200);
      expect(entry.status).toBe(200);
      expect(entry.proxyBody).toContain('upstream');
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('代理：非法 URL 返回 400，服务不存在返回 404，target=null 清除', async () => {
    const badUrl = await fetch(`${server.baseUrl}/__polymock/services/${DEFAULT_SERVICE_ID}/proxy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'not-a-url' }),
    });
    expect(badUrl.status).toBe(400);

    const badScheme = await fetch(`${server.baseUrl}/__polymock/services/${DEFAULT_SERVICE_ID}/proxy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'ftp://example.com' }),
    });
    expect(badScheme.status).toBe(400);

    const missing = await fetch(`${server.baseUrl}/__polymock/services/nope/proxy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'http://localhost:3000' }),
    });
    expect(missing.status).toBe(404);

    const set = await fetch(`${server.baseUrl}/__polymock/services/${DEFAULT_SERVICE_ID}/proxy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'http://localhost:3000' }),
    });
    expect(set.status).toBe(200);

    const clear = await fetch(`${server.baseUrl}/__polymock/services/${DEFAULT_SERVICE_ID}/proxy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: null }),
    });
    expect(clear.status).toBe(200);
    expect(((await clear.json()) as { service: { proxyTarget?: string } }).service.proxyTarget).toBeUndefined();
  });

  it('管理 API：行为字段校验与传递', async () => {
    const badDelay = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '坏延迟', method: 'GET', path: '/api/bad-delay', delayMs: 70000 }),
    });
    expect(badDelay.status).toBe(400);
    expect(((await badDelay.json()) as { error: string }).error).toContain('delayMs');

    const badRate = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '坏概率', method: 'GET', path: '/api/bad-rate', failureRate: 101 }),
    });
    expect(badRate.status).toBe(400);

    const badDisabled = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '坏禁用', method: 'GET', path: '/api/bad-disabled', disabled: 'yes' }),
    });
    expect(badDisabled.status).toBe(400);

    const created = await registerRoute({
      name: '带行为字段',
      method: 'GET',
      path: '/api/behaved',
      response: { status: 200, body: {} },
      delayMs: 10,
      jitterMs: 20,
      failureRate: 5,
    });
    const list = await fetch(`${server.baseUrl}/__polymock/routes`);
    const route = ((await list.json()) as { routes: Array<{ id: string; delayMs?: number; jitterMs?: number; failureRate?: number }> }).routes.find((r) => r.id === created);
    expect(route).toMatchObject({ delayMs: 10, jitterMs: 20, failureRate: 5 });

    const patched = await putRoute(created, { delayMs: 0 });
    expect(patched.status).toBe(200);
    expect(patched.route?.delayMs).toBe(0);
  });

  it('模板占位符可出现在值位置：宽松校验通过，命中按渲染类型返回', async () => {
    const created = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '值位置模板',
        method: 'GET',
        path: '/api/tpl-value/:code',
        response: { status: 200, body: '{"code": {{params.code}}, "note": "{{params.code}}"}' },
      }),
    });
    expect(created.status).toBe(201);

    const hit = await fetch(`${server.baseUrl}/api/tpl-value/200`);
    expect(hit.status).toBe(200);
    /* 值位置的占位符按渲染结果类型注入（数字保持数字），字符串内的注入为文本 */
    expect(await hit.json()).toEqual({ code: 200, note: '200' });

    const bad = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '坏模板',
        method: 'GET',
        path: '/api/tpl-broken',
        response: { status: 200, body: '{"code": {{params.code' },
      }),
    });
    expect(bad.status).toBe(400);
  });

  it('路径参数路由：段匹配提取参数并渲染 {{params.id}}，形状冲突返回 409', async () => {
    await registerRoute({
      name: '用户详情',
      method: 'GET',
      path: '/api/users/:id',
      response: { status: 200, body: { userId: '{{params.id}}' } },
    });
    const hit = await fetch(`${server.baseUrl}/api/users/42`);
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({ userId: '42' });

    const dup = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '形状冲突', method: 'GET', path: '/api/users/42', response: { status: 200, body: {} } }),
    });
    expect(dup.status).toBe(409);

    const otherShape = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '不同形状', method: 'GET', path: '/api/users/42/posts', response: { status: 200, body: {} } }),
    });
    expect(otherShape.status).toBe(201);
  });

  it('序列响应按次序循环返回并在日志中标注 序列#n', async () => {
    const id = await registerRoute({
      name: '序列测试',
      method: 'GET',
      path: '/api/seq',
      response: { status: 200, body: { mode: 'default' } },
      sequence: [
        { status: 201, body: { step: 1 } },
        { status: 200, body: { step: 2 } },
      ],
    });
    const statuses: number[] = [];
    const steps: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${server.baseUrl}/api/seq`);
      statuses.push(res.status);
      steps.push(((await res.json()) as { step: number }).step);
    }
    expect(statuses).toEqual([201, 200, 201, 200]);
    expect(steps).toEqual([1, 2, 1, 2]);

    const logRes = await fetch(`${server.baseUrl}/__polymock/requests?limit=20`);
    /* /requests 按新→旧排序：时间正序应为 序列#1,#2,#1,#2 */
    const entries = ((await logRes.json()) as { requests: RequestLogEntry[] }).requests.filter((r) => r.path === '/api/seq');
    expect(entries.map((e) => e.matched?.variant)).toEqual(['序列#4', '序列#3', '序列#2', '序列#1']);
    expect(entries[0].matched?.routeId).toBe(id);
  });

  it('序列响应校验：非法 status 返回 400，空数组可清空', async () => {
    const bad = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '坏序列', method: 'GET', path: '/api/bad-seq',
        response: { status: 200, body: {} },
        sequence: [{ status: 99, body: {} }],
      }),
    });
    expect(bad.status).toBe(400);

    const id = await registerRoute({
      name: '可清空序列', method: 'GET', path: '/api/clear-seq',
      response: { status: 200, body: {} },
      sequence: [{ status: 200, body: { note: 'once' } }],
    });
    const cleared = await putRoute(id, { sequence: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.route?.sequence).toEqual([]);
  });

  it('有状态 CRUD：创建/列表/查单条/更新/删除全流程', async () => {
    await registerRoute({ name: '笔记创建', method: 'POST', path: '/api/notes', crud: true, response: { status: 200, body: {} } });
    await registerRoute({ name: '笔记列表', method: 'GET', path: '/api/notes', crud: true, response: { status: 200, body: {} } });
    await registerRoute({ name: '笔记条目', method: 'GET', path: '/api/notes/:id', crud: true, response: { status: 200, body: {} } });
    await registerRoute({ name: '笔记更新', method: 'PUT', path: '/api/notes/:id', crud: true, response: { status: 200, body: {} } });
    await registerRoute({ name: '笔记删除', method: 'DELETE', path: '/api/notes/:id', crud: true, response: { status: 200, body: {} } });

    const created = await fetch(`${server.baseUrl}/api/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'a' }),
    });
    expect(created.status).toBe(201);
    const record = (await created.json()) as { id: string; title: string };
    expect(record).toEqual({ id: 'rec-1', title: 'a' });

    const list = await fetch(`${server.baseUrl}/api/notes`);
    expect(((await list.json()) as unknown[]).length).toBe(1);

    const item = await fetch(`${server.baseUrl}/api/notes/rec-1`);
    expect(item.status).toBe(200);
    const missing = await fetch(`${server.baseUrl}/api/notes/zz`);
    expect(missing.status).toBe(404);

    const updated = await fetch(`${server.baseUrl}/api/notes/rec-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'b' }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ id: 'rec-1', title: 'b' });

    const removed = await fetch(`${server.baseUrl}/api/notes/rec-1`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    const gone = await fetch(`${server.baseUrl}/api/notes/rec-1`);
    expect(gone.status).toBe(404);
  });

  it('CRUD 校验：crud 需为布尔值；PUT 仅含 crud 字段可作为 patch', async () => {
    const bad = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '坏CRUD', method: 'GET', path: '/api/badcrud', crud: 'yes', response: { status: 200, body: {} } }),
    });
    expect(bad.status).toBe(400);

    const id = await registerRoute({ name: '条目路由', method: 'GET', path: '/api/items/:id', response: { status: 200, body: {} } });
    const patched = await putRoute(id, { crud: true });
    expect(patched.status).toBe(200);
    expect(patched.route?.crud).toBe(true);
  });

  it('SSE /events：实时推送请求日志（event: log + 条目 JSON）', async () => {
    const controller = new AbortController();
    const sse = await fetch(`${server.baseUrl}/__polymock/events`, { signal: controller.signal });
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    expect(sse.headers.get('cache-control')).toContain('no-cache');

    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    /* 连接建立后触发一次 mock 命中，流中应出现对应日志条目 */
    await fetch(`${server.baseUrl}/api/hello`);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !text.includes('event: log')) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 300)),
      ]);
      if (chunk === 'timeout') continue;
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    expect(text).toContain('event: log');
    expect(text).toContain('/api/hello');
    expect(text).toContain('"matched"');
  });
});

describe('安全加固：管理令牌', () => {
  let registry: RouteRegistry;
  let manager: ServiceManager;
  let server: TestServer;
  let logs: RequestLogStore;

  beforeEach(async () => {
    registry = new RouteRegistry();
    registry.addService('默认服务', 8080, DEFAULT_SERVICE_ID);
    registry.add(DEFAULT_SERVICE_ID, 'GET', '/api/hello', { status: 200, body: { message: 'hi' } });
    logs = new RequestLogStore();
    manager = new ServiceManager(registry, { logs });
    server = await listen(createApp(registry, manager, { mainPort: 8080, logs, adminToken: 'secret-token' }));
  });

  afterEach(async () => {
    await server.close();
  });

  it('未携带令牌访问管理 API 返回 401', async () => {
    const res = await fetch(`${server.baseUrl}/__polymock/routes`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: '需要管理令牌（x-polymock-token 头或 ?token= 参数）' });
  });

  it('令牌错误返回 401，携带正确 x-polymock-token 头返回 200', async () => {
    const wrong = await fetch(`${server.baseUrl}/__polymock/routes`, { headers: { 'x-polymock-token': 'bad' } });
    expect(wrong.status).toBe(401);

    const right = await fetch(`${server.baseUrl}/__polymock/routes`, { headers: { 'x-polymock-token': 'secret-token' } });
    expect(right.status).toBe(200);
    expect(((await right.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('携带正确 ?token= 查询参数返回 200', async () => {
    const res = await fetch(`${server.baseUrl}/__polymock/routes?token=secret-token`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('SSE /events 同样受令牌保护：无令牌 401，?token= 可建立事件流', async () => {
    const denied = await fetch(`${server.baseUrl}/__polymock/events`);
    expect(denied.status).toBe(401);

    const controller = new AbortController();
    const allowed = await fetch(`${server.baseUrl}/__polymock/events?token=secret-token`, { signal: controller.signal });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-type')).toContain('text/event-stream');
    controller.abort();
  });

  it('未设置 adminToken 时不校验，无令牌访问正常', async () => {
    const openServer = await listen(createApp(registry, manager, { mainPort: 8080, logs }));
    try {
      const res = await fetch(`${openServer.baseUrl}/__polymock/routes`);
      expect(res.status).toBe(200);
    } finally {
      await openServer.close();
    }
  });
});

describe('安全加固：代理白名单', () => {
  let registry: RouteRegistry;
  let manager: ServiceManager;
  let server: TestServer;
  let logs: RequestLogStore;

  beforeEach(async () => {
    registry = new RouteRegistry();
    registry.addService('默认服务', 8080, DEFAULT_SERVICE_ID);
    registry.add(DEFAULT_SERVICE_ID, 'GET', '/api/hello', { status: 200, body: { message: 'hi' } });
    logs = new RequestLogStore();
    manager = new ServiceManager(registry, { logs });
    server = await listen(createApp(registry, manager, { mainPort: 8080, logs, proxyAllowHosts: ['localhost'] }));
  });

  afterEach(async () => {
    await server.close();
  });

  it('PUT proxy 目标 host 不在白名单返回 400，白名单内正常设置', async () => {
    const blocked = await fetch(`${server.baseUrl}/__polymock/services/${DEFAULT_SERVICE_ID}/proxy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'http://127.0.0.1:3999' }),
    });
    expect(blocked.status).toBe(400);
    expect(((await blocked.json()) as { error: string }).error).toBe('代理目标不在白名单内');

    const allowed = await fetch(`${server.baseUrl}/__polymock/services/${DEFAULT_SERVICE_ID}/proxy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'http://localhost:3999' }),
    });
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { service: { proxyTarget?: string } }).service.proxyTarget).toBe('http://localhost:3999');
  });

  it('分发层兜底：非白名单代理目标转发前返回 502 并记日志', async () => {
    /* 直接更新注册表模拟旧配置中已存在的非白名单代理目标（绕过管理端校验） */
    registry.updateService(DEFAULT_SERVICE_ID, { proxyTarget: 'http://127.0.0.1:3999' });

    const res = await fetch(`${server.baseUrl}/not-registered`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: '代理目标不在白名单内' });

    const logRes = await fetch(`${server.baseUrl}/__polymock/requests`);
    const body = (await logRes.json()) as { ok: boolean; requests: RequestLogEntry[] };
    expect(body.ok).toBe(true);
    expect(body.requests.length).toBeGreaterThan(0);
    expect(body.requests[0].status).toBe(502);
    expect(body.requests[0].error).toBe('代理目标不在白名单内');
  });
});

describe('路径模式（POLYMOCK_MODE=path）', () => {
  let registry: RouteRegistry;
  let manager: ServiceManager;
  let app: Express;
  let server: TestServer;

  beforeEach(async () => {
    registry = new RouteRegistry();
    registry.addService('默认服务', 8080, DEFAULT_SERVICE_ID);
    registry.add(DEFAULT_SERVICE_ID, 'GET', '/api/hello', { status: 200, body: { from: 'default' } });
    manager = new ServiceManager(registry, undefined, { singlePort: true });
    app = createApp(registry, manager, { mainPort: 8080, mode: 'path' });
    server = await listen(app);
  });

  afterEach(async () => {
    await server.close();
  });

  it('GET /__polymock/meta 返回模式与主端口', async () => {
    const res = await fetch(`${server.baseUrl}/__polymock/meta`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'path', mainPort: 8080 });
  });

  it('路径模式创建服务免端口并自动生成唯一 basePath', async () => {
    const res = await fetch(`${server.baseUrl}/__polymock/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '订单服务' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; service: { port: number; basePath?: string } };
    expect(body.ok).toBe(true);
    expect(body.service.port).toBe(0);
    expect(body.service.basePath).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('路径模式创建服务：显式 basePath 校验格式与冲突', async () => {
    const ok = await fetch(`${server.baseUrl}/__polymock/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '订单服务', basePath: 'order' }),
    });
    expect(ok.status).toBe(201);

    /* 重复 basePath → 409 */
    const dup = await fetch(`${server.baseUrl}/__polymock/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '另一服务', basePath: 'order' }),
    });
    expect(dup.status).toBe(409);

    /* 保留前缀 → 400 */
    const reserved = await fetch(`${server.baseUrl}/__polymock/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '又一服务', basePath: '__polymock' }),
    });
    expect(reserved.status).toBe(400);
  });

  it('请求 /{basePath}/api/... 剥离前缀后分发到对应服务', async () => {
    const create = await fetch(`${server.baseUrl}/__polymock/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '订单服务', basePath: 'order' }),
    });
    const { service } = (await create.json()) as { service: { id: string } };

    await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceId: service.id, name: '查订单', method: 'GET', path: '/api/orders', response: { status: 200, body: { from: 'order' } } }),
    });

    /* 前缀内命中 */
    const hit = await fetch(`${server.baseUrl}/order/api/orders?id=1`);
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({ from: 'order' });

    /* 服务内未注册 → 404（由该服务 dispatch 返回） */
    const miss = await fetch(`${server.baseUrl}/order/api/nope`);
    expect(miss.status).toBe(404);

    /* 未命中任何前缀 → 走默认服务（主端口根路径） */
    const fallback = await fetch(`${server.baseUrl}/api/hello`);
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toEqual({ from: 'default' });
  });

  it('PUT /services/:id/basePath 修改前缀，默认服务拒绝设置', async () => {
    const create = await fetch(`${server.baseUrl}/__polymock/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '订单服务' }),
    });
    const { service } = (await create.json()) as { service: { id: string } };

    const update = await fetch(`${server.baseUrl}/__polymock/services/${service.id}/basePath`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ basePath: 'new-prefix' }),
    });
    expect(update.status).toBe(200);
    expect(((await update.json()) as { service: { basePath?: string } }).service.basePath).toBe('new-prefix');

    /* 默认服务不可设置 basePath */
    const def = await fetch(`${server.baseUrl}/__polymock/services/${DEFAULT_SERVICE_ID}/basePath`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ basePath: 'default' }),
    });
    expect(def.status).toBe(400);
  });

  it('默认服务新建接口的首段与 basePath 重合时返回 409', async () => {
    await fetch(`${server.baseUrl}/__polymock/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '订单服务', basePath: 'order' }),
    });

    const res = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '被遮蔽接口', method: 'GET', path: '/order/anything', response: { status: 200, body: {} } }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('basePath');
  });
  it('自定义响应头：默认响应与变体命中分别携带各自的 headers', async () => {
    registry.add(DEFAULT_SERVICE_ID, 'GET', '/api/with-headers', {
      status: 200,
      body: { ok: true },
      headers: [
        { key: 'X-Mock-Source', value: 'polymock' },
        { key: 'X-Trace', value: 't-default' },
      ],
    }, '带头接口', undefined, false, [
      {
        id: 'v-admin',
        name: 'admin',
        match: { headers: [{ key: 'X-Role', value: 'admin' }] },
        response: { status: 200, body: { role: 'admin' }, headers: [{ key: 'X-Trace', value: 't-admin' }] },
      },
    ]);

    const def = await fetch(`${server.baseUrl}/api/with-headers`);
    expect(def.headers.get('x-mock-source')).toBe('polymock');
    expect(def.headers.get('x-trace')).toBe('t-default');

    const admin = await fetch(`${server.baseUrl}/api/with-headers`, { headers: { 'X-Role': 'admin' } });
    /* 变体整体替换响应：只带变体自己的 headers，默认响应的 headers 不再出现 */
    expect(admin.headers.get('x-trace')).toBe('t-admin');
    expect(admin.headers.get('x-mock-source')).toBeNull();
  });

  it('自定义响应头：同名多条按多值头返回（Set-Cookie）', async () => {
    registry.add(DEFAULT_SERVICE_ID, 'GET', '/api/cookies', {
      status: 200,
      body: {},
      headers: [
        { key: 'Set-Cookie', value: 'a=1; Path=/' },
        { key: 'Set-Cookie', value: 'b=2; Path=/' },
      ],
    });
    const res = await fetch(`${server.baseUrl}/api/cookies`);
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('自定义响应头：值支持模板占位符（params 与 $id）', async () => {
    registry.add(DEFAULT_SERVICE_ID, 'POST', '/api/users/:id', {
      status: 201,
      body: { id: '{{params.id}}' },
      headers: [
        { key: 'Location', value: '/api/users/{{params.id}}' },
        { key: 'X-Req-Id', value: '{{$id}}' },
      ],
    });
    const res = await fetch(`${server.baseUrl}/api/users/42`, { method: 'POST' });
    expect(res.headers.get('location')).toBe('/api/users/42');
    expect(res.headers.get('x-req-id')).toBe('1');
  });

  it('自定义响应头：Content-Type 覆盖 contentType 字段', async () => {
    registry.add(DEFAULT_SERVICE_ID, 'GET', '/api/override-ct', {
      status: 200,
      contentType: 'application/json',
      body: { ok: true },
      headers: [{ key: 'Content-Type', value: 'application/vnd.api+json' }],
    });
    const res = await fetch(`${server.baseUrl}/api/override-ct`);
    /* Express 会为已知 mime 类型补 charset，语义上以自定义头为准（不再是 application/json） */
    expect(res.headers.get('content-type')).toBe('application/vnd.api+json; charset=utf-8');
  });

  it('自定义响应头：序列响应每步携带各自的 headers', async () => {
    registry.add(DEFAULT_SERVICE_ID, 'GET', '/api/seq-headers', { status: 200, body: {} }, undefined, undefined, undefined, undefined, {
      sequence: [
        { status: 200, body: { step: 1 }, headers: [{ key: 'X-Step', value: 'first' }] },
        { status: 500, body: { step: 2 } },
      ],
    });
    const first = await fetch(`${server.baseUrl}/api/seq-headers`);
    expect(first.headers.get('x-step')).toBe('first');
    const second = await fetch(`${server.baseUrl}/api/seq-headers`);
    expect(second.headers.get('x-step')).toBeNull();
  });

  it('管理 API：注册时校验响应头——受管头与非法值返回 400，合法值入库', async () => {
    const post = (response: unknown) =>
      fetch(`${server.baseUrl}/__polymock/routes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'hdr', method: 'GET', path: '/api/hdr', response }),
      });

    const forbidden = await post({ status: 200, body: {}, headers: [{ key: 'Content-Length', value: '12' }] });
    expect(forbidden.status).toBe(400);
    expect(((await forbidden.json()) as { error: string }).error).toContain('托管');

    const crlfValue = ['a', 'b: 1'].join(String.fromCharCode(13, 10));
    const crlf = await post({ status: 200, body: {}, headers: [{ key: 'X-Bad', value: crlfValue }] });
    expect(crlf.status).toBe(400);

    const badKey = await post({ status: 200, body: {}, headers: [{ key: 'Bad Header', value: 'x' }] });
    expect(badKey.status).toBe(400);

    const ok = await post({
      status: 200,
      body: {},
      headers: [
        { key: '  X-Good  ', value: 'yes' },
        { key: 'x-good', value: 'dup' },
      ],
    });
    expect(ok.status).toBe(201);
    const route = ((await ok.json()) as { route: { response: { headers?: Array<{ key: string; value: string }> } } }).route;
    expect(route.response.headers).toEqual([
      { key: 'X-Good', value: 'yes' },
      { key: 'x-good', value: 'dup' },
    ]);

    /* Mock 分发验证入库后实际生效：同名两条按多值头输出 */
    const mock = await fetch(`${server.baseUrl}/api/hdr`);
    expect(mock.headers.get('x-good')).toBe('yes, dup');
  });
});
