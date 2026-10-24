# Changelog

本项目所有显著变更记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [Unreleased]

### Added

- **WebSocket 接口 Mock（protocol = "ws"）**：协议原生的 WS 模拟能力（依赖新增 `ws`）——
  - 注册：管理 API 传 `protocol: "ws"`（method 自动为 `WS`），行为配置收进 `ws` 子对象（`onOpen` 有序推送 + `loopOnOpen` 循环、`onMessage` 回包策略 `echo` / `fixed` / `sequence` / `none`、`interval` 定时推送 100-60000ms）；HTTP 专属字段（`response` / `request` / `variants` / `delayMs` 等）对 WS 路由拒收 400；`WS /ws/orders` 与 `GET /ws/orders` 可共存
  - 握手语义：命中且启用 101；未注册 / 已停用 404、认证失败 401（复用 `auth` Bearer / APIKey，凭证取自握手头），均直接拒绝、不进入 HTTP 分发与代理；HTTP 请求打到 WS 路径同样返回明确 404 且不走代理（同路径 HTTP 接口可另行注册共存）
  - 消息模板：字符串消息原样发送并渲染 `query` / `header` / `params` / `$` 系列占位符（无 `body` 上下文），其余值 JSON 序列化后深度渲染
  - 变更生效：编辑 / 停用 / 删除 WS 接口后存量连接以 close 1012 关闭（客户端重连取新剧本）；删除服务时连接立即销毁，`stop()` 带超时兜底不挂起
  - 日志与快照：只写连接级日志（`method: "WS"`，close 时记录 `ws.connectionId` / 收发帧计数 / `closeCode`），帧级不持久化；新增只读接口 `GET /__polymock/ws/connections`
- **Web 控制台 WS 支持**：视图由三个变为四个（接口管理 / **WS 调试台** / 嵌入测试 / 请求日志）——
  - WS 卡片（v2 克制版）：与 HTTP 卡片同处一个服务分组，紫色 WS 徽章 + 一行等宽剧本摘要 + chip 白名单（认证 / 已停用 / ● N 个连接，连接数仅 > 0 时渲染且点击跳调试台），剧本详情 `<details>` 默认折叠
  - WS 编辑抽屉五区块：基本（服务 / 名称 / 路径 / 地址预览）、握手与准入（认证方式 + 令牌）、① onOpen（延迟 + 内容列表 + 循环开关）、② onMessage（回包策略 + 回包内容）、③ interval（开关 + 间隔 + 内容），底部停用开关与 1012 重连提示；令牌只在抽屉配置与显示
  - WS 调试台：连接条（接口下拉 + 可编辑地址 + 连接/断开）、实时连接列表（2 秒轮询快照）、发送消息（JSON 自动校验 + 快捷示例）、帧时间线（↑ 出 / ↓ 入 / ⇄ 系统，只保存在前端页面）
  - 侧边栏显示 WS 连接数；卡片 ⇄ 按钮与连接数 chip 一键跳转调试台并选中接口

### Changed

- **HTTP 与 WS 卡片统一折叠规则**：内容区（HTTP 响应体 / WS 剧本步骤与使用说明）默认折叠（`<details>` 原生实现），折叠行带单行截断预览（HTTP）或步骤摘要（WS）；标题、徽章、路径、摘要行与状态 chip 始终显示，列表默认等高、可扫读

## [0.2.0] - 2026-10-22

### Added

- **请求准入增强**：条件行新增 `match` 操作符（`exists` / `equals` / `nonEmpty` / `regex`，缺省保持历史语义）；准入失败码 `gateStatus`（`400` 缺省 / `404` 隐藏接口 / `422`）；Body 整体匹配 `bodyMatch`（`subset` 缺省 / `deepEqual` 完整 JSON 相等 / `textEqual` 原文全文相等）+ `bodyRaw`，非 `subset` 时忽略 body 条件行
- **「新增/编辑接口」抽屉重构**：五段卡片（基本信息 / 请求准入 / 响应分支 / 高级选项 / 匹配预览）；分支标签拖动与键盘排序；请求准入从默认响应独立；自定义响应头收进高级选项
- **匹配预览**：表单内纯前端本地推演（请求体解析 → 路径 → 认证 → 请求准入 → 序列响应 → 全局场景集 → 分支 → 默认响应），不发送真实请求
- **请求体原文捕获**：JSON 请求由解析器顺带记录、非 JSON 请求单独读取（不改变既有解析与代理行为），支撑 `textEqual` 原文全文比对
- **请求体模板渲染 `renderRequest`**：路由级开关，默认开启——`{{query.*}}` / `{{header.*}}` / `{{body.*}}` / `{{params.*}}` 占位符在条件匹配前就地渲染请求体
- **basePath 头部徽标就地编辑**；Web UI 字体字号统一（`--sans` / `--mono` 双栈）与响应区布局优化
- **Web 控制台管理令牌入口**：侧边栏可设置 / 清除 `POLYMOCK_ADMIN_TOKEN` 令牌（仅保存在本机 localStorage），401 报错直接提示该入口

### Fixed

- 准入失败码为 `404` 时对外 body 与未注册接口完全一致，不再泄露接口存在与期望条件（真实原因仍记录在请求日志）
- 匹配预览的请求体语义与后端对齐：仅在 `Content-Type: application/json`（或 `*+json`）时解析 body 参与匹配，非法或顶层标量 JSON 按解析器 400 拒绝
- 请求准入区默认折叠：折叠态头部徽标（圆点 + 已开启 / 已关闭）直接显示开关状态，编辑回填与重置表单均回到折叠态
- 条件类型下拉加宽（74px → 88px）：修复 12px 等宽字体下 `boolean` 被原生下拉箭头遮挡
- 响应分支切换高度跳动：删除按钮改为常驻占位（默认响应下不可见），框体高度不再随分支切换变化

### Changed

- CI：Docker 双架构镜像改用原生 runner 构建（amd64 / arm64 各推架构标签后合并 manifest），彻底移除 QEMU

## [0.1.0] - 2026-09-14

首个公开版本。

### Added

- **多服务 Mock**：独立端口 / 路径前缀双运行模式，服务增删改与代理穿透（穿透目标可白名单约束）
- **接口注册**：条件匹配（query / header / body）、响应变体、序列响应、全局场景集、`requireMatch` 准入门槛、路由级认证（Bearer / APIKey）
- **动态响应模板**：`{{query.x}}` / `{{header.x}}` / `{{body.x}}` / `{{params.x}}` 占位符，`{{$id}}` 自增、`{{$now}}`、`{{$int(a,b)}}` 与内置假数据
- **有状态 CRUD 集合**：集合/条目路由的资源语义（GET/POST/PUT/PATCH/DELETE），存储键含 `serviceId` 按服务隔离，管理端 `GET/DELETE /__polymock/crud` 查看与清空
- **非 JSON 文本响应**：生效 Content-Type（自定义头优先于 `contentType` 字段）为非 JSON 时 body 按原样文本存储与发送，模板照常渲染
- **自定义响应头**：默认响应 / 每个变体 / 序列每步均可附加，值支持模板与多值头
- **延迟/抖动/故障注入**：`delayMs` + `jitterMs`，`failureRate` 按概率返回 500
- **代理穿透与录制**：未命中接口转发上游，响应可一键「保存为接口」（JSON 上游格式化存储、文本上游按原 Content-Type 保存）
- **请求日志**：环形缓冲 500 条，SSE 实时推送、过滤、一键重放、复制 curl
- **Web 控制台**：服务分组与状态、接口卡片、抽屉式编辑（可拖拽调宽）、嵌入测试、OpenAPI 导入、CRUD 集合分组与数据弹窗、一键创建配套 CRUD 路由
- **管理 API**：`/__polymock/*` 全套端点，可选 `POLYMOCK_ADMIN_TOKEN` 鉴权，附 OpenAPI 契约与 Postman 全功能回归集合
- **Docker**：多阶段构建镜像（路径模式默认，配置持久化到 `/data` 卷）
- **质量设施**：Vitest 211 用例（真实 HTTP 集成测试）+ Playwright E2E + Postman 回归 + CI（typecheck / test / build / e2e）
- **npm 发布**：包名 `@wcsjun/polymock`，`files` 含 `public`（Web UI 随包分发），bin 命令 `polymock`
- **配置文件定位**：`--config <path>` 参数与 `POLYMOCK_CONFIG_FILE` 环境变量（优先级 CLI 参数 > 环境变量 > 当前目录已存在的配置 > `~/.config/polymock/` 兜底）；传入目录或路径以分隔符结尾时自动补 `polymock.config.json`，并强制 `.json` 后缀

[0.1.0]: https://github.com/wcsjun/PolyMock/releases/tag/v0.1.0
