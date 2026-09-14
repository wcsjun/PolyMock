import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_FILE_NAME, resolveConfigFile, validateConfigFile, type PathKind } from './args.js';

const HOME = path.join('mock', 'home');
/* 全部路径视为不存在（CWD 无配置文件、显式路径为待创建文件） */
const MISSING: (p: string) => PathKind = () => 'missing';

describe('resolveConfigFile', () => {
  it('1. --config <path> CLI 参数优先', () => {
    expect(resolveConfigFile(['node', 'polymock', '--config', 'custom.json'], {}, MISSING, HOME)).toBe('custom.json');
  });

  it('1. --config=<path> 形式同样生效', () => {
    expect(resolveConfigFile(['node', 'polymock', '--config=custom.json'], {}, MISSING, HOME)).toBe('custom.json');
  });

  it('1. CLI 参数优先于环境变量', () => {
    const r = resolveConfigFile(
      ['node', 'polymock', '--config', 'from-cli.json'],
      { POLYMOCK_CONFIG_FILE: 'from-env.json' },
      MISSING,
      HOME,
    );
    expect(r).toBe('from-cli.json');
  });

  it('1. --config 缺值（末尾/空串）视为未提供，落入下一级', () => {
    expect(resolveConfigFile(['node', 'polymock', '--config'], {}, MISSING, HOME)).toBe(
      path.join(HOME, '.config', 'polymock', CONFIG_FILE_NAME),
    );
    expect(resolveConfigFile(['node', 'polymock', '--config='], {}, MISSING, HOME)).toBe(
      path.join(HOME, '.config', 'polymock', CONFIG_FILE_NAME),
    );
  });

  it('1. 显式路径以分隔符结尾视为目录，自动拼接默认配置文件名', () => {
    const dir = path.join('mock', 'conf') + path.sep;
    expect(resolveConfigFile(['node', 'polymock', '--config', dir], {}, MISSING, HOME)).toBe(
      path.join(dir, CONFIG_FILE_NAME),
    );
  });

  it('1. 显式路径已存在的目录自动拼接默认配置文件名', () => {
    const dir = path.join('mock', 'conf');
    const probe: (p: string) => PathKind = (p) => (p === dir ? 'directory' : 'missing');
    expect(resolveConfigFile(['node', 'polymock', '--config', dir], {}, probe, HOME)).toBe(
      path.join(dir, CONFIG_FILE_NAME),
    );
  });

  it('2. 无 CLI 参数时使用 POLYMOCK_CONFIG_FILE 环境变量', () => {
    const r = resolveConfigFile(
      ['node', 'polymock'],
      { POLYMOCK_CONFIG_FILE: '/data/polymock.config.json' },
      MISSING,
      HOME,
    );
    expect(r).toBe('/data/polymock.config.json');
  });

  it('2. 空串环境变量视为未设置', () => {
    expect(resolveConfigFile(['node', 'polymock'], { POLYMOCK_CONFIG_FILE: '' }, MISSING, HOME)).toBe(
      path.join(HOME, '.config', 'polymock', CONFIG_FILE_NAME),
    );
  });

  it('3. CWD 已存在 polymock.config.json 时沿用（相对路径语义不变）', () => {
    const probe: (p: string) => PathKind = (p) => (p === path.resolve(CONFIG_FILE_NAME) ? 'file' : 'missing');
    expect(resolveConfigFile(['node', 'polymock'], {}, probe, HOME)).toBe(CONFIG_FILE_NAME);
  });

  it('3. CWD 同名路径若是目录不算配置文件，落入兜底', () => {
    const probe: (p: string) => PathKind = (p) => (p === path.resolve(CONFIG_FILE_NAME) ? 'directory' : 'missing');
    expect(resolveConfigFile(['node', 'polymock'], {}, probe, HOME)).toBe(
      path.join(HOME, '.config', 'polymock', CONFIG_FILE_NAME),
    );
  });

  it('3. 环境变量优先于 CWD 已存在文件', () => {
    const probe: (p: string) => PathKind = (p) => (p === path.resolve(CONFIG_FILE_NAME) ? 'file' : 'missing');
    expect(resolveConfigFile(['node', 'polymock'], { POLYMOCK_CONFIG_FILE: 'env.json' }, probe, HOME)).toBe('env.json');
  });

  it('4. 全部落空时兜底到 ~/.config/polymock/polymock.config.json', () => {
    expect(resolveConfigFile(['node', 'polymock'], {}, MISSING, HOME)).toBe(
      path.join(HOME, '.config', 'polymock', CONFIG_FILE_NAME),
    );
  });
});

describe('validateConfigFile', () => {
  it('.json 后缀（含大写）通过', () => {
    expect(validateConfigFile('a.json')).toBeNull();
    expect(validateConfigFile('a.JSON')).toBeNull();
    expect(validateConfigFile(path.join('mock', 'conf', 'polymock.config.json'))).toBeNull();
  });

  it('非 .json 后缀或无后缀返回错误文案', () => {
    for (const p of ['a.txt', 'a', path.join('mock', 'conf')]) {
      const err = validateConfigFile(p);
      expect(err).toContain('.json');
      expect(err).toContain(p);
    }
  });
});
