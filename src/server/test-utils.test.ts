import express from 'express';
import { describe, expect, it } from 'vitest';
import { getFreePort, isFetchablePort, listen } from './test-utils.js';

describe('test-utils 测试端口分配', () => {
  it('isFetchablePort：undici 黑名单端口不可用，普通端口可用', () => {
    /* 黑名单抽查（含 Windows 动态端口范围内的条目 6566 / 6665-6669 / 6697） */
    for (const port of [1, 22, 69, 6000, 6566, 6666, 6669, 6697, 10080]) {
      expect(isFetchablePort(port)).toBe(false);
    }
    for (const port of [0, 33233, 49152, 65535]) {
      expect(isFetchablePort(port)).toBe(true);
    }
  });

  it('getFreePort 返回可被 fetch 访问的端口', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(isFetchablePort(await getFreePort())).toBe(true);
    }
  });

  it('listen 返回的 baseUrl 可被真实 fetch 访问（undici 不拒绝该端口）', async () => {
    const server = await listen(express());
    try {
      const port = Number(new URL(server.baseUrl).port);
      expect(isFetchablePort(port)).toBe(true);
      /* express 无路由返回 404：能拿到响应即证明 undici 未因 bad port 拒绝连接 */
      const res = await fetch(server.baseUrl);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
