/**
 * audit/audit-writer.ts —— 异步落盘写入器（F-AUDIT / DESIGN §3）
 *
 * 写入路径：app buffer（**有界队列**）→ 异步批量落盘。主操作不被阻塞
 * （目标 < 100ms，SPEC §2.5）。队列满时按策略丢弃并计数（审计降级可观测），
 * 绝不因审计背压阻塞主链路。
 *
 * API：
 *   emit(event)   非阻塞入队；返回 void。落盘由内部定时器/批大小触发。
 *   flush()       立即排空（测试/优雅停机用）——返回 Promise。
 *   stats()       队列深度 / 已落盘 / 丢弃计数（供 /health 或指标）。
 *
 * 时间源可注入（clock）以支持确定性单测。
 */

import { AuditEvent, AuditRecord } from './audit-types';
import { AuditStore } from './audit-store';

export interface AuditWriterOptions {
  store: AuditStore;
  /** 队列上限；超出即丢弃（记 dropped） */
  maxQueue?: number;
  /** 批量落盘条数阈值 */
  batchSize?: number;
  /** 定时冲刷间隔（ms） */
  flushIntervalMs?: number;
}

export class AuditWriter {
  private readonly store: AuditStore;
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private queue: AuditEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private dropped = 0;
  private persisted = 0;

  constructor(opts: AuditWriterOptions) {
    this.store = opts.store;
    this.maxQueue = opts.maxQueue ?? 10_000;
    this.batchSize = opts.batchSize ?? 128;
    const interval = opts.flushIntervalMs ?? 50;
    // unref：不因审计定时器阻止进程退出
    this.timer = setInterval(() => void this.flush(), interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** 非阻塞入队（主链路调用；不 IO） */
  emit(ev: AuditEvent): void {
    if (this.queue.length >= this.maxQueue) {
      this.dropped++;
      return;
    }
    this.queue.push(ev);
    if (this.queue.length >= this.batchSize) {
      void this.flush();
    }
  }

  /** 立即排空队列（批量落盘）。可重入安全：并发调用共享同一次写。 */
  flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return Promise.resolve();
    this.flushing = true;
    const batch = this.queue;
    this.queue = [];
    return Promise.resolve()
      .then(() => {
        const rows: AuditRecord[] = this.store.appendBatch(batch);
        this.persisted += rows.length;
      })
      .catch((e) => {
        // 落盘失败：不抛（不崩主链路），保留可观测计数
        this.dropped += batch.length;
        // eslint-disable-next-line no-console
        console.error('[audit] flush failed:', (e as Error).message);
      })
      .finally(() => {
        this.flushing = false;
      });
  }

  stats(): { queued: number; persisted: number; dropped: number } {
    return { queued: this.queue.length, persisted: this.persisted, dropped: this.dropped };
  }

  /** 优雅停机：停定时器并排空 */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}
