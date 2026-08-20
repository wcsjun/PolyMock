import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadState, saveState } from './store.js';
import type { PersistedState } from './types.js';

const EMPTY: PersistedState = { version: 1, services: [], routes: [] };

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
});

describe('saveState', () => {
  it('写入后可完整读回', () => {
    const file = path.join(makeTmpDir(), 'config.json');
    const state: PersistedState = {
      version: 1,
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