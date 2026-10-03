/**
 * chat/rate-limit.ts —— 限流（F-CHAT / FR-CHAT-005）
 *
 * 按 **用户 + IP** 双维度滑动窗口限流（DESIGN §8「限流按用户/IP」）。
 * 超过阈值 → 429 语义（AC-CHAT-005）。纯内存实现（进程内），时间源可注入。
 *
 * 双窗：per-user 与 per-IP 各自独立计数；任一超限即拒绝。
 */

export interface RateLimitOptions {
  /** 每用户窗口内最大请求数（默认 60） */
  perUserLimit?: number;
  /** 每 IP 窗口内最大请求数（默认 120） */
  perIpLimit?: number;
  /** 窗口长度（ms，默认 60s） */
  windowMs?: number;
  /** 时间源（epoch ms，测试注入） */
  now?: () => number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** 剩余额度（取两维较小值） */
  remaining: number;
  /** 距窗口重置的秒数（Retry-After） */
  retry_after: number;
  /** 触发的维度 */
  dimension: 'user' | 'ip' | null;
}

export class RateLimiter {
  private readonly perUserLimit: number;
  private readonly perIpLimit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly users = new Map<string, Bucket>();
  private readonly ips = new Map<string, Bucket>();

  constructor(opts: RateLimitOptions = {}) {
    this.perUserLimit = opts.perUserLimit ?? 60;
    this.perIpLimit = opts.perIpLimit ?? 120;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 计一次请求，返回是否放行。 */
  check(userId: string, ip: string): RateLimitResult {
    const t = this.now();
    const u = this.bump(this.users, `u:${userId}`, this.perUserLimit, t);
    const i = this.bump(this.ips, `i:${ip}`, this.perIpLimit, t);
    const allowed = u.ok && i.ok;
    const dimension: RateLimitResult['dimension'] = !u.ok ? 'user' : !i.ok ? 'ip' : null;
    const retry_after = Math.max(
      u.ok ? 0 : Math.ceil((u.bucket.windowStart + this.windowMs - t) / 1000),
      i.ok ? 0 : Math.ceil((i.bucket.windowStart + this.windowMs - t) / 1000),
      0,
    );
    const remaining = Math.max(
      0,
      Math.min(this.perUserLimit - u.bucket.count, this.perIpLimit - i.bucket.count),
    );
    return { allowed, remaining, retry_after, dimension };
  }

  private bump(
    map: Map<string, Bucket>,
    key: string,
    limit: number,
    t: number,
  ): { ok: boolean; bucket: Bucket } {
    let b = map.get(key);
    if (!b || t - b.windowStart >= this.windowMs) {
      b = { count: 0, windowStart: t };
      map.set(key, b);
    }
    b.count += 1;
    return { ok: b.count <= limit, bucket: b };
  }

  /** 重置（测试/管理用） */
  reset(): void {
    this.users.clear();
    this.ips.clear();
  }

  /** 清理过期桶（可被定时器调用；避免内存膨胀） */
  sweep(): void {
    const t = this.now();
    for (const m of [this.users, this.ips]) {
      for (const [k, b] of m) {
        if (t - b.windowStart >= this.windowMs) m.delete(k);
      }
    }
  }
}
