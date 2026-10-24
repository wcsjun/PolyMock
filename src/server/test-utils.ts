import type { Express } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * fetch（undici）拒绝连接的受限端口黑名单（与 Chromium 的 restricted ports 列表一致）：
 * 端口 0 由 OS 从动态端口范围分配，偶尔会命中黑名单——服务能正常监听，但测试里的 fetch
 * 会在连接前直接抛「bad port」（cause），表现为与负载无关的偶发失败。命中时释放端口换一个重试。
 */
const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

/** 测试端口是否可被 fetch 访问（不在 undici 黑名单内） */
export function isFetchablePort(port: number): boolean {
  return !FETCH_BLOCKED_PORTS.has(port);
}

/** 单端口重试上限：防御极端环境（动态端口范围几乎全被排除）下的死循环 */
const MAX_PORT_ATTEMPTS = 20;

export function listen(app: Express): Promise<TestServer> {
  const attempt = (n: number): Promise<TestServer> =>
    new Promise((resolve, reject) => {
      if (n > MAX_PORT_ATTEMPTS) {
        reject(new Error(`连续 ${MAX_PORT_ATTEMPTS} 次分配到 fetch 黑名单端口，请检查本机动态端口范围`));
        return;
      }
      const server: Server = app.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        if (!isFetchablePort(port)) {
          server.close(() => resolve(attempt(n + 1)));
          return;
        }
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((res) => server.close(() => res())),
        });
      });
      server.on('error', reject);
    });
  return attempt(1);
}

export function getFreePort(): Promise<number> {
  const attempt = (n: number): Promise<number> =>
    new Promise((resolve, reject) => {
      if (n > MAX_PORT_ATTEMPTS) {
        reject(new Error(`连续 ${MAX_PORT_ATTEMPTS} 次分配到 fetch 黑名单端口，请检查本机动态端口范围`));
        return;
      }
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        if (!isFetchablePort(port)) {
          server.close(() => resolve(attempt(n + 1)));
          return;
        }
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
  return attempt(1);
}
