/**
 * audit/audit-store.ts —— append-only 审计存储（F-AUDIT / DESIGN §2.1 / §3）
 *
 * 存储：嵌入式 SQLite 单文件 + WAL（选型 D，DESIGN §3）。写入路径：有界队列 → 异步批量落盘
 * （见 audit-writer.ts），主链路不被阻塞（< 100ms，NFR）。
 *
 * append-only 语义（FR-AUDIT-002 / AC-AUDIT-002）：
 *   - 对外**没有** UPDATE/DELETE 接口；仅暴露 append()（追加）与只读查询/校验。
 *   - DB 层用触发器强制拒绝改删（WORM 语义），即使误用裸 SQL 也 fail。
 *
 * 哈希链：seq 全局单调，hash = H(seq ‖ prev_hash ‖ canonical(payload))（hash-chain.ts）。
 * 落盘时在内存维护链尾 (seq, hash)，首次启动从库中回填，保证进程重启后链不断。
 *
 * 查询：who / when 范围 / action_type / result 过滤 + 分页（FR-AUDIT-003）。
 * 校验：verify() 全链重算，返回断链位置或完整（AC-AUDIT-002）。
 *
 * 进程内单例；DB 路径由构造参数给出（默认 data/audit.db，可注入 :memory: 供单测）。
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import {
  AuditEvent,
  AuditRecord,
  AuditQuery,
  AuditPaging,
  AuditVerifyResult,
} from './audit-types';
import { linkRecord, verifyChain, GENESIS_PREV_HASH } from './hash-chain';

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 500;

/** 生成 UUIDv7（时间有序，DESIGN §2.1）—— 无外部依赖，手写。 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  // 48-bit 毫秒时间戳（大端）
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  for (let i = 6; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 追加一行（落盘时链尾 (seq, hash) 已定） */
type AppendRow = AuditRecord;

export interface AuditStoreOptions {
  /** SQLite 文件路径；':memory:' 供单测。缺省 data/audit.db（相对 cwd）。 */
  dbPath?: string;
  /** 时间源（测试注入）；默认 () => new Date().toISOString() */
  clock?: () => string;
}

export class AuditStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => string;
  // 链尾缓存（避免每次 append 读库）
  private lastSeq = 0;
  private lastHash: string = GENESIS_PREV_HASH;
  private readonly insertStmt;

  constructor(opts: AuditStoreOptions = {}) {
    const dbPath = opts.dbPath ?? path.join(process.cwd(), 'data', 'audit.db');
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.clock = opts.clock ?? (() => new Date().toISOString());
    // WAL：追加语义 + 并发读友好（DESIGN §3）
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
    this.insertStmt = this.db.prepare(
      `INSERT INTO audit_log
         (id, seq, who_type, who_id, "when", action_type, target_resource, params_digest,
          why_source, incident_id, session_id, approval_id, result, reason, prev_hash, hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.loadTail();
  }

  // ----------------------------------------------------------- schema + WORM
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id              TEXT PRIMARY KEY,
        seq             INTEGER NOT NULL UNIQUE,
        who_type        TEXT NOT NULL,
        who_id          TEXT NOT NULL,
        "when"          TEXT NOT NULL,
        action_type     TEXT NOT NULL,
        target_resource TEXT NOT NULL,
        params_digest   TEXT,
        why_source      TEXT NOT NULL,
        incident_id     TEXT,
        session_id      TEXT,
        approval_id     TEXT,
        result          TEXT NOT NULL,
        reason          TEXT,
        prev_hash       TEXT NOT NULL,
        hash            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_when            ON audit_log("when");
      CREATE INDEX IF NOT EXISTS idx_audit_who_when        ON audit_log(who_id, "when");
      CREATE INDEX IF NOT EXISTS idx_audit_action_when     ON audit_log(action_type, "when");
      CREATE INDEX IF NOT EXISTS idx_audit_result          ON audit_log(result);
      CREATE INDEX IF NOT EXISTS idx_audit_incident        ON audit_log(incident_id);
      CREATE INDEX IF NOT EXISTS idx_audit_session         ON audit_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_audit_approval        ON audit_log(approval_id);

      -- WORM：DB 层强制拒绝 UPDATE/DELETE（应用层亦无接口；双保险 AC-AUDIT-002）
      CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
        BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only (UPDATE denied)'); END;
      CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
        BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only (DELETE denied)'); END;
    `);
  }

  /** 启动时回填链尾（seq/hash），保证进程重启后链连续 */
  private loadTail(): void {
    const row = this.db
      .prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')
      .get() as { seq: number; hash: string } | undefined;
    if (row) {
      this.lastSeq = Number(row.seq);
      this.lastHash = String(row.hash);
    } else {
      this.lastSeq = 0;
      this.lastHash = GENESIS_PREV_HASH;
    }
  }

  // ----------------------------------------------------------- 追加（唯一写路径）
  /**
   * 追加一条审计事件（append-only；内部补 id/seq/prev_hash/hash）。
   * @returns 落盘后的完整记录
   */
  append(ev: AuditEvent): AuditRecord {
    const id = uuidv7();
    const rec = linkRecord(ev, this.lastSeq, this.lastHash, id);
    this.insertStmt.run(
      rec.id,
      rec.seq,
      rec.who_type,
      rec.who_id,
      rec.when,
      rec.action_type,
      rec.target_resource,
      rec.params_digest,
      rec.why_source,
      rec.incident_id,
      rec.session_id,
      rec.approval_id,
      rec.result,
      rec.reason,
      rec.prev_hash,
      rec.hash,
    );
    this.lastSeq = rec.seq;
    this.lastHash = rec.hash;
    return rec;
  }

  /**
   * 批量追加（异步落盘 writer 的批量终态）。逐条链接保证顺序；单事务提交。
   */
  appendBatch(events: ReadonlyArray<AuditEvent>): AuditRecord[] {
    const out: AuditRecord[] = [];
    if (!events.length) return out;
    this.db.exec('BEGIN');
    try {
      for (const ev of events) {
        const rec = this.append(ev);
        out.push(rec);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return out;
  }

  // ----------------------------------------------------------- 查询（只读投影）
  /** 按 id 取单条 */
  getById(id: string): AuditRecord | null {
    const row = this.db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRecord(row) : null;
  }

  /** 计数（配合分页 total） */
  count(q: AuditQuery = {}): number {
    const { where, args } = buildWhere(q);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`)
      .get(...args) as { n: number };
    return Number(row.n);
  }

  /**
   * 过滤 + 分页查询（FR-AUDIT-003）。缺省按 seq 升序（= 时间序），支持时间有界高效。
   * @returns { items, page, size, total, total_pages }
   */
  query(
    q: AuditQuery = {},
    paging: AuditPaging = {},
  ): { items: AuditRecord[]; page: number; size: number; total: number; total_pages: number } {
    const page = Math.max(1, Math.floor(paging.page ?? 1));
    const size = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(paging.size ?? PAGE_SIZE_DEFAULT)));
    const { where, args } = buildWhere(q);
    const total = this.count(q);
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY seq ASC LIMIT ? OFFSET ?`)
      .all(...args, size, (page - 1) * size) as Array<Record<string, unknown>>;
    return {
      items: rows.map(toRecord),
      page,
      size,
      total,
      total_pages: Math.max(1, Math.ceil(total / size)),
    };
  }

  /** 全部记录（按 seq 升序；校验/外锚定用，谨慎用于大表） */
  all(): AuditRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_log ORDER BY seq ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(toRecord);
  }

  // ----------------------------------------------------------- 校验（AC-AUDIT-002）
  /** 全链校验：返回断链位置或完整 */
  verify(from?: string, to?: string): AuditVerifyResult {
    let sql = 'SELECT * FROM audit_log';
    const args: unknown[] = [];
    const conds: string[] = [];
    if (from) {
      conds.push('"when" >= ?');
      args.push(from);
    }
    if (to) {
      conds.push('"when" <= ?');
      args.push(to);
    }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY seq ASC';
    const records = (this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>).map(
      toRecord,
    );
    // 若取的是带时间窗的子集，首条的 prev_hash 未必是 genesis——以首条自身 prev_hash 为锚，
    // 校验其内部连续性 + 每条自洽（内容篡改仍可检出）。
    const anchor = records.length ? records[0].prev_hash : GENESIS_PREV_HASH;
    const { broken_at_seq, reason } = verifyChain(records, anchor);
    const head = records.length ? records[records.length - 1] : null;
    return {
      ok: broken_at_seq === null,
      checked: records.length,
      head_seq: head ? head.seq : null,
      head_hash: head ? head.hash : null,
      broken_at_seq: broken_at_seq ?? null,
      reason: reason ?? null,
    };
  }

  /** 链头 (seq, hash)——供外锚定（git/对象存储/Issue 评论） */
  head(): { seq: number; hash: string } {
    return { seq: this.lastSeq, hash: this.lastHash };
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

function buildWhere(q: AuditQuery): { where: string; args: unknown[] } {
  const conds: string[] = [];
  const args: unknown[] = [];
  if (q.who) {
    conds.push('(who_id = ? OR who_type = ?)');
    args.push(q.who, q.who);
  }
  if (q.from) {
    conds.push('"when" >= ?');
    args.push(q.from);
  }
  if (q.to) {
    conds.push('"when" <= ?');
    args.push(q.to);
  }
  if (q.action_type) {
    conds.push('action_type = ?');
    args.push(q.action_type);
  }
  if (q.result) {
    conds.push('result = ?');
    args.push(q.result);
  }
  if (q.incident_id) {
    conds.push('incident_id = ?');
    args.push(q.incident_id);
  }
  if (q.session_id) {
    conds.push('session_id = ?');
    args.push(q.session_id);
  }
  if (q.approval_id) {
    conds.push('approval_id = ?');
    args.push(q.approval_id);
  }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', args };
}

function toRecord(row: Record<string, unknown>): AuditRecord {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    who_type: row.who_type as AuditRecord['who_type'],
    who_id: String(row.who_id),
    when: String(row.when),
    action_type: String(row.action_type),
    target_resource: String(row.target_resource),
    params_digest: row.params_digest == null ? null : String(row.params_digest),
    why_source: String(row.why_source),
    incident_id: row.incident_id == null ? null : String(row.incident_id),
    session_id: row.session_id == null ? null : String(row.session_id),
    approval_id: row.approval_id == null ? null : String(row.approval_id),
    result: row.result as AuditRecord['result'],
    reason: row.reason == null ? null : String(row.reason),
    prev_hash: String(row.prev_hash),
    hash: String(row.hash),
  };
}
