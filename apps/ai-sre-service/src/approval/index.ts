/**
 * approval/index.ts —— F-APPROVE 公开 API 聚合（Phase 2）
 *
 * 便于 main.ts 一行接入：
 *   buildApproval({ dbPath, audit }) → { store, engine, handle, sweeper }
 * 其中 sweeper 为 TTL 后台扫描器（到期活动单据 → EXPIRED）。
 *
 * 与 F-AUDIT 集成：engine 的每次判定/决定/白名单变更经 AuditWriter 异步发审计事件。
 * 迁移契约见 db/migrations/0004_phase2_approval.sql。
 */

import { ApprovalStore, ApprovalStoreOptions } from './approval-store';
import { ApprovalEngine, DEFAULT_TTL_MS } from './approval-engine';
import { buildApprovalHandle, ApprovalHandle, ApprovalHttpDeps, APPROVAL_PATH, WHITELIST_PATH } from './http';
import { AuditWriter } from '../audit';

export * from './approval-types';
export { ApprovalStore } from './approval-store';
export { ApprovalEngine, DEFAULT_TTL_MS, isHighRisk, applyDiff } from './approval-engine';
export { WhitelistEngine, scopeMatches, conditionMatches, inWindow } from './whitelist';
export { buildApprovalHandle, APPROVAL_PATH, WHITELIST_PATH } from './http';
export type { WhitelistStore, WhitelistEngineStore } from './whitelist-store';

export interface BuildApprovalOptions extends ApprovalStoreOptions {
  /** 审计写入器（F-AUDIT）；缺省不发审计。 */
  audit?: AuditWriter;
  ttlMs?: number;
  clock?: () => string;
  defaultActor?: string;
  defaultRole?: ApprovalHttpDeps['defaultRole'];
  /** TTL 扫描间隔（ms）；0 → 不启动后台扫描（单测可手动 expireDue）。 */
  sweepIntervalMs?: number;
}

export interface ApprovalRuntime {
  store: ApprovalStore;
  engine: ApprovalEngine;
  handle: ApprovalHandle;
  /** 手动触发一次 TTL 扫描。 */
  sweep: () => number;
  close: () => void;
}

/** 构建 approval 运行时（不直接挂 http；由 main.ts 并入单一 request 监听器）。 */
export function buildApproval(opts: BuildApprovalOptions = {}): ApprovalRuntime {
  const store = new ApprovalStore(opts);
  const engine = new ApprovalEngine({
    store,
    audit: opts.audit,
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
    clock: opts.clock,
  });
  const handle = buildApprovalHandle({
    engine,
    defaultActor: opts.defaultActor ?? 'approval-console',
    defaultRole: opts.defaultRole,
  });

  let timer: NodeJS.Timeout | null = null;
  const interval = opts.sweepIntervalMs ?? 60_000;
  if (interval > 0) {
    timer = setInterval(() => {
      try {
        engine.expireDue();
      } catch {
        /* 扫描异常不崩主链路 */
      }
    }, interval);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    store,
    engine,
    handle,
    sweep: () => engine.expireDue().length,
    close: () => {
      if (timer) clearInterval(timer);
      timer = null;
      store.close();
    },
  };
}

/** 播种初始白名单版本 v1（若尚无版本）。用于服务首启/待接入态。 */
export function seedInitialWhitelist(
  store: ApprovalStore,
  entries: import('./approval-types').WhitelistEntry[],
  createdBy = 'system',
  at = new Date().toISOString(),
): void {
  if (store.currentVersion()) return;
  store.appendWhitelistVersion({ entries, created_by: createdBy, created_at: at, approval_id: null, diff_from_prev: null });
}
