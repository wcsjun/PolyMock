import express from 'express';
import type { ServiceManager } from './manager.js';
import type { RouteRegistry } from './registry.js';
import { DEFAULT_SERVICE_ID, type Route } from './types.js';

export interface AdminOptions {
  mainPort: number;
}

export function createAdminRouter(registry: RouteRegistry, manager: ServiceManager, options: AdminOptions): express.Router {
  const router = express.Router();

  // ---- 服务分组管理 ----
  router.get('/services', (_req, res) => {
    res.json({
      ok: true,
      services: registry.listServices().map((service) => ({
        ...service,
        isDefault: service.id === DEFAULT_SERVICE_ID,
        running: service.id === DEFAULT_SERVICE_ID ? true : manager.isRunning(service.id),
        count: registry.list(service.id).length,
      })),
    });
  });

  router.post('/services', async (req, res) => {
    const { name, port } = req.body ?? {};
    const serviceName = typeof name === 'string' ? name.trim() : '';
    const servicePort = Number(port);

    if (!serviceName) {
      res.status(400).json({ ok: false, error: '服务名称不能为空' });
      return;
    }
    if (!Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65535) {
      res.status(400).json({ ok: false, error: '端口需为 1-65535 的整数' });
      return;
    }
    if (servicePort === options.mainPort) {
      res.status(409).json({ ok: false, error: `端口 ${servicePort} 与主服务（默认服务）端口冲突` });
      return;
    }
    if (registry.findServiceByPort(servicePort)) {
      res.status(409).json({ ok: false, error: `端口 ${servicePort} 已被其他服务占用` });
      return;
    }
    if (registry.listServices().some((s) => s.name === serviceName)) {
      res.status(409).json({ ok: false, error: `服务名称「${serviceName}」已存在` });
      return;
    }

    const service = registry.addService(serviceName, servicePort);
    try {
      await manager.start(service);
    } catch (err) {
      registry.removeService(service.id);
      res.status(409).json({ ok: false, error: `端口 ${servicePort} 启动失败（可能已被占用）: ${(err as Error).message}` });
      return;
    }
    res.status(201).json({ ok: true, service });
  });

  router.delete('/services/:id', async (req, res) => {
    const serviceId = req.params.id;
    if (serviceId === DEFAULT_SERVICE_ID) {
      res.status(400).json({ ok: false, error: '默认服务不可删除' });
      return;
    }
    await manager.stop(serviceId);
    res.json({ ok: registry.removeService(serviceId) });
  });

  // ---- 管理 API（接口注册）----
  router.get('/routes', (req, res) => {
    const serviceId = typeof req.query.serviceId === 'string' ? req.query.serviceId : undefined;
    res.json({ ok: true, routes: registry.list(serviceId) });
  });

  router.post('/routes', (req, res) => {
    const { serviceId, method, path: routePath, response } = req.body ?? {};
    if (typeof method !== 'string' || typeof routePath !== 'string' || !routePath.startsWith('/')) {
      res.status(400).json({ ok: false, error: 'method 与 path 均为必填字符串，path 需以 / 开头' });
      return;
    }

    const sid = typeof serviceId === 'string' && serviceId ? serviceId : DEFAULT_SERVICE_ID;
    if (sid !== DEFAULT_SERVICE_ID && !registry.getService(sid)) {
      res.status(400).json({ ok: false, error: '服务分组不存在' });
      return;
    }
    if (registry.find(sid, method, routePath)) {
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

    const route = registry.add(sid, method, routePath, {
      status: response?.status ?? 200,
      contentType: typeof response?.contentType === 'string' ? response.contentType : undefined,
      body,
    });
    res.status(201).json({ ok: true, route });
  });

  router.delete('/routes', (req, res) => {
    const method = typeof req.query.method === 'string' ? req.query.method : '';
    const routePath = typeof req.query.path === 'string' ? req.query.path : '';
    const serviceId = typeof req.query.serviceId === 'string' && req.query.serviceId ? req.query.serviceId : DEFAULT_SERVICE_ID;
    if (!method || !routePath) {
      res.status(400).json({ ok: false, error: '缺少 method 或 path 参数' });
      return;
    }
    res.json({ ok: registry.remove(serviceId, method, routePath) });
  });

  router.put('/routes/:id', (req, res) => {
    const { serviceId, method, path: routePath, response } = req.body ?? {};
    const patch: Partial<Pick<Route, 'serviceId' | 'method' | 'path' | 'response'>> = {};

    if (serviceId !== undefined) {
      if (typeof serviceId !== 'string' || !serviceId) {
        res.status(400).json({ ok: false, error: 'serviceId 不合法' });
        return;
      }
      if (serviceId !== DEFAULT_SERVICE_ID && !registry.getService(serviceId)) {
        res.status(400).json({ ok: false, error: '服务分组不存在' });
        return;
      }
      patch.serviceId = serviceId;
    }
    if (method !== undefined) {
      if (typeof method !== 'string' || !method) {
        res.status(400).json({ ok: false, error: 'method 不合法' });
        return;
      }
      patch.method = method;
    }
    if (routePath !== undefined) {
      if (typeof routePath !== 'string' || !routePath.startsWith('/')) {
        res.status(400).json({ ok: false, error: 'path 需以 / 开头的字符串' });
        return;
      }
      patch.path = routePath;
    }
    if (response !== undefined) {
      let body: unknown = response?.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          res.status(400).json({ ok: false, error: 'response.body 不是合法的 JSON' });
          return;
        }
      }
      patch.response = {
        status: response?.status ?? 200,
        contentType: typeof response?.contentType === 'string' ? response.contentType : undefined,
        body,
      };
    }

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ ok: false, error: '没有可更新的字段（serviceId / method / path / response）' });
      return;
    }

    const result = registry.update(req.params.id, patch);
    if (!result.ok) {
      if (result.error === 'not-found') {
        res.status(404).json({ ok: false, error: '接口不存在' });
      } else {
        const c = result.conflict;
        res.status(409).json({
          ok: false,
          error: `更新冲突：${c.method} ${c.path} 已存在于该服务分组`,
        });
      }
      return;
    }
    res.json({ ok: true, route: result.route });
  });

  return router;
}