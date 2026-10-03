/**
 * chat/chat-store.ts —— F-CHAT 存储（会话 + 消息 + 令牌吊销/刷新表）
 *
 * 存储：嵌入式 SQLite 单文件 + WAL（选型 D，与 audit/approval 同构）。
 *   - chat_session：会话投影（state/last_active_at/idle_expire_at 可 UPDATE，跟随生命周期）。
 *   - chat_message：**不可变**事件流（append-only；DB 触发器拒改删）——追溯（FR-CHAT-006）。
 *   - revoked_token：jti 吊销表（append-only；登出即作废 access token，FR-CHAT-003）。
 *   - refresh_token：刷新令牌摘要表（one-time-use 轮换；重放即失效）。
 *
 * 进程内单例；dbPath 可注入（默认 data/chat.db，':memory:' 供单测）。
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { ChatSession, ChatMessage, ChatRole, SessionState } from './chat-types';

export interface ChatStoreOptions {
  /** SQLite 文件路径；':memory:' 供单测。缺省 data/chat.db（相对 cwd）。 */
  dbPath?: string;
}

export class ChatStore {
  private readonly db: DatabaseSync;

  constructor(opts: ChatStoreOptions = {}) {
    const dbPath = opts.dbPath ?? path.join(process.cwd(), 'data', 'chat.db');
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_session (
        session_id        TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL,
        roles             TEXT NOT NULL,          -- JSON array
        issuer            TEXT,
        sub               TEXT,
        created_at        TEXT NOT NULL,
        last_active_at    TEXT NOT NULL,
        idle_expire_at    TEXT NOT NULL,
        state             TEXT NOT NULL,          -- active/expired/revoked
        client_fingerprint TEXT NOT NULL,
        csrf_token        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_session_user  ON chat_session(user_id);
      CREATE INDEX IF NOT EXISTS idx_chat_session_state ON chat_session(state);

      -- 消息：不可变（append-only）
      CREATE TABLE IF NOT EXISTS chat_message (
        msg_id          TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL,
        role            TEXT NOT NULL,
        content_digest  TEXT NOT NULL,
        injected_flag   INTEGER NOT NULL DEFAULT 0,
        triggered_action TEXT,
        approval_id     TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_msg_session ON chat_message(session_id, created_at);

      -- jti 吊销表（append-only）
      CREATE TABLE IF NOT EXISTS revoked_token (
        jti         TEXT PRIMARY KEY,
        session_id  TEXT,
        revoked_at  TEXT NOT NULL,
        reason      TEXT
      );

      -- refresh 令牌摘要（one-time-use 轮换）
      CREATE TABLE IF NOT EXISTS refresh_token (
        token_digest TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        issued_at    TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        used_at      TEXT,                        -- 非空=已使用（重放即失效）
        revoked      INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_session ON refresh_token(session_id);

      -- 不可变：消息拒绝改删（双保险，FR-CHAT-006 追溯不可篡改）
      CREATE TRIGGER IF NOT EXISTS trg_chat_msg_no_update
        BEFORE UPDATE ON chat_message
        BEGIN SELECT RAISE(ABORT, 'chat_message is append-only (UPDATE denied)'); END;
      CREATE TRIGGER IF NOT EXISTS trg_chat_msg_no_delete
        BEFORE DELETE ON chat_message
        BEGIN SELECT RAISE(ABORT, 'chat_message is append-only (DELETE denied)'); END;
    `);
  }

  // ----------------------------------------------------------- 会话

  insertSession(s: ChatSession): void {
    this.db
      .prepare(
        `INSERT INTO chat_session
           (session_id, user_id, roles, issuer, sub, created_at, last_active_at, idle_expire_at,
            state, client_fingerprint, csrf_token)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.session_id,
        s.user_id,
        JSON.stringify(s.roles),
        s.issuer,
        s.sub,
        s.created_at,
        s.last_active_at,
        s.idle_expire_at,
        s.state,
        s.client_fingerprint,
        s.csrf_token,
      );
  }

  getSession(session_id: string): ChatSession | null {
    const row = this.db.prepare('SELECT * FROM chat_session WHERE session_id = ?').get(session_id) as
      | Record<string, unknown>
      | undefined;
    return row ? toSession(row) : null;
  }

  /** 更新会话活跃度（滑动空闲窗口）。 */
  touchSession(session_id: string, last_active_at: string, idle_expire_at: string): void {
    this.db
      .prepare('UPDATE chat_session SET last_active_at = ?, idle_expire_at = ? WHERE session_id = ?')
      .run(last_active_at, idle_expire_at, session_id);
  }

  /** 变更会话状态（active/expired/revoked）。 */
  setState(session_id: string, state: SessionState): void {
    this.db.prepare('UPDATE chat_session SET state = ? WHERE session_id = ?').run(state, session_id);
  }

  /** 扫描已过期但状态仍 active 的会话 → expired（空闲超时，FR-CHAT-003）。 */
  expireIdle(now: string): ChatSession[] {
    const rows = this.db
      .prepare("SELECT * FROM chat_session WHERE state = 'active' AND idle_expire_at <= ?")
      .all(now) as Array<Record<string, unknown>>;
    const out = rows.map(toSession);
    for (const s of out) this.setState(s.session_id, 'expired');
    return out;
  }

  // ----------------------------------------------------------- 消息（append-only）

  appendMessage(m: ChatMessage): void {
    this.db
      .prepare(
        `INSERT INTO chat_message
           (msg_id, session_id, role, content_digest, injected_flag, triggered_action, approval_id, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        m.msg_id,
        m.session_id,
        m.role,
        m.content_digest,
        m.injected_flag ? 1 : 0,
        m.triggered_action,
        m.approval_id,
        m.created_at,
      );
  }

  listMessages(session_id: string): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_message WHERE session_id = ? ORDER BY created_at ASC, msg_id ASC')
      .all(session_id) as Array<Record<string, unknown>>;
    return rows.map(toMessage);
  }

  // ----------------------------------------------------------- 令牌吊销

  revokeToken(jti: string, session_id: string | null, revoked_at: string, reason: string | null): void {
    this.db
      .prepare('INSERT OR REPLACE INTO revoked_token (jti, session_id, revoked_at, reason) VALUES (?,?,?,?)')
      .run(jti, session_id, revoked_at, reason);
  }

  isRevoked(jti: string): boolean {
    const row = this.db.prepare('SELECT 1 AS x FROM revoked_token WHERE jti = ?').get(jti);
    return !!row;
  }

  revokedJtiSet(): Set<string> {
    const rows = this.db.prepare('SELECT jti FROM revoked_token').all() as Array<{ jti: string }>;
    return new Set(rows.map((r) => String(r.jti)));
  }

  // ----------------------------------------------------------- refresh 轮换

  insertRefresh(token_digest: string, session_id: string, user_id: string, issued_at: string, expires_at: string): void {
    this.db
      .prepare(
        `INSERT INTO refresh_token (token_digest, session_id, user_id, issued_at, expires_at, used_at, revoked)
         VALUES (?,?,?,?,?,NULL,0)`,
      )
      .run(token_digest, session_id, user_id, issued_at, expires_at);
  }

  getRefresh(token_digest: string):
    | { session_id: string; user_id: string; issued_at: string; expires_at: string; used_at: string | null; revoked: number }
    | null {
    const row = this.db.prepare('SELECT * FROM refresh_token WHERE token_digest = ?').get(token_digest) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      session_id: String(row.session_id),
      user_id: String(row.user_id),
      issued_at: String(row.issued_at),
      expires_at: String(row.expires_at),
      used_at: row.used_at == null ? null : String(row.used_at),
      revoked: Number(row.revoked),
    };
  }

  /** 标记 refresh 已使用（one-time-use；重放触发失效）。 */
  markRefreshUsed(token_digest: string, used_at: string): void {
    this.db.prepare('UPDATE refresh_token SET used_at = ? WHERE token_digest = ?').run(used_at, token_digest);
  }

  revokeRefreshBySession(session_id: string): void {
    this.db.prepare('UPDATE refresh_token SET revoked = 1 WHERE session_id = ?').run(session_id);
  }

  /** 吊销某会话的全部未使用 refresh 摘要（重放检测：同一 session 全链路失效）。 */
  markRefreshReuse(token_digest: string, at: string): void {
    const r = this.getRefresh(token_digest);
    if (!r) return;
    this.db.prepare('UPDATE refresh_token SET used_at = ? WHERE token_digest = ?').run(at, token_digest);
    this.revokeRefreshBySession(r.session_id);
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

function toSession(row: Record<string, unknown>): ChatSession {
  return {
    session_id: String(row.session_id),
    user_id: String(row.user_id),
    roles: JSON.parse(String(row.roles)) as ChatRole[],
    issuer: row.issuer == null ? null : String(row.issuer),
    sub: row.sub == null ? null : String(row.sub),
    created_at: String(row.created_at),
    last_active_at: String(row.last_active_at),
    idle_expire_at: String(row.idle_expire_at),
    state: String(row.state) as SessionState,
    client_fingerprint: String(row.client_fingerprint),
    csrf_token: String(row.csrf_token),
  };
}

function toMessage(row: Record<string, unknown>): ChatMessage {
  return {
    msg_id: String(row.msg_id),
    session_id: String(row.session_id),
    role: String(row.role) as ChatMessage['role'],
    content_digest: String(row.content_digest),
    injected_flag: Number(row.injected_flag) === 1,
    triggered_action: row.triggered_action == null ? null : String(row.triggered_action),
    approval_id: row.approval_id == null ? null : String(row.approval_id),
    created_at: String(row.created_at),
  };
}
