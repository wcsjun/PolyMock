# Changelog

本项目所有显著变更记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [0.2.0] - 2026-10-01

### Added

- **请求准入增强**：条件行新增 `match` 操作符（`exists` / `equals` / `nonEmpty` / `regex`，缺省保持历史语义）；准入失败码 `gateStatus`（`400` 缺省 / `404` 隐藏接口 / `422`）；Body 整体匹配 `bodyMatch`（`subset` 缺省 / `deepEqual` 完整 JSON 相等 / `textEqual` 原文全文相等）+ `bodyRaw`，非 `subset` 时忽略 body 条件行
- **「新增/编辑接口」抽屉重构**：五段卡片（基本信息 / 请求准入 / 响应分支 / 高级选项 / 匹配预览）；分支标签拖动与键盘排序；请求准入从默认响应独立；自定义响应头收进高级选项
- **匹配预览**：表单内纯前端本地推演（请求体解析 → 路径 → 认证 → 请求准入 → 序列响应 → 全局场景集 → 分支 → 默认响应），不发送真实请求
- **请求体原文捕获**：JSON 请求由解析器顺带记录、非 JSON 请求单独读取（不改变既有解析与代理行为），支撑 `textEqual` 原文全文比对
- **请求体模板渲染 `renderRequest`**：路由级开关，默认开启——`{{query.*}}` / `{{header.*}}` / `{{body.*}}` / `{{params.*}}` 占位符在条件匹配前就地渲染请求体
- **basePath 头部徽标就地编辑**；Web UI 字体字号统一（`--sans` / `--mono` 双栈）与响应区布局优化

### Fixed

- 准入失败码为 `404` 时对外 body 与未注册接口完全一致，不再泄露接口存在与期望条件（真实原因仍记录在请求日志）
- 匹配预览的请求体语义与后端对齐：仅在 `Content-Type: application/json`（或 `*+json`）时解析 body 参与匹配，非法或顶层标量 JSON 按解析器 400 拒绝

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
