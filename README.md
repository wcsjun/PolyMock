# PolyMock

> Poly = 多协议，Mock = 模拟接口。一个支持多协议、可动态注册接口的本地 Mock 服务。

## 项目简介

### 背景动机

公司内部的业务服务与三方接口均部署在内网环境中。日常开发中，开发者需要频繁在内网（访问真实接口）与外网（访问依赖、查资料）之间切换网络，过程繁琐且耗时，严重影响开发效率。

PolyMock 的目标是：**在本地开发时模拟内网接口**，让开发者无需切换网络即可完成联调与开发。它不仅仅是一个静态的 mock 工具，而是一个可以**动态注册接口、按需扩展协议**的本地服务。

## 核心特性

- **多协议支持**：可同时开放多种协议的接口（HTTP、WebSocket 等），每个协议独立监听，互不干扰
- **动态注册接口**：运行中可随时注册/注销指定接口及其目标协议，无需重启服务
- **自定义 path**：为每个接口指定任意路由 path（如 `/api/user/info`）
- **固定响应**：直接返回写死的响应体（静态 JSON / 文本 / 二进制）
- **动态响应**：根据请求参数（query / body / header）做条件分支或模板化渲染，灵活模拟真实业务逻辑
- **零成本切换**：本地开发时请求指向 PolyMock，联调时切回内网地址即可，无需改代码（通过配置或环境变量切换 base URL）

## 技术选型建议

目前项目未锁定技术栈，以下为建议（推荐 Node.js / TypeScript）：

| 方案 | 优势 | 适用场景 |
| --- | --- | --- |
| **Node.js + TypeScript（推荐）** | 事件驱动天然适合多协议（HTTP/WebSocket/gRPC-Web）；生态丰富（express/ws/grpc 等）；模板化响应可直接用 JS 表达式求值；开发迭代快 | 团队以 Web 前端为主、希望 mock 配置即写即生效 |
| **Go** | 单二进制分发、内存占用低、并发能力强；性能优秀，适合需要长期驻留或模拟高并发压测场景 | 团队以 Go 为主、或 mock 服务需要部署到多台机器 |
| **Python (FastAPI)** | 上手快、动态求值方便（eval）、配置友好 | 纯工具型使用，不追求性能 |

> 建议：若团队日常以 JS/TS 为主，直接选 Node.js + TypeScript；若已有 Go 基础设施，选 Go。两者均可满足需求，不必纠结。

## 目录结构

```
src/
  index.ts            # 入口：装配、启动、持久化钩子
  types.ts            # 领域类型与常量
  registry.ts         # 接口注册表（服务分组 + 接口，纯领域逻辑）
  store.ts            # 配置读写（原子写：临时文件 + rename）
  server/
    app.ts            # Express 应用组装 + Mock 请求分发
    admin.ts          # /__polymock 管理 API
    manager.ts        # 服务生命周期（启停独立端口的服务）
public/               # Web UI 控制台（原生 HTML/CSS/JS）
```

> 测试与被测文件同目录（`*.test.ts`），共享测试工具在 `server/test-utils.ts`。

## 快速开始

> 以下示例以 Node.js + TypeScript 为假想实现，配置采用 JSON 格式。

### 1. 安装与启动

```bash
pnpm install
pnpm start -- --config ./config/mock.config.json
```

### 2. 配置示例：多协议 + path + 固定/动态响应

```jsonc
{
  "port": 8080,
  "protocols": [
    {
      "type": "http",
      "port": 8080,
      "routes": [
        {
          "path": "/api/user/info",
          "method": "GET",
          // 固定响应：直接返回写死的 JSON
          "response": {
            "status": 200,
            "body": {
              "code": 0,
              "data": { "id": 1001, "name": "PolyMock", "role": "admin" }
            }
          }
        },
        {
          "path": "/api/order/list",
          "method": "GET",
          // 动态响应：根据 query 参数分支
          "response": {
            "dynamic": true,
            "handler": {
              "match": [
                {
                  "when": { "query.page": "1" },
                  "body": { "code": 0, "data": { "page": 1, "list": [{ "id": 1, "amount": 100 }] } }
                },
                {
                  "when": { "query.page": "2" },
                  "body": { "code": 0, "data": { "page": 2, "list": [{ "id": 2, "amount": 200 }] } }
                }
              ],
              "default": { "code": 400, "message": "invalid page" }
            }
          }
        },
        {
          "path": "/api/pay",
          "method": "POST",
          // 动态响应：根据 header 分支（如模拟内部鉴权失败）
          "response": {
            "dynamic": true,
            "handler": {
              "match": [
                {
                  "when": { "header.x-token": "valid-token" },
                  "body": { "code": 0, "message": "pay success" }
                }
              ],
              "default": { "code": 401, "message": "unauthorized" }
            }
          }
        }
      ]
    },
    {
      "type": "websocket",
      "port": 8081,
      "routes": [
        {
          "path": "/ws/message",
          // 固定响应：收到消息后固定回一条
          "response": { "type": "echo", "template": "{\"type\":\"pong\",\"data\":\"${body.message}\"}" }
        }
      ]
    }
  ]
}
```

### 3. 动态注册接口（运行时 API）

除静态配置外，PolyMock 提供管理接口，可在运行中注册/注销接口：

```bash
# 注册一个 HTTP 接口（固定响应）
curl -X POST http://localhost:8080/__polymock/routes \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "http",
    "path": "/api/temp/foo",
    "method": "GET",
    "response": { "status": 200, "body": { "msg": "dynamic registered" } }
  }'

# 注销接口
curl -X DELETE http://localhost:8080/__polymock/routes/http/api/temp/foo
```

## 配置说明

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `port` | number | 是 | 服务总端口（管理接口所在） |
| `protocols[].type` | string | 是 | 协议类型：`http` / `websocket`（可扩展） |
| `protocols[].port` | number | 是 | 该协议监听端口 |
| `protocols[].routes[].path` | string | 是 | 路由路径，如 `/api/user/info`，支持通配符 |
| `protocols[].routes[].method` | string | 否 | HTTP 方法（HTTP 协议必填），默认 `GET` |
| `routes[].response` | object | 是 | 响应定义，见下方说明 |
| `response.status` | number | 否 | 响应状态码，默认 `200` |
| `response.body` | any | 否 | 固定响应体（`dynamic` 为 false 时生效） |
| `response.dynamic` | boolean | 否 | 是否启用动态响应 |
| `response.handler.match[]` | array | 否 | 条件分支列表，`when` 支持 `query.*` / `body.*` / `header.*` 表达式 |
| `response.handler.default` | any | 否 | 无匹配时的兜底响应 |

### 动态响应表达式

- 取值来源：`query.*`（URL 查询参数）、`body.*`（请求体字段）、`header.*`（请求头）
- 匹配方式：精确等于（默认）、正则（可扩展 `regex` 字段）、模板插值（`${...}` 占位符）

```jsonc
{
  "when": { "query.type": "user" },                    // 精确匹配
  "body": { "code": 0, "echo": "${header.x-request-id}" }  // 模板插值
}
```

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `POLYMOCK_CONFIG` | `./config/mock.config.json` | 配置文件路径 |
| `POLYMOCK_PORT` | `8080` | 覆盖管理端口 |

## 未来规划

- [ ] 支持 gRPC 协议
- [ ] 响应延迟模拟（模拟慢接口）
- [ ] 请求/响应日志与回放
- [ ] 热加载配置文件（watch 模式）
- [ ] 管理界面（Web UI）可视化编辑接口

## License

MIT