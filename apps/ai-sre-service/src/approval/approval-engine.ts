/**
 * approval/approval-engine.ts —— F-APPROVE 审批引擎（判定 + 状态机 + 决定）
 *
 * 对齐 DESIGN-PHASE2-AUDIT-APPROVE-CHAT.md §4：
 *   状态集：DRAFT → SUBMITTED → PENDING_2ND → APPROVED → EXECUTE → DONE|FAILED
 *           旁路终态：REJECTED / EXPIRED（TTL 默认 30min 到期 = 拒绝语义）
 *
 * 核心流程（FR-APPROVE-002/004/005）：
 *   judgeOperation()   操作前判定：命中白名单 → 放行（兼审计）；未命中 → 创建审批单（含前置审计）
 *   decide()           审批决定：approve/reject/request_info；高风险强制二次复核（PENDING_2ND）；
 *                      复核人不得与初审为同一人；批准白名单变更 → 落新版本 + 审计
 *   expireDue()        TTL 扫描：到期活动单据 → EXPIRED（记 result=denied）+ 审计
 *   recordExecution()  采纳后执行结果回写（EXECUTE → DONE/FAILED）+ 审计
 *
 * 审计（F-AUDIT 集成 / FR-APPROVE-006）：每次**判定**与每次**审批决定**、
 * 每次**白名单变更**均经 AuditWriter 异步发审计事件（不阻塞主链路）。
 *   action_type: approval.judged / approval.created / approval.decided /
 *                approval.expired / approval.executed / whitelist.applied
 *
 * fail-closed（DESIGN §4）：判定异常 → 拒绝 + 审计（绝不放行）。
 */

import {
  ApprovalRequest,
  ApprovalDetail,
  ApprovalState,
  ApprovalType,
  ApprovalRole,
  ApprovalEvent,
  DecisionInput,
  DecisionResult,
  WhitelistDecision,
  WhitelistEntryDiff,
  WhitelistApplied,
  ApprovalPayload,
  WhitelistChangeRequest,
  TERMINAL_STATES,
  ACTIVE_STATES,
} from './approval-types';
import { ApprovalStore } from './approval-store';
import { WhitelistEngine, WhitelistCheckInput } from './whitelist';
import { AuditWriter, toEvent } from '../audit';
import { uuidv7 } from '../audit/audit-store';

/** 默认 TTL：30 分钟（FR-APPROVE-004.5） */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
/** 高风险操作识别（摘要/操作关键词；可由调用方显式 payload.high_risk 覆盖） */
const HIGH_RISK_KEYWORDS = ['delete', 'drop', 'truncate', 'network', 'firewall', 'policy', 'revert', 'rm_db', '删', '改网络'];

export interface ApprovalEngineOptions {
  store: ApprovalStore;
  /** 审计写入器（F-AUDIT 集成）；缺省不发审计（单测可选）。 */
  audit?: AuditWriter;
  /** 默认 TTL（ms）；缺省 30min。 */
  ttlMs?: number;
  /** 时间源（测试注入）；默认 now ISO。 */
  clock?: () => string;
}

/** 创建操作审批单入参（judgeOperation 未命中时内部使用，亦可外部直建） */
export interface CreateApprovalInput {
  type?: ApprovalType;
  summary: string;
  target_resource: string;
  risk_note: string;
  initiator_agent: string;
  incident_id?: string | null;
  session_id?: string | null;
  payload: ApprovalPayload | WhitelistChangeRequest;
  high_risk?: boolean;
  ttl_ms?: number;
}

export interface JudgeResult {
  /** 放行（命中白名单）时 true */
  allowed: boolean;
  /** 判定明细 */
  decision: WhitelistDecision;
  /** 未命中时创建的审批单 */
  approval: ApprovalRequest | null;
}

export class ApprovalEngine {
  private readonly store: ApprovalStore;
  private readonly audit?: AuditWriter;
  private readonly ttlMs: number;
  private readonly clock: () => string;
  private readonly whitelist: WhitelistEngine;

  constructor(opts: ApprovalEngineOptions) {
    this.store = opts.store;
    this.audit = opts.audit;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.whitelist = new WhitelistEngine(opts.store);
  }

  /** 暴露白名单引擎（判定/查询）。 */
  whitelistEngine(): WhitelistEngine {
    return this.whitelist;
  }

  // ================================================================ 判定

  /**
   * 操作前判定 + 自动建单（FR-APPROVE-002）。
   *   - 命中白名单 → 放行 + 审计（approval.judged, result=success）；
   *   - 未命中     → 创建审批单（state=SUBMITTED）+ 审计（approval.judged result=denied + approval.created）；
   *   - 判定异常   → fail-closed 拒绝 + 审计（result=denied, reason 非空）。
   */
  judgeOperation(
    input: WhitelistCheckInput & {
      initiator_agent: string;
      summary?: string;
      risk_note?: string;
      incident_id?: string | null;
      session_id?: string | null;
      params?: Record<string, unknown>;
      high_risk?: boolean;
    },
  ): JudgeResult {
    const decision = this.whitelist.check(input);
    const at = this.clock();

    if (decision.allowed) {
      this.emit({
        who_type: 'agent',
        who_id: input.initiator_agent,
        at,
        action_type: 'approval.judged',
        target_resource: input.target_resource,
        params_digest: `op=${input.operation};allowed=true;ver=${decision.version}`,
        why_source: 'approval',
        incident_id: input.incident_id ?? null,
        session_id: input.session_id ?? null,
        approval_id: null,
        result: 'success',
        reason: null,
      });
      return { allowed: true, decision, approval: null };
    }

    // 未命中 / fail-closed → 建单（fail-closed 亦建单，供人工裁决）
    const approval = this.createApproval({
      type: 'operation',
      summary: input.summary ?? `${input.operation} on ${input.target_resource}`,
      target_resource: input.target_resource,
      risk_note: input.risk_note ?? decision.reason,
      initiator_agent: input.initiator_agent,
      incident_id: input.incident_id ?? null,
      session_id: input.session_id ?? null,
      payload: {
        action_type: input.operation,
        target_resource: input.target_resource,
        params: input.params ?? {},
        env: input.env ?? 'unknown',
        high_risk: input.high_risk ?? isHighRisk(input.operation, input.summary ?? ''),
      },
      high_risk: input.high_risk ?? isHighRisk(input.operation, input.summary ?? ''),
    });

    this.emit({
      who_type: 'agent',
      who_id: input.initiator_agent,
      at,
      action_type: 'approval.judged',
      target_resource: input.target_resource,
      params_digest: `op=${input.operation};allowed=false;ver=${decision.version ?? 'none'}`,
      why_source: 'approval',
      incident_id: input.incident_id ?? null,
      session_id: input.session_id ?? null,
      approval_id: approval.approval_id,
      result: 'denied',
      reason: decision.reason,
    });

    return { allowed: false, decision, approval };
  }

  /** 直接创建审批单（DRAFT → SUBMITTED），落事件流 + 审计。 */
  createApproval(input: CreateApprovalInput): ApprovalRequest {
    const at = this.clock();
    const type: ApprovalType = input.type ?? 'operation';
    const highRisk = input.high_risk ?? false;
    // 高风险 → 需 SRE 初审 + 平台/安全负责人复核；低风险 → 仅 SRE。
    const required_roles: ApprovalRole[] = highRisk
      ? ['oncall_sre', 'platform_owner']
      : ['oncall_sre'];
    const approval_id = uuidv7();
    const ttlMs = input.ttl_ms ?? this.ttlMs;
    const req: ApprovalRequest = {
      approval_id,
      type,
      summary: input.summary,
      target_resource: input.target_resource,
      risk_note: input.risk_note,
      initiator_agent: input.initiator_agent,
      incident_id: input.incident_id ?? null,
      session_id: input.session_id ?? null,
      required_roles,
      state: 'SUBMITTED',
      ttl_expire_at: new Date(Date.parse(at) + ttlMs).toISOString(),
      payload_ref: input.payload,
      created_at: at,
      updated_at: at,
    };
    this.store.insertRequest(req);
    // 建单：DRAFT(隐性起点) → SUBMITTED
    this.store.appendEvent({
      approval_id,
      from_state: 'DRAFT',
      to_state: 'SUBMITTED',
      actor: input.initiator_agent,
      actor_role: null,
      reason: highRisk ? 'high-risk operation; requires 2nd review' : 'awaiting on-call SRE review',
      at,
    });
    this.emit({
      who_type: 'agent',
      who_id: input.initiator_agent,
      at,
      action_type: 'approval.created',
      target_resource: input.target_resource,
      params_digest: `type=${type};high_risk=${highRisk};roles=${required_roles.join(',')}`,
      why_source: 'approval',
      incident_id: req.incident_id,
      session_id: req.session_id,
      approval_id,
      result: 'pending',
      reason: null,
    });
    return req;
  }

  // ================================================================ 决定

  /**
   * 审批决定（FR-APPROVE-004；AC-APPROVE-004/006）。
   *   SUBMITTED + 值班 SRE approve：
   *      高风险 → PENDING_2ND；低风险 → APPROVED（并落白名单变更版本）
   *   SUBMITTED + reject → REJECTED（终态）
   *   SUBMITTED + request_info → DRAFT（退回补充，可重提）
   *   PENDING_2ND + 平台/安全负责人 approve → APPROVED
   * 校验：终态拒绝；角色须在 required_roles；复核人不得与初审同人；reject 须给理由。
   */
  decide(approval_id: string, input: DecisionInput): DecisionResult {
    const at = input.at ?? this.clock();
    const req = this.store.getRequest(approval_id);
    if (!req) return { ok: false, code: 'not_found', message: '审批单不存在', field: 'id' };

    // 终态不可迁移
    if (TERMINAL_STATES.includes(req.state)) {
      return {
        ok: false,
        code: 'invalid_state',
        message: `审批单已处于终态 ${req.state}，不可再裁决`,
        field: 'state',
      };
    }
    // TTL 已过 → 视为 EXPIRED（拒绝语义）
    if (Date.parse(at) >= Date.parse(req.ttl_expire_at)) {
      this.expire(req, at, 'T+TTL expired at decision time');
      return { ok: false, code: 'expired', message: '审批单已超时（EXPIRED=拒绝语义）', field: 'ttl' };
    }
    // reject/request_info 必须有理由（FR-AUDIT-005 精神）
    if ((input.decision === 'reject' || input.decision === 'request_info') && !input.reason?.trim()) {
      return { ok: false, code: 'missing_reason', message: `${input.decision} 必须提供 reason`, field: 'reason' };
    }
    // 角色须为所需角色
    if (!req.required_roles.includes(input.actor_role)) {
      return {
        ok: false,
        code: 'role_not_required',
        message: `角色 ${input.actor_role} 不在本单所需角色 [${req.required_roles.join(',')}]`,
        field: 'actor_role',
      };
    }

    if (req.state === 'SUBMITTED') {
      if (input.decision === 'reject') return this.transition(req, 'REJECTED', input, at);
      if (input.decision === 'request_info') return this.transition(req, 'DRAFT', input, at);
      // approve：高风险走二次复核，否则直接批准
      if (req.required_roles.length > 1 || isHighRiskPayload(req.payload_ref)) {
        return this.transition(req, 'PENDING_2ND', input, at);
      }
      return this.approveAndApply(req, input, at);
    }

    if (req.state === 'PENDING_2ND') {
      // 复核批准（FR-APPROVE-004.3）：不得与初审同一人（职责分离）
      const first = this.store.lastEventIntoState(approval_id, 'PENDING_2ND');
      if (first && first.actor === input.actor) {
        return {
          ok: false,
          code: 'second_review_same_actor',
          message: '二次复核人不得与初审为同一人（职责分离）',
          field: 'actor',
        };
      }
      if (input.decision === 'reject') return this.transition(req, 'REJECTED', input, at);
      if (input.decision === 'request_info') return this.transition(req, 'DRAFT', input, at);
      return this.approveAndApply(req, input, at);
    }

    if (req.state === 'DRAFT') {
      // 退回补充后重新提交 → SUBMITTED；此处 agent 重提动作以 request_info→approve 表达
      if (input.decision === 'approve') return this.transition(req, 'SUBMITTED', input, at);
      return { ok: false, code: 'invalid_state', message: `DRAFT 状态不支持 decision=${input.decision}`, field: 'state' };
    }

    // APPROVED / EXECUTE 由 execute 流程推进；此处不接受人工 decision
    return {
      ok: false,
      code: 'invalid_state',
      message: `状态 ${req.state} 不支持人工审批决定（请执行/回写）`,
      field: 'state',
    };
  }

  /** 批准终态：如为白名单变更 → 落新版本 + 审计 diff（FR-APPROVE-005）。 */
  private approveAndApply(req: ApprovalRequest, input: DecisionInput, at: string): DecisionResult {
    const res = this.transition(req, 'APPROVED', input, at);
    if (!res.ok) return res;
    if (req.type === 'whitelist_change') {
      this.applyWhitelistChange(req, at);
    }
    return res;
  }

  /** 单步迁移：更新投影 + 追加事件 + 审计。 */
  private transition(
    req: ApprovalRequest,
    to: ApprovalState,
    input: DecisionInput,
    at: string,
  ): DecisionResult {
    const from = req.state;
    this.store.updateState(req.approval_id, to, at);
    const event: ApprovalEvent = {
      approval_id: req.approval_id,
      from_state: from,
      to_state: to,
      actor: input.actor,
      actor_role: input.actor_role,
      reason: input.reason ?? null,
      at,
    };
    this.store.appendEvent(event);

    // 审计：result 语义（批准/推进=success；拒绝/超时=denied）
    const denied = to === 'REJECTED' || to === 'EXPIRED';
    this.emit({
      who_type: 'user',
      who_id: input.actor,
      at,
      action_type: to === 'EXPIRED' ? 'approval.expired' : 'approval.decided',
      target_resource: req.target_resource,
      params_digest: `from=${from};to=${to};role=${input.actor_role}`,
      why_source: 'approval',
      incident_id: req.incident_id,
      session_id: req.session_id,
      approval_id: req.approval_id,
      result: denied ? 'denied' : 'success',
      reason: input.reason ?? (denied ? `${to} (no reason given)` : null),
    });

    const detail = this.store.getDetail(req.approval_id)!;
    return { ok: true, request: detail, event, next_state: to };
  }

  /** 落白名单变更版本（仅批准后调用）。 */
  private applyWhitelistChange(req: ApprovalRequest, at: string): WhitelistApplied | null {
    const change = req.payload_ref as WhitelistChangeRequest | null;
    if (!change || !Array.isArray(change.entries)) return null;
    const cur = this.store.currentVersion();
    const before = cur ? cur.entries : [];
    const after = applyDiff(before, change.entries);
    const version = this.store.appendWhitelistVersion({
      entries: after,
      created_by: req.initiator_agent,
      created_at: at,
      approval_id: req.approval_id,
      diff_from_prev: change.entries,
    });
    this.emit({
      who_type: 'user',
      who_id: req.initiator_agent,
      at,
      action_type: 'whitelist.applied',
      target_resource: 'whitelist',
      params_digest: `version=${version.version};diff_ops=${change.entries.map((d) => d.op).join(',')}`,
      why_source: 'approval',
      incident_id: req.incident_id,
      session_id: req.session_id,
      approval_id: req.approval_id,
      result: 'success',
      reason: null,
    });
    return { version: version.version, diff: change.entries, approval_id: req.approval_id };
  }

  // ================================================================ 执行回写

  /** 采纳后执行结果回写（APPROVED → EXECUTE → DONE/FAILED）。 */
  recordExecution(
    approval_id: string,
    result: { ok: boolean; actor?: string; reason?: string | null },
  ): DecisionResult {
    const at = this.clock();
    const req = this.store.getRequest(approval_id);
    if (!req) return { ok: false, code: 'not_found', message: '审批单不存在', field: 'id' };
    if (req.state !== 'APPROVED' && req.state !== 'EXECUTE') {
      return { ok: false, code: 'invalid_state', message: `状态 ${req.state} 不可执行（需先 APPROVED）`, field: 'state' };
    }
    const actor = result.actor ?? req.initiator_agent;
    if (req.state === 'APPROVED') {
      this.transition(req, 'EXECUTE', { decision: 'approve', reason: 'execution started', actor, actor_role: 'oncall_sre', at }, at);
    }
    const cur = this.store.getRequest(approval_id)!;
    const to: ApprovalState = result.ok ? 'DONE' : 'FAILED';
    const res = this.transition(
      cur,
      to,
      { decision: 'approve', reason: result.reason ?? (result.ok ? 'executed' : 'execution failed'), actor, actor_role: 'oncall_sre', at },
      at,
    );
    if (res.ok) {
      this.emit({
        who_type: 'agent',
        who_id: actor,
        at,
        action_type: 'approval.executed',
        target_resource: req.target_resource,
        params_digest: `op=${(req.payload_ref as ApprovalPayload)?.action_type ?? req.type}`,
        why_source: 'approval',
        incident_id: req.incident_id,
        session_id: req.session_id,
        approval_id,
        result: result.ok ? 'success' : 'failed',
        reason: result.reason ?? (result.ok ? null : 'execution failed'),
      });
    }
    return res;
  }

  // ================================================================ TTL 扫描

  /** 扫描到期活动单据 → EXPIRED（记 denied + 审计，FR-APPROVE-004.5）。返回处理数。 */
  expireDue(now?: string): ApprovalRequest[] {
    const at = now ?? this.clock();
    const due = this.store.listExpired(at);
    for (const req of due) this.expire(req, at, 'TTL expired (auto-deny)');
    return due;
  }

  private expire(req: ApprovalRequest, at: string, reason: string): void {
    const from = req.state;
    this.store.updateState(req.approval_id, 'EXPIRED', at);
    this.store.appendEvent({
      approval_id: req.approval_id,
      from_state: from,
      to_state: 'EXPIRED',
      actor: 'system',
      actor_role: null,
      reason,
      at,
    });
    this.emit({
      who_type: 'system',
      who_id: 'approval-sweeper',
      at,
      action_type: 'approval.expired',
      target_resource: req.target_resource,
      params_digest: `from=${from};to=EXPIRED`,
      why_source: 'approval',
      incident_id: req.incident_id,
      session_id: req.session_id,
      approval_id: req.approval_id,
      result: 'denied',
      reason,
    });
  }

  // ================================================================ 查询

  getDetail(id: string): ApprovalDetail | null {
    return this.store.getDetail(id);
  }
  list(q: Parameters<ApprovalStore['listRequests']>[0], p?: Parameters<ApprovalStore['listRequests']>[1]) {
    return this.store.listRequests(q, p);
  }
  /** 白名单版本列表（只读，DESIGN §7）。 */
  listWhitelistVersions() {
    return this.store.listVersions();
  }
  /** 指定白名单版本（只读；AC-APPROVE-001）。 */
  getWhitelistVersion(version: number) {
    return this.store.getVersion(version);
  }

  // ================================================================ 审计

  private emit(input: {
    who_type: 'agent' | 'user' | 'system';
    who_id: string;
    at: string;
    action_type: string;
    target_resource: string;
    params_digest: string | null;
    why_source: string;
    incident_id: string | null;
    session_id: string | null;
    approval_id: string | null;
    result: 'success' | 'failed' | 'denied' | 'pending';
    reason: string | null;
  }): void {
    if (!this.audit) return;
    this.audit.emit(
      toEvent({
        who_type: input.who_type,
        who_id: input.who_id,
        when: input.at,
        action_type: input.action_type,
        target_resource: input.target_resource,
        params_digest: input.params_digest,
        why_source: input.why_source,
        incident_id: input.incident_id,
        session_id: input.session_id,
        approval_id: input.approval_id,
        result: input.result,
        reason: input.reason,
      }),
    );
  }
}

// ------------------------------------------------------------------ helpers

/** 高风险识别：显式 high_risk 或操作/摘要命中关键词。 */
export function isHighRisk(action_type: string, summary: string): boolean {
  const hay = `${action_type} ${summary}`.toLowerCase();
  return HIGH_RISK_KEYWORDS.some((k) => hay.includes(k.toLowerCase()));
}

function isHighRiskPayload(payload: ApprovalPayload | WhitelistChangeRequest | null): boolean {
  // 白名单变更视为高风险（需平台负责人批准，FR-APPROVE-005）
  if (!payload) return false;
  if ('entries' in payload) return true;
  return payload.high_risk === true;
}

/** 应用条目级 diff 到 before 集，产出 after 集。 */
export function applyDiff(before: import('./approval-types').WhitelistEntry[], diff: WhitelistEntryDiff[]) {
  const key = (e: { operation: string; resource_scope: string }) => `${e.operation}::${e.resource_scope}`;
  const map = new Map(before.map((e) => [key(e), e]));
  for (const d of diff) {
    if (d.op === 'add' && d.after) map.set(key(d.after), d.after);
    else if (d.op === 'remove' && d.before) map.delete(key(d.before));
    else if (d.op === 'modify' && d.after) map.set(key(d.after), d.after);
  }
  return Array.from(map.values());
}
