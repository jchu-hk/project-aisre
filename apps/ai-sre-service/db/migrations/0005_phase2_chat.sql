-- ============================================================
-- AI SRE — db migration 0005 : Phase 2 F-CHAT 鉴权对话（会话 + 消息 + 令牌）
--
-- 对应 SPEC-PHASE2 §4（FR-CHAT-001~006 / AC-CHAT-001~006）与
-- DESIGN-PHASE2-AUDIT-APPROVE-CHAT.md §2.4 / §5 / §6。
--
-- 在已 apply 的 0001/0002/0003/0004 之上「新增不覆盖」：
--   1. chat_session：服务端权威会话（投影；state/last_active_at 可 UPDATE，跟随生命周期）。
--   2. chat_message：消息事件流（**append-only**；追溯 FR-CHAT-006，内容仅存摘要、禁全量明文）。
--   3. revoked_token：access token jti 吊销表（**append-only**；登出即作废，FR-CHAT-003）。
--   4. refresh_token：刷新令牌摘要（one-time-use 轮换；重放即整链路失效，FR-CHAT-001）。
--   5. 不可变语义：触发器强制拒绝 chat_message 的 UPDATE/DELETE。
--
-- ⚠️ 本迁移为 schema 契约（供 DEVOPS 依目标 RDBMS/权限环境适配执行，符合「系统无关」）。
--    进程内参照实现见 apps/ai-sre-service/src/chat/chat-store.ts（SQLite 单文件 + WAL）。
--    审计落账复用 0003 的 audit_log（action_type=chat.*，why_source=chat，绑定 session_id+user）。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) chat_session（服务端权威会话 / DESIGN §2.4）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_session (
    session_id         TEXT         PRIMARY KEY,       -- 会话 ID（uuidv7）
    user_id            TEXT         NOT NULL,           -- 企业身份主体（sub）
    roles              TEXT         NOT NULL,           -- 角色集（JSON array；RBAC 依据）
    issuer             TEXT,                            -- OIDC issuer
    sub                TEXT,                            -- OIDC subject
    created_at         TIMESTAMPTZ  NOT NULL,           -- 建立时间（UTC）
    last_active_at     TEXT         NOT NULL,           -- 最近活跃（滑动空闲窗口）
    idle_expire_at     TEXT         NOT NULL,           -- 空闲到期时刻（默认 +30min）
    state              TEXT         NOT NULL,           -- active/expired/revoked
    client_fingerprint TEXT         NOT NULL,           -- IP/UA 摘要（限流与异常检测）
    csrf_token         TEXT         NOT NULL            -- CSRF 令牌（cookie 双提交）
);
CREATE INDEX IF NOT EXISTS idx_chat_session_user  ON chat_session(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_session_state ON chat_session(state);
CREATE INDEX IF NOT EXISTS idx_chat_session_idle  ON chat_session(state, idle_expire_at);

-- ------------------------------------------------------------
-- 2) chat_message（消息事件流 / append-only）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_message (
    msg_id           TEXT        PRIMARY KEY,          -- 消息 ID（uuidv7）
    session_id       TEXT        NOT NULL,             -- 绑定会话（FR-CHAT-006 追溯）
    role             TEXT        NOT NULL,             -- user/assistant/system
    content_digest   TEXT        NOT NULL,             -- 内容摘要（脱敏/哈希化；禁全量明文）
    injected_flag    INTEGER     NOT NULL DEFAULT 0,   -- 注入检测命中标记（FR-CHAT-004）
    triggered_action TEXT,                             -- 由此消息触发的动作类型（无则 NULL）
    approval_id      TEXT,                             -- 触发的审批单（经 F-APPROVE 时回填）
    created_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_msg_session ON chat_message(session_id, created_at);

-- append-only 护栏（SQLite 等价实现；目标 RDBMS 以权限收口）
CREATE TRIGGER IF NOT EXISTS trg_chat_msg_no_update BEFORE UPDATE ON chat_message
  BEGIN SELECT RAISE(ABORT,'chat_message is append-only (UPDATE denied)'); END;
CREATE TRIGGER IF NOT EXISTS trg_chat_msg_no_delete BEFORE DELETE ON chat_message
  BEGIN SELECT RAISE(ABORT,'chat_message is append-only (DELETE denied)'); END;

-- ------------------------------------------------------------
-- 3) revoked_token（access jti 吊销表 / append-only）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS revoked_token (
    jti         TEXT        PRIMARY KEY,               -- JWT 唯一 id
    session_id  TEXT,                                  -- 关联会话
    revoked_at  TIMESTAMPTZ NOT NULL,
    reason      TEXT                                   -- logout / kill / reuse 等
);

-- ------------------------------------------------------------
-- 4) refresh_token（one-time-use 轮换）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_token (
    token_digest TEXT        PRIMARY KEY,              -- 刷新令牌摘要（不存明文）
    session_id   TEXT        NOT NULL,
    user_id      TEXT        NOT NULL,
    issued_at    TIMESTAMPTZ NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TEXT,                                 -- 非空=已使用（重放即失效）
    revoked      INTEGER     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_refresh_session ON refresh_token(session_id);

COMMIT;
