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
