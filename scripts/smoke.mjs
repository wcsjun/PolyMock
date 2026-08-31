/**
 * PolyMock 冒烟脚本：对构建产物（dist/index.js）做端到端验证。
 *
 * 流程：
 * 1. 要求 dist/index.js 存在（不存在提示先 pnpm build）；
 * 2. 以随机空闲端口 + 临时配置文件 spawn 子进程；
 * 3. 轮询 /__polymock/services 就绪（≤10s）；
 * 4. 依次断言：默认路由 / 模板 + 延迟 / 禁用 404 / 变体强制命中 / 请求日志；
 * 5. 结束 kill 子进程并删除临时文件；任一断言失败打印细节后 exit 1。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const READY_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;
const DELAY_MS = 50;

const distEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
if (!existsSync(distEntry)) {
  console.error('[smoke] 未找到 dist/index.js，请先执行 pnpm build');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 申请一个随机空闲端口（探测后立即释放，存在极小的竞态窗口，可接受） */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/** 带超时的 JSON 请求；返回 { status, body }（body 为解析失败时的原文） */
async function request(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* 保留原文 */
  }
  return { status: res.status, body };
}

/** 断言失败即抛错，附带打印细节 */
function assert(cond, message, detail) {
  if (!cond) {
    const err = new Error(message);
    err.detail = detail;
    throw err;
  }
}

function post(url, payload) {
  return request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function put(url, payload) {
  return request(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const output = [];
function record(line) {
  console.log(line);
  output.push(line);
}

async function waitForReady(base, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('PolyMock 子进程提前退出');
    }
    try {
      const { status, body } = await request(`${base}/__polymock/services`);
      if (status === 200 && body?.ok) return;
    } catch (err) {
      lastError = err.message;
    }
    await sleep(200);
  }
  throw new Error(`服务在 ${READY_TIMEOUT_MS / 1000}s 内未就绪${lastError ? `：${lastError}` : ''}`);
}

async function main() {
  const port = await getFreePort();
  const configFile = path.join(os.tmpdir(), `polymock-smoke-${process.pid}-${Date.now()}.json`);
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [distEntry], {
    env: { ...process.env, POLYMOCK_PORT: String(port), POLYMOCK_CONFIG_FILE: configFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childOutput = [];
  child.stdout.on('data', (chunk) => childOutput.push(chunk));
  child.stderr.on('data', (chunk) => childOutput.push(chunk));

  try {
    await waitForReady(base, child);
    record(`[smoke] 服务就绪：${base}（配置文件 ${configFile}）`);

    // ---- 1. 默认路由 GET /api/hello ----
    const hello = await request(`${base}/api/hello`);
    assert(hello.status === 200 && hello.body && typeof hello.body.message === 'string' && hello.body.message,
      'GET /api/hello 应返回 200 且含 message 字段', hello);
    record(`[smoke] ✓ GET /api/hello -> 200 message=${JSON.stringify(hello.body.message)}`);

    // ---- 2. 注册带模板 + 延迟路由 ----
    const created = await post(`${base}/__polymock/routes`, {
      serviceId: 'default',
      method: 'GET',
      path: '/api/smoke/hello',
      name: '冒烟-模板延迟',
      response: { status: 200, body: JSON.stringify({ msg: 'hi-{{query.name}}' }) },
      delayMs: DELAY_MS,
    });
    const createdBody = await created.body;
    assert(created.status === 201 && createdBody?.ok && createdBody.route?.id,
      'POST /__polymock/routes 注册模板路由应返回 201', created);
    const routeId = createdBody.route.id;
    record(`[smoke] ✓ POST /__polymock/routes -> 201 id=${routeId}`);

    // ---- 3. 命中：模板渲染 + 延迟生效 ----
    const hitStart = performance.now();
    const hit = await request(`${base}/api/smoke/hello?name=smoke`);
    const elapsed = Math.round(performance.now() - hitStart);
    assert(hit.status === 200 && hit.body?.msg === 'hi-smoke',
      '命中请求应返回 200 且模板 {{query.name}} 渲染为 hi-smoke', hit);
    assert(elapsed >= DELAY_MS,
      `命中请求耗时应 >= ${DELAY_MS}ms（实际 ${elapsed}ms）`, { elapsed });
    record(`[smoke] ✓ GET /api/smoke/hello?name=smoke -> 200 msg=${hit.body.msg} 耗时 ${elapsed}ms`);

    // ---- 4. 禁用后 404，解禁恢复 ----
    const disabled = await put(`${base}/__polymock/routes/${routeId}`, { disabled: true });
    assert(disabled.status === 200 && disabled.body?.ok, 'PUT 禁用路由应成功', disabled);
    const afterDisable = await request(`${base}/api/smoke/hello?name=smoke`);
    assert(afterDisable.status === 404, '禁用后请求应按未注册处理（404）', afterDisable);
    const enabled = await put(`${base}/__polymock/routes/${routeId}`, { disabled: false });
    assert(enabled.status === 200 && enabled.body?.ok, 'PUT 解禁路由应成功', enabled);
    const reHit = await request(`${base}/api/smoke/hello?name=smoke`);
    assert(reHit.status === 200 && reHit.body?.msg === 'hi-smoke', '解禁后请求应恢复 200', reHit);
    record('[smoke] ✓ PUT 禁用 -> 404 / 解禁 -> 200');

    // ---- 5. 变体 + 全局场景集强制命中 ----
    const variantCreated = await post(`${base}/__polymock/routes`, {
      serviceId: 'default',
      method: 'GET',
      path: '/api/smoke/variant',
      name: '冒烟-变体',
      response: { status: 200, body: '{"from":"default"}' },
      variants: [
        {
          name: 'forced',
          match: { headers: [{ key: 'X-Force', value: 'yes' }] },
          response: { status: 200, body: '{"from":"forced"}' },
        },
      ],
    });
    const variantCreatedBody = await variantCreated.body;
    assert(variantCreated.status === 201 && variantCreatedBody?.ok,
      '注册带变体路由应返回 201', variantCreated);
    const defaultHit = await request(`${base}/api/smoke/variant`);
    assert(defaultHit.status === 200 && defaultHit.body?.from === 'default',
      '未设置场景集时应命中默认响应', defaultHit);
    const settingsPut = await put(`${base}/__polymock/settings`, { activeVariant: 'forced' });
    assert(settingsPut.status === 200 && settingsPut.body?.settings?.activeVariant === 'forced',
      'PUT /settings 设置 activeVariant 应成功', settingsPut);
    const forcedHit = await request(`${base}/api/smoke/variant`);
    assert(forcedHit.status === 200 && forcedHit.body?.from === 'forced',
      '设置场景集后应强制命中同名变体（绕过条件）', forcedHit);
    await put(`${base}/__polymock/settings`, { activeVariant: null }); // 复位场景集
    record('[smoke] ✓ 变体强制命中（default -> forced）');

    // ---- 6. 请求日志 ----
    const logs = await request(`${base}/__polymock/requests?limit=500`);
    const entries = logs.body?.requests;
    assert(logs.status === 200 && Array.isArray(entries) && entries.length > 0,
      'GET /__polymock/requests 应返回非空请求记录', logs);
    assert(entries.some((entry) => entry.matched),
      '请求日志应包含命中记录', entries?.[0]);
    record(`[smoke] ✓ GET /__polymock/requests -> ${entries.length} 条记录`);

    record('[smoke] 冒烟测试全部通过');
  } catch (err) {
    console.error(`[smoke] 冒烟测试失败：${err.message}`);
    if (err.detail !== undefined) {
      console.error(`[smoke] 细节：${JSON.stringify(err.detail, null, 2)}`);
    }
    console.error('--- 子进程输出 ---');
    console.error(childOutput.join('') || '(无输出)');
    process.exitCode = 1;
  } finally {
    child.kill();
    await rm(configFile, { force: true });
  }
}

main();
