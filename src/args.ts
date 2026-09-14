import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 配置文件名契约：所有场景共用 */
export const CONFIG_FILE_NAME = 'polymock.config.json';

/** 路径类型探测结果 */
export type PathKind = 'file' | 'directory' | 'missing';

function defaultProbe(p: string): PathKind {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (st?.isDirectory()) return 'directory';
  return st?.isFile() ? 'file' : 'missing';
}

/**
 * 配置文件路径解析（优先级从高到低）：
 * 1. --config <path> / --config=<path>（CLI 参数）
 * 2. POLYMOCK_CONFIG_FILE 环境变量（Docker 镜像经此钉死到 /data 卷）
 * 3. CWD 下已存在的 polymock.config.json（兼容既有用户的项目内配置）
 * 4. ~/.config/polymock/polymock.config.json（兜底新建，避免在主目录裸跑时污染 CWD）
 *
 * 用户显式路径（1/2）的容错：以 / 或 \ 结尾、或指向已存在的目录时，
 * 自动使用该目录下的默认配置文件名（目录不存在会由 saveState 自动创建）。
 * probe / homedir 为注入参数，便于测试。
 */
export function resolveConfigFile(
  argv: string[],
  env: NodeJS.ProcessEnv,
  probe: (p: string) => PathKind = defaultProbe,
  homedir: string = os.homedir(),
): string {
  let explicit: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') {
      const value = argv[i + 1];
      if (value) {
        explicit = value;
        break;
      }
    } else if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (value) {
        explicit = value;
        break;
      }
    }
  }
  if (explicit === undefined && env.POLYMOCK_CONFIG_FILE) {
    explicit = env.POLYMOCK_CONFIG_FILE;
  }

  if (explicit !== undefined) {
    if (/[\\/]$/.test(explicit) || probe(explicit) === 'directory') {
      return path.join(explicit, CONFIG_FILE_NAME);
    }
    return explicit;
  }

  if (probe(path.resolve(CONFIG_FILE_NAME)) === 'file') return CONFIG_FILE_NAME;
  return path.join(homedir, '.config', 'polymock', CONFIG_FILE_NAME);
}

/**
 * 启动期校验：用户输入不可靠，显式指定的配置文件必须以 .json 结尾。
 * 解析本身按内容（JSON.parse）与后缀无关，但统一后缀可避免编辑器误判与
 * 「文件格式不一致」的困惑；不满足时返回错误文案，由入口打印并拒绝启动。
 */
export function validateConfigFile(filePath: string): string | null {
  if (path.extname(filePath).toLowerCase() === '.json') return null;
  return `配置文件路径需以 .json 结尾，或指向已存在的目录（自动使用目录下 ${CONFIG_FILE_NAME}）；收到：${filePath}`;
}
