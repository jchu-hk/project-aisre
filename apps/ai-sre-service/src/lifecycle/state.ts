/**
 * lifecycle/state.ts —— lifecycle 状态与配置驱动的合法迁移定义（§12.6）
 *
 * 对齐 DESIGN §12.6：`reported → triage(dup/known/new) → accepted_in_progress →
 * investigating → closed`，外加并入分支（dup/known→closed@triage，不入 investigating）、
 * detected 汇入与显式 reopen。状态集合与迁移表「配置驱动」而非写死分支（NFR-X）。
 *
 * 本模块为纯定义/纯函数（无 IO），便于单测。
 */

/**
 * lifecycle 对外合法状态（= DB sre_incident_lifecycle_enum）。
 * stored 名字与 DB enum 对齐；display/in-code 保持不变。
 */
export const LIFECYCLE_STATES = [
  'reported',
  'triage',
  'accepted_in_progress',
  'investigating',
  'closed',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** 是否 lifecycle 已达「关单」锁位 */
export function isClosed(state: LifecycleState): boolean {
  return state === 'closed';
}

/**
 * 迁移「触发分类」（= DB sre_lifecycle_trigger_enum）。驱动 audit/trigger 溯源与理由语义。
 */
export const LIFECYCLE_TRIGGERS = [
  'intake_normalize',
  'intake_received',
  'detector',
  'triage_new',
  'triage_merge',
  'triage_known_issue',
  'investigation_start',
  'investigation_pause',
  'fix_verify',
  'manual_close',
  'suppressed',
  'explicit_reopen',
  'issue_state_sync',
] as const;
export type LifecycleTrigger = (typeof LIFECYCLE_TRIGGERS)[number];

/** 该迁移触发者类型分类 */
export type LifecycleActorType =
  | 'ai_sre'
  | 'detector'
  | 'triage'
  | 'intake_channel'
  | 'human'
  | 'query_console'
  | string;

/**
 * 一条合法迁移定义（配置驱动）。
 * - reopen 为真：仅 closed→ 合法（closed 唯一出路，必须带 reason）。
 * - allow_same：是否允许 from=to（默认 false——closed→closed 恒禁止，§12.6「不允许」）。
 */
export interface TransitionDef {
  from: LifecycleState;
  to: LifecycleState;
  /** 默认触发者分类（溯源时若未给用） */
  kind: LifecycleTrigger;
  /** 允许缺省 reason（false=必须显式给依据才放行；reopen/manual e.g. 要求 reason） */
  reasonOptional?: boolean;
  /** 是否 closed→ 显式 reopen（须 reopen_reason） */
  reopen?: boolean;
}

/** 可配置的 lifecycle 规范（状态机 + 合法迁移）。默认实现即 §12.6 迁移表。 */
export interface LifecycleSpec {
  states: readonly LifecycleState[];
  /** 合法迁移白名单（配置可增删；默认如下）。 */
  transitions: TransitionDef[];
}

// ---------------------------------------------------------------------------
// 默认规范（= DESIGN §12.6 合法迁移表）
// ---------------------------------------------------------------------------
const DEFAULT_TRANSITIONS: TransitionDef[] = [
  // reported: intake/normalize 受理开始做三分类
  { from: 'reported', to: 'triage', kind: 'intake_normalize', reasonOptional: true },
  // reported：detected 汇入即进入处置（无需人工三分类起步；source 桥接）
  { from: 'reported', to: 'investigating', kind: 'detector' },
  // triage→accepted（new 判定进入受理/处理中）
  { from: 'triage', to: 'accepted_in_progress', kind: 'triage_new', reasonOptional: true },
  // triage→closed@triage（dup/known：并入源 incident，不入 investigating —— §12.6 并入分支）
  { from: 'triage', to: 'closed', kind: 'triage_merge' }, // dup
  { from: 'triage', to: 'closed', kind: 'triage_known_issue' }, // known（并入处理中 Issue）
  // accepted/in_progress → investigating（定向排查）
  { from: 'accepted_in_progress', to: 'investigating', kind: 'investigation_start' },
  // investigating → accepted/in_progress（等待 DEV/人工/暂停）
  { from: 'investigating', to: 'accepted_in_progress', kind: 'investigation_pause' },
  // investigating → closed（修复+验证 / 转 DEV 关单）
  { from: 'investigating', to: 'closed', kind: 'fix_verify' },
  // accepted_in_progress → closed（人工 / suppressed 关单）
  { from: 'accepted_in_progress', to: 'closed', kind: 'manual_close' },
  { from: 'accepted_in_progress', to: 'closed', kind: 'suppressed' },
  // detected locating/healing by seed maps to investigating; direct seed paths already handled.
  // (detected → reported/investigating handled above via reported→investigating detector).
  // closed → 显式 reopen（唯一出路；须带 reason，回到 accepted/in_progress 或 investigating）
  { from: 'closed', to: 'accepted_in_progress', kind: 'explicit_reopen', reopen: true },
  { from: 'closed', to: 'investigating', kind: 'explicit_reopen', reopen: true },
  // Issue state 变化回写（open→相关态 / closed→关闭，作为旁路合法迁移；reason 缺省友好）
  { from: 'reported', to: 'closed', kind: 'issue_state_sync' },
  { from: 'accepted_in_progress', to: 'closed', kind: 'issue_state_sync' },
  { from: 'investigating', to: 'closed', kind: 'issue_state_sync' },
  { from: 'triage', to: 'closed', kind: 'issue_state_sync' },
];

export const DEFAULT_LIFECYCLE_SPEC: LifecycleSpec = {
  states: LIFECYCLE_STATES,
  transitions: DEFAULT_TRANSITIONS,
};

/**
 * 由配置片段构建 spec：环境若无自定义则用默认；若有则做最小合法性校验，
 * 非法片段抛错（fail-fast），避免运行时静默漂移（NFR-X）。
 * @param overrides A list of transition defs to *replace* the default set (供 profile 增删)
 */
export function buildLifecycleSpec(overrides?: {
  states?: readonly LifecycleState[];
  transitions?: TransitionDef[];
}): LifecycleSpec {
  if (!overrides) return DEFAULT_LIFECYCLE_SPEC;
  const states: readonly LifecycleState[] = overrides.states && overrides.states.length ? overrides.states : LIFECYCLE_STATES;
  const transitions = overrides.transitions && overrides.transitions.length ? overrides.transitions : DEFAULT_TRANSITIONS;
  if (!states.includes('closed')) {
    throw new Error('LifecycleSpec: states must include closed (monotonic latch required by §12.6)');
  }
  for (const t of transitions) {
    if (!states.includes(t.from) || !states.includes(t.to)) {
      throw new Error(`LifecycleSpec: transition references unknown state ${t.from}->${t.to}`);
    }
    if (t.from === 'closed' && !t.reopen) {
      // 允许 closed→closed? NO：显式禁止静默同态关闭；重开须 reopen
      // 这里不报错——由 machine.validate 拦 closed→closed 与失位。
    }
  }
  return { states, transitions };
}
