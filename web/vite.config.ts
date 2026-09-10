import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { resolveMainPort } from '../src/types';

// root 固定为本文件所在目录（web/），保证从仓库任意目录用 -c 调用时路径一致
const root = fileURLToPath(new URL('.', import.meta.url));

/* dev 代理端口与后端同一解析规则（resolveMainPort）：POLYMOCK_PORT > 配置文件 default 服务端口 > DEFAULT_PORT */
function backendPort(): number {
  try {
    const configFile = process.env.POLYMOCK_CONFIG_FILE ?? 'polymock.config.json';
    // 与后端 loadState 一致：相对路径基于进程 cwd 解析
    const state = JSON.parse(fs.readFileSync(path.resolve(configFile), 'utf8'));
    return resolveMainPort(process.env, state);
  } catch {
    // 配置文件缺失/损坏时退化为：环境变量 > DEFAULT_PORT
    return resolveMainPort(process.env, {});
  }
}

export default defineConfig({
  root,
  plugins: [vue()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/__polymock': `http://localhost:${backendPort()}`,
    },
  },
});
