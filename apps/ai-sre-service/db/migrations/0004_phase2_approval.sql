-- ============================================================
-- AI SRE — db migration 0004 : Phase 2 F-APPROVE 白名单 + 审批状态机
--
-- 对应 SPEC-PHASE2 §3（FR-APPROVE-001~006 / AC-APPROVE-001~006）与
-- DESIGN-PHASE2-AUDIT-APPROVE-CHAT.md §2.2 / §2.3 / §4。
--
-- 在已 apply 的 0001/0002/0003 之上「新增不覆盖」：
--   1. whitelist_version：版本化白名单（**不可变快照**；运行时只读当前生效版本）。
--   2. approval_request：审批单（投影，state 为最新状态；载荷冻结）。
--   3. approval_event：审批事件流（**append-only**，状态变更追加记录）。
--   4. 索引对齐查询维度（state/type/created/ttl/incident/session）。
--   5. 不可变语义：触发器强制拒绝 whitelist_version / approval_event 的 UPDATE/DELETE。
--
-- ⚠️ 本迁移为 schema 契约（供 DEVOPS 依目标 RDBMS/权限环境适配执行，符合「系统无关」）。
--    进程内参照实现见 apps/ai-sre-service/src/approval/approval-store.ts（SQLite 单文件 + WAL）。
--    白名单变更必须经审批（type=whitelist_change）；批准后落新版本并记 diff_from_prev。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) whitelist_version（不可变快照 / DESIGN §2.2）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whitelist_version (
    version         INTEGER      PRIMARY KEY,             -- 版本号（自增；不可变快照）
    entries_json    TEXT         NOT NULL,                -- 该版本完整条目集（JSON 快照）
    created_by      TEXT         NOT NULL,                -- 创建者
    created_at      TIMESTAMPTZ  NOT NULL,                -- 创建时间（UTC）
    approval_id     TEXT,                                 -- 使其生效的审批单（v1 为 NULL）
    diff_from_prev  TEXT,                                 -- 相对前一版本 diff（JSON）
    CONSTRAINT uq_whitelist_version UNIQUE (version)
);

-- ------------------------------------------------------------
-- 2) approval_request（审批单投影 / DESIGN §2.3）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_request (
    approval_id      TEXT         PRIMARY KEY,            -- UUIDv7
    type             TEXT         NOT NULL,               -- operation / whitelist_change
    summary          TEXT         NOT NULL,               -- 操作摘要（FR-APPROVE-003）
    target_resource  TEXT         NOT NULL,               -- 目标资源
    risk_note        TEXT         NOT NULL,               -- 风险说明
    initiator_agent  TEXT         NOT NULL,               -- 发起 agent
    incident_id      TEXT,                                -- 关联 incident（FR-AUDIT-004）
    session_id       TEXT,                                -- 关联会话（F-CHAT）
    required_roles   TEXT         NOT NULL,               -- 需审角色（JSON array；含高风险二次复核标记）
    state            TEXT         NOT NULL,               -- 当前状态（DESIGN §4）
    ttl_expire_at    TIMESTAMPTZ  NOT NULL,               -- 超时时刻（默认 +30min）
    payload_ref      TEXT,                                -- 待执行载荷引用（JSON：operation 载荷 / whitelist diff）
    created_at       TIMESTAMPTZ  NOT NULL,
    updated_at       TIMESTAMPTZ  NOT NULL,
    CONSTRAINT chk_approval_type  CHECK (type IN ('operation','whitelist_change')),
    CONSTRAINT chk_approval_state CHECK (state IN
        ('DRAFT','SUBMITTED','PENDING_2ND','APPROVED','EXECUTE','DONE','FAILED','REJECTED','EXPIRED'))
);

-- ------------------------------------------------------------
-- 3) approval_event（不可变事件流 / DESIGN §2.3 / §4）
--    approval_request.state 由本事件流驱动（投影）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_event (
    seq         BIGSERIAL    PRIMARY KEY,                 -- 全局自增（事件序）
    approval_id TEXT         NOT NULL,                    -- 关联审批单
    from_state  TEXT,                                     -- 起态（建单首事件可为 NULL/DRAFT）
    to_state    TEXT         NOT NULL,                    -- 止态
    actor       TEXT         NOT NULL,                    -- 动作者（agent / user id / system）
    actor_role  TEXT,                                     -- 角色（oncall_sre/platform_owner/security_owner/auditor）
    reason      TEXT,                                     -- 理由（FR-APPROVE-006）
    at          TIMESTAMPTZ  NOT NULL,
    CONSTRAINT fk_approval_event_req FOREIGN KEY (approval_id)
        REFERENCES approval_request(approval_id)
);

-- ------------------------------------------------------------
-- 4) 索引（AC-APPROVE-001/003；审批人收件箱按 state/type）
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_approval_state    ON approval_request(state);
CREATE INDEX IF NOT EXISTS idx_approval_type     ON approval_request(type);
CREATE INDEX IF NOT EXISTS idx_approval_created  ON approval_request(created_at);
CREATE INDEX IF NOT EXISTS idx_approval_ttl      ON approval_request(ttl_expire_at);
CREATE INDEX IF NOT EXISTS idx_approval_incident ON approval_request(incident_id);
CREATE INDEX IF NOT EXISTS idx_approval_session  ON approval_request(session_id);
CREATE INDEX IF NOT EXISTS idx_approval_event_id ON approval_event(approval_id, seq);

-- ------------------------------------------------------------
-- 5) 不可变语义：禁止改删（AC-APPROVE-005「悄悄放权」不可行 / 事件流不可变）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION approval_immutable_block() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is immutable/append-only: % denied', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_whitelist_version_no_update ON whitelist_version;
CREATE TRIGGER trg_whitelist_version_no_update
    BEFORE UPDATE ON whitelist_version
    FOR EACH ROW EXECUTE FUNCTION approval_immutable_block();

DROP TRIGGER IF EXISTS trg_whitelist_version_no_delete ON whitelist_version;
CREATE TRIGGER trg_whitelist_version_no_delete
    BEFORE DELETE ON whitelist_version
    FOR EACH ROW EXECUTE FUNCTION approval_immutable_block();

DROP TRIGGER IF EXISTS trg_approval_event_no_update ON approval_event;
CREATE TRIGGER trg_approval_event_no_update
    BEFORE UPDATE ON approval_event
    FOR EACH ROW EXECUTE FUNCTION approval_immutable_block();

DROP TRIGGER IF EXISTS trg_approval_event_no_delete ON approval_event;
CREATE TRIGGER trg_approval_event_no_delete
    BEFORE DELETE ON approval_event
    FOR EACH ROW EXECUTE FUNCTION approval_immutable_block();

-- ------------------------------------------------------------
-- 6) 最小权限（仅供 DEVOPS 参考；账户名依环境调整）
--    agent：SELECT current whitelist version + INSERT approval_request/event。
--    白名单写入（INSERT whitelist_version）仅授予审批服务账号。
-- ------------------------------------------------------------
-- GRANT SELECT, INSERT ON approval_request, approval_event TO sre_approval_writer;
-- GRANT SELECT ON whitelist_version TO sre_agent_ro;
-- REVOKE UPDATE, DELETE, TRUNCATE ON whitelist_version, approval_event FROM PUBLIC;

COMMIT;
