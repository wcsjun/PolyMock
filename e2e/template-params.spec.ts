import { test, expect } from '@playwright/test';

const ROUTE_PATH = '/api/e2e/users/:id';
const REQUEST_PATH = '/api/e2e/users/e2e42';

/**
 * 路径参数 + 响应模板：管理 API 注册 GET /api/e2e/users/:id（响应 body 用 {{params.id}} 注入），
 * 实际请求 e2e42 后返回 { userId: 'e2e42' }，并在「请求日志」视图中留下记录
 */
test('路径参数模板：{{params.id}} 注入响应并出现在请求日志', async ({ page, request }) => {
  // 预清理：删除上次运行可能残留的同名接口，保证用例可重复执行
  await request.delete(`/__polymock/routes?method=GET&path=${encodeURIComponent(ROUTE_PATH)}`);

  // 通过 request fixture 调管理 API 注册带路径参数模板的接口
  const created = await request.post('/__polymock/routes', {
    data: {
      name: 'E2E 路径参数模板',
      method: 'GET',
      path: ROUTE_PATH,
      response: { status: 200, body: { userId: '{{params.id}}' } },
    },
  });
  expect(created.status()).toBe(201);

  // 请求具体 id，响应模板应注入 params.id
  const res = await request.get(REQUEST_PATH);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ userId: 'e2e42' });

  // 打开「请求日志」视图，断言列表出现该请求
  await page.goto('/');
  await page.getByRole('button', { name: /请求日志/ }).click();
  await expect(page.locator('.log-row', { hasText: REQUEST_PATH })).toBeVisible();

  // 清理：删除接口并清空请求日志
  await request.delete(`/__polymock/routes?method=GET&path=${encodeURIComponent(ROUTE_PATH)}`);
  await request.delete('/__polymock/requests');
});
