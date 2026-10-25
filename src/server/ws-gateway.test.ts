import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createApp } from './app.js';
import { resolveUpgradeService } from './dispatch.js';
import { ServiceManager } from './manager.js';
import { RequestLogStore } from './request-log.js';
import { WsGateway, WS_CLOSE_ROUTE_CHANGED } from './ws-gateway.js';
import { RouteRegistry } from '../registry.js';
import { DEFAULT_SERVICE_ID, type RequestLogEntry } from '../types.js';
import { getFreePort } from './test-utils.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 集成测试用的真实 WS 客户端：收集帧、等待打开 / 关闭、捕获握手拒绝状态码 */
class WsClient {
  readonly ws: WebSocket;
  readonly frames: string[] = [];

  /** 已消费的帧游标：帧可能在 open 与 nextFrame 之间到达，按序取出避免竞态 */
  private readIndex = 0;
  private readonly openPromise: Promise<void>;
  private readonly closePromise: Promise<number>;

  private constructor(url: string, headers?: Record<string, string>) {
    this.ws = new WebSocket(url, { headers });
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`握手被拒绝（${res.statusCode}）`)));
      this.ws.once('error', (err) => reject(err));
    });
    this.closePromise = new Promise((resolve) => {
      this.ws.once('close', (code) => resolve(code));
    });
    this.ws.on('message', (data) => {
      this.frames.push(data.toString());
    });
  }

  /** 建连并等待握手完成 */
  static connect(url: string, headers?: Record<string, string>): Promise<WsClient> {
    const client = new WsClient(url, headers);
    return client.openPromise.then(() => client);
  }

  /** 期望握手被拒绝，返回拒绝状态码（404 / 401） */
  static rejectStatus(url: string, headers?: Record<string, string>): Promise<number> {
    const client = new WsClient(url, headers);
    return client.openPromise.then(
      () => {
        client.ws.close();
        throw new Error('握手本应被拒绝');
      },
      (err: Error & { message: string }) => {
        const match = /（(\d+)）/.exec(err.message);
        if (!match) throw err;
        return Number(match[1]);
      },
    );
  }

  /** 等待下一条帧（按序消费已到达或即将到达的帧；超时抛错，避免用例悬挂） */
  nextFrame(timeoutMs = 2000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`等待帧超时（${timeoutMs}ms）`));
      }, timeoutMs);
      const deliver = () => {
        if (this.readIndex >= this.frames.length) return;
        cleanup();
        resolve(this.frames[this.readIndex++] as string);
      };
      const onMessage = () => deliver();
      const cleanup = () => {
        clearTimeout(timer);
        this.ws.off('message', onMessage);
      };
      this.ws.on('message', onMessage);
      deliver();
    });
  }

  /** 等待连接关闭，返回关闭码 */
  closed(timeoutMs = 3000): Promise<number> {
    return Promise.race([this.closePromise, delay(timeoutMs).then(() => -1)]);
  }

  sendText(text: string): void {
    this.ws.send(text);
  }

  close(code = 1000): void {
    this.ws.close(code);
  }

  terminate(): void {
    this.ws.terminate();
  }
}

interface Harness {
  registry: RouteRegistry;
  logs: RequestLogStore;
  gateway: WsGateway;
  manager: ServiceManager;
  baseUrl: string;
  wsBase: string;
  port: number;
  close: () => Promise<void>;
}

/** 装配完整主应用（与 index.ts 同构）：createServer + WS 网关 + 管理 API */
async function createHarness(mode: 'port' | 'path' = 'port'): Promise<Harness> {
  const port = await getFreePort();
  const registry = new RouteRegistry();
  registry.addService('默认服务', port, DEFAULT_SERVICE_ID);
  const logs = new RequestLogStore();
  const gateway = new WsGateway(registry, { logs });
  const manager = new ServiceManager(registry, { logs }, { singlePort: mode === 'path', gateway });
  const app = createApp(registry, manager, { mainPort: port, logs, mode, gateway });
  const server: Server = createServer(app);
  gateway.attach(server, (req) => resolveUpgradeService(registry, req.url ?? '/', mode));
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  return {
    registry,
    logs,
    gateway,
    manager,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    close: async () => {
      gateway.destroyAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('WS 网关集成测试', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('握手 101 后 onOpen 按序推送，每条延迟生效', async () => {
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/orders', '订单推送', {
      onOpen: [
        { body: { type: 'snapshot' } },
        { delayMs: 150, body: { type: 'status', status: 'paid' } },
        { delayMs: 100, body: { type: 'status', status: 'shipped' } },
      ],
    });
    const client = await WsClient.connect(`${h.wsBase}/ws/orders?orderId=A1001`);
    expect(JSON.parse(await client.nextFrame())).toEqual({ type: 'snapshot' });
    const beforeSecond = Date.now();
    expect(JSON.parse(await client.nextFrame())).toEqual({ type: 'status', status: 'paid' });
    expect(Date.now() - beforeSecond).toBeGreaterThanOrEqual(120);
    expect(JSON.parse(await client.nextFrame())).toEqual({ type: 'status', status: 'shipped' });
    client.close();
  });

  it('loopOnOpen 循环播放整个开场序列', async () => {
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/loop', '循环推送', {
      onOpen: [{ body: { n: 1 } }, { delayMs: 80, body: { n: 2 } }],
      loopOnOpen: true,
    });
    const client = await WsClient.connect(`${h.wsBase}/ws/loop`);
    expect(JSON.parse(await client.nextFrame())).toEqual({ n: 1 });
    expect(JSON.parse(await client.nextFrame())).toEqual({ n: 2 });
    expect(JSON.parse(await client.nextFrame())).toEqual({ n: 1 });
    expect(JSON.parse(await client.nextFrame())).toEqual({ n: 2 });
    client.close();
  });

  it('消息模板支持 query / params / $now', async () => {
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/room/:room', '房间推送', {
      onOpen: [{ body: '{"room":"{{params.room}}","orderId":"{{query.orderId}}","now":"{{$now}}"}' }],
    });
    const client = await WsClient.connect(`${h.wsBase}/ws/room/lobby?orderId=A1001`);
    const frame = JSON.parse(await client.nextFrame()) as { room: string; orderId: string; now: string };
    expect(frame.room).toBe('lobby');
    expect(frame.orderId).toBe('A1001');
    expect(frame.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    client.close();
  });

  it('未注册路径握手 404，已停用握手 404', async () => {
    expect(await WsClient.rejectStatus(`${h.wsBase}/ws/nope`)).toBe(404);
    const route = h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/disabled', '停用', {}, { disabled: true });
    expect(await WsClient.rejectStatus(`${h.wsBase}/ws/disabled`)).toBe(404);
    /* 启用后可正常握手 */
    h.registry.update(route.id, { disabled: false });
    const client = await WsClient.connect(`${h.wsBase}/ws/disabled`);
    client.close();
  });

  it('认证失败握手 401，携带正确令牌可建连', async () => {
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/secure', '认证推送', {}, {
      auth: { type: 'bearer', value: 'dev-token' },
    });
    expect(await WsClient.rejectStatus(`${h.wsBase}/ws/secure`)).toBe(401);
    expect(await WsClient.rejectStatus(`${h.wsBase}/ws/secure`, { authorization: 'Bearer wrong' })).toBe(401);
    const client = await WsClient.connect(`${h.wsBase}/ws/secure`, { authorization: 'Bearer dev-token' });
    client.close();
  });

  it('浏览器等价凭证：?token= 查询参数可用于 Bearer / APIKey 认证', async () => {
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/bearer-q', 'Bearer 查询', {}, {
      auth: { type: 'bearer', value: 'dev-token' },
    });
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/key-q', 'APIKey 查询', {}, {
      auth: { type: 'apikey', value: 'k-1' },
    });
    /* 正确 token 通过，错误 token 401 */
    const bearer = await WsClient.connect(`${h.wsBase}/ws/bearer-q?token=dev-token`);
    bearer.close();
    expect(await WsClient.rejectStatus(`${h.wsBase}/ws/bearer-q?token=wrong`)).toBe(401);
    const keyed = await WsClient.connect(`${h.wsBase}/ws/key-q?token=k-1`);
    keyed.close();
    expect(await WsClient.rejectStatus(`${h.wsBase}/ws/key-q?token=nope`)).toBe(401);
  });

  it('APIKey 认证：自定义 header 名生效', async () => {
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/keyed', '密钥推送', {}, {
      auth: { type: 'apikey', value: 'k-1', header: 'X-Token' },
    });
    expect(await WsClient.rejectStatus(`${h.wsBase}/ws/keyed`)).toBe(401);
    const client = await WsClient.connect(`${h.wsBase}/ws/keyed`, { 'x-token': 'k-1' });
    client.close();
  });

  it('path 模式：非默认服务经 basePath 前缀握手，未命中前缀归默认服务', async () => {
    await h.close();
    h = await createHarness('path');
    h.registry.addService('订单服务', 0, 'order', 'order');
    h.registry.addWs('order', '/ws/push', '订单推送', { onOpen: [{ body: { svc: 'order' } }] });
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/main', '主服务推送', { onOpen: [{ body: { svc: 'main' } }] });

    const order = await WsClient.connect(`${h.wsBase}/order/ws/push`);
    expect(JSON.parse(await order.nextFrame())).toEqual({ svc: 'order' });
    order.close();

    const main = await WsClient.connect(`${h.wsBase}/ws/main`);
    expect(JSON.parse(await main.nextFrame())).toEqual({ svc: 'main' });
    main.close();

    /* 带错误前缀的路径等价于默认服务下的未注册路径 */
    expect(await WsClient.rejectStatus(`${h.wsBase}/order/nope`)).toBe(404);
  });

  it('echo 原样回显', async () => {
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/echo', '回显', { onMessage: { mode: 'echo' } });
    const client = await WsClient.connect(`${h.wsBase}/ws/echo`);
    client.sendText('hello');
    expect(await client.nextFrame()).toBe('hello');
    client.sendText('{"a":1}');
    expect(await client.nextFrame()).toBe('{"a":1}');
    client.close();
  });

  it('fixed 固定回包：模板每次渲染', async () => {
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/fixed', '固定回包', {
      onMessage: { mode: 'fixed', replies: [{ type: 'ack' }] },
    });
    const client = await WsClient.connect(`${h.wsBase}/ws/fixed`);
    client.sendText('one');
    expect(JSON.parse(await client.nextFrame())).toEqual({ type: 'ack' });
    client.sendText('two');
    expect(JSON.parse(await client.nextFrame())).toEqual({ type: 'ack' });
    client.close();
  });

  it('sequence 按序循环回包', async () => {
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/seq', '按序回包', {
      onMessage: { mode: 'sequence', replies: [{ n: 1 }, { n: 2 }] },
    });
    const client = await WsClient.connect(`${h.wsBase}/ws/seq`);
    for (const expected of [1, 2, 1]) {
      client.sendText('ping');
      expect(JSON.parse(await client.nextFrame())).toEqual({ n: expected });
    }
    client.close();
  });

  it('none 与缺省策略均不回包', async () => {
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/none', '不回包', { onMessage: { mode: 'none' } });
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/silent', '缺省', {});
    const none = await WsClient.connect(`${h.wsBase}/ws/none`);
    const silent = await WsClient.connect(`${h.wsBase}/ws/silent`);
    none.sendText('a');
    silent.sendText('b');
    await delay(250);
    expect(none.frames).toHaveLength(0);
    expect(silent.frames).toHaveLength(0);
    none.close();
    silent.close();
  });

  it('interval 定时推送；连接关闭后定时器停止，不再产生帧与日志', async () => {
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/tick', '定时推送', {
      interval: { everyMs: 120, body: { type: 'tick' } },
    });
    const client = await WsClient.connect(`${h.wsBase}/ws/tick`);
    expect(JSON.parse(await client.nextFrame())).toEqual({ type: 'tick' });
    expect(JSON.parse(await client.nextFrame())).toEqual({ type: 'tick' });
    client.close();
    await client.closed();
    const logCount = h.logs.list().length;
    expect(logCount).toBe(1);
    await delay(300);
    /* 关闭后不产生新的连接日志（HTTP 日志更不会被帧冲刷） */
    expect(h.logs.list()).toHaveLength(logCount);
  });

  it('编辑 WS 路由后存量连接以 1012 关闭，新连接用新剧本', async () => {
    const route = h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/edit', '可编辑', {
      onOpen: [{ body: { v: 1 } }],
    });
    const client = await WsClient.connect(`${h.wsBase}/ws/edit`);
    expect(JSON.parse(await client.nextFrame())).toEqual({ v: 1 });
    h.registry.update(route.id, { ws: { onOpen: [{ body: { v: 2 } }] } });
    expect(await client.closed()).toBe(WS_CLOSE_ROUTE_CHANGED);

    const fresh = await WsClient.connect(`${h.wsBase}/ws/edit`);
    expect(JSON.parse(await fresh.nextFrame())).toEqual({ v: 2 });
    fresh.close();
  });

  it('停用 WS 路由后存量连接以 1012 关闭，新握手 404', async () => {
    const route = h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/gate', '停用关闭', {});
    const client = await WsClient.connect(`${h.wsBase}/ws/gate`);
    h.registry.update(route.id, { disabled: true });
    expect(await client.closed()).toBe(WS_CLOSE_ROUTE_CHANGED);
    expect(await WsClient.rejectStatus(`${h.wsBase}/ws/gate`)).toBe(404);
  });

  it('删除服务：连接销毁且 stop() 带超时兜底不挂起', async () => {
    const port = await getFreePort();
    h.registry.addService('独立服务', port, 'svc');
    const service = h.registry.getService('svc');
    if (!service) throw new Error('服务不存在');
    await h.manager.start(service);
    h.registry.addWs('svc', '/ws/svc', '服务推送', { onOpen: [{ body: { ok: true } }] });

    const client = await WsClient.connect(`ws://127.0.0.1:${port}/ws/svc`);
    expect(JSON.parse(await client.nextFrame())).toEqual({ ok: true });

    const stop = h.manager.stop('svc');
    const stopped = await Promise.race([
      stop.then(() => true),
      delay(4000).then(() => false),
    ]);
    expect(stopped).toBe(true);
    expect(await client.closed()).toBe(1006);
  });

  it('GET /ws/orders 走 HTTP Mock，与 WS /ws/orders 共存', async () => {
    h.registry.add(DEFAULT_SERVICE_ID, 'GET', '/ws/orders', { status: 200, body: { http: true } });
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/orders', '同名 WS', { onOpen: [{ body: { ws: true } }] });

    const res = await fetch(`${h.baseUrl}/ws/orders`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ http: true });

    const client = await WsClient.connect(`${h.wsBase}/ws/orders`);
    expect(JSON.parse(await client.nextFrame())).toEqual({ ws: true });
    client.close();
  });

  it('HTTP 请求打到仅注册为 WS 的路径：明确 404 且不走代理', async () => {
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/only', '仅 WS', {});
    /* 配置不可达的代理目标：若误走代理会得到 502 而非 404 */
    h.registry.updateService(DEFAULT_SERVICE_ID, { proxyTarget: 'http://127.0.0.1:9' });
    try {
      const res = await fetch(`${h.baseUrl}/ws/only`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('WS 接口');
    } finally {
      h.registry.updateService(DEFAULT_SERVICE_ID, { proxyTarget: undefined });
    }
    /* :param 形状的 WS 路径同样拦截 */
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/room/:room', '参数 WS', {});
    const paramRes = await fetch(`${h.baseUrl}/ws/room/lobby`);
    expect(paramRes.status).toBe(404);
  });

  it('stop() 超时兜底强制断开残余 TCP 连接，端口可立即复用', async () => {
    const port = await getFreePort();
    h.registry.addService('挂起服务', port, 'svc-hang');
    const service = h.registry.getService('svc-hang');
    if (!service) throw new Error('服务不存在');
    await h.manager.start(service);

    /* 不发任何请求的裸 TCP 连接：会让 server.close() 一直等待 */
    const net = await import('node:net');
    const socket = net.connect({ port, host: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });

    const stop = h.manager.stop('svc-hang');
    const stopped = await Promise.race([
      stop.then(() => true),
      delay(6000).then(() => false),
    ]);
    socket.destroy();
    expect(stopped).toBe(true);

    /* 端口已确认释放：可立即在同一端口重新监听 */
    const reuse = createServer();
    await new Promise<void>((resolve) => reuse.listen(port, '127.0.0.1', () => resolve()));
    await new Promise<void>((resolve) => reuse.close(() => resolve()));
  }, 12000);

  it('连接快照：id / 对端 / 收发计数', async () => {
    const route = h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/live', '在线', {
      onMessage: { mode: 'echo' },
    });
    const client = await WsClient.connect(`${h.wsBase}/ws/live`);
    client.sendText('hi');
    await client.nextFrame();
    const snapshot = h.gateway.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      serviceId: DEFAULT_SERVICE_ID,
      routeId: route.id,
      path: '/ws/live',
      framesIn: 1,
      framesOut: 1,
    });
    expect(snapshot[0].id).toMatch(/^c-/);
    expect(snapshot[0].remoteAddress).toContain('127.0.0.1');
    client.close();
  });

  it('连接级日志：101 关闭时写入，携带 ws 计数与关闭码', async () => {
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/log', '日志', {
      onOpen: [{ body: { hello: true } }],
      onMessage: { mode: 'echo' },
    });
    const client = await WsClient.connect(`${h.wsBase}/ws/log?orderId=A1001`);
    await client.nextFrame();
    client.sendText('ping');
    await client.nextFrame();
    client.close();
    await client.closed();

    const entries = h.logs.list() as RequestLogEntry[];
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toMatchObject({
      serviceId: DEFAULT_SERVICE_ID,
      method: 'WS',
      path: '/ws/log',
      status: 101,
      matched: { routeId: expect.any(String), variant: null },
    });
    expect(entry.ws).toMatchObject({ framesIn: 1, framesOut: 2, closeCode: 1000 });
    expect(entry.ws?.connectionId).toMatch(/^c-/);
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('握手拒绝写入连接级日志：404 未注册 matched 为 null', async () => {
    await WsClient.rejectStatus(`${h.wsBase}/ws/absent`);
    const entries = h.logs.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ method: 'WS', status: 404, matched: null });
  });

  it('管理 API：GET /ws/connections 返回连接快照', async () => {
    h.registry.addWs(DEFAULT_SERVICE_ID, '/ws/api', '接口快照', {});
    const client = await WsClient.connect(`${h.wsBase}/ws/api`);
    const res = await fetch(`${h.baseUrl}/__polymock/ws/connections`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; connections: Array<{ path: string; framesIn: number }> };
    expect(body.ok).toBe(true);
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({ path: '/ws/api', framesIn: 0 });
    client.close();
  });
});

describe('WS 路由管理 API 校验', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  function postRoutes(payload: unknown): Promise<Response> {
    return fetch(`${h.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  it('protocol:"ws" 创建 WS 接口（method 缺省自动补齐），列表返回 protocol ws', async () => {
    const res = await postRoutes({
      protocol: 'ws',
      name: '订单推送',
      path: '/ws/orders',
      ws: { onOpen: [{ body: { type: 'snapshot' } }], interval: { everyMs: 1000, body: { type: 'tick' } } },
    });
    expect(res.status).toBe(201);
    const { route } = (await res.json()) as { route: { protocol: string; method: string; ws?: unknown } };
    expect(route.protocol).toBe('ws');
    expect(route.method).toBe('WS');

    const list = await (await fetch(`${h.baseUrl}/__polymock/routes`)).json() as { routes: Array<{ protocol: string; method: string }> };
    expect(list.routes).toHaveLength(1);
    expect(list.routes[0]).toMatchObject({ protocol: 'ws', method: 'WS' });
  });

  it('WS 接口携带 response 等 HTTP 专属字段返回 400', async () => {
    for (const extra of [
      { response: { status: 200, body: { x: 1 } } },
      { request: { query: [{ key: 'a', value: '1' }] } },
      { requireMatch: true },
      { gateStatus: 404 },
      { variants: [{ name: 'v', response: { status: 200, body: {} } }] },
      { sequence: [{ status: 200, body: {} }] },
      { crud: true },
      { delayMs: 100 },
      { jitterMs: 100 },
      { failureRate: 10 },
      { renderRequest: false },
    ]) {
      const res = await postRoutes({ protocol: 'ws', name: 'X', path: '/ws/x', ...extra });
      expect(res.status).toBe(400);
    }
  });

  it('WS 接口配置校验：非法 onMessage / interval / loopOnOpen 返回 400', async () => {
    for (const ws of [
      { onMessage: { mode: 'nope' } },
      { onMessage: { mode: 'fixed' } },
      { onMessage: { mode: 'echo', replies: ['x'] } },
      { interval: { everyMs: 50, body: {} } },
      { interval: { everyMs: 1000 } },
      { loopOnOpen: true },
      { onOpen: [{ delayMs: -1, body: {} }] },
      { onOpen: [{ body: null }] },
    ]) {
      const res = await postRoutes({ protocol: 'ws', name: 'X', path: '/ws/x', ws });
      expect(res.status).toBe(400);
    }
  });

  it('HTTP 分支拒绝 method WS；WS 分支拒绝非 WS method', async () => {
    const viaHttp = await postRoutes({ name: 'X', method: 'WS', path: '/ws/x' });
    expect(viaHttp.status).toBe(400);

    const viaWs = await postRoutes({ protocol: 'ws', name: 'X', method: 'GET', path: '/ws/y' });
    expect(viaWs.status).toBe(400);
  });

  it('WS 与 WS 形状冲突返回 409；与 HTTP 同路径不冲突', async () => {
    const first = await postRoutes({ protocol: 'ws', name: 'A', path: '/ws/conf' });
    expect(first.status).toBe(201);
    const second = await postRoutes({ protocol: 'ws', name: 'B', path: '/ws/:id' });
    expect(second.status).toBe(409);

    /* 同路径不同协议（GET vs WS）互不冲突 */
    const httpSame = await fetch(`${h.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'C', method: 'GET', path: '/ws/conf', response: { status: 200, body: {} } }),
    });
    expect(httpSame.status).toBe(201);
  });

  it('PUT 更新 ws 配置；HTTP 路由拒收 ws 字段与 protocol 变更', async () => {
    const created = await postRoutes({ protocol: 'ws', name: 'W', path: '/ws/put' });
    const { route } = (await created.json()) as { route: { id: string } };

    const updated = await fetch(`${h.baseUrl}/__polymock/routes/${route.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'W2', ws: { onMessage: { mode: 'echo' } } }),
    });
    expect(updated.status).toBe(200);
    const { route: after } = (await updated.json()) as { route: { name: string; ws?: { onMessage?: { mode: string } } } };
    expect(after.name).toBe('W2');
    expect(after.ws?.onMessage?.mode).toBe('echo');

    /* ws: null 清除配置 */
    const cleared = await fetch(`${h.baseUrl}/__polymock/routes/${route.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ws: null }),
    });
    expect(cleared.status).toBe(200);
    const { route: bare } = (await cleared.json()) as { route: { ws?: unknown } };
    expect(bare.ws).toBeUndefined();

    /* HTTP 路由拒收 ws 与 protocol */
    const httpRoute = await fetch(`${h.baseUrl}/__polymock/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'H', method: 'GET', path: '/api/h', response: { status: 200, body: {} } }),
    });
    const { route: http } = (await httpRoute.json()) as { route: { id: string } };
    const addWs = await fetch(`${h.baseUrl}/__polymock/routes/${http.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ws: { onMessage: { mode: 'echo' } } }),
    });
    expect(addWs.status).toBe(400);
    const changeProtocol = await fetch(`${h.baseUrl}/__polymock/routes/${http.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'ws' }),
    });
    expect(changeProtocol.status).toBe(400);

    /* WS 路由拒收 HTTP 专属字段更新 */
    const wsAddDelay = await fetch(`${h.baseUrl}/__polymock/routes/${route.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delayMs: 100 }),
    });
    expect(wsAddDelay.status).toBe(400);
  });
});
