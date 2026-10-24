# ADR-0003 — WS 认证的 `?token=` 浏览器等价凭证（及日志不含 query 的理由）

状态：已采纳 ｜ 日期：2026-10-24

## 背景

WS 路由复用路由级认证（Bearer / APIKey）。HTTP 客户端可以随意设置握手头，但浏览器 `new WebSocket(url)` 无法携带自定义请求头——`Authorization: Bearer ...` 与自定义 API Key 头在浏览器里发不出去，若只认握手头，浏览器侧永远 401。

## 决策

WS 握手认证额外接受查询参数 `?token=<令牌>` 作为等价凭证（`src/server/ws-gateway.ts` 的 `checkUpgradeAuth`）：Bearer 校验其值、APIKey 校验其值，与管理令牌 `?token=` 的查询参数先例保持一致。错误提示文案明确指引"浏览器连接可在地址后附加 ?token=<令牌>"。

日志不含 query 的理由：请求日志记录的 `path` 取自 `resolveUpgradeService` 返回的 `url.pathname`（不含查询串），因此 `?token=` 凭证**不会落进请求日志或控制台地址栏历史以外的任何持久化位置**——凭证属于敏感信息，日志层按"只记路径、不记 query"处理，避免令牌经日志泄露。

## 后果

- 浏览器与后端客户端可用同一套路由认证；调试台连接条支持在地址后追加 `?token=`。
- 代价：令牌可能出现在浏览器地址栏与代理服务器的访问日志中（PolyMock 自身不记录）；文档需提示生产环境谨慎使用 `?token=`，或改用非浏览器客户端携带握手头。
