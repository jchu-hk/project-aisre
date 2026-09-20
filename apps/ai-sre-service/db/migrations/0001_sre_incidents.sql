-- ============================================================
-- AI SRE — db migration 0001 : sre_incidents (+ enums)
--
-- 落地 DESIGN-AI-SRE §7.2 表 1：异常/报障事件统一真相源
--   source = detected(监控采集) / intake(用户报障, F-SRE-014)
-- intake 专属列（标 ✚）仅在 source='intake' 时有值。
--
-- 注意：本迁移仅为 schema 契约（供 DEVOPS 依目标 RDBMS 适配执行，
-- 符合「系统无关」）。附件注释标注 NFR-S §5.8 保留策略落点。
-- ============================================================

BEGIN;

-- source 枚举：detected / intake
DO $$ BEGIN
  CREATE TYPE sre_incident_source_enum AS ENUM ('detected','intake');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- severity 枚举
DO $$ BEGIN
  CREATE TYPE sre_severity_enum AS ENUM ('P0','P1','P2','P3');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- status 枚举
DO $$ BEGIN
  CREATE TYPE sre_incident_status_enum AS ENUM
    ('detected','locating','healing','escalated','resolved','suppressed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- triage 三分类
DO $$ BEGIN
  CREATE TYPE sre_incident_triage_enum AS ENUM ('dup','known','new');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ack 回执状态
DO $$ BEGIN
  CREATE TYPE sre_incident_ack_enum AS ENUM ('received','processing','fixed','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS sre_incidents (
  id                    UUID PRIMARY KEY,
  -- 命名空间隔离（per-system）。随 F-SRE-013 sre_systems 落地后可加外键
  -- REFERENCES sre_systems(system_id)；当前阶段以 system_id 命名空间做应用侧隔离。
  system_id             VARCHAR(64) NOT NULL,
  source                sre_incident_source_enum NOT NULL DEFAULT 'detected',
  anomaly_type          VARCHAR(64) NOT NULL,          -- service_down/disk_high/.../functional/manual
  severity              sre_severity_enum NOT NULL DEFAULT 'P3',
  reported_severity     VARCHAR(32),                   -- ✚ intake 初步估计
  status                sre_incident_status_enum NOT NULL DEFAULT 'locating',
  affected_component    VARCHAR(128),
  symptom_desc          TEXT,                          -- ✚ intake 现象自由文本
  root_cause_hypotheses JSONB,
  recent_changes        JSONB,
  dedup_fingerprint     VARCHAR(64),                   -- 含 system_id；去重/三分类
  triage                sre_incident_triage_enum,      -- ✚ dup/known/new
  duplicate_of_id       UUID REFERENCES sre_incidents(id), -- ✚ dup 并入
  issue_id              INTEGER,                       -- ✚ GitHub Issue（Issue 唯一真相源）
  reporter_contact_ref  VARCHAR(128),                  -- ✚ 脱敏存储；NFR-S §5.8（关单后 N 天清除）
  source_channel        VARCHAR(32),                   -- ✚ webhook/im/email/webform/...
  raw_payload           JSONB,                         -- ✚ 可选；按 rawPayloadKeepDays 自动清理（NFR-S）
  ack_status            sre_incident_ack_enum,         -- ✚ received/processing/fixed/closed
  ack_attempts          SMALLINT NOT NULL DEFAULT 0,
  ack_last_result       TEXT,
  received_at           TIMESTAMPTZ NOT NULL,          -- ✚ intake 接收
  detected_at           TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 去重/抑制索引（F-SRE-007 通知去重与抑制）
CREATE INDEX IF NOT EXISTS idx_sre_incidents_system_fp
  ON sre_incidents(system_id, dedup_fingerprint, ack_status);

-- issue 关联索引（Issue 唯一真相源反查）
CREATE INDEX IF NOT EXISTS idx_sre_incidents_issue
  ON sre_incidents(issue_id) WHERE issue_id IS NOT NULL;

COMMIT;
