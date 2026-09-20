/**
 * query/types.ts —— incident 查询/列表 API 域模型（§12.2）
 *
 * 对齐 DESIGN §12.2：过滤白名单、游标分页、精简/详情/下钻三级投影、
 * scope=full|trace|audit、per-system ACL、统一 error shape {code,message,field?}。
 */

export interface IncidentListQuery {
  /** 系统命名空间（可空=所辖全系统；非空须在授权集内） */
  system_id?: string;
  /** processing 处置轴 status（可选过滤） */
  status?: string | string[];
  /** 对外权威 lifecycle（可选单值过滤；多个用 lifecycle[]） */
  lifecycle?: string | string[];
  /** 来源 detected/intake */
  source?: string;
  /** severity 白名单数组 */
  severity?: string[];
  /** created_at 时间区间 [from,to] ISO */
  created_from?: string;
  created_to?: string;
  /** 关联 GitHub Issue */
  issue_id?: number;
  /** 现象/标题子串检索 */
  q?: string;
  /** scope=full 返回完整字段（PII 掩码）；scope=audit 返回关联审计轨迹；list 缺省会精简 */
  scope?: 'full' | 'trace' | 'audit';
}

export interface CursorPaging {
  /** 游标（base64 编码的 opaque token，含排序键/复用 filter hash）；空=首页 */
  cursor?: string;
  /** 每页条数 default 20（上限可配，code 层 clamp，如 ≤100） */
  limit?: number;
}

/** 排序键（对齐默认 occurred_at desc / lifecycle_updated_at desc） */
export type IncidentSortField = 'created_at' | 'lifecycle_updated_at' | 'severity';
export type IncidentSortOrder = 'asc' | 'desc';

export interface IncidentListRow {
  id: string;
  system_name: string;
  lifecycle: string;
  severity: string;
  triage: string | null;
  source: string;
  affected_component: string | null;
  ack_status: string | null;
  issue_id: number | null;
  issue_url: string | null; // https://github.com/…/issues/{id}（经 host/profile 注入或 null）
  created_at: string;
  updated_at: string; // = lifecycle_updated_at（对外 updated 语义）
}

export interface IncidentTimelineHop {
  prev_state: string;
  new_state: string;
  trigger: string;
  actor_id: string;
  reason: string | null;
  occurred_at: string;
}

/** scope=full 详情负载（PII 一律掩码/不回） */
export interface IncidentDetail {
  id: string;
  system_id: string;
  source: string;
  anomaly_type: string | null;
  severity: string;
  reported_severity: string | null;
  status: string;
  lifecycle: string;
  lifecycle_reopen_reason: string | null;
  affected_component: string | null;
  triage: string | null;
  duplicate_of_id: string | null;
  issue_id: number | null;
  issue_url: string | null;
  ack_status: string | null;
  reporter_contact: string | null; // 掩码形态
  symptom_desc: string | null;
  received_at: string | null;
  detected_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  /** scope=trace：lifecycle 迁移时间线（每跳/触发者/依据/旧新） */
  timeline?: IncidentTimelineHop[];
  /** scope=audit：关联查询审计/动作审计概要 */
  audit?: ReadonlyArray<Record<string, unknown>>;
}

export interface IncidentListResponse {
  items: IncidentListRow[];
  next_cursor: string | null;
  count: number;
}

export interface QueryErrorBody {
  code: string;
  message: string;
  field?: string;
}

// -------- 常量/工具（投影 / 掩码 / issue url） --------

export const LIST_LIMIT_MAX = 100;
export const LIST_LIMIT_DEFAULT = 20;

/** 过滤白名单键（§12.2）—— 审计 filters 仅接受这些键（防枚举攻击/侧信道） */
export const QUERY_FILTER_ALLOWLIST = [
  'system_id',
  'status',
  'lifecycle',
  'source',
  'severity',
  'created_from',
  'created_to',
  'issue_id',
  'q',
] as const;
