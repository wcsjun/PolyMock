import { test, expect } from '@playwright/test';

const WS_PATH = '/ws/e2e-push';

/**
 * WS 主链路：抽屉建 WS 接口 → 真实浏览器连接 → 收到 onOpen → 发送回显 → 停用后握手失败
 */
test('WS 接口：创建 / 调试台连接 / 回显 / 停用后握手失败', async ({ page, request }) => {
  // 预清理：删除上次运行可能残留的同名接口，保证用例可重复执行
  await request.delete(`/__polymock/routes?method=WS&path=${encodeURIComponent(WS_PATH)}`);

  await page.goto('/');

  // 点「＋ 新增 WS 接口」打开 WS 编辑抽屉（role=dialog，aria-label=WS 接口编辑表单）
  await page.getByRole('button', { name: /新增 WS 接口/ }).click();
  const drawer = page.getByRole('dialog', { name: 'WS 接口编辑表单' });
  await expect(drawer).toBeVisible();

  // 填名称与路径，配置一条 onOpen 推送与 echo 回包
  await drawer.getByLabel('名称').fill('E2E推送');
  await drawer.locator('#f-ws-path').fill(WS_PATH);
  const firstBody = drawer.getByLabel('第 1 条推送内容');
  await expect(firstBody).toBeVisible();
  await firstBody.fill('{"type":"hello","ts":"{{$now}}"}');
  await drawer.locator('#f-ws-reply-mode').selectOption('echo');

  // 提交创建
  await drawer.getByRole('button', { name: /创建 WS 接口/ }).click();
  await expect(drawer).toBeHidden();

  // 接口管理列表出现 WS 卡片（紫色 WS 徽章 + 摘要行）
  const card = page.locator('.route-card', { hasText: WS_PATH });
  await expect(card).toBeVisible();
  await expect(card.locator('.method-badge')).toHaveText('WS');
  await expect(card.locator('.ws-summary')).toContainText('onOpen 1 步');
  await expect(card.locator('.ws-summary')).toContainText('收到回显');

  // 卡片 ⇄ 按钮跳转到 WS 调试台并选中该接口
  await card.getByRole('button', { name: `在 WS 调试台打开 WS ${WS_PATH}` }).click();
  const debugView = page.locator('#view-ws-debug');
  await expect(debugView).toBeVisible();
  await expect(debugView.locator('#dbg-route')).toHaveValue(/\S/);
  await expect(debugView.locator('#dbg-url')).toHaveValue(new RegExp(`${WS_PATH.replace(/\//g, '\\/')}$`));

  // 真实浏览器 WebSocket 连接
  await debugView.getByRole('button', { name: '连接' }).click();
  await expect(debugView.locator('.frame', { hasText: '握手成功 101' })).toBeVisible();

  // onOpen 推送到达（模板 {{$now}} 已渲染为 ISO 时间）
  const helloFrame = debugView.locator('.frame', { hasText: '"type":"hello"' });
  await expect(helloFrame).toBeVisible();

  // 断开后重连（携带 query 验证地址可编辑），发送消息 → echo 原样回显：一出一入两条帧
  await debugView.locator('#dbg-url').fill(`${await debugView.locator('#dbg-url').inputValue()}?orderId=A1001`);
  await debugView.getByRole('button', { name: '断开' }).click();
  await expect(debugView.locator('.frame', { hasText: '客户端主动断开' })).toBeVisible();
  await debugView.getByRole('button', { name: '连接', exact: true }).click();
  await expect(debugView.locator('.frame', { hasText: '握手成功 101' }).last()).toBeVisible();
  await debugView.getByLabel('发送内容').fill('{"type":"ping","orderId":"A1001"}');
  await debugView.getByRole('button', { name: '发送' }).click();
  await expect(debugView.locator('.frame:has(.frame-dir.out)', { hasText: '"type":"ping"' })).toBeVisible();
  await expect(debugView.locator('.frame:has(.frame-dir.in)', { hasText: '"type":"ping"' })).toBeVisible();

  // 停用后：卡片显示已停用，存量连接被 1012 关闭，新握手失败（404 关闭）
  await page.locator('.nav-item', { hasText: '接口管理' }).click();
  await card.locator('label.route-disable').click();
  await expect(card.locator('.route-chip.off')).toHaveText('已停用');

  await page.locator('.nav-item', { hasText: 'WS 调试台' }).click();
  await expect(debugView.locator('.frame', { hasText: '1012' })).toBeVisible({ timeout: 10000 });
  await debugView.getByRole('button', { name: '连接', exact: true }).click();
  await expect(debugView.locator('.frame', { hasText: '握手失败' })).toBeVisible({ timeout: 10000 });
});
