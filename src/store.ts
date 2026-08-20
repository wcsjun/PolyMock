import fs from 'node:fs';
import path from 'node:path';
import type { PersistedState } from './types.js';

const EMPTY: PersistedState = { version: 1, services: [], routes: [] };

export function loadState(filePath: string): PersistedState {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return EMPTY;
  }
  try {
    const data = JSON.parse(raw);
    return {
      version: 1,
      services: Array.isArray(data?.services) ? data.services : [],
      routes: Array.isArray(data?.routes) ? data.routes : [],
    };
  } catch (err) {
    console.error(`[PolyMock] 配置文件解析失败（${filePath}），按空配置启动:`, err);
    return EMPTY;
  }
}

export function saveState(filePath: string, state: PersistedState): void {
  try {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error(`[PolyMock] 配置保存失败（${filePath}）:`, err);
  }
}
