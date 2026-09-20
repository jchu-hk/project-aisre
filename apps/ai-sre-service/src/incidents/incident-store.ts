/**
 * incidents/incident-store.ts
 *
 * sre_incidents 内存域存储（M2 骨架；检测 + 用户报障 Intake 统一真相源，
 * DESIGN §7.2 表 1）。真实持久化交由 DEVOPS 依 db/migrations/0001_*.sql
 * 落地 RDBMS；本模块提供决策/去重/回执/保留策略同构的进程内参照实现，
 * 使 AC-014a/014b 与 UC-SRE-016 可独立自测，不依赖外部 DB。
 *
 * 方法均为纯同步便于测试；不引入异步副作用。
 */

import {
  IntakeIncident,
  IncidentTriage,
  IncidentAckStatus,
} from './incident.types';

export interface TriageDecision {
  triage: IncidentTriage;
  /** triage=dup 时并入的既有 incident_id */
  duplicate_of_id: string | null;
  /** triage=known 时关联的既有 issue_id（若有） */
  known_issue_id: number | null;
  reason: string;
}

/** 去重指纹到既有 intake incident 的索引 */
export class IncidentStore {
  private readonly byId = new Map<string, IntakeIncident>();
  /** 现役（未关单）incident 首建 id，按指纹索引（F-SRE-007 抑制 / dup 窗口） */
  private readonly activeByFingerprint = new Map<string, string>(); // fp -> firstId

  upsert(inc: IntakeIncident): void {
    this.byId.set(inc.incident_id, inc);
    if (!this.activeByFingerprint.has(inc.dedup_fingerprint)) {
      this.activeByFingerprint.set(inc.dedup_fingerprint, inc.incident_id);
    }
  }

  getById(id: string): IntakeIncident | undefined {
    return this.byId.get(id);
  }

  all(): IntakeIncident[] {
    return Array.from(this.byId.values());
  }

  /** 视 incident 为已闭环（不再参与 dup/known/抑制匹配） */
  isClosed(inc: IntakeIncident): boolean {
    return inc.ack_status === 'closed' || inc.status === 'resolved';
  }

  /** 同指纹现役 incident（dup/known 候选） */
  findActiveByFingerprint(fp: string): IntakeIncident[] {
    const res: IntakeIncident[] = [];
    const firstId = this.activeByFingerprint.get(fp);
    if (firstId) {
      const inc = this.byId.get(firstId);
      if (inc && !this.isClosed(inc)) res.push(inc);
    }
    return res;
  }

  /**
   * 命中同一 GitHub Issue 的现役（open）incident —— known 判定（F-SRE-014 §3.11.4）。
   * 直接扫描 byId，避免维护独立 issue 索引带来的陈旧（markIssue 变更不必重索引开销）。
   * 数据量在单实例骨架可控；接入 RDBMS 后由 SQL 优化。
   */
  findByIssueId(issueId: number): IntakeIncident[] {
    const res: IntakeIncident[] = [];
    for (const inc of this.byId.values()) {
      if (inc.issue_id === issueId && !this.isClosed(inc)) res.push(inc);
    }
    return res;
  }

  /** 是否有同指纹的现役重复（dup 判定用） */
  hasOpenDuplicate(fp: string, excludeId?: string): boolean {
    return this.findActiveByFingerprint(fp).some((i) => i.incident_id !== excludeId);
  }

  /** 标记回执状态推进（受理→定位→修复→关单） */
  setAckStatus(id: string, next: IncidentAckStatus): boolean {
    const inc = this.byId.get(id);
    if (!inc) return false;
    inc.ack_status = next;
    if (next === 'closed' || next === 'fixed') {
      inc.status = 'resolved';
      inc.resolved_at = inc.resolved_at ?? new Date().toISOString();
      this.releaseActive(inc);
    }
    return true;
  }

  /** 关联/更新 Issue（Issue 唯一真相源链接） */
  markIssue(id: string, issueId: number): boolean {
    const inc = this.byId.get(id);
    if (!inc) return false;
    inc.issue_id = issueId;
    return true;
  }

  /** triage=dup 归并挂靠（不可变审计保留 dup 记录，不新建 active/Issue） */
  mergeIntoDuplicate(inc: IntakeIncident, base: IntakeIncident): void {
    inc.triage = 'dup';
    inc.duplicate_of_id = base.incident_id;
    this.byId.set(inc.incident_id, inc);
  }

  private releaseActive(inc: IntakeIncident): void {
    const fp = inc.dedup_fingerprint;
    if (this.activeByFingerprint.get(fp) === inc.incident_id) {
      this.activeByFingerprint.delete(fp);
    }
  }
}

/**
 * 三分类 triage（F-SRE-014 §3.11.4 / AC-014a/014b）：
 *   dup   同根因/同现象既有 incident（现役窗口内）→ 归并，不新建
 *   known 命中已在处理的 GitHub Issue 或已知根因（同 issue open 记录）
 *   new   以上皆非 → 新建 incident
 */
export function decideTriage(
  inc: IntakeIncident,
  store: IncidentStore,
): TriageDecision {
  // 1) dup
  const dups = store.findActiveByFingerprint(inc.dedup_fingerprint);
  const realDup = dups.find((d) => d.incident_id !== inc.incident_id);
  if (realDup) {
    return {
      triage: 'dup',
      duplicate_of_id: realDup.incident_id,
      known_issue_id: realDup.issue_id,
      reason: `与既有 incident ${realDup.incident_id} 同象重复（去重指纹一致/抑制窗口内）`,
    };
  }
  // 2) known：命中 open Issue 既有 incident（经 report.issue_id 提示或归一化关联）
  if (inc.issue_id != null) {
    const known = store.findByIssueId(inc.issue_id).filter(
      (i) => i.incident_id !== inc.incident_id,
    );
    if (known.length > 0) {
      const k = known[0];
      return {
        triage: 'known',
        duplicate_of_id: k.incident_id, // 并入对象（补充证据语义）
        known_issue_id: k.issue_id,
        reason: `命中处理中 Issue #${k.issue_id} 的既有 incident ${k.incident_id}`,
      };
    }
  }
  // 3) new
  return {
    triage: 'new',
    duplicate_of_id: null,
    known_issue_id: null,
    reason: '新建：无现役重复，亦无命中处理中 Issue',
  };
}
