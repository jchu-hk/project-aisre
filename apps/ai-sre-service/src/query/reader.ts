/**
 * query/reader.ts —— incident 一致性读路径（§12.2）
 *
 * 从进程内参照存储（IncidentStore + LifecycleLedger）构造 §12.2 一致的
 * 列表/详情/下钻；过滤白名单、游标分页、per-system ACL、PII 投影。
 *
 * 状态权威：lifecycle 以 LifecycleLedger 为准（显式驱动）；对仍未建档的 legacy incident
 * （如检测源/存量、或尚未经 driver 建档的行）reader 用 forwardSeedProjection 作投影当前态
 * 但**不在读路径产生写副作用**（读不改写，防把「查询」误当推进）。
 *
 * AC-016b：筛选无匹配→ 200 空数组（不报错）；跨 per-system 越权→ 如同不存在（403 语义由 HTTP 层）。
 */

import { IncidentStore } from '../incidents/incident-store';
import { IntakeIncident } from '../incidents/incident.types';
import { LifecycleLedger } from '../lifecycle/ledger';
import { forwardSeedProjection } from '../lifecycle/project';
import {
  IncidentListRow,
  IncidentDetail,
  IncidentListResponse,
  IncidentListQuery,
  CursorPaging,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
} from './types';

export interface ReaderOpts {
  /** 授权可读 system_id 白名单；省略=不限（上游注入所辖集）；空数组=no access(fail-closed) */
  aclSystems?: ReadonlyArray<string>;
  /** GitHub issue base URL（含仓库路径不含 /issues）；缺省→不产出 issue_url(回 issue_id) */
  issueBaseUrl?: string | null;
}

interface IndexRow {
  inc: IntakeIncident;
  lifecycle: string;
  lifecycleUpdated: string; // effective 'updated' (timeline last or incident time)
}

export function listIncidents(
  store: IncidentStore,
  ledger: LifecycleLedger,
  q: IncidentListQuery,
  paging: CursorPaging & { sort?: string },
  opts: ReaderOpts,
): IncidentListResponse {
  const acl = opts.aclSystems;
  if (acl && acl.length === 0) {
    return { items: [], next_cursor: null, count: 0 }; // fail-closed: 无授权系统 → 空
  }
  const { limit, sortWanted } = normalizePaging(paging);
  const itemsRaw = index(store, ledger, opts.issueBaseUrl ?? null);

  const matched = itemsRaw
    .filter((r) => {
      if (acl && !acl.includes(r.inc.system_id)) return false;
      return filter(q)(r.inc, r.lifecycle);
    })
    .sort((a, b) => compare(a, b, sortWanted));

  // 游标定位
  const fromIndex = applyCursorOffset(matched, paging.cursor);
  const pageRows = matched.slice(fromIndex, fromIndex + limit);
  const items: IncidentListRow[] = pageRows.map((r) => toListRow(r, opts.issueBaseUrl ?? null));
  const last = pageRows[pageRows.length - 1];
  const next_cursor =
    fromIndex + pageRows.length < matched.length && last
      ? encodeKeyset(sortWanted, rowTime(last, sortWanted), last.inc.incident_id)
      : null;
  return { items, next_cursor, count: matched.length };
}

export function getIncidentDetail(
  store: IncidentStore,
  ledger: LifecycleLedger,
  id: string,
  scope: 'full' | 'trace' | 'audit',
  opts: ReaderOpts,
): IncidentDetail | null {
  const inc = store.getById(id);
  if (!inc) return null;
  if (opts.aclSystems && !opts.aclSystems.includes(inc.system_id)) return null; // 越权读=不可见
  const logged = ledger.current(id);
  const timeline = ledger.timeline(id);
  const curLifecycle = logged ?? forwardSeedProjection(inc);
  const updatedAt = timeline.length
    ? timeline[timeline.length - 1].occurred_at
    : new Date(inc.received_at || inc.detected_at || Date.now()).toISOString();
  const reopenReason =
    timeline.length ? timeline[timeline.length - 1].reopen_reason ?? null : null;

  const detail: IncidentDetail = {
    id: inc.incident_id,
    system_id: inc.system_id,
    source: inc.source,
    anomaly_type: inc.anomaly_type ?? null,
    severity: inc.severity,
    reported_severity: inc.reported_severity ?? null,
    status: inc.status,
    lifecycle: curLifecycle,
    lifecycle_reopen_reason: reopenReason,
    affected_component: inc.affected_component ?? null,
    triage: inc.triage ?? null,
    duplicate_of_id: inc.duplicate_of_id ?? null,
    issue_id: inc.issue_id ?? null,
    issue_url: computeIssueUrl(inc.issue_id ?? null, opts.issueBaseUrl ?? null),
    ack_status: inc.ack_status ?? null,
    reporter_contact: inc.reporter_contact_ref ?? null, // 掩码已脱敏入库；原文不回
    symptom_desc: inc.symptom_desc ?? null,
    received_at: inc.received_at ?? null,
    detected_at: inc.detected_at ?? null,
    resolved_at: inc.resolved_at && inc.resolved_at !== '' ? inc.resolved_at : null,
    created_at: new Date(inc.received_at || inc.detected_at || Date.now()).toISOString(),
    updated_at: updatedAt,
  };

  if (scope === 'trace' || scope === 'audit') {
    detail.timeline = timeline.map((t) => ({
      prev_state: t.prev_state,
      new_state: t.new_state,
      trigger: t.trigger,
      actor_id: t.actor_id,
      reason: t.reason,
      occurred_at: t.occurred_at,
    }));
  }
  if (scope === 'audit') {
    // audit 视角：除 timeline 外附该 incident 最近被谁查过（query audit，最小投影）
    const touched = ledger.queryAuditForIncident(id).map((r) => ({
      kind: 'query' as const,
      actor_id: r.actor_id,
      endpoint: r.endpoint,
      requested_at: r.requested_at,
    }));
    detail.audit = touched as unknown as ReadonlyArray<Record<string, unknown>>;
  }
  return detail;
}

// --------------------------------------------------------------------- helpers

type SortKey = { field: 'created_at' | 'severity' | 'lifecycle_updated_at'; order: 'asc' | 'desc' };

function normalizePaging(p: CursorPaging & { sort?: string }): { limit: number; sortWanted: SortKey } {
  let limit = LIST_LIMIT_DEFAULT;
  if (typeof p.limit === 'number' && Number.isFinite(p.limit)) {
    limit = Math.min(Math.max(1, Math.floor(p.limit)), LIST_LIMIT_MAX);
  }
  const sort = (p.sort ?? 'created_at').toLowerCase();
  const descending = sort.startsWith('-');
  const body = sort.replace(/^-/, '');
  let field: SortKey['field'] = 'created_at';
  if (body === 'severity') field = 'severity';
  if (body === 'lifecycle_updated_at') field = 'lifecycle_updated_at';
  return { limit, sortWanted: { field, order: descending ? 'desc' : 'asc' } };
}

function rowTime(r: IndexRow, k: SortKey): string {
  if (k.field === 'severity') return r.inc.severity || '';
  return k.field === 'lifecycle_updated_at' ? r.lifecycleUpdated : (r.inc.received_at || r.inc.detected_at || '');
}

function compare(a: IndexRow, b: IndexRow, k: SortKey): number {
  if (k.field === 'severity') {
    const r = sevRank(a.inc.severity) - sevRank(b.inc.severity);
    return k.order === 'asc' ? r : -r;
  }
  const at = new Date(rowTime(a, k)).getTime() || 0;
  const bt = new Date(rowTime(b, k)).getTime() || 0;
  const r = at - bt;
  if (r !== 0) return k.order === 'asc' ? r : -r;
  return a.inc.incident_id < b.inc.incident_id ? -1 : 1; // tie-break stable
}

function sevRank(s: string): number {
  const m = /^P([0-3])$/.exec(s || '');
  return m ? Number(m[1]) : 9;
}

function applyCursorOffset(sortedRows: IndexRow[], cursor?: string): number {
  if (!cursor) return 0;
  const c = decodeCursor(cursor);
  if (!c || !c.lastId) return 0;
  // 游标末端 lastId 已按排序/次序在当前 resultset 中出现——续页即从它后面一页继续，
  // 不重不漏（compare 已以 incident_id 做稳定 tie-break，lastId 唯一）。
  const idx = sortedRows.findIndex((r) => r.inc.incident_id === c.lastId);
  return idx < 0 ? 0 : idx + 1;
}

function decodeCursor(_cursor: string): { field: string; order: string; timeMs: number; lastId: string } | null {
  // 已由 encodeKeyset 编码 {time}:{lastId}；此函数主要为定位 lastId 供稳定续页。
  try {
    const raw = Buffer.from(_cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf(':');
    if (sep < 0) return null;
    const timeMs = Number(raw.slice(0, sep));
    const lastId = raw.slice(sep + 1);
    if (!Number.isFinite(timeMs) || !lastId) return null;
    return { field: '', order: '', timeMs, lastId };
  } catch {
    return null;
  }
}

function computeIssueUrl(id: number | null, base: string | null): string | null {
  if (id == null) return null;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/issues/${id}`;
}

function index(store: IncidentStore, ledger: LifecycleLedger, _issueBase: string | null): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const inc of store.all()) {
    const logged = ledger.current(inc.incident_id);
    const tl = ledger.timeline(inc.incident_id);
    const lifecycle = logged ?? forwardSeedProjection(inc);
    const lifecycleUpdated = tl.length
      ? tl[tl.length - 1].occurred_at
      : new Date(inc.received_at || inc.detected_at || Date.now()).toISOString();
    rows.push({ inc, lifecycle, lifecycleUpdated });
  }
  return rows;
}

function filter(q: IncidentListQuery): (inc: IntakeIncident, lifecycle: string) => boolean {
  const lifecycles = asSet(q.lifecycle);
  const statuses = asSet(q.status);
  const sevSet = q.severity ? new Set(q.severity) : null;
  const fromMs = q.created_from ? new Date(q.created_from).getTime() : null;
  const toMs = q.created_to ? new Date(q.created_to).getTime() : null;
  const qs = q.q ? q.q.trim().toLowerCase() : null;

  return (inc, lifecycle) => {
    if (q.system_id && inc.system_id !== q.system_id) return false;
    if (q.source && inc.source !== q.source) return false;
    if (lifecycles && !lifecycles.has(lifecycle)) return false;
    if (statuses && !statuses.has(inc.status)) return false;
    if (sevSet && !sevSet.has(inc.severity)) return false;
    if (q.issue_id != null && inc.issue_id !== q.issue_id) return false;
    if (qs) {
      const hay = [inc.symptom_desc, inc.affected_component, inc.anomaly_type, inc.system_id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(qs)) return false;
    }
    const baseTime = new Date(inc.received_at || inc.detected_at || 0).getTime();
    if (Number.isFinite(baseTime)) {
      if (fromMs != null && baseTime < fromMs) return false;
      if (toMs != null && baseTime > toMs) return false;
    }
    return true;
  };
}

function asSet(v?: string | string[]): Set<string> | null {
  if (!v) return null;
  return new Set(Array.isArray(v) ? v : [v]);
}

function toListRow(r: IndexRow, issueBase: string | null): IncidentListRow {
  return {
    id: r.inc.incident_id,
    system_name: r.inc.system_id, // §7.2 sre_systems.name 可后续 join；现在以 system_id 展示
    lifecycle: r.lifecycle,
    severity: r.inc.severity,
    triage: r.inc.triage ?? null,
    source: r.inc.source,
    affected_component: r.inc.affected_component ?? null,
    ack_status: r.inc.ack_status ?? null,
    issue_id: r.inc.issue_id ?? null,
    issue_url: computeIssueUrl(r.inc.issue_id ?? null, issueBase),
    created_at: new Date(r.inc.received_at || r.inc.detected_at || Date.now()).toISOString(),
    updated_at: r.lifecycleUpdated,
  };
}

/** opaque keyset cursor：{timeMs}:{incident_id} */
function encodeKeyset(k: SortKey, keyTime: string, lastId: string): string {
  const ms = k.field === 'severity' ? 0 : new Date(keyTime).getTime() || 0;
  return Buffer.from(`${ms}:${lastId}`, 'utf8').toString('base64url');
}
