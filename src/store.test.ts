import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadState, saveState } from './store.js';
import { SCHEMA_VERSION, type PersistedState } from './types.js';

const EMPTY: PersistedState = { version: SCHEMA_VERSION, services: [], routes: [] };

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymock-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadState', () => {
  it('文件不存在时返回空状态', () => {
    const file = path.join(makeTmpDir(), 'missing.json');
    expect(loadState(file)).toEqual(EMPTY);
  });

  it('解析合法配置文件', () => {
    const file = path.join(makeTmpDir(), 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        services: [{ id: 'a', name: '服务A', port: 9001, createdAt: 1 }],
        routes: [
          {
            id: 'r',
            serviceId: 'a',
            protocol: 'http',
            method: 'GET',
            path: '/api/x',
            response: { status: 200, body: { ok: true } },
            createdAt: 2,
          },
        ],
      }),
    );
    const state = loadState(file);
    expect(state.services).toHaveLength(1);
    expect(state.services[0].port).toBe(9001);
    expect(state.routes).toHaveLength(1);
    expect(state.routes[0].path).toBe('/api/x');
  });

  it('JSON 损坏时返回空状态', () => {
    const file = path.join(makeTmpDir(), 'bad.json');
    fs.writeFileSync(file, '{oops');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const state = loadState(file);
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(state).toEqual(EMPTY);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('字段缺失时按空数组兜底', () => {
    const file = path.join(makeTmpDir(), 'config.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1 }));
    const state = loadState(file);
    expect(state.services).toEqual([]);
    expect(state.routes).toEqual([]);
  });

  it('settings 合法时读回，非法或缺失时兜底省略', () => {
    const file = path.join(makeTmpDir(), 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, services: [], routes: [], settings: { activeVariant: '异常场景' } }),
    );
    expect(loadState(file).settings).toEqual({ activeVariant: '异常场景' });

    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, services: [], routes: [], settings: { activeVariant: 42 } }),
    );
    expect(loadState(file).settings).toBeUndefined();

    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, services: [], routes: [], settings: 'oops' }),
    );
    expect(loadState(file).settings).toBeUndefined();
  });

  it('version 1 配置迁移到 version 2 且数据保留', () => {
    const file = path.join(makeTmpDir(), 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        services: [{ id: 'a', name: '服务A', port: 9001, createdAt: 1 }],
        routes: [
          {
            id: 'r',
            serviceId: 'a',
            protocol: 'http',
            method: 'GET',
            path: '/api/legacy',
            response: { status: 200, body: { legacy: true } },
            createdAt: 2,
          },
        ],
        settings: { activeVariant: '旧场景' },
      }),
    );
    const state = loadState(file);
    expect(state.version).toBe(2);
    expect(state.services).toHaveLength(1);
    expect(state.services[0]).toMatchObject({ id: 'a', name: '服务A', port: 9001 });
    expect(state.routes).toHaveLength(1);
    expect(state.routes[0]).toMatchObject({ path: '/api/legacy', response: { status: 200, body: { legacy: true } } });
    expect(state.settings).toEqual({ activeVariant: '旧场景' });
  });

  it('version 缺失或非法时按旧版本处理并迁移到 version 2', () => {
    const file = path.join(makeTmpDir(), 'config.json');
    fs.writeFileSync(file, JSON.stringify({ services: [{ id: 'a', name: '服务A', port: 9001, createdAt: 1 }], routes: [] }));
    const missing = loadState(file);
    expect(missing.version).toBe(2);
    expect(missing.services).toHaveLength(1);

    fs.writeFileSync(file, JSON.stringify({ version: 'oops', services: [], routes: [] }));
    expect(loadState(file).version).toBe(2);
  });
});

describe('saveState', () => {
  it('写入后可完整读回', () => {
    const file = path.join(makeTmpDir(), 'config.json');
    const state: PersistedState = {
      version: SCHEMA_VERSION,
      services: [{ id: 'a', name: '服务A', port: 9001, createdAt: 1 }],
      routes: [],
    };
    saveState(file, state);
    expect(loadState(file)).toEqual(state);
  });

  it('自动创建父目录', () => {
    const file = path.join(makeTmpDir(), 'nested', 'deep', 'config.json');
    saveState(file, EMPTY);
    expect(fs.existsSync(file)).toBe(true);
  });
});