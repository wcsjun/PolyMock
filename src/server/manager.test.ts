import { afterEach, describe, expect, it } from 'vitest';
import { RouteRegistry } from '../registry.js';
import { DEFAULT_SERVICE_ID, type Service } from '../types.js';
import { ServiceManager } from './manager.js';
import { getFreePort } from './test-utils.js';

describe('ServiceManager', () => {
  const registry = new RouteRegistry();
  registry.addService('默认服务', 8080, DEFAULT_SERVICE_ID);
  const manager = new ServiceManager(registry);
  const started: string[] = [];

  afterEach(async () => {
    for (const id of started.splice(0)) {
      await manager.stop(id);
    }
  });

  it('启动后 isRunning 为 true，独立端口可访问 Mock 接口', async () => {
    const port = await getFreePort();
    registry.addService('独立服务', port, 'svc');
    started.push('svc');
    const service = registry.getService('svc') as Service;

    await manager.start(service);
    expect(manager.isRunning('svc')).toBe(true);

    registry.add('svc', 'GET', '/ping', { status: 200, body: { pong: true } });
    const res = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  it('重复启动幂等，不重复监听', async () => {
    const port = await getFreePort();
    registry.addService('独立服务2', port, 'svc2');
    started.push('svc2');
    const service = registry.getService('svc2') as Service;

    await manager.start(service);
    await manager.start(service);
    expect(manager.isRunning('svc2')).toBe(true);
  });

  it('stop 后 isRunning 为 false，端口释放', async () => {
    const port = await getFreePort();
    registry.addService('独立服务3', port, 'svc3');
    started.push('svc3');
    const service = registry.getService('svc3') as Service;

    await manager.start(service);
    await manager.stop('svc3');
    expect(manager.isRunning('svc3')).toBe(false);
  });
});