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

  async function putRoute(id: string, payload: Record<string, unknown>): Promise<{ status: number; route?: { id: string; disabled?: boolean; delayMs?: number; failureRate?: number } }> {
    const res = await fetch(`${server.baseUrl}/__polymock/routes/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as { ok: boolean; route?: { id: string; disabled?: boolean; delayMs?: number; failureRate?: number } };
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
});