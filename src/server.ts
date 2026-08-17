import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteRegistry } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export function createApp(registry: RouteRegistry): express.Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // ---- 管理 API ----
  app.get('/__polymock/routes', (_req, res) => {
    res.json({ ok: true, routes: registry.list() });
  });

  app.post('/__polymock/routes', (req, res) => {
    const { method, path: routePath, response } = req.body ?? {};
    if (typeof method !== 'string' || typeof routePath !== 'string' || !routePath.startsWith('/')) {
      res.status(400).json({ ok: false, error: 'method 与 path 均为必填字符串，path 需以 / 开头' });
      return;
    }
    if (registry.find(method, routePath)) {
      res.status(409).json({ ok: false, error: `接口 ${method.toUpperCase()} ${routePath} 已存在` });
      return;
    }

    let body: unknown = response?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        res.status(400).json({ ok: false, error: 'response.body 不是合法的 JSON' });
        return;
      }
    }

    const route = registry.add(method, routePath, {
      status: response?.status ?? 200,
      contentType: typeof response?.contentType === 'string' ? response.contentType : undefined,
      body,
    });
    res.status(201).json({ ok: true, route });
  });

  app.delete('/__polymock/routes', (req, res) => {
    const method = typeof req.query.method === 'string' ? req.query.method : '';
    const routePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!method || !routePath) {
      res.status(400).json({ ok: false, error: '缺少 method 或 path 参数' });
      return;
    }
    res.json({ ok: registry.remove(method, routePath) });
  });

  // ---- Web UI 静态资源 ----
  app.use(express.static(PUBLIC_DIR));

  // ---- Mock 接口分发 ----
  app.use((req, res) => {
    const route = registry.find(req.method, req.path);
    if (!route) {
      res.status(404).json({ ok: false, error: `未注册接口: ${req.method} ${req.path}` });
      return;
    }
    if (route.response.contentType) {
      res.type(route.response.contentType);
    }
    res.status(route.response.status).json(route.response.body);
  });

  return app;
}
