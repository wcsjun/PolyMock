import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchServices, getAdminToken, setAdminToken } from './api';

/** api.ts 依赖浏览器 localStorage / fetch：测试里用最小桩替代，验证令牌存取与 401 提示 */

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
  );
}

describe('管理令牌存取', () => {
  it('未设置时返回空串', () => {
    expect(getAdminToken()).toBe('');
  });

  it('保存后读取到令牌，传空串清除', () => {
    setAdminToken('secret');
    expect(getAdminToken()).toBe('secret');
    expect(store.get('polymock:token')).toBe('secret');

    setAdminToken('');
    expect(getAdminToken()).toBe('');
    expect(store.has('polymock:token')).toBe(false);
  });

  it('令牌随管理请求发送到 x-polymock-token 头', async () => {
    setAdminToken('secret');
    stubFetch(200, { ok: true, services: [] });
    await fetchServices();
    const init = (vi.mocked(fetch).mock.calls[0][1] ?? {}) as RequestInit;
    expect(new Headers(init.headers).get('x-polymock-token')).toBe('secret');
  });
});

describe('错误提示', () => {
  it('401 提示用户去侧边栏填写令牌', async () => {
    stubFetch(401, { ok: false, error: '需要管理令牌（x-polymock-token 头或 ?token= 参数）' });
    await expect(fetchServices()).rejects.toThrow(/需要管理令牌.*左侧栏「管理令牌」/);
  });

  it('其他错误保持后端文案不变', async () => {
    stubFetch(500, { ok: false, error: '内部错误' });
    await expect(fetchServices()).rejects.toThrow('内部错误');
  });
});
