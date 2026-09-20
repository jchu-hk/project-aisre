/**
 * lifecycle/ledger.ts —— lifecycle ledger（进程内参照持久化 + 迁移/查询审计）
 *
 * 为『读路径（query endpoints）+ scope=trace 下钻』提供一致状态源，与既有 IncidentStore
 * 平行。ledger 是 对外 lifecycle / 迁移历史 / 查询审计 的进程内参照实现：
 *   - 唯一写路径：apply() 先经 LifecycleMachine 校验（纯 fail-closed），仅合法迁移 append
 *     到 transitions + 更新 current lifecycle；closed 锁 + reopen 在 machine 层强制。
 *   - RDBMS 对应：schema 见 db/migrations/0002 —— sre_incidents.lifecycle / lifecycle_updated_at
 *     + sre_incident_state_transitions + sre_incident_query_audit。
 *   - 进程内为参照实现（与 app 既有『DDL 契约 + 进程内参照』架构一致）；DEVOPS 接 PG 时段上
 *     同谓词即一致。
 *
 * 本模块无外部 IO（除内存 Map），单测友好。
 */

import { LifecycleState, LifecycleTrigger } from './state';
import {
  LifecycleMachine,
  LifecycleTransitionEvent,
  MachineResult,
} from './machine';
import { IncLifecycleMeta } from './types';

/** 内存参照迁移行（与 DB 列对齐） */
export interface TransitionRow {
  incident_id: string;
  system_id: string;
  issue_id: number | null;
  prev_state: LifecycleState;
  new_state: LifecycleState;
  trigger: string;
  actor_type: string;
  actor_id: string;
  reason: string | null;
  reopen_reason: string | null;
  trace_id: string | null;
  policy_version: string | null;
  occurred_at: string;
}

/** 查询审计记录（与 sre_incident_query_audit 对齐） */
export interface QueryAuditRow {
  id: string;
  system_id_requested: string;
  endpoint: string;
  method: string;
  actor_id: string;
  scope?: string | null;
  filters: Record<string, unknown> | null;
  cursor?: string | null;
  requested_at: string;
}

export interface LedgerOptions {
  machine?: LifecycleMachine;
  startClock?: () => string; // ISO provider（测试注入）
  /** 若要把每个 actor/incident 授权集交还 ledger 强校验可注入；默认不额外约束（读路径 ACL 在校验层） */
}

type InternalIncidentLifecycle = IncLifecycleMeta;

/** Ledger：按 incident_id 建平行索引，提供一致的 lifecycle 与 trace。 */
export class LifecycleLedger {
  private readonly machine: LifecycleMachine;
  private readonly clock: () => string;
  private readonly lifecycleById = new Map<string, InternalIncidentLifecycle>();
  private readonly transitions: TransitionRow[] = [];
  private readonly queryAudit: QueryAuditRow[] = [];

  constructor(opts?: LedgerOptions) {
    this.machine = opts?.machine ?? new LifecycleMachine();
    this.clock = opts?.startClock ?? (() => new Date().toISOString());
  }

  /** 当前 lifecycle（undefined=该 incident 尚未在 ledger 建档，即未发生任何迁移） */
  current(id: string): LifecycleState | undefined {
    return this.lifecycleById.get(id)?.lifecycle;
  }

  /** 该 incident 的轨迹（按 occurred_at asc —— scope=trace 用） */
  timeline(id: string): TransitionRow[] {
    return this.transitions
      .filter((t) => t.incident_id === id)
      .slice()
      .sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0));
  }

  /** 某 incident 是否已 closed（读路径/防落后 AC 判断用） */
  isClosed(id: string): boolean {
    return this.current(id) === 'closed';
  }

  /** 归档首条建文档（seed）——当没有 transition 也不想造 :triage 噪音时的安全写路径 */
  seed(id: string, lifecycle: LifecycleState, system_id: string): void {
    if (!this.lifecycleById.has(id)) {
      this.lifecycleById.set(id, {
        lifecycle,
        lifecycle_updated_at: this.clock(),
        lifecycle_reopen_reason: null,
      });
    }
  }

  /**
   * 推进一次 lifecycle 迁移（经 machine fail-closed）。返回事件或错误。
   * 成功即写 transitions + 更新 current；供 state-change 调用方在宿主记录。
   */
  apply(
    from: LifecycleState,
    to: LifecycleState,
    ctx: {
      incident_id: string;
      system_id: string;
      issue_id?: number | null;
      trigger?: LifecycleTrigger;
      actor_type?: string;
      actor_id?: string;
      reason?: string | null;
      reopen_reason?: string | null;
      trace_id?: string | null;
      policy_version?: string | null;
    },
  ): MachineResult {
    const res = this.machine.transition(from, to, {
      incident_id: ctx.incident_id,
      system_id: ctx.system_id,
      issue_id: ctx.issue_id ?? null,
      trigger: ctx.trigger,
      actor_type: ctx.actor_type,
      actor_id: ctx.actor_id,
      reason: ctx.reason ?? null,
      reopen_reason: ctx.reopen_reason ?? null,
      trace_id: ctx.trace_id ?? null,
      policy_version: ctx.policy_version ?? null,
      at: this.clock(),
    });
    if (res.ok) {
      this.record(res.event);
    }
    return res;
  }

  /** 写入一笔迁移（internal）—— 同步 current + transitions。 */
  record(evt: LifecycleTransitionEvent): void {
    const row: IncLifecycleMeta = {
      lifecycle: evt.new_state,
      lifecycle_updated_at: evt.occurred_at,
      lifecycle_reopen_reason: evt.reopen_reason,
    };
    this.lifecycleById.set(evt.incident_id, row);
    this.transitions.push({
      incident_id: evt.incident_id,
      system_id: evt.system_id,
      issue_id: evt.issue_id,
      prev_state: evt.prev_state,
      new_state: evt.new_state,
      trigger: evt.trigger,
      actor_type: evt.actor_type,
      actor_id: evt.actor_id,
      reason: evt.reason,
      reopen_reason: evt.reopen_reason,
      trace_id: evt.trace_id,
      policy_version: evt.policy_version,
      occurred_at: evt.occurred_at,
    });
  }

  // ---------------- trace / 查询审计 ----------------
  appendQueryAudit(row: Omit<QueryAuditRow, 'id' | 'requested_at'>, now?: string): void {
    this.queryAudit.push({
      ...row,
      id: randomUuid(),
      requested_at: now ?? this.clock(),
    });
  }

  queryAuditLog(): readonly QueryAuditRow[] {
    return this.queryAudit as readonly QueryAuditRow[];
  }

  /** 某 incident 被哪些查询审计记录触及（detail scope=audit 反查） */
  queryAuditForIncident(incident_id: string): QueryAuditRow[] {
    return this.queryAudit.filter((r) => {
      const ids = r.filters?.['matched_ids'];
      if (Array.isArray(ids) && ids.includes(incident_id)) return true;
      return false;
    });
  }
}

/** 简单 uuid v4（无外部依赖） */
export function randomUuid(): string {
  // crypto.randomUUID 在 node>=16.7；此处兜底字符串拼 uuid4
  if (typeof crypto !== 'undefined' && typeof (crypto as { randomUUID?: () => string }).randomUUID === 'function') {
    return (crypto as { randomUUID: () => string }).randomUUID();
  }
  const hex = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return hex.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
