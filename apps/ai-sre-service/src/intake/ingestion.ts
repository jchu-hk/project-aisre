/**
 * intake/ingestion.ts
 *
 * 用户报障摄入编排（F-SRE-014 §3.11 主流程）：
 *   报文 → 归一化(normalize) → 三分类 triage → Issue 关联 → 回执闭环 → 持久化(store)
 *
 * new：创建 incident + 关联/创建 Issue（本地 store 伪 issue，真实创建走 IssueGateWay），
 *      回执「已受理(received)」；
 * dup/known：归并入既有，补充证据（addComment / mergeIntoDuplicate），不新建 Issue/告警；
 *      回执合并通知。
 * 异常流：报文缺关键字段 → 返回标记 missing，由调用方 428 + 提示补全（UC-SRE-016）。
 *
 * ⚠️ 纯进程内可自测参照实现：真实 RDBMS 持久化与真实 GitHub / 回执通道由
 *    DEVOPS 依据本体骨架 + migrations 接入（本文件不写数据库/GitHub/回执的
 *    硬编码外部端点，符合「系统无关」）。
 */

import {
  IntakeIncident,
  IncidentAckStatus,
  NormalizeResult,
} from '../incidents/incident.types';
import { IncidentStore, decideTriage, TriageDecision } from '../incidents/incident-store';
import { NoopIssueGateway, IssueGateway } from '../incidents/issue-gateway';
import { normalizeReport, RawReport } from './normalize';
import { Acknowledger, AckBackend } from './acknowledger';

export interface IntakeOutcome {
  ok: boolean;
  /** 428 missing 时列出应补字段 */
  missingFields?: string[];
  /** 429 / 400 错误描述 */
  error?: string;
  /** 受理 / 归并 / 新建 判定 */
  triage?: TriageDecision;
  incident?: IntakeIncident;
  /** 回执是否成功 */
  acked: boolean;
  /** 关联/创建的 Issue（new）或既有并入 Issue */
  issueId: number | null;
  /** 回执文案（供日志/审计展示） */
  ackMessage?: string;
}

export interface IntakeMeta {
  sourceChannel: string;
  /** 接收时间（HTTP 层传真实 now；测试可注入） */
  receivedAt: Date;
}

/**
 * IntakeService —— 统一收纳各类通道（webhook/webform/im/email）的入口。
 * 任意通道把 RawReport + meta 交给 ingest()。
 * 每 incident 对应 store 中一条；dup 记录亦保留（不可变审计）。
 */
export class IntakeService {
  private readonly issueGateway: IssueGateway;
  private readonly acknowledger: Acknowledger;

  constructor(
    private readonly store: IncidentStore,
    opts?: {
      issueGateway?: IssueGateway;
      ackBackend?: AckBackend;
      ackMaxAttempts?: number;
    },
  ) {
    this.issueGateway = opts?.issueGateway ?? new NoopIssueGateway();
    this.acknowledger = new Acknowledger(
      store,
      opts?.ackBackend,
      opts?.ackMaxAttempts ?? 3,
    );
  }

  /** 受控暴露回执器（供状态推进会话用） */
  ack(): Acknowledger {
    return this.acknowledger;
  }

  /** 单条报障摄入主流程 */
  async ingest(report: RawReport, meta: IntakeMeta): Promise<IntakeOutcome> {
    // —— 归一化 + 校验 ——
    const norm: NormalizeResult = normalizeReport(report, {
      sourceChannel: meta.sourceChannel,
      receivedAt: meta.receivedAt,
    });
    if (!norm.ok || !norm.incident) {
      return {
        ok: false,
        missingFields: norm.missing,
        error: norm.missing.length
          ? '报文缺关键字段，请补全后重试'
          : norm.errors.join('; '),
        acked: false,
        issueId: null,
      };
    }
    const inc = norm.incident;

    // 可选：报障者在已知 Issue 上报（issue_id 提示）→ 关联该 Issue，供 known 判定
    const hint = (report as { issue_id?: number }).issue_id;
    if (typeof hint === 'number' && Number.isInteger(hint)) {
      inc.issue_id = hint;
    }

    // —— 三分类 triage ——
    const decision = decideTriage(inc, this.store);
    inc.triage = decision.triage;
    if (decision.triage === 'dup') {
      // 归并既有（不新建 Issue/告警，AC-014b）
      const base = this.store.getById(decision.duplicate_of_id!)!;
      this.store.mergeIntoDuplicate(inc, base);
      inc.issue_id = base.issue_id ?? decision.known_issue_id;
      // 补充证据 / 合并通知（best-effort）
      if (base.issue_id) {
        await this.issueGateway.addComment(base.issue_id, `[F-SRE-014] 重复报障归并 ${inc.incident_id}`);
      }
      // 不重复回执到既有原报障者？仍向本条报障者给合并回执
      const acked = await this.acknowledger.acknowledge(
        inc.incident_id,
        'received',
        '该报障与既有 incident 重复，已归并，无需新建工单',
      );
      return {
        ok: true,
        triage: decision,
        incident: inc,
        acked,
        issueId: inc.issue_id,
      };
    }

    // —— new / known ——
    // known 时若关联到既有 Issue 则补充证据（不新建），仍未关联则建 Issue
    let issueId: number | null = inc.issue_id ?? null;
    // 落库（B1：known 分支此前在 return 前未 upsert，导致已知 issue 再报不入 store →
    // acked=false、报障丢失不可追踪补证；此处与 new 分支同构，先持久化再走回执）
    this.store.upsert(inc);
    if (decision.triage === 'known' && decision.known_issue_id != null) {
      issueId = decision.known_issue_id;
      await this.issueGateway.addComment(issueId, `[F-SRE-014] 命中已知根因 incident ${inc.incident_id}`);
      this.store.markIssue(inc.incident_id, issueId);
      const acked = await this.acknowledger.acknowledge(
        inc.incident_id,
        'received',
        '该报障命中进行中已知问题，将并入 Issue',
      );
      inc.ack_status = 'received';
      return { ok: true, triage: decision, incident: inc, acked, issueId };
    }

    // —— new：创建/关联 Issue ——
    const title = `[报障] ${inc.system_id} — ${truncateLabel(inc.symptom_desc, 60)}`;
    const body = issueBody(inc);
    const created = await this.issueGateway.createIssue(inc, title, body);
    if (created.issueId != null && created.issueId > 0) {
      issueId = created.issueId;
      this.store.markIssue(inc.incident_id, issueId);
    }
    inc.issue_id = issueId;

    // 落库
    this.store.upsert(inc);

    // —— 回执 已受理 ——
    const acked = await this.acknowledger.acknowledge(
      inc.incident_id,
      'received',
      '已受理并登记为新 incident，进入排查',
    );
    return { ok: true, triage: decision, incident: inc, acked, issueId, ackMessage: '已受理' };
  }

  /** 供外部状态推进会话（如 Detector 修好/关单）调用 */
  transitionAck(id: string, next: IncidentAckStatus): Promise<boolean> {
    return this.acknowledger.acknowledge(id, next);
  }
}

function truncateLabel(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function issueBody(inc: IntakeIncident): string {
  return [
    `- 系统: ${inc.system_id}`,
    `- 来源: ${inc.source_channel}`,
    `- 报障现象: ${inc.symptom_desc}`,
    `- 初步严重度: ${inc.reported_severity || 'N/A'}`,
    `- 回执联系: ${inc.reporter_contact_ref || '(未提供)'}  ⚠️ 仅脱敏引用，用于回执`,
    `- incident_id: ${inc.incident_id}`,
  ].join('\n');
}
