import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 集成测试在真实端口上起 HTTP 服务（fetch + 临时端口），测试文件并行执行时
  // Windows 下存在偶发端口竞态（fetch failed: bad port / 端口被并行 worker 抢占），
  // 串行执行文件内仍保留并发，代价是总时长略增，换取整套测试稳定可重复。
  fileParallelism: false,
});
