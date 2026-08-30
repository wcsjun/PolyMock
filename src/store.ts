import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, type PersistedState } from './types.js';

const EMPTY: PersistedState = { version: SCHEMA_VERSION, services: [], routes: [] };

/**
 * 版本迁移：把旧版本状态升级到当前版本。
 * 1 -> 2：无字段变化，迁移动作 = 标记 version: 2 并保留数据；
 * 未来版本（2 -> 3 ...）在此按旧版本号逐级扩展迁移逻辑。
 */
function migrate(state: PersistedState): PersistedState {
  return { ...state, version: SCHEMA_VERSION };
}

export function loadState(filePath: string): PersistedState {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return EMPTY;
  }
  try {
    const data = JSON.parse(raw);
    const state: PersistedState = {
      version: SCHEMA_VERSION,
      services: Array.isArray(data?.services) ? data.services : [],
      routes: Array.isArray(data?.routes) ? data.routes : [],
    };
    /* settings 缺省兜底：仅在接受对象且 activeVariant 为字符串或 null 时保留 */
    const rawSettings = data?.settings;
    if (rawSettings !== null && typeof rawSettings === 'object') {
      const activeVariant = (rawSettings as { activeVariant?: unknown }).activeVariant;
      if (typeof activeVariant === 'string' || activeVariant === null) {
        state.settings = { activeVariant };
      }
    }
    /* 非法/缺失 version 按 1（旧版本）处理，统一走迁移后返回 */
    if (data?.version !== SCHEMA_VERSION) {
      return migrate(state);
    }
    return state;
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
