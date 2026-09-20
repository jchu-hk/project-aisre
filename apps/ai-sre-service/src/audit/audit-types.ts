/**
 * audit/audit-types.ts —— F-AUDIT 审计事件类型（Phase 2 / DESIGN §2.1 / §3）
 *
 * 对齐设计文档 §2.1 `audit_log` 逻辑模型（终端选型 D：嵌入式 SQLite 单文件、WAL）。
 * 字段回答 SPEC §2.1 的四问：谁（who）/ 何时（when）/ 做什么（what）/ 为何（why）。
 *
 * 本文件为纯定义（无 IO），便于单测与跨模块共享。
 */

/** 审计主体类别：agent / user / system（DESIGN §2.1） */
export type WhoType = 'agent' | 'user' | 'system';

/** 操作结果（SPEC FR-AUDIT-005 / DESIGN §2.1） */
export type AuditResult = 'success' | 'failed' | 'denied' | 'pending';

/** 触发来源（why 的可结构化维度；DESIGN §2.1 why_source） */
export type WhySource =
  | 'intake'
  | 'chat'
  | 'schedule'
  | 'alert'
  | 'detector'
  | 'lifecycle'
  | 'approval'
  | 'query'
  | 'system'
  | string;

/**
 * 审计事件（写入载荷；seq/prev_hash/hash 由 hash-chain 补齐后落盘）。
 *
 * 说明：params_digest 为入参摘要（脱敏后的摘要素，禁全量明文，DESIGN §2.1）。
 */
export interface AuditEvent {
  /** who：主体类别 + 身份标识 */
  who_type: WhoType;
  who_id: string;
  /** when：事件时间（UTC ISO-8601） */
  when: string;
  /** what：操作类型枚举（如 intake.received / incident.lifecycle.changed / restart） */
  action_type: string;
  /** 目标资源标识 */
  target_resource: string;
  /** 入参摘要（脱敏；null 表示无入参） */
  params_digest: string | null;
  /** why：触发来源 */
  why_source: WhySource;
  /** 关联 incident（FR-AUDIT-004） */
  incident_id: string | null;
  /** 关联会话（F-CHAT，FR-AUDIT-004） */
  session_id: string | null;
  /** 关联审批单（F-APPROVE，FR-AUDIT-004） */
  approval_id: string | null;
  /** 结果 */
  result: AuditResult;
  /** 失败/拒绝原因；result ∈ {failed, denied} 时非空（FR-AUDIT-005） */
  reason: string | null;
}

/** 已落盘的完整审计记录（含哈希链锚点字段 + 主键 + 全局序号） */
export interface AuditRecord extends AuditEvent {
  /** UUIDv7（时间有序），DESIGN §2.1 */
  id: string;
  /** 全局单调递增序号（哈希链锚点） */
  seq: number;
  /** 前一记录的 hash；genesis 记录为固定前导 */
  prev_hash: string;
  /** 本记录 hash = H(seq ‖ prev_hash ‖ canonical(payload)) */
  hash: string;
}

/** 查询过滤（FR-AUDIT-003：who / when 范围 / action_type / result） */
export interface AuditQuery {
  who?: string;
  from?: string; // ISO；含下界
  to?: string; // ISO；含上界
  action_type?: string;
  result?: AuditResult;
  incident_id?: string;
  session_id?: string;
  approval_id?: string;
}

/** 分页（page 从 1 起，size 缺省 50、上限 500） */
export interface AuditPaging {
  page?: number;
  size?: number;
}

/** 哈希链校验结果（AC-AUDIT-002） */
export interface AuditVerifyResult {
  ok: boolean; // 完整=true；断链=false
  checked: number; // 已校验记录数
  head_seq: number | null; // 链头 seq
  head_hash: string | null; // 链头 hash
  broken_at_seq?: number | null; // 断链位置（ok=false 时）
  reason?: string | null; // 断链原因
}
