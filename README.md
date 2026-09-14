# PolyMock

[English](./README.en.md) | 简体中文

> 本地 HTTP Mock 服务器：多服务分组（独立端口或路径前缀）、运行时注册接口、请求条件匹配、响应场景切换——为前端本地开发与联调而设计。

## 项目简介

日常开发中，被依赖的后端接口往往部署在内网，开发者需要在内外网之间频繁切换，联调成本高。PolyMock 在本地模拟这些 HTTP 接口：请求指向 PolyMock 即可完成开发与自测，联调时把地址切回真实后端即可，无需改代码。

它不是静态的假数据工具，而是一个**可运行时管理接口的本地服务**：

- 接口通过 Web 控制台或管理 API 随时注册、修改、启停，无需重启
- 同一接口可定义多个响应场景（变体），按请求条件自动分流，或一键全局切换
- 未注册的请求可穿透代理到真实后端，Mock 与真实接口无缝衔接

技术栈：Node.js 18+ / TypeScript / Express 5（后端），Vue 3 + Vite（Web 控制台），Vitest（测试）。包管理器为 pnpm。

## 快速开始

通过 npm 安装（包内自带 Web UI 构建产物，本机无需构建）：

```bash
npm i -g @wcsjun/polymock   # 全局安装后运行：
polymock                    # 启动后访问 http://localhost:33233
```

或免安装临时运行：

```bash
npx @wcsjun/polymock

# 指定配置文件路径（也支持环境变量 POLYMOCK_CONFIG_FILE，详见「配置文件」）
npx @wcsjun/polymock --config ./mock/polymock.config.json
```

也可以从源码运行（开发场景）：

```bash
pnpm install
pnpm build        # tsc 编译后端到 dist/ + vite 构建前端到 public/
pnpm start        # 启动后访问 http://localhost:33233
```

> `public/` 是前端构建产物，不入库。**克隆后必须先执行 `pnpm build`**，否则访问不到 Web UI。

启动后：

- Web 控制台：<http://localhost:33233>
- 默认服务 `default` 监听主端口（出厂 `33233`；**改端口直接编辑 `polymock.config.json` 里 `default` 服务的 `port` 字段，重启生效，无需改源码**），并预置默认路由 `GET /api/hello`
- 所有变更自动保存到 `polymock.config.json`，重启后恢复

### 开发模式

```bash
pnpm dev          # 后端热启动（tsx watch）
pnpm dev:web      # 前端 Vite dev server（HMR），/__polymock 代理自动跟随主端口
```

开发模式下 Web UI 走 Vite 地址（默认 <http://localhost:5173>）；Mock 请求本身仍访问主端口或各服务分组端口。

### 第一个接口

```bash
# 注册接口：带请求条件与响应变体
curl -X POST http://localhost:33233/__polymock/routes \
  -H "Content-Type: application/json" \
  -d '{
    "name": "订单查询",
    "method": "GET",
    "path": "/api/orders",
    "response": { "status": 200, "body": { "role": "default" } },
    "variants": [
      { "name": "管理员视角", "match": { "headers": [{ "key": "X-Role", "value": "admin" }] },
        "response": { "status": 200, "body": { "role": "admin" } } }
    ]
  }'

curl http://localhost:33233/api/orders                                    # {"role":"default"}
curl -H "X-Role: admin" http://localhost:33233/api/orders                 # {"role":"admin"}
```

### Docker

镜像默认启用路径模式（`POLYMOCK_MODE=path`）：所有服务经主端口 `/{basePath}` 前缀分发，只需暴露一个端口，配置持久化到 `/data` 卷（重启不丢）。

```bash
# 预构建镜像（每次发版由流水线自动构建，amd64/arm64 双架构）：
docker run -d --name polymock -p 33233:33233 -v polymock-data:/data ghcr.io/wcsjun/polymock
# 或 Docker Hub：docker run -d --name polymock -p 33233:33233 -v polymock-data:/data jun82315/polymock

# 本地构建：
docker build -t polymock . && docker run -d --name polymock -p 33233:33233 -v polymock-data:/data polymock
```

启动后打开 <http://localhost:33233>，新增服务分组时无需指定端口，接口按 `http://localhost:33233/{basePath}{接口路径}` 访问（详见下文「运行模式」）。

## 运行模式

环境变量 `POLYMOCK_MODE` 决定服务分组的承载方式，缺省 `port`：

| 模式 | 说明 |
| --- | --- |
| `port`（默认） | 各服务分组在独立端口监听，默认服务占用主端口 |
| `path` | 所有服务经主端口 `/{basePath}` 前缀分发；只需暴露主端口，适合容器部署 |

路径模式的差异：

- 服务分组创建时免端口，按 `basePath` 前缀区分；不指定时由服务名自动生成（小写字母/数字/连字符，重名自动追加 `-2`、`-3`……），Web 控制台服务面板中可随时修改
- 接口实际访问地址为 `http://<主地址>/{basePath}{接口路径}`——如 basePath 为 `order` 的服务注册了 `GET /api/orders`，则访问 `/order/api/orders`；默认服务仍占用主端口根路径，不加前缀
- `basePath` 不可使用保留前缀（`__polymock`、`assets`），也不能与其他服务的 basePath 或默认服务接口路径的首段重合，冲突在创建/修改时返回 409
- 旧配置文件里缺失 `basePath` 的服务在启动时自动补齐；当前模式可通过 `GET /__polymock/meta` 查询，Web 控制台也会随之切换表单与地址拼接

## 功能清单

### 接口管理

- **多服务分组**：除主端口上的默认服务外，可创建多个服务分组——端口模式下各自独立端口监听，路径模式下经主端口 `/{basePath}` 前缀分发（见「运行模式」）
- **Web 控制台**：抽屉式表单新增/编辑接口，条件用 Postman 风格表格编辑（Body 支持表格 ⇄ JSON 双向互转）
- **接口启用/禁用**：禁用后视为未注册（配置了代理时穿透到真实后端）
- **删除确认**：删除服务或接口均弹出确认提示，防止误删

### 请求匹配

- **路径匹配**：精确路径 + `:param` 路径参数段（如 `/api/users/:id`）；形状冲突（含参数段互撞）在注册时返回 409
- **条件维度**：query 参数、请求头（大小写不敏感）、JSON body 点路径（如 `user.id`）三组条件
- **比对类型**：`string`（缺省，字符串化比对）/ `number` / `boolean` / `json`（深度相等）/ `array`（包含匹配，实际数组需包含期望 JSON 数组的全部元素，无序）；期望值为空串表示仅要求 key 存在
- **必填/选填**：条件默认必填，`required: false` 时 key 缺失视为通过（存在才比对）
- **requireMatch 准入门槛**：开启后所有请求必须满足接口的 `request` 条件，否则返回 400 并说明不匹配原因（优先于任何变体）
- **路由级认证**：`auth` 配置后模拟后端鉴权，未携带正确凭证返回 401；支持 `apikey`（自定义 header 携带密钥，缺省 `X-API-Key`，可改 header 名）与 `bearer`（`Authorization: Bearer <token>`，401 时附 `WWW-Authenticate: Bearer`）；401 优先于 requireMatch 门槛，CRUD 接口同样生效

### 响应能力

- **响应场景（变体）**：同一接口挂多个带名字的变体，按数组顺序匹配，第一个条件全部通过的生效，全不命中走默认响应
- **序列响应**：按命中次序循环返回一组响应（如「成功 → 成功 → 失败」），优先于场景集/变体/默认响应
- **全局场景集**：设置 `activeVariant` 后，所有拥有同名变体的接口强制命中该变体（绕过其条件），一键切换全局场景
- **动态响应模板**：响应体字符串中支持 `{{query.x}}`、`{{header.x}}`、`{{body.x}}`（点路径）、`{{params.x}}`（路径参数）、`{{$id}}`（路由级自增）、`{{$now}}`（ISO 时间）、`{{$int(a,b)}}`（闭区间随机整数），以及内置假数据 `{{$name}}` `{{$ename}}` `{{$email}}` `{{$phone}}` `{{$city}}` `{{$word}}` `{{$bool}}`；取不到值的占位符原样保留
- **自定义响应头**：默认响应、每个变体与序列每步均可附加自定义响应头；值支持模板占位符（如 `Location: /api/users/{{params.id}}`、`X-Request-Id: {{$id}}`）；同名多条按多值头返回（如多个 Set-Cookie）；在 `contentType` 字段之后应用，同名 Content-Type 覆盖之；`content-length` / `transfer-encoding` 等受管头注册时拒绝（400）
- **非 JSON 文本响应**：生效 Content-Type（自定义头 `Content-Type` 优先于 `contentType` 字段）为非 JSON（如 `text/html`、`text/plain`、`application/xml`）时，body 按原样文本存储与发送、不再强制 JSON 校验，模板占位符照常渲染（值按文本注入）；未声明或 JSON 类 Content-Type 仍按 JSON 严格校验。请求日志「保存为接口」据此自动选择模式，文本上游响应可直接落为 Mock 接口
- **延迟/抖动/故障注入**：`delayMs`（0-60000 固定延迟）+ `jitterMs`（随机抖动上限），`failureRate`（0-100%）按概率返回 500
- **格式化与即时校验**：body 一键格式化，JSON 模式下失焦即时校验并标红（声明非 JSON Content-Type 时跳过校验），提交时后端再次校验

响应解析优先级：路由级认证（401）→ `requireMatch` 准入门槛 → 序列响应 → 全局场景集 → 条件变体 → 默认响应。

### 有状态 CRUD

接口开启 `crud` 后按资源语义响应（内存维护，重启清空）：

- **集合路由**（路径无参数段）：`GET` 返回全部资源，`POST` 创建（无 `id` 时自动生成 `rec-N`）
- **条目路由**（路径含 `:id` 参数段）：`GET` 查单条（不存在返回 404）、`PUT`/`PATCH` 浅合并（保留原 id）、`DELETE` 删除
- 仅支持 GET/POST/PUT/PATCH/DELETE，其余方法返回 405
- **按服务隔离**：存储键为 `serviceId` + 去掉参数段后的集合路径，同服务同形状的集合/条目路由共享一份数据，不同服务同形状路径互不可见
- **存储可视化**：`GET /__polymock/crud` 查看各服务集合的资源明细，`DELETE /__polymock/crud`（可选 `?serviceId=&collection=` 过滤）清空；Web 控制台的集合分组卡片内可直接查看与清空

### 调试

- **请求日志**：环形缓冲 500 条，记录方法/路径/query/body 摘要/状态码/耗时，并标注命中的接口与变体（或代理穿透、失败原因）
- **实时推送**：通过 SSE（`/__polymock/events`）实时推送新日志，连接不可用时自动回落 2 秒轮询
- **过滤与重放**：按状态码（2xx/4xx/5xx）、服务、路径关键字过滤；GET 记录可一键重放，任意记录可复制 curl
- **保存为接口**：代理穿透的响应原文可一键保存为 Mock 接口，实现「抓一次、长期 Mock」；JSON 上游格式化存储，文本上游按原 Content-Type 与原文保存

### 代理穿透

- **服务级 `proxyTarget`**：为服务分组配置真实后端地址后，未命中 Mock 接口的请求自动转发（转发前剥离 `host` / `content-length`）
- 上游失败或目标不在白名单时返回 502；上游响应体（截断 5000 字符）记入请求日志，供「保存为接口」

### 导入/导出

- **OpenAPI 3 JSON 导入**：控制台粘贴文档 JSON，遍历 `paths` 下 get/post/put/patch/delete；`$ref` 解析（JSON Pointer，深度上限 10）、schema 采样生成示例响应（example/default 优先、enum 取第一、date/date-time 转 ISO 等）、`{id}` 路径段转换为 `:id`；默认上限 100 条（超出截断），失败/跳过明细在报告中展示
- **复制片段**：每个接口卡片可复制 Mock 地址、curl、fetch 代码，以及由响应 JSON 推导的 Java 实体类（Lombok `@Data` 风格，嵌套对象生成静态内部类，数组取首元素推导 `List<T>`）

### 安全（可选）

- **管理令牌**：设置环境变量 `POLYMOCK_ADMIN_TOKEN` 后，所有 `/__polymock` 接口需携带 `x-polymock-token` 请求头（SSE 场景可用 `?token=` 查询参数），否则返回 401
- **代理白名单**：设置 `POLYMOCK_PROXY_ALLOW`（逗号分隔 host 列表）后，代理目标 hostname 必须在白名单内（管理端设置与转发前双重校验）

## Web 控制台

启动后浏览器打开 <http://localhost:33233>，左侧边栏切换三个视图（选择会记忆）：

| 视图 | 说明 |
| --- | --- |
| **接口管理** | 服务分组列表（新建/删除/端口或 basePath/运行状态，头部徽标快捷设置代理穿透）与接口卡片（方法色标、条件摘要、变体列表）；CRUD 路由按集合分组展示（组头可弹窗查看集合数据、整集合删除）；抽屉式表单编辑接口的条件、变体、序列响应、延迟/抖动/故障注入、CRUD 开关（开启后可一键创建配套的列表/创建/详情/更新/删除路由）；侧边栏可一键切换全局场景集；支持 OpenAPI 导入抽屉 |
| **嵌入测试** | 输入任意页面地址，将其嵌入可拖拽调整宽高的 iframe 容器中（右/下/右下边缘拖拽、一键铺满、新标签页打开），便于在控制台内直接验证页面与 Mock 的联调效果 |
| **请求日志** | 日志列表与过滤（状态/服务/路径关键字），实时（SSE）/轮询模式徽标，支持重放、复制 curl、清空、把代理条目保存为接口 |

## 管理 API

所有管理接口挂载在主端口的 `/__polymock` 下，请求与响应均为 JSON。成功返回 `{ "ok": true, ... }`，失败返回 `{ "ok": false, "error": "原因" }`；状态码语义：`400` 参数错误或条件不满足、`401` 缺少管理令牌、`404` 服务/接口不存在（Mock 分发同理）、`409` 冲突（端口/服务名/接口形状）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/__polymock/meta` | 运行模式元信息：`{ mode, mainPort }` |
| GET | `/__polymock/services` | 服务分组列表（含 `isDefault` / `running` / `basePath` / 接口数量） |
| POST | `/__polymock/services` | 新建服务分组；端口模式 body `{ name, port }`，路径模式 body `{ name, basePath? }`（省略时自动生成） |
| DELETE | `/__polymock/services/:id` | 删除服务分组（默认服务不可删除） |
| PUT | `/__polymock/services/:id/basePath` | 修改服务 basePath 前缀（路径模式），body `{ basePath }` |
| PUT | `/__polymock/services/:id/proxy` | 设置代理穿透目标，body `{ target }`（`null` 或空串清除） |
| GET | `/__polymock/routes` | 接口列表，可选 `?serviceId=` 过滤 |
| POST | `/__polymock/routes` | 注册接口（必填 `name` / `method` / `path`，path 以 `/` 开头） |
| PUT | `/__polymock/routes/:id` | 更新接口，支持 patch：只传需要修改的字段 |
| DELETE | `/__polymock/routes` | 按 `?method=&path=&serviceId=` 删除接口 |
| GET | `/__polymock/requests` | 请求日志，可选 `?serviceId=` 与 `?limit=`（默认 100，上限 500），按新到旧排序 |
| DELETE | `/__polymock/requests` | 清空请求日志 |
| GET | `/__polymock/settings` | 读取全局设置（当前仅 `activeVariant`） |
| PUT | `/__polymock/settings` | 更新全局设置，body `{ activeVariant }`（空串视为清除） |
| GET | `/__polymock/crud` | 查看有状态 CRUD 集合存储：`{ collections: [{ serviceId, collection, count, records }] }`（内存态，重启即清） |
| DELETE | `/__polymock/crud` | 清空 CRUD 集合存储；可选 `?serviceId=&collection=` 过滤（可单独或组合指定），返回清理的资源条数 `cleared` |
| GET | `/__polymock/events` | SSE 实时推送请求日志（`event: log`，data 为日志条目 JSON） |

> 设置 `POLYMOCK_ADMIN_TOKEN` 后，以上接口均需携带 `x-polymock-token` 请求头或 `?token=` 查询参数，否则 401。

## 配置文件

配置持久化在 `polymock.config.json`，注册表每次变更自动落盘（临时文件 + rename 原子写）。配置文件路径按以下优先级解析：

1. `--config <path>` CLI 参数（支持 `--config=<path>` 形式）
2. `POLYMOCK_CONFIG_FILE` 环境变量（Docker 镜像经此钉死到 `/data` 卷）
3. 当前工作目录下已存在的 `polymock.config.json`（沿用，兼容项目内配置）
4. `~/.config/polymock/polymock.config.json`（兜底新建，避免在主目录裸跑时污染工作目录）

> 显式路径容错：指向已存在的目录（或以 `\`、`/` 结尾）时自动使用目录下 `polymock.config.json`；文件路径必须以 `.json` 结尾，否则启动即报错退出。

其中 `default` 服务的 `port` 字段就是主端口（Web UI / 管理 API / 默认服务所在）。当前 schema 版本为 `2`：

```json
{
  "version": 2,
  "services": [
    { "id": "default", "name": "默认服务", "port": 33233, "createdAt": 1730000000000 },
    { "id": "u-9f2c", "name": "用户服务", "port": 8101, "createdAt": 1730000001000, "proxyTarget": "http://localhost:3000" }
  ],
  "routes": [
    {
      "id": "r-1a2b",
      "serviceId": "default",
      "protocol": "http",
      "method": "GET",
      "path": "/api/users/:id",
      "name": "用户详情",
      "response": { "status": 200, "body": { "id": "{{params.id}}", "name": "{{$name}}" } },
      "request": { "headers": [{ "key": "X-Token", "value": "", "required": false }] },
      "requireMatch": false,
      "variants": [
        { "id": "v-01", "name": "管理员视角", "match": { "headers": [{ "key": "X-Role", "value": "admin" }] },
          "response": { "status": 200, "body": { "role": "admin" } } }
      ],
      "sequence": [],
      "disabled": false,
      "delayMs": 200,
      "jitterMs": 100,
      "failureRate": 0,
      "crud": false,
      "createdAt": 1730000002000
    }
  ],
  "settings": { "activeVariant": null }
}
```

常用字段说明：

| 字段 | 说明 |
| --- | --- |
| `version` | schema 版本，当前为 `2` |
| `services[]` | 服务分组：`id` / `name` / `port` / `createdAt`，可选 `proxyTarget`（代理穿透目标）；路径模式下非默认服务改由 `basePath` 前缀承载（`port` 不使用，置 `0`）；**`default` 服务的 `port` 即主端口，改后重启生效** |
| `routes[].method` / `path` | HTTP 方法与路径，path 支持 `:param` 参数段 |
| `routes[].response` | 默认响应：`status` / `contentType?` / `headers?`（自定义响应头）/ `body`；body 在 JSON 模式严格校验，生效 Content-Type 为非 JSON 时为原样文本 |
| `routes[].request` / `requireMatch` | 预期请求条件与准入开关 |
| `routes[].variants[]` | 响应变体：`name` / `match?`（缺省=总是命中）/ `response` |
| `routes[].sequence[]` | 序列响应：`{ status, body, headers? }` 数组，循环返回 |
| `routes[].disabled` / `delayMs` / `jitterMs` / `failureRate` / `crud` | 行为开关与模拟参数 |
| `settings.activeVariant` | 全局场景集：非空时同名变体强制命中 |

旧版本配置（缺失 `version` 或 `version: 1`）加载时自动迁移到当前版本，字段保持兼容，无需手动处理。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `POLYMOCK_MODE` | `port` | 运行模式：`port` = 各服务独立端口监听；`path` = 所有服务经主端口 `/{basePath}` 前缀分发（Docker 镜像默认 `path`），详见「运行模式」 |
| `POLYMOCK_PORT` | 配置文件 `default` 服务 `port`（出厂 `33233`） | 主端口（默认服务与 Web UI / 管理 API 所在）；优先级高于配置文件，显式设置后会回写同步到配置 |
| `POLYMOCK_HOST` | 未设置（监听全部网卡） | 监听地址；设置为非回环地址且未配置管理令牌时启动会输出安全警告 |
| `POLYMOCK_CONFIG_FILE` | 无（见「配置文件」解析顺序） | 配置文件路径；优先级低于 `--config` CLI 参数，高于工作目录自动探测 |
| `POLYMOCK_ADMIN_TOKEN` | 未设置（不校验） | 管理令牌，设置后 `/__polymock` 全部接口需鉴权（空串视为未设置） |
| `POLYMOCK_PROXY_ALLOW` | 未设置（不校验） | 代理目标白名单，逗号分隔 host 列表（如 `localhost,127.0.0.1`） |

## 开发与测试

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 后端热启动（tsx watch） |
| `pnpm dev:web` | 前端 Vite dev server（HMR，`/__polymock` 代理自动跟随主端口，与后端同一解析规则） |
| `pnpm build` | tsc 编译后端到 `dist/` + vite 构建前端到 `public/` |
| `pnpm build:web` | 仅构建前端 |
| `pnpm start` | 运行 `dist/index.js`（需先 `pnpm build`） |
| `pnpm typecheck` | 后端类型检查（应用 + 测试） |
| `pnpm typecheck:web` | 前端类型检查（vue-tsc） |
| `pnpm test` | 运行全部测试（Vitest） |
| `pnpm test:watch` | 测试监听模式 |
| `pnpm smoke` | 构建产物全链路冒烟（需先 `pnpm build`） |
| `pnpm test:e2e` | Playwright 浏览器 E2E（需先 `pnpm build`，自动拉起服务） |

测试定位：

- **后端**（`src/**/*.test.ts`）：registry / store / template 的单元测试，加上走真实 HTTP（`fetch` + 临时端口）的集成测试，不 mock Express 内部；含管理令牌与代理白名单的安全加固用例
- **前端**（`web/src/*.test.ts`）：纯函数单测（OpenAPI 解析、代码片段生成、条件表格转换、序列草稿解析、Java 实体生成）
- **smoke**（`scripts/smoke.mjs`）：以随机空闲端口 + 临时配置文件启动 `dist/index.js`，依次断言默认路由、模板与延迟、禁用后 404、场景集强制命中、请求日志，任一失败即退出非零
- **E2E**（`e2e/*.spec.ts`）：Playwright 驱动真实 Chromium，覆盖控制台加载、抽屉注册/调用/删除、路径参数模板与请求日志视图（`pnpm test:e2e`）

## CI

仓库使用 GitHub Actions（`.github/workflows/ci.yml`）：在 push（`main` 与 `feat/**` 分支）和所有 Pull Request 上执行两个 job——`CI`（`pnpm typecheck`、`pnpm typecheck:web`、`pnpm test`、`pnpm build`）与 `E2E`（安装 Playwright Chromium 后构建并运行 `pnpm test:e2e`）。Node 22，pnpm 版本读取 `package.json` 的 `packageManager` 字段，安装使用 `--frozen-lockfile`。

发布走独立流水线（`.github/workflows/release.yml`）：推送 `v*` tag 后自动执行「tag 与 package.json 版本校验 → typecheck/test/build 门禁 → npm 发布（`@wcsjun/polymock`，含 provenance）→ Docker 多架构镜像推送（GHCR + Docker Hub，含 `latest` 与主次版本 tag）→ 创建 GitHub Release（说明提取自 `CHANGELOG.md`）」。发版前需在仓库 Secrets 配置 `NPM_TOKEN`（Granular Access Token，须勾选 **Bypass 2FA**；classic / automation token 已下线）、`DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`。

## Roadmap（规划）

- **WebSocket 接口 Mock**（规划中，尚未实现）：在现有 HTTP 能力之外，提供 WS 接口的模拟与录制回放

## License

MIT（见 [LICENSE](LICENSE)）
