import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE_NAME } from './args.js';
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
    /* callbacks 缺省兜底：仅接受对象数组（元素结构由 registry / 管理端校验，此处只做形状防御） */
    if (Array.isArray(data?.callbacks)) {
      state.callbacks = data.callbacks.filter((item: unknown) => item !== null && typeof item === 'object');
    }
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
    /* 损坏保护：先把原文件整体保留为 .corrupt-<时间戳> 副本再按空配置启动，
       否则下一次注册表变更会用空状态原子覆盖原文件，原本可救的数据被静默清空 */
    const backup = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(filePath, backup);
      console.error(`[PolyMock] 配置文件解析失败（${filePath}），按空配置启动；原文件已保留为 ${backup}:`, err);
    } catch {
      /* 副本保留失败（权限等）时降级为仅日志：不影响启动，原文件保持原位 */
      console.error(`[PolyMock] 配置文件解析失败（${filePath}），按空配置启动；副本保留失败，原文件保持原位:`, err);
    }
    return EMPTY;
  }
}

export function saveState(filePath: string, state: PersistedState): void {
  try {
    const resolved = path.resolve(filePath);
    /* 预检：目标路径是已存在的目录时，rename 落盘必然失败（Windows 报 EPERM），提前给出可操作提示 */
    if (fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(
        `[PolyMock] 配置保存失败（${filePath}）: 配置路径指向已存在的目录，请指定含文件名的完整路径（例如 ${path.join(resolved, CONFIG_FILE_NAME)}）`,
      );
      return;
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error(`[PolyMock] 配置保存失败（${filePath}）:`, err);
  }
}
