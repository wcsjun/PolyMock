import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminRouter } from './admin.js';
import type { ServiceManager } from './manager.js';
import type { RouteRegistry } from '../registry.js';
import { DEFAULT_SERVICE_ID } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

export interface MainAppOptions {
  mainPort: number;
}

export function createDispatch(registry: RouteRegistry, serviceId: string): express.RequestHandler {
  return (req, res) => {
    const route = registry.find(serviceId, req.method, req.path);
    if (!route) {
      res.status(404).json({ ok: false, error: `未注册接口: ${req.method} ${req.path}` });
      return;
    }
    if (route.response.contentType) {
      res.type(route.response.contentType);
    }
    res.status(route.response.status).json(route.response.body);
  };
}

export function createApp(registry: RouteRegistry, manager: ServiceManager, options: MainAppOptions): express.Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // ---- 管理 API ----
  app.use('/__polymock', createAdminRouter(registry, manager, { mainPort: options.mainPort }));

  // ---- Web UI 静态资源 ----
  app.use(express.static(PUBLIC_DIR));

  // ---- Mock 接口分发（默认服务 = 主端口）----
  app.use(createDispatch(registry, DEFAULT_SERVICE_ID));

  return app;
}

export function createRouteApp(registry: RouteRegistry, serviceId: string): express.Express {
  const app = express();
  app.use(createDispatch(registry, serviceId));
  return app;
}