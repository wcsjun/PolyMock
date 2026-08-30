import type { RequestLogEntry } from '../types.js';

/**
 * 固定容量的请求日志存储：超容量淘汰最旧条目。
 * 纯内存，不落盘；list 按新 -> 旧排序返回。
 */
export class RequestLogStore {
  private readonly entries: RequestLogEntry[] = [];

  constructor(private readonly capacity = 500) {}

  /** 追加一条日志，超出容量时淘汰最旧的 */
  push(entry: RequestLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
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
