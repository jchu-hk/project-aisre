/**
 * approval/approval-store.ts —— F-APPROVE 存储（白名单版本 + 审批单 + 事件流）
 *
 * 存储：嵌入式 SQLite 单文件 + WAL（选型 D）。与 audit-store 同构：
 *   - whitelist_version：**不可变快照**（append-only；版本自增，运行时只读当前生效版本）。
 *   - approval_request：单据投影（state 为最新状态；载荷冻结）。
 *   - approval_event：**不可变事件流**（append-only；状态变更追加记录，DESIGN §2.3）。
 *
 * 约束：
 *   - 白名单无 UPDATE/DELETE 接口；版本一旦落库不可改（AC-APPROVE-005「悄悄放权」不可行）。
 *   - approval_event 无 UPDATE/DELETE；DB 层触发器拒绝改删（双保险）。
 *   - approval_request 仅为投影，允许 UPDATE（跟随事件流更新最新 state/updated_at）。
 *
 * 进程内单例；dbPath 可注入（默认 data/approval.db，':memory:' 供单测）。
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import {
  ApprovalRequest,
  ApprovalEvent,
  ApprovalState,
  ApprovalType,
  ApprovalRole,
  ApprovalQuery,
  ApprovalPaging,
  ApprovalDetail,
  WhitelistVersion,
  WhitelistEntry,
  WhitelistEntryDiff,
  ApprovalPayload,
  WhitelistChangeRequest,
} from './approval-types';
import type { WhitelistStore } from './whitelist-store';

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 500;

export interface ApprovalStoreOptions {
  /** SQLite 文件路径；':memory:' 供单测。缺省 data/approval.db（相对 cwd）。 */
  dbPath?: string;
}

export class ApprovalStore implements WhitelistStore {
  private readonly db: DatabaseSync;

  constructor(opts: ApprovalStoreOptions = {}) {
    const dbPath = opts.dbPath ?? path.join(process.cwd(), 'data', 'approval.db');
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      -- 白名单版本（不可变快照，DESIGN §2.2）
      CREATE TABLE IF NOT EXISTS whitelist_version (
        version        INTEGER PRIMARY KEY,       -- 自增版本号
        entries_json   TEXT NOT NULL,              -- 该版本完整条目集（JSON 快照）
        created_by     TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        approval_id    TEXT,                        -- 使其生效的审批单
        diff_from_prev TEXT                         -- 相对前一版本 diff（JSON）
      );

      -- 审批单投影（DESIGN §2.3）
      CREATE TABLE IF NOT EXISTS approval_request (
        approval_id      TEXT PRIMARY KEY,
        type             TEXT NOT NULL,            -- operation / whitelist_change
        summary          TEXT NOT NULL,
        target_resource  TEXT NOT NULL,
        risk_note        TEXT NOT NULL,
        initiator_agent  TEXT NOT NULL,
        incident_id      TEXT,
        session_id       TEXT,
        required_roles   TEXT NOT NULL,            -- JSON array
        state            TEXT NOT NULL,
        ttl_expire_at    TEXT NOT NULL,
        payload_ref      TEXT,                      -- JSON
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approval_state    ON approval_request(state);
      CREATE INDEX IF NOT EXISTS idx_approval_type     ON approval_request(type);
      CREATE INDEX IF NOT EXISTS idx_approval_created  ON approval_request(created_at);
      CREATE INDEX IF NOT EXISTS idx_approval_ttl      ON approval_request(ttl_expire_at);
      CREATE INDEX IF NOT EXISTS idx_approval_incident ON approval_request(incident_id);
      CREATE INDEX IF NOT EXISTS idx_approval_session  ON approval_request(session_id);

      -- 审批事件流（不可变，DESIGN §2.3）
      CREATE TABLE IF NOT EXISTS approval_event (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        approval_id TEXT NOT NULL,
        from_state  TEXT,
        to_state    TEXT NOT NULL,
        actor       TEXT NOT NULL,
        actor_role  TEXT,
        reason      TEXT,
        at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approval_event_id ON approval_event(approval_id, seq);

      -- 不可变：事件流拒绝改删（双保险）
      CREATE TRIGGER IF NOT EXISTS trg_approval_event_no_update
        BEFORE UPDATE ON approval_event
        BEGIN SELECT RAISE(ABORT, 'approval_event is append-only (UPDATE denied)'); END;
      CREATE TRIGGER IF NOT EXISTS trg_approval_event_no_delete
        BEFORE DELETE ON approval_event
        BEGIN SELECT RAISE(ABORT, 'approval_event is append-only (DELETE denied)'); END;
      -- 不可变：白名单版本拒绝改删（AC-APPROVE-005）
      CREATE TRIGGER IF NOT EXISTS trg_whitelist_version_no_update
        BEFORE UPDATE ON whitelist_version
        BEGIN SELECT RAISE(ABORT, 'whitelist_version is immutable (UPDATE denied)'); END;
      CREATE TRIGGER IF NOT EXISTS trg_whitelist_version_no_delete
        BEFORE DELETE ON whitelist_version
        BEGIN SELECT RAISE(ABORT, 'whitelist_version is immutable (DELETE denied)'); END;
    `);
  }

  // ----------------------------------------------------------- 白名单（append-only）

  /** 追加一个新版本快照，返回落库后的版本记录。 */
  appendWhitelistVersion(v: {
    entries: WhitelistEntry[];
    created_by: string;
    created_at: string;
    approval_id: string | null;
    diff_from_prev: WhitelistEntryDiff[] | null;
  }): WhitelistVersion {
    const row = this.db.prepare('SELECT MAX(version) AS v FROM whitelist_version').get() as {
      v: number | null;
    };
    const version = Number(row?.v ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO whitelist_version (version, entries_json, created_by, created_at, approval_id, diff_from_prev)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        version,
        JSON.stringify(v.entries),
        v.created_by,
        v.created_at,
        v.approval_id,
        v.diff_from_prev ? JSON.stringify(v.diff_from_prev) : null,
      );
    return {
      version,
      entries: v.entries,
      created_by: v.created_by,
      created_at: v.created_at,
      approval_id: v.approval_id,
      diff_from_prev: v.diff_from_prev,
    };
  }

  /** 当前生效版本（最新）；无任何版本时 null。 */
  currentVersion(): WhitelistVersion | null {
    const row = this.db
      .prepare('SELECT * FROM whitelist_version ORDER BY version DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    return row ? toWhitelistVersion(row) : null;
  }

  /** 按版本号取（AC-APPROVE-001）。 */
  getVersion(version: number): WhitelistVersion | null {
    const row = this.db
      .prepare('SELECT * FROM whitelist_version WHERE version = ?')
      .get(version) as Record<string, unknown> | undefined;
    return row ? toWhitelistVersion(row) : null;
  }

  /** 版本列表（新→旧）。 */
  listVersions(): WhitelistVersion[] {
    const rows = this.db
      .prepare('SELECT * FROM whitelist_version ORDER BY version DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(toWhitelistVersion);
  }

  // ----------------------------------------------------------- 审批单

  insertRequest(r: ApprovalRequest): void {
    this.db
      .prepare(
        `INSERT INTO approval_request
           (approval_id, type, summary, target_resource, risk_note, initiator_agent,
            incident_id, session_id, required_roles, state, ttl_expire_at, payload_ref,
            created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.approval_id,
        r.type,
        r.summary,
        r.target_resource,
        r.risk_note,
        r.initiator_agent,
        r.incident_id,
        r.session_id,
        JSON.stringify(r.required_roles),
        r.state,
        r.ttl_expire_at,
        r.payload_ref ? JSON.stringify(r.payload_ref) : null,
        r.created_at,
        r.updated_at,
      );
  }

  /** 更新单据投影（state/updated_at）；由事件流驱动。 */
  updateState(approval_id: string, state: ApprovalState, updated_at: string): void {
    this.db
      .prepare('UPDATE approval_request SET state = ?, updated_at = ? WHERE approval_id = ?')
      .run(state, updated_at, approval_id);
  }

  getRequest(approval_id: string): ApprovalRequest | null {
    const row = this.db
      .prepare('SELECT * FROM approval_request WHERE approval_id = ?')
      .get(approval_id) as Record<string, unknown> | undefined;
    return row ? toRequest(row) : null;
  }

  getDetail(approval_id: string): ApprovalDetail | null {
    const req = this.getRequest(approval_id);
    if (!req) return null;
    return { ...req, events: this.listEvents(approval_id) };
  }

  listRequests(
    q: ApprovalQuery = {},
    paging: ApprovalPaging = {},
  ): { items: ApprovalRequest[]; page: number; size: number; total: number; total_pages: number } {
    const page = Math.max(1, Math.floor(paging.page ?? 1));
    const size = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(paging.size ?? PAGE_SIZE_DEFAULT)));
    const conds: string[] = [];
    const args: unknown[] = [];
    if (q.state) {
      conds.push('state = ?');
      args.push(q.state);
    }
    if (q.type) {
      conds.push('type = ?');
      args.push(q.type);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM approval_request ${where}`).get(...args) as {
        n: number;
      }).n,
    );
    const rows = this.db
      .prepare(`SELECT * FROM approval_request ${where} ORDER BY created_at DESC, approval_id DESC LIMIT ? OFFSET ?`)
      .all(...args, size, (page - 1) * size) as Array<Record<string, unknown>>;
    return {
      items: rows.map(toRequest),
      page,
      size,
      total,
      total_pages: Math.max(1, Math.ceil(total / size)),
    };
  }

  /** 扫描到期活动单据（TTL → EXPIRED，FR-APPROVE-004.5）。 */
  listExpired(now: string): ApprovalRequest[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM approval_request
          WHERE ttl_expire_at <= ? AND state IN ('DRAFT','SUBMITTED','PENDING_2ND','APPROVED','EXECUTE')
          ORDER BY ttl_expire_at ASC`,
      )
      .all(now) as Array<Record<string, unknown>>;
    return rows.map(toRequest);
  }

  // ----------------------------------------------------------- 事件流（append-only）

  appendEvent(e: ApprovalEvent): void {
    this.db
      .prepare(
        `INSERT INTO approval_event (approval_id, from_state, to_state, actor, actor_role, reason, at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(e.approval_id, e.from_state, e.to_state, e.actor, e.actor_role, e.reason, e.at);
  }

  listEvents(approval_id: string): ApprovalEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM approval_event WHERE approval_id = ? ORDER BY seq ASC')
      .all(approval_id) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      approval_id: String(row.approval_id),
      from_state: row.from_state == null ? null : (String(row.from_state) as ApprovalState),
      to_state: String(row.to_state) as ApprovalState,
      actor: String(row.actor),
      actor_role: row.actor_role == null ? null : (String(row.actor_role) as ApprovalRole),
      reason: row.reason == null ? null : String(row.reason),
      at: String(row.at),
    }));
  }

  /** 最近一次进入某状态的事件（二次复核「同一审批人」判定用）。 */
  lastEventIntoState(approval_id: string, state: ApprovalState): ApprovalEvent | null {
    const row = this.db
      .prepare(
        'SELECT * FROM approval_event WHERE approval_id = ? AND to_state = ? ORDER BY seq DESC LIMIT 1',
      )
      .get(approval_id, state) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      approval_id: String(row.approval_id),
      from_state: row.from_state == null ? null : (String(row.from_state) as ApprovalState),
      to_state: String(row.to_state) as ApprovalState,
      actor: String(row.actor),
      actor_role: row.actor_role == null ? null : (String(row.actor_role) as ApprovalRole),
      reason: row.reason == null ? null : String(row.reason),
      at: String(row.at),
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

// ------------------------------------------------------------------ helpers

function toWhitelistVersion(row: Record<string, unknown>): WhitelistVersion {
  return {
    version: Number(row.version),
    entries: JSON.parse(String(row.entries_json)) as WhitelistEntry[],
    created_by: String(row.created_by),
    created_at: String(row.created_at),
    approval_id: row.approval_id == null ? null : String(row.approval_id),
    diff_from_prev:
      row.diff_from_prev == null
        ? null
        : (JSON.parse(String(row.diff_from_prev)) as WhitelistEntryDiff[]),
  };
}

function toRequest(row: Record<string, unknown>): ApprovalRequest {
  return {
    approval_id: String(row.approval_id),
    type: String(row.type) as ApprovalType,
    summary: String(row.summary),
    target_resource: String(row.target_resource),
    risk_note: String(row.risk_note),
    initiator_agent: String(row.initiator_agent),
    incident_id: row.incident_id == null ? null : String(row.incident_id),
    session_id: row.session_id == null ? null : String(row.session_id),
    required_roles: JSON.parse(String(row.required_roles)) as ApprovalRole[],
    state: String(row.state) as ApprovalState,
    ttl_expire_at: String(row.ttl_expire_at),
    payload_ref:
      row.payload_ref == null
        ? null
        : (JSON.parse(String(row.payload_ref)) as ApprovalPayload | WhitelistChangeRequest),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
