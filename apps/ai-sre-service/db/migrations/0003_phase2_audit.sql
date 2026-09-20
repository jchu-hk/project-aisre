-- ============================================================
-- AI SRE — db migration 0003 : Phase 2 F-AUDIT 审计日志（append-only 哈希链）
--
-- 对应 SPEC-PHASE2 §2（FR-AUDIT-001~005 / AC-AUDIT-001~003）与
-- DESIGN-PHASE2-AUDIT-APPROVE-CHAT.md §2.1 / §3。
--
-- 在已 apply 的 0001/0002 之上「新增不覆盖」：
--   1. 新建 audit_log（append-only；who/when/what/why/result/reason + 哈希链锚点）。
--   2. 索引对齐 §2.1 查询维度：(when) / (who_id,when) / (action_type,when) / (result)
--      / (incident_id) / (session_id) / (approval_id)。
--   3. WORM 语义：触发器强制拒绝 UPDATE/DELETE（应用层亦无接口，双保险 AC-AUDIT-002）。
--      最小权限：审计账户默认仅 INSERT+SELECT（由 DEVOPS 依目标环境授权）。
--
-- ⚠️ 本迁移为 schema 契约（供 DEVOPS 依目标 RDBMS/权限环境适配执行，符合「系统无关」）。
--    进程内参照实现见 apps/ai-sre-service/src/audit/audit-store.ts（SQLite 单文件 + WAL）。
--    哈希链：hash = H(seq ‖ prev_hash ‖ canonical(payload))，seq 全局单调。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) audit_log（append-only / DESIGN §2.1）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id              TEXT         PRIMARY KEY,             -- UUIDv7（时间有序）
    seq             BIGINT       NOT NULL UNIQUE,         -- 全局单调递增（哈希链锚点）
    who_type        TEXT         NOT NULL,                -- agent / user / system
    who_id          TEXT         NOT NULL,                -- 身份标识
    "when"          TIMESTAMPTZ  NOT NULL,                -- 事件时间（UTC）
    action_type     TEXT         NOT NULL,                -- 操作类型枚举（如 restart/whitelist.update/chat.message）
    target_resource TEXT         NOT NULL,                -- 目标资源标识
    params_digest   TEXT,                                 -- 入参摘要（脱敏，禁全量明文）
    why_source      TEXT         NOT NULL,                -- 触发来源（intake/chat/schedule/alert…）
    incident_id     TEXT,                                 -- 关联 incident（FR-AUDIT-004）
    session_id      TEXT,                                 -- 关联会话（F-CHAT）
    approval_id     TEXT,                                 -- 关联审批单（F-APPROVE）
    result          TEXT         NOT NULL,                -- success / failed / denied / pending
    reason          TEXT,                                 -- 失败/拒绝原因（FR-AUDIT-005）
    prev_hash       TEXT         NOT NULL,                -- 前记录 hash（genesis=全 0）
    hash            TEXT         NOT NULL,                -- 本记录 hash
    CONSTRAINT chk_audit_who_type CHECK (who_type IN ('agent','user','system')),
    CONSTRAINT chk_audit_result   CHECK (result IN ('success','failed','denied','pending')),
    -- failed/denied 必须有可诊断原因（FR-AUDIT-005 / AC-AUDIT-005）
    CONSTRAINT chk_audit_reason   CHECK (
        result NOT IN ('failed','denied') OR (reason IS NOT NULL AND length(reason) > 0)
    )
);

-- ------------------------------------------------------------
-- 2) 索引（§2.1 查询维度 / AC-AUDIT-003 时间有界查询 < 2s）
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_when        ON audit_log("when");
CREATE INDEX IF NOT EXISTS idx_audit_who_when    ON audit_log(who_id, "when");
CREATE INDEX IF NOT EXISTS idx_audit_action_when ON audit_log(action_type, "when");
CREATE INDEX IF NOT EXISTS idx_audit_result      ON audit_log(result);
CREATE INDEX IF NOT EXISTS idx_audit_incident    ON audit_log(incident_id);
CREATE INDEX IF NOT EXISTS idx_audit_session     ON audit_log(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_approval    ON audit_log(approval_id);

-- ------------------------------------------------------------
-- 3) WORM：DB 层强制拒绝 UPDATE/DELETE（AC-AUDIT-002 双保险）
--    （PostgreSQL 函数 + 触发器；应用层亦不提供任何改删接口。）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_block_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only: % denied', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_no_update ON audit_log;
CREATE TRIGGER trg_audit_no_update
    BEFORE UPDATE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

DROP TRIGGER IF EXISTS trg_audit_no_delete ON audit_log;
CREATE TRIGGER trg_audit_no_delete
    BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

-- ------------------------------------------------------------
-- 4) 最小权限（仅供 DEVOPS 参考；账户名依环境调整）
--    审计账户：仅 INSERT + SELECT（禁 UPDATE/DELETE/TRUNCATE）。
-- ------------------------------------------------------------
-- GRANT SELECT, INSERT ON audit_log TO sre_audit_writer;
-- REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC;

COMMIT;
