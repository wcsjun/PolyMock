import type { Express } from 'express';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { ServiceManager } from './manager.js';
import { RequestLogStore } from './request-log.js';
import { RouteRegistry } from '../registry.js';
import { CALLBACK_MAX_DEPTH, DEFAULT_SERVICE_ID, type RequestLogEntry } from '../types.js';
import { getFreePort, listen, type TestServer } from './test-utils.js';

/**
 * 异步回调集成测试（真实 HTTP，禁 mock 内部）：
 * 临时端口起接收服务器等回调到达再断言，覆盖 延迟 / 模板渲染 / 上下文快照 / 变体继承 / 引用模板 /
 * 白名单 / 连接失败 / 防自环深度头 / 模板 CRUD（usage / 409 删除保护）/ 路由注册校验。
 */

/** 轮询等待条件成立（回调是异步出站，不能同步断言） */
async function waitFor<T>(probe: () => T | undefined | null, timeoutMs = 3000, stepMs = 20): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** 接收服务器捕获到的回调请求 */
interface CapturedCall {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/** 起一个捕获请求的接收服务器，返回 baseUrl 与捕获列表（数组引用实时追加） */
async function startReceiver(): Promise<{ baseUrl: string; calls: CapturedCall[]; close: () => Promise<void> }> {
  const calls: CapturedCall[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      calls.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.statusCode = 200;
      res.end('ok');
    });
  });
  const port = await getFreePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('异步回调（出站执行器 + 回调模板）', () => {
  let registry: RouteRegistry;
  let manager: ServiceManager;
  let app: Express;
  let server: TestServer;
  let logs: RequestLogStore;
  let receiver: { baseUrl: string; calls: CapturedCall[]; close: () => Promise<void> };

  const postRoute = async (body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${server.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  const outEntries = (): RequestLogEntry[] => logs.list({ limit: 500 }).filter((e) => e.direction === 'out');

  beforeEach(async () => {
    registry = new RouteRegistry();
    registry.addService('默认服务', 8080, DEFAULT_SERVICE_ID);
    logs = new RequestLogStore();
    const crudStores = new Map<string, Map<string, Record<string, unknown>>>();
    const crudCounters = new Map<string, number>();
    manager = new ServiceManager(registry, { logs, crudStores, crudCounters });
    app = createApp(registry, manager, { mainPort: 8080, logs, crudStores, crudCounters });
    server = await listen(app);
    receiver = await startReceiver();
  });

  afterEach(async () => {
    await server.close();
    await receiver.close();
  });

  it('内联回调：命中后按延迟发出，URL / 头 / 载荷用命中请求快照渲染，出站日志关联源请求', async () => {
    const created = await postRoute({
      name: '支付受理',
      method: 'POST',
      path: '/api/pay',
      response: {
        status: 202,
        body: { code: 0 },
        callback: {
          url: `${receiver.baseUrl}/notify`,
          method: 'POST',
          delayMs: 50,
          headers: [{ key: 'X-Source', value: 'polymock' }],
          body: '{"orderNo":"{{body.orderNo}}","status":"PAID"}',
        },
      },
    });
    expect(created.status).toBe(201);

    const hitAt = Date.now();
    const hit = await fetch(`${server.baseUrl}/api/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderNo: 'A1001' }),
    });
    expect(hit.status).toBe(202);

    const call = await waitFor(() => receiver.calls[0]);
    expect(call.url).toBe('/notify');
    expect(call.headers['x-polymock-callback-depth']).toBe('1');
    expect(call.headers['x-source']).toBe('polymock');
    expect(JSON.parse(call.body)).toEqual({ orderNo: 'A1001', status: 'PAID' });

    const entry = await waitFor(() => outEntries().find((e) => e.status === 200));
    expect(entry.callback?.target).toBe(`${receiver.baseUrl}/notify`);
    expect(entry.callback?.sourceLogId).not.toBeNull();
    expect(entry.callback?.firedAfterMs).toBeGreaterThanOrEqual(50);
    expect(entry.durationMs).toBeLessThan(Date.now() - hitAt + 5000);
  });

  it('回调不阻塞响应路径：响应先返回，回调随后到达', async () => {
    await postRoute({
      name: '慢回调',
      method: 'GET',
      path: '/api/slow-cb',
      response: { status: 200, body: { ok: true }, callback: { url: `${receiver.baseUrl}/cb`, delayMs: 400 } },
    });
    const start = Date.now();
    const res = await fetch(`${server.baseUrl}/api/slow-cb`);
    expect(res.status).toBe(200);
    expect(Date.now() - start).toBeLessThan(200);
    await waitFor(() => receiver.calls[0]);
  });

  it('变体回调跟随命中分支：变体发变体回调，默认分支发默认回调，未配置回调的命中不发送', async () => {
    await postRoute({
      name: '支付',
      method: 'POST',
      path: '/api/pay2',
      response: {
        status: 202,
        body: { hit: 'default' },
        callback: { url: `${receiver.baseUrl}/default-cb`, delayMs: 20 },
      },
      variants: [
        {
          name: '成功',
          match: { body: [{ key: 'scene', value: 'ok' }] },
          response: {
            status: 202,
            body: { hit: 'ok' },
            callback: { url: `${receiver.baseUrl}/variant-cb`, delayMs: 20, body: '{"scene":"{{body.scene}}"}' },
          },
        },
      ],
    });
    await fetch(`${server.baseUrl}/api/pay2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scene: 'ok' }),
    });
    await waitFor(() => receiver.calls.find((c) => c.url === '/variant-cb'));
    await new Promise((r) => setTimeout(r, 120));
    expect(receiver.calls.some((c) => c.url === '/default-cb')).toBe(false);

    const receiver2Calls = receiver.calls;
    await fetch(`${server.baseUrl}/api/pay2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await waitFor(() => receiver2Calls.find((c) => c.url === '/default-cb' && c !== undefined));
  });

  it('引用模板：信封来自模板，bodyOverride 覆盖默认载荷；编辑模板后后续命中用新 URL', async () => {
    const tplRes = await fetch(`${server.baseUrl}/__polymock/callbacks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '支付通知', url: `${receiver.baseUrl}/t1`, method: 'POST', body: '{"status":"PAID"}', delayMs: 20 }),
    });
    const tpl = (await tplRes.json()) as { template: { id: string } };

    const created = await postRoute({
      name: '受理',
      method: 'POST',
      path: '/api/accept',
      response: {
        status: 202,
        body: { ok: true },
        callback: { template: tpl.template.id, bodyOverride: '{"orderNo":"{{body.orderNo}}"}' },
      },
    });
    expect(created.status).toBe(201);

    await fetch(`${server.baseUrl}/api/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderNo: 'B2002' }),
    });
    const first = await waitFor(() => receiver.calls[0]);
    expect(first.url).toBe('/t1');
    expect(JSON.parse(first.body)).toEqual({ orderNo: 'B2002' });

    const putRes = await fetch(`${server.baseUrl}/__polymock/callbacks/${tpl.template.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '支付通知', url: `${receiver.baseUrl}/t2`, method: 'POST', body: '{"status":"PAID"}' }),
    });
    const putBody = (await putRes.json()) as { affected: number };
    expect(putBody.affected).toBe(1);

    await fetch(`${server.baseUrl}/api/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const second = await waitFor(() => receiver.calls.find((c) => c.url === '/t2'));
    // bodyOverride 始终优先于模板默认载荷：第二次命中请求体为空对象，占位符无值保持原样
    expect(JSON.parse(second.body)).toEqual({ orderNo: '{{body.orderNo}}' });
  });

  it('模板 CRUD：重名 409、GET 带 usage 与 stats、被引用删除 409、未引用删除成功', async () => {
    const create = async (name: string) => {
      const res = await fetch(`${server.baseUrl}/__polymock/callbacks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, url: `${receiver.baseUrl}/n` }),
      });
      return (await res.json()) as { ok: boolean; template?: { id: string }; error?: string };
    };
    const first = await create('通知A');
    expect(first.ok).toBe(true);
    const dup = await create('通知A');
    expect(dup.ok).toBe(false);

    await postRoute({
      name: '引用路由',
      method: 'GET',
      path: '/api/use-tpl',
      response: { status: 200, body: {}, callback: { template: first.template!.id } },
    });

    const listRes = await fetch(`${server.baseUrl}/__polymock/callbacks`);
    const list = (await listRes.json()) as {
      callbacks: Array<{ id: string; usage: Array<{ path: string; branch: string | null }>; stats: { ok: number; fail: number } }>;
    };
    const target = list.callbacks.find((c) => c.id === first.template!.id);
    expect(target?.usage).toHaveLength(1);
    expect(target?.usage[0]).toMatchObject({ path: '/api/use-tpl', branch: null });
    expect(target?.stats).toEqual({ ok: 0, fail: 0, lastFiredAt: null });

    const blocked = await fetch(`${server.baseUrl}/__polymock/callbacks/${first.template!.id}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as { usage: unknown[] };
    expect(blockedBody.usage).toHaveLength(1);

    const second = await create('通知B');
    const removed = await fetch(`${server.baseUrl}/__polymock/callbacks/${second.template!.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
  });

  it('路由注册校验：引用不存在模板 400、序列 / CRUD 与回调互斥 400、WS 拒收 callback、引用模式多余字段 400', async () => {
    const missingTpl = await postRoute({
      name: 'x', method: 'GET', path: '/api/x1',
      response: { status: 200, body: {}, callback: { template: 'no-such' } },
    });
    expect(missingTpl.status).toBe(400);

    const withSeq = await postRoute({
      name: 'x', method: 'GET', path: '/api/x2', sequence: [{ status: 200, body: { step: 'a' } }],
      response: { status: 200, body: {}, callback: { url: `${receiver.baseUrl}/n` } },
    });
    expect(withSeq.status).toBe(400);
    expect(String(withSeq.json.error)).toContain('序列响应不支持回调');

    const withCrud = await postRoute({
      name: 'x', method: 'GET', path: '/api/x3', crud: true,
      response: { status: 200, body: {}, callback: { url: `${receiver.baseUrl}/n` } },
    });
    expect(withCrud.status).toBe(400);
    expect(String(withCrud.json.error)).toContain('CRUD 接口不支持回调');

    const wsWithCb = await postRoute({ name: 'x', protocol: 'ws', path: '/ws/x', callback: { url: `${receiver.baseUrl}/n` } });
    expect(wsWithCb.status).toBe(400);

    const extraField = await postRoute({
      name: 'x', method: 'GET', path: '/api/x4',
      response: { status: 200, body: {}, callback: { template: 't', url: 'http://x' } },
    });
    expect(extraField.status).toBe(400);
    expect(String(extraField.json.error)).toContain('多余字段');
  });

  it('PUT response 不带 callback 时清除原回调配置（整体替换语义）', async () => {
    const created = await postRoute({
      name: '待清除',
      method: 'GET',
      path: '/api/clear-cb',
      response: { status: 200, body: {}, callback: { url: `${receiver.baseUrl}/n` } },
    });
    const routeId = (created.json as { route: { id: string } }).route.id;
    const put = await fetch(`${server.baseUrl}/__polymock/routes/${routeId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: { status: 200, body: {} } }),
    });
    const putBody = (await put.json()) as { route: { response: { callback?: unknown } } };
    expect(putBody.route.response.callback).toBeUndefined();
  });

  it('白名单：POLYMOCK_PROXY_ALLOW 外的回调目标被拒绝并记日志（独立 app 实例）', async () => {
    const allowRegistry = new RouteRegistry();
    allowRegistry.addService('默认服务', 8080, DEFAULT_SERVICE_ID);
    const allowLogs = new RequestLogStore();
    const crudStores = new Map<string, Map<string, Record<string, unknown>>>();
    const crudCounters = new Map<string, number>();
    const allowManager = new ServiceManager(allowRegistry, { logs: allowLogs, crudStores, crudCounters });
    const allowApp = createApp(allowRegistry, allowManager, {
      mainPort: 8080, logs: allowLogs, crudStores, crudCounters, proxyAllowHosts: ['127.0.0.1'],
    });
    const allowServer = await listen(allowApp);
    try {
      await fetch(`${allowServer.baseUrl}/__polymock/routes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '白名单用例',
          method: 'GET',
          path: '/api/allow-cb',
          response: { status: 200, body: {}, callback: { url: 'http://localhost.invalid-domain/cb', delayMs: 20 } },
        }),
      });
      await fetch(`${allowServer.baseUrl}/api/allow-cb`);
      const entry = await waitFor(() => allowLogs.list({ limit: 100 }).find((e) => e.direction === 'out'));
      expect(entry.status).toBe(0);
      expect(entry.error).toContain('白名单');
    } finally {
      await allowServer.close();
    }
  });

  it('连接失败：目标未监听时出站日志记录失败原因，status 0', async () => {
    const deadPort = await getFreePort();
    await postRoute({
      name: '失败用例',
      method: 'GET',
      path: '/api/dead-cb',
      response: { status: 200, body: {}, callback: { url: `http://127.0.0.1:${deadPort}/cb`, delayMs: 20 } },
    });
    await fetch(`${server.baseUrl}/api/dead-cb`);
    const entry = await waitFor(() => outEntries()[0], 5000);
    expect(entry.status).toBe(0);
    expect(entry.error).toContain('回调发送失败');
    expect(entry.callback?.firedAfterMs).toBeGreaterThanOrEqual(20);
  });

  it('防自环：回调指向自身时按深度头递增，达到上限后跳过发送并记日志', async () => {
    await postRoute({
      name: '自环',
      method: 'POST',
      path: '/api/loop',
      response: { status: 202, body: { hit: true }, callback: { url: `${server.baseUrl}/api/loop`, delayMs: 10 } },
    });
    await fetch(`${server.baseUrl}/api/loop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

    await waitFor(() => outEntries().find((e) => e.error?.includes('深度超限')), 8000);
    const sent = outEntries().filter((e) => e.status === 202);
    expect(sent.length).toBe(CALLBACK_MAX_DEPTH);
    expect(sent.every((e) => e.callback?.target === `${server.baseUrl}/api/loop`)).toBe(true);
    expect(sent.every((e) => e.callback?.sourceLogId !== null)).toBe(true);
  });

  it('文本模式响应分支同样触发回调；GET 回调不携带请求体与 Content-Type', async () => {
    await postRoute({
      name: '文本分支',
      method: 'GET',
      path: '/api/text-cb',
      response: {
        status: 200,
        contentType: 'text/plain',
        body: 'plain-{{query.tag}}',
        callback: { url: `${receiver.baseUrl}/text-cb?tag={{query.tag}}`, method: 'GET', delayMs: 20, body: 'ignored' },
      },
    });
    const hit = await fetch(`${server.baseUrl}/api/text-cb?tag=abc`);
    expect(await hit.text()).toBe('plain-abc');
    const call = await waitFor(() => receiver.calls[0]);
    expect(call.url).toBe('/text-cb?tag=abc');
    expect(call.headers['content-type']).toBeUndefined();
  });
});
