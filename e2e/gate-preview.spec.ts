import { test, expect } from '@playwright/test';

const DEMO_PATH = '/api/e2e-gate';

/**
 * 新增接口改造后的主链路：请求准入（存在 + 正则在共享条件里）、准入失败码 404、
 * 响应分支（region=cn-north → 409）、匹配预览的本地推演，以及注册后的真实分发结果。
 */
test('请求准入 + 响应分支：正则共享条件、准入失败码 404 与匹配预览推演一致', async ({ page, request }) => {
  // 预清理：删除上次运行可能残留的同名接口，保证用例可重复执行
  await request.delete(`/__polymock/routes?method=GET&path=${encodeURIComponent(DEMO_PATH)}`);

  await page.goto('/');
  await page.getByRole('button', { name: /新增接口/ }).click();
  const drawer = page.getByRole('dialog', { name: '接口编辑表单' });
  await expect(drawer).toBeVisible();

  await drawer.getByLabel('接口名称').fill('E2E 准入与分支');
  await drawer.locator('#f-path').fill(DEMO_PATH);

  // ---- 请求准入：tenantId 存在 + region 正则 ----
  await drawer.locator('#f-gate').check({ force: true });
  const gate = drawer.locator('.gate-body');
  await gate.getByRole('button', { name: /添加共享条件/ }).click();
  const tenantRow = gate.locator('.cond-row').first();
  await tenantRow.locator('.cond-key').fill('tenantId');
  await tenantRow.locator('.cond-op').selectOption('exists');

  await gate.getByRole('button', { name: /添加共享条件/ }).click();
  const regionRow = gate.locator('.cond-row').nth(1);
  await regionRow.locator('.cond-key').fill('region');
  await regionRow.locator('.cond-op').selectOption('regex');
  await regionRow.locator('.cond-value').fill('^cn-\\w+$');

  // 准入失败码改为 404（隐藏接口）
  await gate.locator('.status-select select').selectOption('404');

  // 默认响应 body
  await drawer.locator('#f-resp-body').fill('{"ok":true,"scope":"default"}');

  // ---- 响应分支：region=cn-north 时返回业务 409 ----
  await drawer.getByRole('button', { name: /新增分支/ }).click();
  await drawer.locator('#f-scene-name').fill('华东区');
  const branchPanel = drawer.locator('.branch-editor .subpanel').first();
  await branchPanel.getByRole('button', { name: /添加条件/ }).click();
  const branchRow = branchPanel.locator('.cond-row').first();
  await branchRow.locator('.cond-key').fill('region');
  await branchRow.locator('.cond-value').fill('cn-north');
  await drawer.locator('#f-resp-status').fill('409');
  await drawer.locator('#f-resp-body').fill('{"ok":false,"scope":"branch"}');

  // ---- 匹配预览：本地推演应与真实分发一致 ----
  await drawer.getByRole('button', { name: /展开预览/ }).click();
  const preview = drawer.locator('.preview');
  await expect(preview.locator('.status-pill')).toHaveText('HTTP 404');
  await expect(preview.locator('.result-title')).toHaveText(/准入失败/);

  await preview.getByLabel('测试查询参数').fill('tenantId=acme&region=cn-north');
  await expect(preview.locator('.status-pill')).toHaveText('HTTP 409');
  await expect(preview.locator('.result-title')).toHaveText(/华东区/);

  /* cn-south 通过正则门槛但不匹配分支（分支只要 cn-north）→ 默认响应 */
  await preview.getByLabel('测试查询参数').fill('tenantId=acme&region=cn-south');
  await expect(preview.locator('.status-pill')).toHaveText('HTTP 200');
  await expect(preview.locator('.result-title')).toHaveText(/默认响应/);

  // ---- 注册后按真实 HTTP 分发验证同样的三种结果 ----
  await drawer.getByRole('button', { name: /注册接口/ }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('.route-card', { hasText: DEMO_PATH })).toBeVisible();

  const status = (path: string) => page.evaluate(async (p) => (await fetch(p)).status, path);
  expect(await status(DEMO_PATH)).toBe(404);
  expect(await status(`${DEMO_PATH}?tenantId=acme&region=cn-north`)).toBe(409);
  expect(await status(`${DEMO_PATH}?tenantId=acme&region=cn-south`)).toBe(200);
  /* 正则不匹配 → 准入失败 404 */
  expect(await status(`${DEMO_PATH}?tenantId=acme&region=us`)).toBe(404);

  // 清理：删除接口
  await request.delete(`/__polymock/routes?method=GET&path=${encodeURIComponent(DEMO_PATH)}`);
});

/**
 * 响应分支排序：分支标签支持拖动排序（不再使用上下箭头），
 * 顺序即匹配优先级，注册后第一个命中的生效。
 */
test('响应分支：拖动标签调整匹配顺序，第一个命中的分支生效', async ({ page, request }) => {
  const ORDER_PATH = '/api/e2e-order';
  await request.delete(`/__polymock/routes?method=GET&path=${encodeURIComponent(ORDER_PATH)}`);

  await page.goto('/');
  await page.getByRole('button', { name: /新增接口/ }).click();
  const drawer = page.getByRole('dialog', { name: '接口编辑表单' });
  await drawer.getByLabel('接口名称').fill('E2E 分支顺序');
  await drawer.locator('#f-path').fill(ORDER_PATH);
  await drawer.locator('#f-resp-body').fill('{"scope":"default"}');

  // 两个分支条件完全相同（x=1），谁排在前面谁生效
  const branches = [
    { name: '第一优先', body: '{"scope":"first"}' },
    { name: '第二优先', body: '{"scope":"second"}' },
  ] as const;
  for (const branch of branches) {
    await drawer.getByRole('button', { name: /新增分支/ }).click();
    await drawer.locator('#f-scene-name').fill(branch.name);
    const panel = drawer.locator('.branch-editor .subpanel').first();
    await panel.getByRole('button', { name: /添加条件/ }).click();
    const row = panel.locator('.cond-row').first();
    await row.locator('.cond-key').fill('x');
    await row.locator('.cond-value').fill('1');
    await drawer.locator('#f-resp-body').fill(branch.body);
  }

  const tabs = drawer.locator('.branch-tab');
  await expect(tabs).toHaveText([/默认响应/, /第一优先/, /第二优先/]);

  // 把「第二优先」拖到「第一优先」之前
  await tabs.nth(2).dragTo(tabs.nth(1));
  await expect(tabs).toHaveText([/默认响应/, /第二优先/, /第一优先/]);

  // 默认响应固定在最后兜底、不参与拖动：拖动它不应改变顺序
  await tabs.nth(0).dragTo(tabs.nth(2));
  await expect(tabs).toHaveText([/默认响应/, /第二优先/, /第一优先/]);

  // 键盘：聚焦标签后用 ← / → 连续移动（移动后焦点仍在同一标签上，不需重新聚焦）
  await tabs.nth(2).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs).toHaveText([/默认响应/, /第一优先/, /第二优先/]);
  await page.keyboard.press('ArrowRight');
  await expect(tabs).toHaveText([/默认响应/, /第二优先/, /第一优先/]);

  await drawer.getByRole('button', { name: /注册接口/ }).click();
  await expect(drawer).toBeHidden();

  // 真实分发：命中拖动后排在前的「第二优先」
  const body = await page.evaluate(async (p) => (await (await fetch(p)).json()) as { scope?: string }, `${ORDER_PATH}?x=1`);
  expect(body).toEqual({ scope: 'second' });

  await request.delete(`/__polymock/routes?method=GET&path=${encodeURIComponent(ORDER_PATH)}`);
});
