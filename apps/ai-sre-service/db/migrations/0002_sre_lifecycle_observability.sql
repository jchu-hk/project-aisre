-- ============================================================
-- AI SRE — db migration 0002 : incident 生命周期可观测性（Issue #372）
--
-- 对应 FUNCTIONAL-SPEC-AI-SRE.md F-SRE-016 / AC-016 / UC-SRE-018 / NFR-T，
-- DESIGN-AI-SRE.md §12（T-ARCH-1/2/6/7）与 docs/ai-sre/DB-SCHEMA.md。
--
-- 在已 apply 的 0001 之上「增列不覆盖」：
--   1. 新增 sre_incident_lifecycle_enum（对外权威生命周期，§12.6）；triage/dup/known/new 与 ack
--      保留为 intake axis；status 保留为 processing 轴（docs §8 权威投影规则）。
--   2. sre_incidents 增列 lifecycle / lifecycle_updated_at / lifecycle_reopen_reason，
--      并对存量/检测源做一次生命周期指引（seed）。
--   3. 新建 sre_incident_state_transitions（迁移历史，scope=trace 下钻源）——
--      RANGE 分区按 occurred_at，审计取证/长留存类（§12.6/12.7），不走普通日志回收。
--   4. 新建 sre_incident_query_audit（append 型，§12.2「谁查过什么」）。
--   5. 索引对齐 §12.2 列表过滤（system/status/lifecycle/severity/time/issue）；
--      权限最小化：对审计类仅用只审计账户 INSERT。
--
-- ⚠️ 本迁移为 schema 契约（供 DEVOPS 依目标 RDBMS/权限环境适配执行，符合「系统无关」）。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) 生命周期枚举（§12.6）：reported→triage→accepted_in_progress→investigating→closed
--    （dup/known 并入分支 → closed@triage，不入 investigating；detected 直接 investigating 起步，
--     由 0002 seed 指引。）
-- ------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE sre_incident_lifecycle_enum AS ENUM
    ('reported','triage','accepted_in_progress','investigating','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 触发分类（驱动 audit/trigger 溯源，§12.6 迁移表「触发者」分类）
DO $$ BEGIN
  CREATE TYPE sre_lifecycle_trigger_enum AS ENUM
    ('intake_normalize','intake_received','detector',
     'triage_new','triage_merge','triage_known_issue',
     'investigation_start','investigation_pause',
     'fix_verify','manual_close','suppressed',
     'explicit_reopen','issue_state_sync');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 2) sre_incidents 增列（增列不覆盖：不加改既有 status/triage/ack_status 语义）
-- ------------------------------------------------------------
ALTER TABLE sre_incidents
  ADD COLUMN IF NOT EXISTS lifecycle                  sre_incident_lifecycle_enum
      NOT NULL DEFAULT 'reported',
  ADD COLUMN IF NOT EXISTS lifecycle_updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS lifecycle_reopen_reason    TEXT;   -- 仅 closed→显式 reopen 时有值

-- §12.2 列表过滤/游标索引（per-system 首键）
CREATE INDEX IF NOT EXISTS idx_sre_incidents_system_lifecycle
  ON sre_incidents(system_id, lifecycle);
CREATE INDEX IF NOT EXISTS idx_sre_incidents_system_severity
  ON sre_incidents(system_id, severity);
CREATE INDEX IF NOT EXISTS idx_sre_incidents_system_created
  ON sre_incidents(system_id, created_at);
-- 关联 Issue 反查（Issue 唯一真相源；0001 已按 issue_id 部分索引，这里补 system 维度便于 per-system）
CREATE INDEX IF NOT EXISTS idx_sre_incidents_system_issue
  ON sre_incidents(system_id, issue_id) WHERE issue_id IS NOT NULL;

-- 对存量/检测源生命周期指引（seed）：仅当 lifecycle 仍是默认 'reported' 且未真正发生 intake
-- 迁移时，依据既有轴字段做一次性投影（与 src/lifecycle/project.ts 的 forward projection 同规则）。
-- 已显式推进过 lifecycle 的行不受影响（投影只 seed 未定的）。
UPDATE sre_incidents SET
    lifecycle = CASE
        -- 检测源已 resolved/suppressed → closed（显式处置关单）
        WHEN source = 'detected' AND status IN ('resolved','suppressed')
          THEN 'closed'
        -- 检测源仍 locating/healing/escalated → investigating（进入处置）
        WHEN source = 'detected' AND status IN ('locating','healing','escalated')
          THEN 'investigating'
        -- intake ack 已 closed → closed（回执闭环关单）
        WHEN source = 'intake' AND ack_status = 'closed'
          THEN 'closed'
        -- intake triage=new → 处理中（accepted；此后 investigation_start 入 investigating）
        WHEN source = 'intake' AND triage = 'new'
          THEN 'accepted_in_progress'
        -- intake dup/known → 并入既有（closed@triage，single audit 保留 dup 记录）
        WHEN source = 'intake' AND triage IN ('dup','known')
          THEN 'closed'
        -- 默认：受理态起步（后续由迁移器驱动）
        ELSE 'reported'
    END,
    lifecycle_updated_at = now()
  WHERE source = 'intake' OR source = 'detected';

-- ------------------------------------------------------------
-- 3) sre_incident_state_transitions —— lifecycle 迁移历史（scope=trace 下钻源）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sre_incident_state_transitions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id        UUID NOT NULL REFERENCES sre_incidents(id),
  system_id          VARCHAR(64) NOT NULL,
  issue_id           INTEGER,
  prev_state         sre_incident_lifecycle_enum NOT NULL,
  new_state          sre_incident_lifecycle_enum NOT NULL,
  trigger            sre_lifecycle_trigger_enum NOT NULL,
  actor_type         VARCHAR(32) NOT NULL DEFAULT 'ai_sre',
  actor_id           VARCHAR(64) NOT NULL DEFAULT 'ai-sre-service',
  reason             TEXT,
  reopen_reason      TEXT,                  -- closed→显式 reopen 冗余别名（聚合查询友好）
  trace_id           UUID,
  policy_version     VARCHAR(32),
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (occurred_at);

-- 初始分区（按季；DEVOPS 可按量/合规调粒度与预建窗口）
DO $part$ BEGIN
  CREATE TABLE sre_incident_state_transitions_p2026q3 PARTITION OF sre_incident_state_transitions
    FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');
  CREATE TABLE sre_incident_state_transitions_p2026q4 PARTITION OF sre_incident_state_transitions
    FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');
  CREATE TABLE sre_incident_state_transitions_p2027q1 PARTITION OF sre_incident_state_transitions
    FOR VALUES FROM ('2027-01-01') TO ('2027-04-01');
  CREATE TABLE sre_incident_state_transitions_default PARTITION OF sre_incident_state_transitions
    DEFAULT;   -- 兜底（历史/越界），供显式改造成合规分区
EXCEPTION WHEN duplicate_table THEN NULL; END $part$;

-- trace 下钻时间线 / per-system 归档隔离 / 追踪链
CREATE INDEX IF NOT EXISTS idx_sre_it_incident_time
  ON sre_incident_state_transitions(incident_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_sre_it_system_time
  ON sre_incident_state_transitions(system_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_sre_it_trace
  ON sre_incident_state_transitions(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sre_it_reopen
  ON sre_incident_state_transitions(reopen_reason) WHERE reopen_reason IS NOT NULL;

-- 审计取证保护注释（m4/NFR-T）：本表为审计/取证语料，默认长留存，
-- 严禁并入普通日志回收；回收走 §12.7 分区 DETACH/归档 + investigation hold 检查。

-- ------------------------------------------------------------
-- 4) sre_incident_query_audit —— 查询审计（append-only 型，§12.2）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sre_incident_query_audit (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id_requested   VARCHAR(64) NOT NULL,
  endpoint              VARCHAR(128) NOT NULL,
  method                VARCHAR(8)   NOT NULL DEFAULT 'GET',
  actor_id              VARCHAR(64)  NOT NULL,
  scope                 VARCHAR(16),
  filters               JSONB,
  cursor                VARCHAR(128),
  matched_ids           JSONB,
  requested_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
) PARTITION BY RANGE (requested_at);

DO $part$ BEGIN
  CREATE TABLE sre_incident_query_audit_p2026q3 PARTITION OF sre_incident_query_audit
    FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');
  CREATE TABLE sre_incident_query_audit_p2026q4 PARTITION OF sre_incident_query_audit
    FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');
  CREATE TABLE sre_incident_query_audit_p2027q1 PARTITION OF sre_incident_query_audit
    FOR VALUES FROM ('2027-01-01') TO ('2027-04-01');
  CREATE TABLE sre_incident_query_audit_default PARTITION OF sre_incident_query_audit
    DEFAULT;
EXCEPTION WHEN duplicate_table THEN NULL; END $part$;

CREATE INDEX IF NOT EXISTS idx_sre_iqa_system_time
  ON sre_incident_query_audit(system_id_requested, requested_at);
CREATE INDEX IF NOT EXISTS idx_sre_iqa_actor
  ON sre_incident_query_audit(actor_id, requested_at);
CREATE INDEX IF NOT EXISTS idx_sre_iqa_endpoint
  ON sre_incident_query_audit(endpoint, requested_at);

-- ------------------------------------------------------------
-- 5) append-only / 最小权限（§12.1 fail-closed：审计缺写不让动作落地）
--    DEVOPS 依实际角色体系建账户/授权；此处给出声明与 REVOKE 护栏原型。
-- ------------------------------------------------------------
-- 查询审计只允许 INSERT（防「谁查过什么」被抹）；不能 UPDATE/DELETE/TRUNCATE。
-- 下面以独立账户示例（实际命名随环境）：
--   CREATE ROLE sre_query_audit_app_writer;         -- 应用写审计
--   GRANT INSERT, SELECT ON sre_incident_query_audit TO sre_query_audit_app_writer;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sre_query_audit_app_writer;
--   REVOKE UPDATE, DELETE, TRUNCATE ON sre_incident_query_audit FROM sre_query_audit_app_writer;
--
-- 状态迁移历史仅 writer（ai-sre）可写；上报运营 reader 只读限定 per-system：
--   CREATE ROLE sre_report_reader;
--   GRANT SELECT ON sre_incidents, sre_incident_state_transitions TO sre_report_reader;

COMMIT;
