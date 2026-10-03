/**
 * approval/approval-types.ts —— F-APPROVE 类型定义（Phase 2 / DESIGN §2.2 §2.3 §4）
 *
 * 对齐 DESIGN-PHASE2-AUDIT-APPROVE-CHAT.md：
 *   §2.2 whitelist_version / whitelist_entry（版本化白名单，运行时只读当前生效版本）
 *   §2.3 approval_request / approval_event（审批单为不可变事件流）
 *   §4   审批状态机（DRAFT→SUBMITTED→PENDING_2ND→APPROVED→EXECUTE→DONE|FAILED；旁路 REJECTED/EXPIRED）
 *
 * 本文件为纯定义（无 IO），便于单测与跨模块共享。
 */

// ------------------------------------------------------------------ 白名单

/**
 * 白名单条目（DESIGN §2.2 whitelist_entry）。
 *   operation + resource_scope + condition(env 限定) + effective_from/to。
 */
export interface WhitelistEntry {
  /** 操作类型（如 restart / scale / read_metric） */
  operation: string;
  /** 资源范围：'*' 通配 / 'system/<id>' 精确 / 'system/<id>/<component>' 前缀 */
  resource_scope: string;
  /** 允许条件：如 env ∈ {dev, staging}；null=不限 */
  condition: WhitelistCondition | null;
  /** 生效起（ISO；null=立即） */
  effective_from: string | null;
  /** 生效止（ISO；null=无限） */
  effective_to: string | null;
}

/** 环境限定条件（DESIGN §2.2 condition(env 限定)） */
export interface WhitelistCondition {
  /** 允许的环境白名单；空/缺省=不限 */
  env?: string[];
}

/** 一条白名单条目的变更（增/删/改；DESIGN §2.2 diff_from_prev / FR-APPROVE-005） */
export interface WhitelistEntryDiff {
  op: 'add' | 'remove' | 'modify';
  /** 变更前条目（add 时为 null） */
  before: WhitelistEntry | null;
  /** 变更后条目（remove 时为 null） */
  after: WhitelistEntry | null;
}

/** 白名单版本快照（DESIGN §2.2 whitelist_version；不可变） */
export interface WhitelistVersion {
  /** 版本号（自增，从 1 起） */
  version: number;
  /** 该版本完整条目集（快照） */
  entries: WhitelistEntry[];
  created_by: string;
  created_at: string;
  /** 使其生效的审批单（初始版本为 null） */
  approval_id: string | null;
  /** 相对前一版本的 diff（初始版本为 null） */
  diff_from_prev: WhitelistEntryDiff[] | null;
}

/** 白名单判定结果（FR-APPROVE-002） */
export interface WhitelistDecision {
  /** 命中白名单 → 允许自主执行 */
  allowed: boolean;
  /** 命中的条目（allowed=true 时） */
  matched: WhitelistEntry | null;
  /** 判定依据/未命中原因 */
  reason: string;
  /** 判定所用白名单版本 */
  version: number | null;
  /** 判定耗时（ms） */
  elapsed_ms: number;
}

// ------------------------------------------------------------------ 审批单

/** 审批单类型（DESIGN §2.3 type / §7） */
export type ApprovalType = 'operation' | 'whitelist_change';

/** 审批状态机状态集（DESIGN §4） */
export type ApprovalState =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'PENDING_2ND'
  | 'APPROVED'
  | 'EXECUTE'
  | 'DONE'
  | 'FAILED'
  | 'REJECTED'
  | 'EXPIRED';

/** 终态（事件流不再迁移） */
export const TERMINAL_STATES: ReadonlyArray<ApprovalState> = [
  'DONE',
  'FAILED',
  'REJECTED',
  'EXPIRED',
];

/** 活动态（TTL 到期纳入 EXPIRED 扫描） */
export const ACTIVE_STATES: ReadonlyArray<ApprovalState> = [
  'DRAFT',
  'SUBMITTED',
  'PENDING_2ND',
  'APPROVED',
  'EXECUTE',
];

/** 审批角色（DESIGN §5 RBAC 角色集） */
export type ApprovalRole = 'oncall_sre' | 'platform_owner' | 'security_owner' | 'auditor';

/** 决定类型（DESIGN §7 decision body decision 字段） */
export type Decision = 'approve' | 'reject' | 'request_info';

/** 待执行操作载荷（发起时冻结，供采纳后执行） */
export interface ApprovalPayload {
  /** 操作类型（如 restart/scale/delete_db） */
  action_type: string;
  /** 目标资源 */
  target_resource: string;
  /** 操作入参 */
  params: Record<string, unknown>;
  /** 环境（用于白名单 condition 判定） */
  env: string;
  /** 是否高风险（高风险强制二次复核，FR-APPROVE-004.3） */
  high_risk: boolean;
}

/** 白名单变更请求体（type=whitelist_change 时携带，FR-APPROVE-005） */
export interface WhitelistChangeRequest {
  /** 目标条目 diff 列表 */
  entries: WhitelistEntryDiff[];
  /** 变更理由 */
  reason: string;
}

/** 审批单（DESIGN §2.3 approval_request；事件流投影，state=最新状态） */
export interface ApprovalRequest {
  approval_id: string;
  type: ApprovalType;
  /** 操作摘要（FR-APPROVE-003） */
  summary: string;
  target_resource: string;
  /** 风险说明（FR-APPROVE-003） */
  risk_note: string;
  initiator_agent: string;
  incident_id: string | null;
  session_id: string | null;
  /** 需审角色（含高风险二次复核标记） */
  required_roles: ApprovalRole[];
  /** 当前状态 */
  state: ApprovalState;
  /** 超时时刻（默认 +30min） */
  ttl_expire_at: string;
  /** 待执行载荷引用（operation）/ diff（whitelist_change） */
  payload_ref: ApprovalPayload | WhitelistChangeRequest | null;
  created_at: string;
  updated_at: string;
}

/** 审批事件（不可变；DESIGN §2.3 approval_event） */
export interface ApprovalEvent {
  approval_id: string;
  from_state: ApprovalState | null;
  to_state: ApprovalState;
  /** 动作发起者（agent 自动 / 审批人 user id） */
  actor: string;
  actor_role: ApprovalRole | null;
  reason: string | null;
  at: string;
}

/** 单据详情 = 单据 + 事件流 */
export interface ApprovalDetail extends ApprovalRequest {
  events: ApprovalEvent[];
}

/** 列表查询过滤（DESIGN §7 GET /approvals?state&type&page&size） */
export interface ApprovalQuery {
  state?: ApprovalState;
  type?: ApprovalType;
}

/** 分页 */
export interface ApprovalPaging {
  page?: number;
  size?: number;
}

/** 决定入参 */
export interface DecisionInput {
  decision: Decision;
  reason: string;
  actor: string;
  actor_role: ApprovalRole;
  at?: string;
}

/** 决定结果 */
export type DecisionResult =
  | { ok: true; request: ApprovalDetail; event: ApprovalEvent; next_state: ApprovalState }
  | { ok: false; code: ApprovalErrorCode; message: string; field?: string };

/** 稳定错误码（网关可直接映射 HTTP 状态） */
export type ApprovalErrorCode =
  | 'not_found'
  | 'invalid_state'
  | 'role_not_required'
  | 'high_risk_requires_2nd'
  | 'second_review_same_actor'
  | 'missing_reason'
  | 'invalid_input'
  | 'whitelist_load_failed'
  | 'expired';

/** 白名单变更生效结果（采纳后应用到新版本） */
export interface WhitelistApplied {
  version: number;
  diff: WhitelistEntryDiff[];
  approval_id: string;
}
