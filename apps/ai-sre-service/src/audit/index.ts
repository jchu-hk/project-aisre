/**
 * audit/index.ts —— F-AUDIT 公开 API 聚合（Phase 2）
 *
 * 便于 main.ts 一行接入：构建 AuditStore（SQLite 单文件 WAL）+ AuditWriter（有界异步队列）
 * + 查询 handle，并暴露便捷 emit 助手（收报成功 / 生命周期变更两处埋点）。
 *
 * 无外部依赖（node:sqlite 内建），与既有「DDL 契约 + 进程内参照」架构一致；
 * 迁移契约见 db/migrations/0002/0003。
 */

import { AuditStore, AuditStoreOptions } from './audit-store';
import { AuditWriter } from './audit-writer';
import { buildAuditHandle, AuditHandle, AuditHttpDeps } from './http';
import { AuditEvent, WhoType, AuditResult, WhySource } from './audit-types';

export * from './audit-types';
export { AuditStore, uuidv7 } from './audit-store';
export { AuditWriter } from './audit-writer';
export { buildAuditHandle, AUDIT_PATH } from './http';
export {
  computeHash,
  canonicalPayload,
  verifyChain,
  linkRecord,
  GENESIS_PREV_HASH,
} from './hash-chain';

export interface AuditRuntime {
  store: AuditStore;
  writer: AuditWriter;
  handle: AuditHandle;
}

export interface BuildAuditOptions extends AuditStoreOptions {
  /** 默认主体 */
  defaultActor?: string;
  maxQueue?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  /** 是否注册查询审计埋点（默认 true） */
  auditQueries?: boolean;
}

/** 构建 audit 运行时（不直接挂 http；由 main.ts 并入单一 request 监听器） */
export function buildAudit(opts: BuildAuditOptions = {}): AuditRuntime {
  const store = new AuditStore(opts);
  const writer = new AuditWriter({
    store,
    maxQueue: opts.maxQueue,
    batchSize: opts.batchSize,
    flushIntervalMs: opts.flushIntervalMs,
  });
  const httpDeps: AuditHttpDeps = {
    store,
    writer: opts.auditQueries === false ? undefined : writer,
    defaultActor: opts.defaultActor ?? 'audit-console',
  };
  const handle = buildAuditHandle(httpDeps);
  return { store, writer, handle };
}

// ------------------------------------------------------------------ 埋点助手

export interface EmitInput {
  who_type: WhoType;
  who_id: string;
  when: string;
  action_type: string;
  target_resource: string;
  params_digest?: string | null;
  why_source: WhySource;
  incident_id?: string | null;
  session_id?: string | null;
  approval_id?: string | null;
  result: AuditResult;
  reason?: string | null;
}

/** 规范化并校验后入队（FR-AUDIT-005：failed/denied 必须带 reason） */
export function toEvent(input: EmitInput): AuditEvent {
  let reason = input.reason ?? null;
  if ((input.result === 'failed' || input.result === 'denied') && !reason) {
    reason = 'unspecified'; // 兜底：保证非空约束
  }
  return {
    who_type: input.who_type,
    who_id: input.who_id,
    when: input.when,
    action_type: input.action_type,
    target_resource: input.target_resource,
    params_digest: input.params_digest ?? null,
    why_source: input.why_source,
    incident_id: input.incident_id ?? null,
    session_id: input.session_id ?? null,
    approval_id: input.approval_id ?? null,
    result: input.result,
    reason,
  };
}

/** 埋点：intake 收报成功 */
export function emitIntakeReceived(
  writer: AuditWriter,
  input: {
    incident_id: string | null;
    system_id?: string;
    channel: string;
    at: string;
    ok: boolean;
    reason?: string | null;
  },
): void {
  writer.emit(
    toEvent({
      who_type: 'system',
      who_id: `intake:${input.channel}`,
      when: input.at,
      action_type: input.ok ? 'intake.received' : 'intake.rejected',
      target_resource: input.incident_id ?? input.system_id ?? 'intake',
      params_digest: input.system_id ? `system_id=${input.system_id};channel=${input.channel}` : null,
      why_source: 'intake',
      incident_id: input.incident_id,
      result: input.ok ? 'success' : 'failed',
      reason: input.reason ?? null,
    }),
  );
}

/** 埋点：incident 生命周期状态变更 */
export function emitLifecycleChanged(
  writer: AuditWriter,
  input: {
    incident_id: string;
    system_id: string;
    prev_state: string;
    new_state: string;
    trigger: string;
    actor_id?: string;
    actor_type?: WhoType;
    reason?: string | null;
    at: string;
  },
): void {
  writer.emit(
    toEvent({
      who_type: input.actor_type ?? 'agent',
      who_id: input.actor_id ?? 'ai-sre',
      when: input.at,
      action_type: 'incident.lifecycle.changed',
      target_resource: `${input.system_id}/${input.incident_id}`,
      params_digest: `prev=${input.prev_state};new=${input.new_state};trigger=${input.trigger}`,
      why_source: 'lifecycle',
      incident_id: input.incident_id,
      result: 'success',
      reason: input.reason ?? null,
    }),
  );
}
