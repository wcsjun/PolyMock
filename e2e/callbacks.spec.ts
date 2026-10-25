import { test, expect } from '@playwright/test';

const TPL_NAME = 'E2E回调模板';
const SOURCE_PATH = '/api/e2e-cb-source';
const TARGET_PATH = '/api/e2e-cb-hit';

/**
 * 异步回调主链路：回调管理视图新建模板 → 编辑抽屉引用模板注册接口 → 命中触发回调（回调打到自身 mock 接口）→
 * 请求日志出现出站条目 → 重发按钮再触发一次目标接口
 */

test('回调管理：新建模板后卡片出现，删除保护与空态可用', async ({ page, request }) => {
  // 预清理：删掉上次运行残留的同名模板（未被引用时才可删除；被引用则跳过，靠下方用例自清）
  const list = (await (await request.get('/__polymock/callbacks')).json()) as {
    callbacks: Array<{ id: string; name: string; usage: unknown[] }>;
  };
  for (const tpl of list.callbacks) {
    if (tpl.name === TPL_NAME && tpl.usage.length === 0) {
      await request.delete(`/__polymock/callbacks/${tpl.id}`);
    }
  }

  await page.goto('/');

  // 切到「回调管理」视图
  await page.getByRole('button', { name: /回调管理/ }).click();

  // 新建模板
  await page.getByRole('button', { name: /新建回调模板/ }).click();
  const drawer = page.getByRole('dialog', { name: '回调模板编辑表单' });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel('模板名称').fill(TPL_NAME);
  await drawer.locator('#ft-url').fill('http://127.0.0.1:5919/noop');
  await drawer.getByRole('button', { name: '保存模板' }).click();

  // 列表出现模板卡片（名称 + 未被引用 chip）
  const card = page.locator('.tpl-card', { hasText: TPL_NAME });
  await expect(card).toBeVisible();
  await expect(card.locator('.tpl-chip', { hasText: '未被引用' })).toBeVisible();

  // 清理：删除本用例创建的模板（未被引用，直接删除成功）
  await page.once('dialog', (dialog) => void dialog.accept());
  await card.getByRole('button', { name: '×' }).click();
  await expect(card).toBeHidden();
});

test('回调闭环：注册带回调的接口 → 命中触发回调打到 mock 接口 → 日志出站条目 → 重发', async ({ page, request }) => {
  // 预清理 + 建目标 mock 接口（回调的接收方就是 PolyMock 自身 mock，深度 1 合法）
  await request.delete(`/__polymock/routes?method=GET&path=${encodeURIComponent(SOURCE_PATH)}`);
  await request.delete(`/__polymock/routes?method=GET&path=${encodeURIComponent(TARGET_PATH)}`);
  await request.delete('/__polymock/requests');
  const created = await request.post('/__polymock/routes', {
    data: { name: 'E2E回调目标', method: 'GET', path: TARGET_PATH, response: { status: 200, body: { hit: true } } },
  });
  expect(created.status()).toBe(201);
  await request.post('/__polymock/routes', {
    data: {
      name: 'E2E回调源',
      method: 'GET',
      path: SOURCE_PATH,
      response: {
        status: 200,
        body: { ok: true },
        callback: { url: `http://127.0.0.1:5919${TARGET_PATH}`, method: 'GET', delayMs: 30 },
      },
    },
  });

  await page.goto('/');

  // 命中源接口 → 回调异步打到目标接口
  const hit = await request.get(SOURCE_PATH);
  expect(hit.status()).toBe(200);

  // 请求日志出现出站条目（↗ 出 徽标 + 回调·内联），详情含重发按钮
  await page.getByRole('button', { name: /请求日志/ }).click();
  const outRow = page.locator('.log-row', { hasText: TARGET_PATH }).filter({ hasText: '↗ 出' });
  await expect(outRow).toBeVisible({ timeout: 5000 });
  await outRow.click();
  await page.getByRole('button', { name: /重发此回调/ }).click();

  // 重发后目标接口再次被命中：出站条目变为两条（原发 + 重发，重发条目 firedAfterMs=0）
  await expect(async () => {
    const logs = (await (await request.get('/__polymock/requests?limit=100')).json()) as {
      requests: Array<{ direction?: string; path: string; callback?: { firedAfterMs: number } }>;
    };
    const outs = logs.requests.filter((r) => r.direction === 'out' && r.path.includes(TARGET_PATH));
    expect(outs.length).toBeGreaterThanOrEqual(2);
    expect(outs.some((r) => r.callback?.firedAfterMs === 0)).toBe(true);
  }).toPass({ timeout: 5000 });

  // 清理
  await request.delete(`/__polymock/routes?method=GET&path=${encodeURIComponent(SOURCE_PATH)}`);
  await request.delete(`/__polymock/routes?method=GET&path=${encodeURIComponent(TARGET_PATH)}`);
  await request.delete('/__polymock/requests');
});

test('编辑抽屉：高级选项回调子区双模式可切换并随接口保存', async ({ page, request }) => {
  await request.delete(`/__polymock/routes?method=GET&path=${encodeURIComponent(SOURCE_PATH)}`);
  await page.goto('/');

  await page.getByRole('button', { name: /新增接口/ }).click();
  const drawer = page.getByRole('dialog', { name: '接口编辑表单' });
  await drawer.getByLabel('接口名称').fill('E2E回调抽屉');
  await drawer.locator('#f-path').fill(SOURCE_PATH);
  await drawer.locator('#f-resp-body').fill('{"ok":true}');

  // 展开高级选项，启用异步回调（开关为视觉隐藏 checkbox，点击可见的 label 拨动）
  await drawer.getByRole('button', { name: /展开高级选项/ }).click();
  await drawer.locator('label[for="f-callback"]').click();
  await expect(drawer.getByText('引用模板', { exact: true })).toBeVisible();

  // 切内联模式，填 URL 与延迟
  await drawer.getByRole('button', { name: '内联配置' }).click();
  await drawer.locator('#f-cb-url').fill(`http://127.0.0.1:5919${TARGET_PATH}`);
  await drawer.locator('#f-cb-delay').fill('30');

  await drawer.getByRole('button', { name: /注册接口/ }).click();
  await expect(drawer).toBeHidden();

  // 后端确认 callback 已随路由保存
  const routes = (await (await request.get('/__polymock/routes')).json()) as {
    routes: Array<{ path: string; response?: { callback?: { url: string; delayMs?: number } } }>;
  };
  const route = routes.routes.find((r) => r.path === SOURCE_PATH);
  expect(route?.response?.callback).toMatchObject({ url: `http://127.0.0.1:5919${TARGET_PATH}`, delayMs: 30 });

  // 卡片出现回调 chip
  const card = page.locator('.route-card', { hasText: SOURCE_PATH });
  await expect(card.locator('.route-chip.cb')).toBeVisible();

  // 清理
  await request.delete(`/__polymock/routes?method=GET&path=${encodeURIComponent(SOURCE_PATH)}`);
  await request.delete(`/__polymock/routes?method=GET&path=${encodeURIComponent(TARGET_PATH)}`);
});
