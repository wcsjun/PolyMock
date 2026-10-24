import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RequestLogStore } from './request-log.js';
import type { RouteRegistry } from '../registry.js';
import { renderString, renderTemplate, type TemplateContext } from '../template.js';
import type { Route, RouteAuth, WsMessage } from '../types.js';

/** GET /__polymock/ws/connections 返回的单条连接快照（只读，不含帧内容） */
export interface WsConnectionSnapshot {
  id: string;
  serviceId: string;
  routeId: string;
  path: string;
  remoteAddress: string;
  connectedAt: number;
  framesIn: number;
  framesOut: number;
}

interface WsConnection {
  id: string;
  serviceId: string;
  routeId: string;
  path: string;
  remoteAddress: string;
  connectedAt: number;
  framesIn: number;
  framesOut: number;
  socket: WebSocket;
  route: Route;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** 该连接的全部延时任务与定时器：close / 路由变更 / 服务停止时统一清理 */
  timers: Set<NodeJS.Timeout>;
  closed: boolean;
  /** sequence 回包策略的循环游标 */
  seqIndex: number;
  /** {{$id}} 连接级自增 */
  idCounter: number;
}

/** WS 路由变更（编辑 / 停用 / 删除）后存量连接的关闭码：Service Restart，客户端据此重连取新剧本 */
export const WS_CLOSE_ROUTE_CHANGED = 1012;

function flattenSearchParams(searchParams: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of searchParams) {
    if (!(key in result)) result[key] = value;
  }
  return result;
}

function flattenHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') result[key] = value;
    else if (Array.isArray(value) && value.length > 0) result[key] = value.join(', ');
  }
  return result;
}

/** 校验 upgrade 握手的路由级认证（语义与 HTTP 分发的 checkAuth 一致，凭证取自握手头） */
function checkUpgradeAuth(auth: RouteAuth, req: IncomingMessage, searchParams: URLSearchParams): string | null {
  /* 浏览器 WebSocket 握手无法携带自定义头：?token= 可作为等价凭证（与管理令牌的查询参数先例一致） */
  const queryToken = searchParams.get('token');
  const header = (name: string): string | undefined => {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  if (auth.type === 'bearer') {
    const authorization = header('authorization');
    if (authorization !== undefined) {
      const match = /^Bearer\s+(.+)$/i.exec(authorization);
      if (!match) return 'Authorization 头需为 Bearer <token> 形式';
      if (match[1] !== auth.value) return '令牌不正确';
      return null;
    }
    if (queryToken !== null) return queryToken === auth.value ? null : '令牌不正确';
    return '缺少 Authorization 头（浏览器连接可在地址后附加 ?token=<令牌>）';
  }
  const headerName = auth.header ?? 'X-API-Key';
  const key = header(headerName);
  if (key !== undefined) return key === auth.value ? null : 'API Key 不正确';
  if (queryToken !== null) return queryToken === auth.value ? null : 'API Key 不正确';
  return `缺少 ${headerName} 头（浏览器连接可在地址后附加 ?token=<密钥>）`;
}

/**
 * WebSocket Mock 网关：
 * - 接管 http.Server 的 upgrade 事件，按 (serviceId, 'WS', path) 查注册表，命中则 101 建连并执行剧本；
 * - 未注册 / 已停用 404、认证失败 401，均直接拒绝握手，不进入 Express 的 HTTP Mock 分发；
 * - 每个连接的 onOpen 延时任务与 interval 定时器挂在连接对象上，统一清理；
 * - 注册表变更时比对 WS 路由签名，编辑 / 停用 / 删除的存量连接以 1012 关闭（帧级不落日志，只写连接级）。
 */
export class WsGateway {
  private readonly connections = new Map<string, WsConnection>();
  /** routeId → 路由签名（serviceId / path / auth / disabled / ws）：变更检测用 */
  private readonly signatures = new Map<string, string>();

  constructor(
    private readonly registry: RouteRegistry,
    private readonly deps: { logs?: RequestLogStore } = {},
  ) {
    registry.on('change', () => this.syncRoutes());
    this.syncRoutes();
  }

  /**
   * 接管 server 的 upgrade 事件。resolveTarget 把请求解析为 { serviceId, path }：
   * 主端口网关用 resolveUpgradeService（路径模式剥 basePath 前缀），独立端口服务网关固定返回所属服务。
   */
  attach(server: Server, resolveTarget: (req: IncomingMessage) => { serviceId: string; path: string }): void {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const startedAt = Date.now();
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://polymock.local');
      } catch {
        socket.destroy();
        return;
      }
      const { serviceId, path } = resolveTarget(req);
      const found = this.registry.findWithParams(serviceId, 'WS', path);
      if (!found) {
        this.rejectHandshake(socket, 404, `未注册接口: WS ${path}`, serviceId, path, null, startedAt);
        return;
      }
      const { route, params } = found;
      if (route.auth) {
        const authError = checkUpgradeAuth(route.auth, req, url.searchParams);
        if (authError) {
          this.rejectHandshake(socket, 401, `认证失败：${authError}`, serviceId, path, route, startedAt, route.auth.type === 'bearer');
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.accept(ws, req, route, params, serviceId, path, url.searchParams, startedAt);
      });
    });
  }

  /** 全部活跃连接快照（管理 API 只读接口用） */
  snapshot(): WsConnectionSnapshot[] {
    return [...this.connections.values()]
      .map((conn) => ({
        id: conn.id,
        serviceId: conn.serviceId,
        routeId: conn.routeId,
        path: conn.path,
        remoteAddress: conn.remoteAddress,
        connectedAt: conn.connectedAt,
        framesIn: conn.framesIn,
        framesOut: conn.framesOut,
      }))
      .sort((a, b) => a.connectedAt - b.connectedAt);
  }

  /** 某条 WS 路由的当前连接数（0 表示无连接） */
  countForRoute(routeId: string): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.routeId === routeId) count += 1;
    }
    return count;
  }

  /** 服务停止 / 删除：立即销毁该服务的全部连接（否则 server.close() 在长连接下会永久挂起） */
  destroyForService(serviceId: string): void {
    for (const conn of [...this.connections.values()]) {
      if (conn.serviceId !== serviceId) continue;
      conn.socket.terminate();
    }
  }

  /** 销毁全部连接（进程退出 / 测试清理用） */
  destroyAll(): void {
    for (const conn of [...this.connections.values()]) {
      conn.socket.terminate();
    }
  }

  /** 未注册 / 已停用 → 404、认证失败 → 401：直接在 socket 上返回 HTTP 响应并关闭，不进入 Express 分发 */
  private rejectHandshake(
    socket: Duplex,
    status: number,
    error: string,
    serviceId: string,
    path: string,
    route: Route | null,
    startedAt: number,
    bearer = false,
  ): void {
    const lines = [
      `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Not Found'}`,
      'connection: close',
      'content-type: application/json; charset=utf-8',
    ];
    if (bearer) lines.push('www-authenticate: Bearer');
    socket.end(`${lines.join('\r\n')}\r\n\r\n${JSON.stringify({ ok: false, error })}`);
    this.deps.logs?.push({
      id: randomUUID(),
      ts: startedAt,
      serviceId,
      method: 'WS',
      path,
      matched: route ? { routeId: route.id, variant: null } : null,
      status,
      error,
      durationMs: Date.now() - startedAt,
    });
  }

  private accept(
    ws: WebSocket,
    req: IncomingMessage,
    route: Route,
    params: Record<string, string>,
    serviceId: string,
    path: string,
    searchParams: URLSearchParams,
    startedAt: number,
  ): void {
    const conn: WsConnection = {
      /* 8 位十六进制（32 bit）：4 位在长开多连接下会生日碰撞，碰撞会让连接注册表互相覆盖 */
      id: `c-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      serviceId,
      routeId: route.id,
      path,
      remoteAddress: req.socket.remoteAddress ?? '',
      connectedAt: startedAt,
      framesIn: 0,
      framesOut: 0,
      socket: ws,
      route,
      params,
      query: flattenSearchParams(searchParams),
      headers: flattenHeaders(req.headers),
      timers: new Set(),
      closed: false,
      seqIndex: 0,
      idCounter: 0,
    };
    this.connections.set(conn.id, conn);
    ws.on('message', (data, isBinary) => {
      if (conn.closed) return;
      conn.framesIn += 1;
      this.handleMessage(conn, data, isBinary);
    });
    ws.on('close', (code) => {
      this.closeConnection(conn, typeof code === 'number' ? code : 1005);
    });
    ws.on('error', () => {
      /* close 事件随后必然到达，统一在 close 清理与写日志 */
    });
    this.playOnOpen(conn);
    this.startInterval(conn);
  }

  private handleMessage(conn: WsConnection, data: unknown, isBinary: boolean): void {
    const onMessage = conn.route.ws?.onMessage;
    if (!onMessage || onMessage.mode === 'none') return;
    if (onMessage.mode === 'echo') {
      /* 原样回显：不做模板渲染 */
      if (conn.socket.readyState !== WebSocket.OPEN) return;
      conn.socket.send(data as Parameters<WebSocket['send']>[0], { binary: isBinary });
      conn.framesOut += 1;
      return;
    }
    const replies = onMessage.replies ?? [];
    if (replies.length === 0) return;
    const reply = onMessage.mode === 'fixed' ? replies[0] : replies[conn.seqIndex % replies.length];
    if (onMessage.mode === 'sequence') conn.seqIndex += 1;
    this.sendBody(conn, reply);
  }

  /** 发送一条剧本消息：字符串原样（支持模板），其余深度渲染后 JSON 序列化 */
  private sendBody(conn: WsConnection, body: unknown): void {
    const text =
      typeof body === 'string'
        ? renderString(body, this.templateContext(conn))
        : JSON.stringify(renderTemplate(body, this.templateContext(conn))) ?? 'null';
    if (conn.closed || conn.socket.readyState !== WebSocket.OPEN) return;
    conn.socket.send(text);
    conn.framesOut += 1;
  }

  /** 模板上下文：query + header + params + $ 系列（握手无请求体，消息体不参与模板） */
  private templateContext(conn: WsConnection): TemplateContext {
    return {
      query: conn.query,
      headers: conn.headers,
      params: conn.params,
      body: undefined,
      routeId: conn.routeId,
      nextId: () => {
        conn.idCounter += 1;
        return conn.idCounter;
      },
    };
  }

  private playOnOpen(conn: WsConnection): void {
    const behavior = conn.route.ws;
    const messages = behavior?.onOpen ?? [];
    this.playSequence(conn, messages, behavior?.loopOnOpen === true && messages.length > 0);
  }

  /** 按序播放消息列表：每条相对上一条的延迟生效；loop 时整个序列播完从头再来 */
  private playSequence(conn: WsConnection, messages: WsMessage[], loop: boolean): void {
    let elapsed = 0;
    for (const message of messages) {
      elapsed += Math.max(0, message.delayMs ?? 0);
      const timer = setTimeout(() => {
        conn.timers.delete(timer);
        if (!conn.closed) this.sendBody(conn, message.body);
      }, elapsed);
      conn.timers.add(timer);
    }
    if (loop) {
      const timer = setTimeout(() => {
        conn.timers.delete(timer);
        if (!conn.closed) this.playSequence(conn, messages, true);
      }, elapsed);
      conn.timers.add(timer);
    }
  }

  private startInterval(conn: WsConnection): void {
    const interval = conn.route.ws?.interval;
    if (!interval) return;
    /* 配置文件可绕过 API 校验写入过小间隔，运行时兜底 100ms 防止刷帧 */
    const everyMs = Math.max(100, interval.everyMs);
    const timer = setInterval(() => {
      if (!conn.closed) this.sendBody(conn, interval.body);
    }, everyMs);
    conn.timers.add(timer);
  }

  private closeConnection(conn: WsConnection, closeCode: number): void {
    if (conn.closed) return;
    conn.closed = true;
    for (const timer of conn.timers) clearTimeout(timer);
    conn.timers.clear();
    this.connections.delete(conn.id);
    /* 连接级日志：帧不落盘，只记录握手 / 计数与关闭码，避免定时推送冲掉 HTTP 请求日志 */
    this.deps.logs?.push({
      id: randomUUID(),
      ts: conn.connectedAt,
      serviceId: conn.serviceId,
      method: 'WS',
      path: conn.path,
      matched: { routeId: conn.routeId, variant: null },
      status: 101,
      durationMs: Date.now() - conn.connectedAt,
      ws: { connectionId: conn.id, framesIn: conn.framesIn, framesOut: conn.framesOut, closeCode },
    });
  }

  /** 注册表变更：WS 路由签名（serviceId / path / auth / disabled / ws）变化的存量连接以 1012 关闭 */
  private syncRoutes(): void {
    const next = new Map<string, string>();
    for (const route of this.registry.list()) {
      if (route.protocol !== 'ws') continue;
      next.set(route.id, JSON.stringify([route.serviceId, route.path, route.auth ?? null, route.disabled ?? false, route.ws ?? null]));
    }
    for (const [routeId, signature] of this.signatures) {
      if (next.get(routeId) === signature) continue;
      this.signatures.delete(routeId);
      for (const conn of [...this.connections.values()]) {
        if (conn.routeId === routeId) conn.socket.close(WS_CLOSE_ROUTE_CHANGED, 'route updated');
      }
    }
    for (const [routeId, signature] of next) this.signatures.set(routeId, signature);
  }
}
