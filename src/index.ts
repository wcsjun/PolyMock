#!/usr/bin/env node
import { createApp } from './server/app.js';
import { ServiceManager } from './server/manager.js';
import { RequestLogStore } from './server/request-log.js';
import { RouteRegistry } from './registry.js';
import { loadState, saveState } from './store.js';
import { DEFAULT_SERVICE_ID, resolveMainPort, resolveMode } from './types.js';

const configFile = process.env.POLYMOCK_CONFIG_FILE ?? 'polymock.config.json';

/* 监听地址：未设置 POLYMOCK_HOST 时保持原行为（监听全部网卡） */
const host = process.env.POLYMOCK_HOST;
/* 管理令牌：设置后 /__polymock 全部接口需鉴权（空串视为未设置） */
const adminToken = process.env.POLYMOCK_ADMIN_TOKEN || undefined;
/* 代理白名单：逗号分隔 host 列表（如 localhost,127.0.0.1），空串视为未设置 */
const proxyAllowHosts = process.env.POLYMOCK_PROXY_ALLOW
  ? process.env.POLYMOCK_PROXY_ALLOW.split(',').map((h) => h.trim()).filter(Boolean)
  : undefined;
/* 运行模式：POLYMOCK_MODE=path 时所有服务经主端口 basePath 前缀分发（Docker 友好）；缺省独立端口 */
const mode = resolveMode(process.env);

const state = loadState(configFile);
const registry = new RouteRegistry(state);
registry.on('change', () => saveState(configFile, registry.toJSON()));

/* 主端口：POLYMOCK_PORT > 配置文件 default 服务端口 > DEFAULT_PORT（改端口编辑配置文件即可，无需改源码） */
const port = resolveMainPort(process.env, state);

/* 旧配置兼容：为缺失/非法 basePath 的非默认服务自动补齐前缀（触发 change 事件落盘） */
registry.ensureBasePaths();

const defaultService = registry.getService(DEFAULT_SERVICE_ID);
if (defaultService) {
  /* 仅环境变量显式指定时回写配置，保持文件与实际监听端口一致 */
  if (process.env.POLYMOCK_PORT && defaultService.port !== port) {
    defaultService.port = port;
    registry.emit('change');
  }
} else {
  registry.addService('默认服务', port, DEFAULT_SERVICE_ID);
}

/* findAny：默认路由即使被禁用也不重新播种；旧配置中无名称的默认路由补一个展示名称 */
const helloRoute = registry.findAny(DEFAULT_SERVICE_ID, 'GET', '/api/hello');
if (!helloRoute) {
  registry.add(DEFAULT_SERVICE_ID, 'GET', '/api/hello', {
    status: 200,
    body: { message: 'Hello from PolyMock', hint: '在控制台新增你的接口' },
  }, '默认示例接口');
} else if (!helloRoute.name) {
  registry.update(helloRoute.id, { name: '默认示例接口' });
}

const logs = new RequestLogStore();
/* 有状态 CRUD 共享存储与 id 计数：主应用（默认服务 / 路径模式）与各独立端口服务共用同一份，
   键为 serviceId + 集合路径，跨服务相互隔离；管理端 GET/DELETE /__polymock/crud 读取与清空 */
const crudStores = new Map<string, Map<string, Record<string, unknown>>>();
const crudCounters = new Map<string, number>();
const manager = new ServiceManager(registry, { logs, crudStores, crudCounters }, { singlePort: mode === 'path' });
void manager.startAll(registry.listServices().filter((s) => s.id !== DEFAULT_SERVICE_ID));

const app = createApp(registry, manager, { mainPort: port, logs, adminToken, proxyAllowHosts, mode, crudStores, crudCounters });

/* 回环地址集合：host 为这些值时管理 API 不暴露给外部网络 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const onListening = () => {
  console.log('PolyMock 已启动');
  console.log(`  Web UI   -> http://localhost:${port}`);
  console.log(`  管理 API -> http://localhost:${port}/__polymock/routes`);
  console.log(`  配置文件 -> ${configFile}`);
  if (mode === 'path') {
    console.log('  运行模式 -> path（非默认服务按 /{basePath} 前缀经主端口分发）');
  }
  if (host && !LOOPBACK_HOSTS.has(host) && !adminToken) {
    console.warn('  警告：管理 API 暴露在非回环地址且未设置管理令牌，存在安全风险');
  }
};

if (host) {
  app.listen(port, host, onListening);
} else {
  app.listen(port, onListening);
}
