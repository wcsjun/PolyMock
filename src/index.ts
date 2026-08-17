import { createApp } from './server.js';
import { RouteRegistry } from './registry.js';

const port = Number(process.env.POLYMOCK_PORT ?? 8080);
const registry = new RouteRegistry();

registry.add('GET', '/api/hello', {
  status: 200,
  body: { message: 'Hello from PolyMock', hint: '在左侧新增你的接口' },
});

createApp(registry).listen(port, () => {
  console.log('PolyMock 已启动');
  console.log(`  Web UI   -> http://localhost:${port}`);
  console.log(`  管理 API -> http://localhost:${port}/__polymock/routes`);
  console.log('  示例接口 -> http://localhost:8080/api/hello');
});
