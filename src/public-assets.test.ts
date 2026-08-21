import fs from 'node:fs';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';

const readPublicFile = (name: string): string =>
  fs.readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

const appSource = readPublicFile('app.js');
const htmlSource = readPublicFile('index.html');

describe('public 前端资源完整性', () => {
  it('app.js 语法可编译（无 SyntaxError）', () => {
    expect(() => new Script(appSource)).not.toThrow();
  });

  it('index.html 引用的静态资源存在', () => {
    const refs = [...htmlSource.matchAll(/(?:href|src)="\/([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(() => fs.accessSync(new URL(`../public/${ref}`, import.meta.url))).not.toThrow();
    }
  });

  it('app.js 中引用的元素 id 都存在于 index.html', () => {
    const ids = [...appSource.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(htmlSource, `index.html 缺少 id="${id}"`).toContain(`id="${id}"`);
    }
  });
});
