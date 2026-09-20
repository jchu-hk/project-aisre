/**
 * lifecycle/machine.ts —— LifecycleMachine：校验与执行合法迁移（§12.6）
 *
 * 硬约束：
 *   - 状态集合与迁移白名单配置驱动（LifecycleSpec，默认 §12.6）。
 *   - closed 是**单调锁位**：除显式 reopen（带 reopen_reason）外，任何 closed→非closed
 *     迁移一律拒绝（AC-016「禁止关闭态静默复活为不知情重生」）。
 *   - closed→closed（同态）恒禁止。
 *   - 复开必须给依据（reopen_reason），且落到 accepted/in_progress 或 investigating。
 *
 * 纯函数无 IO：transition() 产出 {ok, event|error}；由调用方负责写入 store/审计。
 */

import {
  LifecycleState,
  LifecycleTrigger,
  LifecycleActorType,
  isClosed,
} from './state';
import { LifecycleSpec, DEFAULT_LIFECYCLE_SPEC, TransitionDef } from './state';

/** 一次合法迁移事件（落库到 sre_incident_state_transitions 的对象） */
export interface LifecycleTransitionEvent {
  incident_id: string;
  system_id: string;
  issue_id: number | null;
  prev_state: LifecycleState;
  new_state: LifecycleState;
  trigger: LifecycleTrigger;
  actor_type: LifecycleActorType;
  actor_id: string;
  reason: string | null;
  reopen_reason: string | null;
  trace_id: string | null;
  policy_version: string | null;
  occurred_at: string; // ISO
}

interface TransitionCtx {
  incident_id: string;
  system_id: string;
  issue_id?: number | null;
  trigger?: LifecycleTrigger;
  actor_type?: LifecycleActorType;
  actor_id?: string;
  reason?: string | null; // 补充依据
  reopen_reason?: string | null; // closed→reopen 才需要
  trace_id?: string | null;
  policy_version?: string | null;
  at?: string; // ISO 时刻（测试可注入）
}

export interface MachineResultOk {
  ok: true;
  event: LifecycleTransitionEvent;
}
export interface MachineResultErr {
  ok: false;
  /** 稳定错误码（网关/读路径可直接 422 return） */
  code: 'malformed_transition' | 'forbidden_resurrect' | 'same_state' | 'reopen_requires_reason';
  message: string;
}
export type MachineResult = MachineResultOk | MachineResultErr;

const FAIL_CLOSED_REASON = 'Unknown actor / reason not supplied; lifecycle transition denied (fail-closed).';

/** 纯状态机：给定从/到/上下文返回迁移判定（不写任何 store/db）。 */
export class LifecycleMachine {
  constructor(private readonly spec: LifecycleSpec = DEFAULT_LIFECYCLE_SPEC) {}

  /** 默认触发者查找（按 from/to 在规范里找 one def 的 kind；可能多——取第一匹配）。 */
  private defaultTrigger(from: LifecycleState, to: LifecycleState): LifecycleTrigger | undefined {
    const f = this.findTransitions(from, to);
    return f.length ? f[0].kind : undefined;
  }

  private findTransitions(from: LifecycleState, to: LifecycleState): TransitionDef[] {
    return this.spec.transitions.filter((t) => t.from === from && t.to === to);
  }

  /**
   * 判定 from→to 是否可配置的合法迁移。
   *   1) 查白名单（含 default trigger / reopen 标记）。
   *   2) closed 锁：非 reopen 不应发生 closed→其他；reopen 须带 reopen_reason。
   *   3) from===to 一律不是合法迁移（尤其 closed→closed）。
   * @param reason 外部提供的依据（可为 undefined——对 require-reason 类强制）
   */
  canTransition(from: LifecycleState, to: LifecycleState): boolean {
    if (from === to) return false; // 同态非迁移
    const defs = this.findTransitions(from, to);
    if (defs.length === 0) return false;
    // closed 除显式 reopen（def.reopen=true）不可出（reopen 由 openClosedWithReason 把控）
    if (isClosed(from)) {
      // 只允许 reopen def
      return defs.some((d) => d.reopen === true);
    }
    return true;
  }

  /**
   * 生成一笔合法迁移事件；非法返回错误（fail-closed），绝不让「只做不记」的空迁移过。
   */
  transition(
    from: LifecycleState,
    to: LifecycleState,
    ctx: TransitionCtx,
  ): MachineResult {
    // —— 同态 ——
    if (from === to) {
      // closed→closed 或任意同态皆非迁移：拒绝并记录原因
      return {
        ok: false,
        code: 'same_state',
        message: `lifecycle ${from}→${to} 同态不是迁移（§12.6 不允许 closed→closed / 无意义跳转）`,
      };
    }
    const defs = this.findTransitions(from, to);
    // 不在白名单 → malformed
    if (defs.length === 0) {
      return {
        ok: false,
        code: 'malformed_transition',
        message: `lifecycle ${from}→${to} 不在白名单（§12.6 合法迁移表外跳转拒绝）`,
      };
    }
    // choose best def: prefer one matching provided trigger else fallback first
    let def: TransitionDef = defs[0];
    if (ctx.trigger) {
      const m = defs.find((d) => d.kind === ctx.trigger);
      if (m) def = m;
    }

    // —— closed 锁：唯一出路是显式 reopen（def.reopen=true 且带 reopen_reason）——
    if (isClosed(from)) {
      if (!def.reopen) {
        return {
          ok: false,
          code: 'forbidden_resurrect',
          message: `closed incident 不能经 ${def.kind} 静默复活（§12.6）；必须显式 reopen 带原因`,
        };
      }
      const rr = ctx.reopen_reason;
      if (!rr || !rr.trim().length) {
        return {
          ok: false,
          code: 'reopen_requires_reason',
          message: 'closed→显式 reopen 必须携带 reopen_reason（防止 unaware 重生，AC-016）',
        };
      }
    }

    // reason 门槛：需 reason 但缺 → fail-closed
    const requiresReason = !def.reasonOptional && !def.reopen;
    if (requiresReason && (!ctx.reason || !String(ctx.reason).trim().length)) {
      return {
        ok: false,
        code: 'forbidden_resurrect',
        message: '该 lifecycle 迁移需要依据(reason)才放行（fail-closed）',
      };
    }

    const trigger: LifecycleTrigger = ctx.trigger ?? def.kind;
    const event: LifecycleTransitionEvent = {
      incident_id: ctx.incident_id,
      system_id: ctx.system_id,
      issue_id: ctx.issue_id ?? null,
      prev_state: from,
      new_state: to,
      trigger,
      actor_type: ctx.actor_type ?? (from === 'closed' ? 'human' : 'ai_sre'),
      actor_id: ctx.actor_id ?? 'ai-sre-service',
      reason: ctx.reason ?? null,
      reopen_reason: def.reopen ? (ctx.reopen_reason ?? ctx.reason ?? null) : null,
      trace_id: ctx.trace_id ?? null,
      policy_version: ctx.policy_version ?? null,
      occurred_at: ctx.at ?? new Date().toISOString(),
    };
    return { ok: true, event };
  }

  /** closed→ 显式 reopen 便捷入口（到 accepted/in_progress 或 investigating，必须 reason）。 */
  reopen(
    incident_id: string,
    system_id: string,
    to: 'accepted_in_progress' | 'investigating',
    opts: { reason: string; actor_id?: string; actor_type?: LifecycleActorType; trace_id?: string; issue_id?: number | null; policy_version?: string; at?: string } & object,
  ): MachineResult {
    if (!opts.reason || !opts.reason.trim().length) {
      return {
        ok: false,
        code: 'reopen_requires_reason',
        message: FAIL_CLOSED_REASON,
      };
    }
    return this.transition('closed', to, {
      incident_id,
      system_id,
      issue_id: opts.issue_id ?? null,
      trigger: 'explicit_reopen',
      actor_type: opts.actor_type ?? 'human',
      actor_id: opts.actor_id ?? 'ai-sre-service',
      reason: opts.reason,
      reopen_reason: opts.reason,
      trace_id: opts.trace_id ?? null,
      policy_version: opts.policy_version ?? null,
      at: opts.at,
    });
  }
}
