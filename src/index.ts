import { createApp } from './server/app.js';
import { ServiceManager } from './server/manager.js';
import { RouteRegistry } from './registry.js';
import { loadState, saveState } from './store.js';
import { DEFAULT_SERVICE_ID } from './types.js';

const port = Number(process.env.POLYMOCK_PORT ?? 8080);
const configFile = process.env.POLYMOCK_CONFIG_FILE ?? 'polymock.config.json';

const registry = new RouteRegistry(loadState(configFile));
registry.on('change', () => saveState(configFile, registry.toJSON()));

const defaultService = registry.getService(DEFAULT_SERVICE_ID);
if (defaultService) {
  if (defaultService.port !== port) {
    defaultService.port = port;
    registry.emit('change');
  }
} else {
  registry.addService('默认服务', port, DEFAULT_SERVICE_ID);
}

if (!registry.find(DEFAULT_SERVICE_ID, 'GET', '/api/hello')) {
  registry.add(DEFAULT_SERVICE_ID, 'GET', '/api/hello', {
    status: 200,
    body: { message: 'Hello from PolyMock', hint: '在控制台新增你的接口' },
  });
}

const manager = new ServiceManager(registry);
void manager.startAll(registry.listServices().filter((s) => s.id !== DEFAULT_SERVICE_ID));

const app = createApp(registry, manager, { mainPort: port });
app.listen(port, () => {
  console.log('PolyMock 已启动');
  console.log(`  Web UI   -> http://localhost:${port}`);
  console.log(`  管理 API -> http://localhost:${port}/__polymock/routes`);
  console.log(`  配置文件 -> ${configFile}`);
});