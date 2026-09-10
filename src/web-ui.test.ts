import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 前端源码完整性检查。
 *
 * 前端已迁移为 Vue 3 + Vite（源码在 web/，构建产物输出到 public/）。
 * 本测试只读 web/ 源码，不依赖任何构建产物 —— 保证在全新克隆
 * （未执行过 pnpm build）上也能通过。
 */

const webRoot = new URL('../web/', import.meta.url);
const readWebFile = (rel: string): string => fs.readFileSync(new URL(rel, webRoot), 'utf8');

describe('web 前端源码完整性', () => {
  it('web/index.html 存在且包含 Vue 挂载点与入口脚本', () => {
    const html = readWebFile('index.html');
    expect(html).toContain('<div id="app">');
    expect(html).toMatch(/<script[^>]+type="module"[^>]+src="\/src\/main\.ts"/);
  });

  it('web/src/main.ts 创建并挂载 Vue 应用，且引入全局样式', () => {
    const main = readWebFile('src/main.ts');
    expect(main).toContain('createApp');
    expect(main).toContain(".mount('#app')");
    expect(main).toMatch(/\.css'/);
  });

  it('关键组件与工具文件齐全', () => {
    for (const rel of [
      'src/App.vue',
      'src/api.ts',
      'src/types.ts',
      'src/utils.ts',
      'src/styles/global.css',
      'src/components/ServicePanel.vue',
      'src/components/RouteCard.vue',
      'src/components/RouteForm.vue',
      'src/components/EmbedTest.vue',
    ]) {
      expect(() => fs.accessSync(new URL(rel, webRoot)), `缺少文件 ${rel}`).not.toThrow();
    }
  });

  it('favicon 资源位于 web/public（构建时拷贝到产物目录）', () => {
    expect(() => fs.accessSync(new URL('public/favicon.svg', webRoot))).not.toThrow();
    expect(() => fs.accessSync(new URL('public/favicon.ico', webRoot))).not.toThrow();
  });

  it('vite 构建契约：产物输出 ../public 且代理端口与后端共用 resolveMainPort', () => {
    const cfg = readWebFile('vite.config.ts');
    expect(cfg).toContain("'../public'");
    expect(cfg).toContain('emptyOutDir: true');
    // 代理端口必须与后端同一解析规则（src/types.ts resolveMainPort），禁止硬编码端口
    expect(cfg).toContain("from '../src/types'");
    expect(cfg).toContain('resolveMainPort');
    expect(cfg).toContain('POLYMOCK_CONFIG_FILE');
    expect(cfg).not.toMatch(/localhost:\d+/);
  });
});
