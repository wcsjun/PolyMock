import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, DEFAULT_SERVICE_ID, resolveMainPort, resolveMode, slugifyBasePath } from './types.js';

describe('resolveMainPort 主端口解析', () => {
  type PortState = Parameters<typeof resolveMainPort>[1];
  const stateWithDefaultPort = (port: number): PortState => ({
    services: [{ id: DEFAULT_SERVICE_ID, port }],
  });

  it('环境变量优先于配置文件与默认值', () => {
    expect(resolveMainPort({ POLYMOCK_PORT: '6000' }, stateWithDefaultPort(5000))).toBe(6000);
  });

  it('未设置环境变量时取配置文件 default 服务端口', () => {
    expect(resolveMainPort({}, stateWithDefaultPort(5000))).toBe(5000);
    const mixed: PortState = {
      services: [
        { id: 'other', port: 5001 },
        { id: DEFAULT_SERVICE_ID, port: 5000 },
      ],
    };
    expect(resolveMainPort({}, mixed)).toBe(5000);
  });

  it('配置无 default 服务或缺配置时回退 DEFAULT_PORT', () => {
    expect(resolveMainPort({}, { services: [] })).toBe(DEFAULT_PORT);
    expect(resolveMainPort({}, {})).toBe(DEFAULT_PORT);
  });

  it('非法输入逐级回退', () => {
    // 环境变量空串/非数字/越界 → 用配置文件端口
    for (const invalid of ['', 'abc', '0', '70000']) {
      expect(resolveMainPort({ POLYMOCK_PORT: invalid }, stateWithDefaultPort(5000))).toBe(5000);
    }
    // 配置端口越界/非整数 → DEFAULT_PORT
    for (const invalid of [0, -1, 70000, 1.5]) {
      expect(resolveMainPort({}, stateWithDefaultPort(invalid))).toBe(DEFAULT_PORT);
    }
    // 环境变量非法且无 default 服务 → DEFAULT_PORT
    expect(resolveMainPort({ POLYMOCK_PORT: 'abc' }, { services: [] })).toBe(DEFAULT_PORT);
  });

  it('合法边界端口可用', () => {
    expect(resolveMainPort({ POLYMOCK_PORT: '1' }, { services: [] })).toBe(1);
    expect(resolveMainPort({ POLYMOCK_PORT: '65535' }, { services: [] })).toBe(65535);
  });
});

describe('主端口解析接线', () => {
  it('index.ts 通过 resolveMainPort 解析端口，不允许绕过配置文件', () => {
    const entry = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(entry).toContain('resolveMainPort(process.env, state)');
    expect(entry).not.toContain('?? DEFAULT_PORT');
  });
});

describe('resolveMode 运行模式解析', () => {
  it('POLYMOCK_MODE=path 时为路径模式', () => {
    expect(resolveMode({ POLYMOCK_MODE: 'path' })).toBe('path');
  });

  it('未设置或非 path 值回退端口模式', () => {
    expect(resolveMode({})).toBe('port');
    expect(resolveMode({ POLYMOCK_MODE: '' })).toBe('port');
    expect(resolveMode({ POLYMOCK_MODE: 'PATH' })).toBe('port');
    expect(resolveMode({ POLYMOCK_MODE: 'port' })).toBe('port');
    expect(resolveMode({ POLYMOCK_MODE: 'unknown' })).toBe('port');
  });
});

describe('slugifyBasePath 服务名转前缀', () => {
  it('小写化并折叠非法字符为连字符', () => {
    expect(slugifyBasePath('Order Service')).toBe('order-service');
    expect(slugifyBasePath('用户服务 User API')).toBe('user-api');
    expect(slugifyBasePath('  --Pay__V2--  ')).toBe('pay-v2');
  });

  it('纯中文等无有效字符时返回空串', () => {
    expect(slugifyBasePath('用户服务')).toBe('');
    expect(slugifyBasePath('***')).toBe('');
  });

  it('已合法的名称保持不变', () => {
    expect(slugifyBasePath('order-svc-2')).toBe('order-svc-2');
  });
});
