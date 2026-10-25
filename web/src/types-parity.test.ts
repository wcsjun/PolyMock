import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * 类型镜像护栏：src/types.ts ↔ web/src/types.ts 是手工镜像（AGENTS 铁律 8 靠纪律维护），
 * 本测试用 TypeScript compiler API 解析两侧源码文本，机器比对共享 interface 的成员名与可选性，
 * 漏同步字段时测试变红并指名道姓。CI 跑 pnpm test 时自动生效。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_TYPES = fs.readFileSync(path.resolve(here, '../../src/types.ts'), 'utf8');
const BACKEND_WS_GATEWAY = fs.readFileSync(path.resolve(here, '../../src/server/ws-gateway.ts'), 'utf8');
const FRONTEND_TYPES = fs.readFileSync(path.resolve(here, 'types.ts'), 'utf8');

/** 两侧源码中各取一个 interface，返回成员名 → 是否可选 */
function extractMembers(...sources: string[]): (name: string) => Map<string, boolean> | undefined {
  const tables = sources.map((sourceText) => {
    const sourceFile = ts.createSourceFile('types.ts', sourceText, ts.ScriptTarget.ES2022, true);
    const table = new Map<string, Map<string, boolean>>();
    sourceFile.forEachChild((node) => {
      if (!ts.isInterfaceDeclaration(node)) return;
      const members = new Map<string, boolean>();
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.name) continue;
        members.set(member.name.getText(sourceFile), Boolean(member.questionToken));
      }
      table.set(node.name.text, members);
    });
    return table;
  });
  return (name: string) => {
    for (const table of tables) {
      const found = table.get(name);
      if (found) return found;
    }
    return undefined;
  };
}

const backendOf = extractMembers(BACKEND_TYPES, BACKEND_WS_GATEWAY);
const frontendOf = extractMembers(FRONTEND_TYPES);

/** 两侧镜像比对的目标类型（服务端分散在 types.ts 与 ws-gateway.ts，前端集中在 web/src/types.ts） */
const SHARED_TYPES = ['Route', 'WsMessage', 'WsOnMessage', 'WsBehavior', 'WsConnectionSnapshot', 'RouteAuth', 'RequestLogEntry', 'CallbackTemplate'];

/**
 * 白名单机制：两侧「有意」不同步的差异在此登记，防止护栏误报。
 * 预期保持为空（ServiceInfo / RoutePayload / ConditionRow 等前端专属类型不参与比对，无需登记）；
 * 若某字段确属有意不镜像，请在此登记并在字段注释说明原因。
 */
const PARITY_EXCEPTIONS: Record<string, { onlyFrontend?: string[]; onlyBackend?: string[]; optionalityDiff?: string[] }> = {};

/** GET /__polymock/meta 响应契约：后端无同名 interface（admin.ts 内联构造 + openapi 契约），此处按契约钉住成员 */
const PINNED_BACKEND: Map<string, Map<string, boolean>> = new Map<string, Map<string, boolean>>([
  [
    'MockMeta',
    new Map<string, boolean>([
      ['mode', false],
      ['mainPort', false],
      ['stateVersion', false],
    ]),
  ],
]);

describe('类型镜像护栏（src/types.ts ↔ web/src/types.ts）', () => {
  it('共享 interface 两侧成员名与可选性一致（漏同步时在此指名道姓）', () => {
    const problems: string[] = [];
    const check = (name: string, backend?: Map<string, boolean>, frontend?: Map<string, boolean>) => {
      if (!backend || !frontend) {
        problems.push(`${name}: ${!backend ? '后端' : '前端'}源码中找不到该 interface`);
        return;
      }
      const exception = PARITY_EXCEPTIONS[name] ?? {};
      const onlyFrontend = new Set(exception.onlyFrontend ?? []);
      const onlyBackend = new Set(exception.onlyBackend ?? []);
      const optionalityDiff = new Set(exception.optionalityDiff ?? []);
      for (const [member, optional] of backend) {
        if (onlyBackend.has(member)) continue;
        if (!frontend.has(member)) {
          problems.push(`${name}.${member}: 后端有而前端缺（如属有意不镜像，请登记 PARITY_EXCEPTIONS）`);
        } else if (frontend.get(member) !== optional && !optionalityDiff.has(member)) {
          problems.push(`${name}.${member}: 可选性不一致（后端 ${optional ? '?' : '必填'} / 前端 ${frontend.get(member) ? '?' : '必填'}）`);
        }
      }
      for (const member of frontend.keys()) {
        if (!backend.has(member) && !onlyFrontend.has(member)) {
          problems.push(`${name}.${member}: 前端有而后端无（如属有意不镜像，请登记 PARITY_EXCEPTIONS）`);
        }
      }
    };
    for (const name of SHARED_TYPES) check(name, backendOf(name), frontendOf(name));
    for (const [name, pinned] of PINNED_BACKEND) check(name, pinned, frontendOf(name));
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
