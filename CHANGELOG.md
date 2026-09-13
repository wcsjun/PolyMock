# Changelog

本项目所有显著变更记录于此。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

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
- **质量设施**：Vitest 196 用例（真实 HTTP 集成测试）+ Playwright E2E + Postman 回归 + CI（typecheck / test / build / e2e）
- **npm 发布**：包名 `@wcsjun/polymock`，`files` 含 `public`（Web UI 随包分发），bin 命令 `polymock`

[0.1.0]: https://github.com/wcsjun/PolyMock/releases/tag/v0.1.0
