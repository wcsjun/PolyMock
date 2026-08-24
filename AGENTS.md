# AGENTS.md — PolyMock 协作规范

> 本文件是给 AI 编码助手的工作守则。**动手改代码前必须通读本文件。**
> 目标是：新功能不破坏旧功能、改动可验证、任何一步失败都能回滚。

## 项目概览

- 技术栈：Node.js 18+ / TypeScript（NodeNext）/ Express 5 / Vitest；前端为 Vue 3 + Vite（源码在 `web/`）
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
7. 前端（`web/`）是 Vue 3 + Vite 项目（`public/` 为构建产物，不入库）。改动前端后必须运行 `pnpm typecheck:web` 与 `pnpm build:web`，并提示用户打开 Web UI 手动验证，或给出可复现的验证步骤。

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
web/                  # Web UI 前端源码（Vue 3 SFC + Vite，依赖装在根 package.json）
  index.html          # Vite 入口（挂载点 <div id="app">）
  vite.config.ts      # 构建产物输出 ../public；dev 代理 /__polymock -> localhost:8080
  tsconfig.json       # 前端类型检查（vue-tsc -p web/tsconfig.json）
  src/
    main.ts           # createApp(App).mount('#app')，引入全局样式
    App.vue           # 整体骨架：sidebar + 视图切换 + toast + 轮询
    api.ts            # fetch 封装（/__polymock 管理 API）
    types.ts          # 前端类型（镜像后端字段）
    utils.ts          # method 色板 / body 格式化等共享工具
    styles/global.css # 全局样式（沿用原控制台视觉）
    components/       # ServicePanel / RouteCard / RouteForm / EmbedTest
public/               # ⚠️ 纯构建产物（vite build 输出，不入库）；Express 托管该目录
测试与被测文件同目录（*.test.ts），共享工具在 test-utils.ts
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | tsx watch 热启动（后端） |
| `pnpm dev:web` | Vite dev server（前端 HMR，代理 /__polymock 到 8080） |
| `pnpm build` | tsc 编译到 dist + vite build 输出 public/（start 前必须先执行） |
| `pnpm build:web` | 仅构建前端（vite build → public/） |
| `pnpm start` | 运行 dist/index.js |
| `pnpm typecheck` | 类型检查（应用 + 测试） |
| `pnpm typecheck:web` | 前端类型检查（vue-tsc） |
| `pnpm test` | 运行全部测试 |
| `pnpm test:watch` | 监听模式跑测试 |

> 克隆后首次运行：`pnpm install && pnpm build`（public/ 不入库，需先构建前端才能看到 Web UI）。

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