/**
 * lifecycle/project.ts —— 三 legacy 轴字段与 lifecycle 的权威联合/投影规则（§12.8-①）
 *
 * 结论实现的「join/projection 不变式」（即 DB-SCHEMA §2 与 DATA-DICTIONARY §状态四轴）：
 *
 *   A. 四字段是同一事物的**正交轴**，非两套真相：
 *        lifecycle           —— 对外权威生命周期（状态机 §12.6）
 *        status(processing)  —— 检测/自愈处置管线（detected 视界主要）
 *        triage              —— intake 三分类（一次性判定）
 *        ack_status          —— intake 回执闭环
 *     当生命周期字段未显式落库时（检测源 / 存量迁移），用 →forwardSeedProjection() 一次性 seed；
 *     之后对外读到的是 engine/flows 显式推进的 lifecycle，不由本 four-field「实时重算」覆盖。
 *
 *   B. 反向护栏：已 closed 的 instance，下方 legacy（status/triage/ack）的后端推进，**不**把
 *      lifecycle 拉回未完结处理态（Ack/Detector 的「late」关闭/复查不得凭空复活）。
 *      唯一出路是 closed→显式 reopen（带 reason）——由 LifecycleMachine.reopen 负责。
 *
 * 本文件为纯函数（无 IO），供入口/读路径/迁移 seed 复用。
 */

import { IntakeIncident } from '../incidents/incident.types';
import { LifecycleState } from './state';

/**
 * 依据 legacy 轴字段 + source，给出「未显式生命周期」时的合理 seed lifecycle（§12.6 + §7.2 桥接）。
 * 仅在 lifecycle 尚未显式推进（当前存入的 lifecycle 仍旧默认 reported 且无 transition 记录）时调用一次。
 * @returns lifecycle；调用方再写 sre_incidents.lifecycle / lifecycle_updated_at 即可。
 */
export function forwardSeedProjection(inc: Pick<IntakeIncident, 'source' | 'status' | 'triage' | 'ack_status'>): LifecycleState {
  const { source, status, triage, ack_status } = inc;
  if (source === 'detected') {
    // 检测源 status(resolved|suppressed) → closed；locating/healing/escalated → investigating
    if (status === 'resolved' || status === 'suppressed') return 'closed';
    return 'investigating';
  }
  // source === 'intake'
  // ack 回执闭环 closed/fixed 视为已关单（显式处置）
  if (ack_status === 'closed' || ack_status === 'fixed') {
    // fixed 仍处"已修复待关"→留给 ack closed 处置；此二态一律映射处理完成关单可下转 accepted 由 flow，
    // 但保险起见当 ack=closed 已显式关单 → closed
    return ack_status === 'closed' ? 'closed' : 'accepted_in_progress';
  }
  if (triage === 'dup' || triage === 'known') {
    // 三分类并入（triaged dup/known → 并入源 / known 已知 Issue），不入 investigating
    return 'closed';
  }
  if (triage === 'new') {
    return 'accepted_in_progress';
  }
  // ack received/processing 及未分类（初到）：介于 reported/received——走到受理态
  return 'accepted_in_progress';
}

/**
 * same-state latency lock check：报告一个 incident 是否已被显式 closed。
 * 对 closed 锁位，任何（除 reopen 外的）legacy 推进都会在此处被拦截并（在调用方）产生审计，
 * 防止『not知情的 unknowingly 复活』。见 LifecycleMachine 的 closed 锁 + reopen。
 */
export function isClosedLifecycle(lifecycle: LifecycleState | null | undefined): boolean {
  return lifecycle === 'closed';
}

/**
 * 返回可对外展示的精简投影字段名集合（列表 item 白名单，§12.2 精简投影）。
 * UI/Dashboard 只用这些，不出现 PII（symptom_desc 全文/raw/原始 contact 不回）。
 */
export const LIST_ITEM_PROJECTION = [
  'id',
  'system_id',
  'lifecycle',
  'severity',
  'triage',
  'source',
  'affected_component',
  'ack_status',
  'issue_id',
  'created_at',
  'lifecycle_updated_at',
] as const;
