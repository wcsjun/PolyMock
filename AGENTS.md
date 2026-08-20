# AGENTS.md — PolyMock 协作规范

> 本文件是给 AI 编码助手的工作守则。**动手改代码前必须通读本文件。**
> 目标是：新功能不破坏旧功能、改动可验证、任何一步失败都能回滚。

## 项目概览

- 技术栈：Node.js 18+ / TypeScript（NodeNext）/ Express 5 / Vitest
- 包管理器：**pnpm**（锁定文件为 `pnpm-lock.yaml`）
- 入口：`src/index.ts`；构建产物输出到 `dist/`
- 关键行为：管理 API 挂载在 `/__polymock`；Mock 请求按 `(serviceId, method, path)` 在注册表查找响应
- 配置持久化到 `polymock.config.json`，注册表每次变更自动落盘

## 铁律（不可违反）

1. **只改与本任务相关的文件。** 禁止「顺手重构」、批量重命名、格式化无关代码、重排无关 import。
2. **保持既有契约不变：**
   - 响应字段：`ok` / `error` / `route` / `services` / `service`
   - HTTP 状态码语义：404 未注册接口、409 冲突、400 参数错误
   - 默认路由 `GET /api/hello`、默认服务 `default`、配置文件名 `polymock.config.json`
3. **改动后必须运行：**
   ```
   pnpm run typecheck
   pnpm test
   ```
   全部通过才能交付。测试失败时必须修复代码；**禁止删测试或改断言来「让测试变绿」**。
4. 不得修改 `pnpm-lock.yaml`，除非任务明确要求安装/升级依赖。
5. 涉及多文件或行为变更的改动，先给出改动计划，经确认后再实现。
6. 完成一个逻辑单元后，提示用户提交 git；**不要自行提交/推送**，除非被明确要求。
7. 前端（`public/`）是手写原生 HTML/CSS/JS。改动后必须提示用户打开 Web UI 手动验证，或给出可复现的验证步骤。

## 目录结构

```
src/
  index.ts            # 入口：装配、启动、持久化钩子
  types.ts            # 领域类型与常量
  registry.ts         # 接口注册表（纯领域逻辑，无 IO，可独立测试）
  store.ts            # 配置读写（原子写：临时文件 + rename）
  server/
    app.ts            # Express 应用组装 + Mock 请求分发
    admin.ts          # /__polymock 管理 API
    manager.ts        # 服务生命周期（启停独立端口的服务）
测试与被测文件同目录（*.test.ts），共享工具在 test-utils.ts
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | tsx watch 热启动 |
| `pnpm build` | tsc 编译到 dist |
| `pnpm start` | 运行 dist/index.js |
| `pnpm typecheck` | 类型检查（应用 + 测试） |
| `pnpm test` | 运行全部测试 |
| `pnpm test:watch` | 监听模式跑测试 |

## 数据流（后端视角）

1. `index.ts` 启动主 App，注入 `RouteRegistry` + `ServiceManager`
2. 请求进入后按优先级分发：
   - `/__polymock/*` → 管理 API（admin.ts）
   - 静态文件 → `public/`
   - 其余 → Mock 分发（app.ts `createDispatch`）按 `(serviceId, method, path)` 查表
3. 注册表 `change` 事件 → `index.ts` 自动保存配置
4. 非默认服务由 manager.ts 在独立端口监听，同样走分发逻辑

## 测试约定

- 框架：Vitest，测试与被测文件同目录（`*.test.ts`）
- **新功能必须带测试；修改行为必须同步更新测试。**
- 集成测试走真实 HTTP 请求（`fetch` + 临时端口），**禁止 mock Express 内部**，确保整条链路被验证。
- 端口类测试用 `test-utils.ts` 的 `getFreePort` 获取可用端口，避免冲突。
- `tsconfig.json` 不编译测试文件到 dist；`tsconfig.test.json` 用于对测试做类型检查。