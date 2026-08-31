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
