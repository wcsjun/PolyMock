import { test, expect } from '@playwright/test';

const DEMO_PATH = '/api/e2e-demo';

/**
 * 接口管理主链路：打开抽屉 → 注册接口 → 列表出现卡片 → 页面内调用返回 200 → 删除后卡片消失
 */
test('新增接口：注册 /api/e2e-demo 后可调用，删除后卡片消失', async ({ page, request }) => {
  // 预清理：删除上次运行可能残留的同名接口，保证用例可重复执行
  await request.delete(`/__polymock/routes?method=GET&path=${encodeURIComponent(DEMO_PATH)}`);

  await page.goto('/');

  // 点「＋ 新增接口」打开右侧抽屉（role=dialog，aria-label=接口编辑表单）
  await page.getByRole('button', { name: /新增接口/ }).click();
  const drawer = page.getByRole('dialog', { name: '接口编辑表单' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: /注册接口/ })).toBeVisible();

  // 填接口名称与路径（默认场景响应 body 为空会被后端 400 拒绝，故填入合法 JSON）
  await drawer.getByLabel('接口名称').fill('E2E测试');
  await drawer.locator('#f-path').fill(DEMO_PATH);
  await drawer.locator('.resp-field textarea').fill('{"ok":true}');

  // 提交注册
  await drawer.getByRole('button', { name: /注册接口/ }).click();

  // 抽屉关闭，列表出现 /api/e2e-demo 卡片
  await expect(drawer).toBeHidden();
  const card = page.locator('.route-card', { hasText: DEMO_PATH });
  await expect(card).toBeVisible();

  // 页面内 fetch 该 mock 接口，应返回 200
  const status = await page.evaluate(async () => (await fetch('/api/e2e-demo')).status);
  expect(status).toBe(200);

  // 点卡片删除按钮并接受 confirm 对话框，卡片消失
  await page.once('dialog', (dialog) => void dialog.accept());
  await card.getByRole('button', { name: `删除 GET ${DEMO_PATH}` }).click();
  await expect(card).toBeHidden();
});
