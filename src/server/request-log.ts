import { EventEmitter } from 'node:events';
import type { RequestLogEntry } from '../types.js';

/**
 * 固定容量的请求日志存储：超容量淘汰最旧条目。
 * 纯内存，不落盘；list 按新 -> 旧排序返回。
 * 内置 EventEmitter：push() 成功后发出 'entry' 事件（携带新条目），供 SSE 实时推送订阅。
 */
export class RequestLogStore extends EventEmitter {
  private readonly entries: RequestLogEntry[] = [];

  constructor(private readonly capacity = 500) {
    super();
  }

  /** 追加一条日志，超出容量时淘汰最旧的，并向订阅者发出 'entry' 事件 */
  push(entry: RequestLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.emit('entry', entry);
  }

  /** 按新 -> 旧排序返回；可按服务过滤并限制条数 */
  list(opts?: { serviceId?: string; limit?: number }): RequestLogEntry[] {
    const filtered = opts?.serviceId
      ? this.entries.filter((entry) => entry.serviceId === opts.serviceId)
      : [...this.entries];
    const ordered = filtered.reverse();
    const limit = opts?.limit;
    return limit !== undefined && limit >= 0 ? ordered.slice(0, limit) : ordered;
  }

  /** 清空全部日志 */
  clear(): void {
    this.entries.length = 0;
  }
}
