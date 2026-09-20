/**
 * lifecycle/driver.ts —— LifecycleDriver（intent → 合法迁移，幂等安全）
 *
 * 唯一被允许向 LifecycleLedger（→ machine fail-closed）写 lifecycle 的业务入口，
 * 把「intake 判定 / 排查推进 / 关单 / reopen」映射为 §12.6 合法 trigger。
 *
 * 护栏：
 *   - 全幂等：已在目标态 → 不写噪音迁移（返回 'noop'）。
 *   - closed 唯一出路 = 显式 reopen(reason)；progress()/mergeClosed 不会把 closed 拉回
 *     未完结处理态（AC-016）：即使 legacy ack/status 再推进也不会静默重生。
 *   - 读路径 scope=trace 即读 ledger.timeline（无死信）。
 */

import { LifecycleLedger } from './ledger';
import { LifecycleState, LifecycleTrigger } from './state';
import type { IntakeOutcome } from '../intake/ingestion';

export type StepStatus = 'advanced' | 'noop' | 'missing';
export interface StepResult {
  status: StepStatus;
}

interface Ref {
  incident_id: string;
  system_id: string;
  issue_id: number | null;
}

export class LifecycleDriver {
  constructor(
    private readonly find: (id: string) => Ref | undefined,
    private readonly ledger: LifecycleLedger,
    private readonly actorId = 'ai-sre-service',
  ) {}

  private step(
    id: string,
    from: LifecycleState,
    to: LifecycleState,
    trigger: LifecycleTrigger,
    reason?: string | null,
  ): StepStatus {
    const ref = this.find(id);
    if (!ref) return 'missing';
    const res = this.ledger.apply(from, to, {
      incident_id: id,
      system_id: ref.system_id,
      issue_id: ref.issue_id,
      trigger,
      actor_id: this.actorId,
      reason: reason ?? null,
    });
    return res.ok ? 'advanced' : 'noop'; // same_state/malformed/fail-closed → 不推进
  }

  /** intake `new` 受理：报告受纳（reported 起步）→ triage → accepted（合法两步）。幂等。 */
  acceptNew(incident_id: string): StepResult {
    const ref = this.find(incident_id);
    if (!ref) return { status: 'missing' };
    if (!this.ledger.current(incident_id)) {
      this.ledger.seed(incident_id, 'reported', ref.system_id);
    }
    // reported → triage（受纳+做三分类）
    if (this.ledger.current(incident_id) === 'reported') {
      this.step(incident_id, 'reported', 'triage', 'intake_normalize', 'intake 受纳 (normalize)');
    }
    // triage(new) → accepted_in_progress
    if (this.ledger.current(incident_id) === 'triage') {
      this.step(incident_id, 'triage', 'accepted_in_progress', 'triage_new', 'triage=new → 受理');
    }
    return {
      status: this.ledger.current(incident_id) === 'accepted_in_progress' ? 'advanced' : 'noop',
    };
  }

  /** dup / known 归并：副本直接 closed（审计保留；不入 investigating/active） */
  mergeClosed(incident_id: string, kind: 'dup' | 'known'): StepResult {
    const ref = this.find(incident_id);
    if (!ref) return { status: 'missing' };
    if (!this.ledger.current(incident_id)) this.ledger.seed(incident_id, 'reported', ref.system_id);
    if (this.ledger.current(incident_id) === 'closed') return { status: 'noop' };
    const trigger: LifecycleTrigger = kind === 'dup' ? 'triage_merge' : 'triage_known_issue';
    const s = this.step(incident_id, 'reported', 'closed', trigger, kind === 'dup' ? 'dup 归并并入源' : 'known 并入已知 Issue');
    return { status: s };
  }

  /** 排查推进 / 验收关单 */
  progress(incident_id: string, action: 'start' | 'close'): StepResult {
    const cur = this.ledger.current(incident_id);
    if (!cur) return { status: 'missing' };
    if (action === 'start') {
      if (cur === 'investigating') return { status: 'noop' };
      return { status: this.step(incident_id, cur, 'investigating', 'investigation_start', '进入排查') };
    }
    // close
    if (cur === 'closed') return { status: 'noop' };
    const trigger: LifecycleTrigger = cur === 'investigating' ? 'fix_verify' : 'manual_close';
    return {
      status: this.step(incident_id, cur, 'closed', trigger, cur === 'investigating' ? '修复+验证关单' : '人工/suppressed关单'),
    };
  }

  /** 显式 reopen：closed 唯一出路，reason 必填（machine 强校验）。 */
  reopen(incident_id: string, to: 'accepted_in_progress' | 'investigating', reason: string): StepResult {
    if (!reason || !reason.trim()) return { status: 'noop' }; // machine also guards
    const ref = this.find(incident_id);
    if (!ref) return { status: 'missing' };
    if (this.ledger.current(incident_id) !== 'closed') return { status: 'noop' };
    const res = this.ledger.apply('closed', to, {
      incident_id,
      system_id: ref.system_id,
      issue_id: ref.issue_id,
      trigger: 'explicit_reopen',
      actor_id: this.actorId,
      reason,
      reopen_reason: reason,
    });
    return { status: res.ok ? 'advanced' : 'noop' };
  }
}

/** intake outcome 的 new/dup/known → 对应 driver 动作（供主进程/测试联动）。 */
export function enactIngest(driver: LifecycleDriver, outcome: IntakeOutcome): StepResult[] {
  const inc = outcome.incident;
  if (!inc) return [];
  switch (outcome.triage?.triage) {
    case 'dup':
      return [driver.mergeClosed(inc.incident_id, 'dup')];
    case 'known':
      return [driver.mergeClosed(inc.incident_id, 'known')];
    default:
      return [driver.acceptNew(inc.incident_id)];
  }
}
