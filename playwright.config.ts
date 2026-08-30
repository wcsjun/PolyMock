import { defineConfig } from '@playwright/test';

/**
 * PolyMock E2E 测试配置
 * - 所有用例共用同一个被测服务实例（workers=1），避免配置互相污染
 * - webServer 以独立临时配置文件启动 dist/index.js（端口 5919）
 */
export default defineConfig({
  // 用例目录
  testDir: './e2e',
  // 单条用例超时
  timeout: 20000,
  // 不开启文件内并行
  fullyParallel: false,
  // 单进程串行执行：共用一个服务实例，避免配置互相污染
  workers: 1,
  // 测试启动前拉起被测服务（需先 pnpm build 生成 dist 与 public）
  webServer: {
    command: 'node dist/index.js',
    url: 'http://127.0.0.1:5919/__polymock/services',
    // 本地复用已启动的实例，CI 中强制新起
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
    env: {
      POLYMOCK_PORT: '5919',
      // 使用独立临时配置文件，不污染根目录 polymock.config.json
      POLYMOCK_CONFIG_FILE: 'e2e/.tmp-polymock.json',
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:5919',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
