import { test, expect } from '@playwright/test';

/**
 * 控制台首页冒烟：标题、侧边栏导航、服务分组面板与新增入口
 */
test('控制台首页渲染：标题、侧边栏导航与服务分组面板', async ({ page }) => {
  await page.goto('/');

  // 页面标题包含 PolyMock
  await expect(page).toHaveTitle(/PolyMock/);

  // 侧边栏三个视图导航项
  await expect(page.getByRole('button', { name: /接口管理/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /嵌入测试/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /请求日志/ })).toBeVisible();

  // 主区：服务分组面板与「＋ 新增接口」按钮
  await expect(page.getByRole('heading', { name: '服务分组' })).toBeVisible();
  await expect(page.getByRole('button', { name: /新增接口/ })).toBeVisible();
});

/**
 * 抽屉宽度：左缘拖拽调宽、localStorage 持久化、双击恢复默认
 */
test('编辑抽屉：拖拽左缘加宽并记忆，双击恢复默认', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /新增接口/ }).click();
  const panel = page.getByRole('dialog', { name: '接口编辑表单' });
  await expect(panel).toBeVisible();

  const before = (await panel.boundingBox())?.width ?? 0;
  expect(before).toBeGreaterThan(0);

  // 等待 drawer-in 入场动画（0.25s）结束，避免 boundingBox 取到平移中的坐标
  await page.waitForTimeout(400);

  // 沿左缘拖拽手柄向左拉 160px → 抽屉等量加宽
  const handle = panel.locator('.drawer-rz');
  const handleBox = (await handle.boundingBox())!;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x - 160, handleBox.y + handleBox.height / 2, { steps: 5 });
  await page.mouse.up();

  const after = (await panel.boundingBox())?.width ?? 0;
  expect(after).toBeCloseTo(before + 160, -1); // 允许钳制/取整带来的小幅偏差

  // 刷新后重新打开抽屉：宽度从 localStorage 恢复
  await page.reload();
  await page.getByRole('button', { name: /新增接口/ }).click();
  await expect(panel).toBeVisible();
  expect((await panel.boundingBox())?.width).toBeCloseTo(after, -1);

  // 双击手柄恢复 CSS 默认宽度
  await handle.dblclick();
  expect((await panel.boundingBox())?.width).toBeCloseTo(before, -1);
});

/**
 * 管理令牌入口：侧边栏设置后写入 localStorage 并显示「已设置」，清除后恢复；
 * 令牌只存本机浏览器，不写入服务端配置。
 */
test('管理令牌：侧边栏设置、刷新后记忆、可清除', async ({ page }) => {
  await page.goto('/');
  const entry = page.locator('.token-entry');
  await expect(entry).toContainText('未设置');

  await entry.click();
  const dialog = page.getByRole('dialog', { name: '管理令牌' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('令牌', { exact: true }).fill('e2e-token');
  await dialog.getByRole('button', { name: '保存' }).click();

  await expect(dialog).toBeHidden();
  await expect(entry).toContainText('已设置');
  expect(await page.evaluate(() => localStorage.getItem('polymock:token'))).toBe('e2e-token');

  // 刷新后仍然记住
  await page.reload();
  await expect(page.locator('.token-entry')).toContainText('已设置');

  // 清除后回到未设置
  await page.locator('.token-entry').click();
  await page.getByRole('dialog', { name: '管理令牌' }).getByRole('button', { name: '清除' }).click();
  await expect(page.locator('.token-entry')).toContainText('未设置');
  expect(await page.evaluate(() => localStorage.getItem('polymock:token'))).toBeNull();
});

