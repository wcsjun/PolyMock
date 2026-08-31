import { test, expect } from '@playwright/test';

/**
 * 请求日志：命中默认接口 /api/hello 的请求出现在日志列表，并提供「清空」入口
 */
test('请求日志视图：/api/hello 条目出现且「清空」按钮可用', async ({ page, request }) => {
  // 先制造一条命中 /api/hello 的请求
  const res = await request.get('/api/hello');
  expect(res.status()).toBe(200);

  await page.goto('/');

  // 切换到「请求日志」视图
  await page.getByRole('button', { name: /请求日志/ }).click();

  // 日志列表出现 /api/hello 条目，「清空」按钮可见且可用（有条目时才可用）
  await expect(page.locator('.log-row', { hasText: '/api/hello' })).toBeVisible();
  const clearBtn = page.getByRole('button', { name: '清空' });
  await expect(clearBtn).toBeVisible();
  await expect(clearBtn).toBeEnabled();

  // 清理：清空请求日志，避免残留影响其他用例
  await request.delete('/__polymock/requests');
});
