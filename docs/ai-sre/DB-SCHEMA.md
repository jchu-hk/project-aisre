# AI SRE — 记录层 Schema（嵌入式 SQLite）

> AI SRE 服务（`apps/ai-sre-service`）的记录层（incident / lifecycle 迁移 / incident 查询审计）
> 由 **嵌入式 SQLite 单文件库**（per-deployment 自包含，`ai-sre-service` 数据卷内 `sre/dl/sre.db`）承载，
> 表沿用 `sre_*` 命名与 per-`system_id` 语义隔离（DESIGN-AI-SRE §7 / §12）。
> 本文档是 `apps/ai-sre-service/db/sqlite/init.sql` + 运行时迁移 (`schema_version`) 的 schema 说明与真值源对齐
> （READ 侧约定：以迁移 SQL 为准，本文档为人工可读契约）。

> ⚠️ **v0.5.0 记录层选型变更**：incident 持久化由 **PostgreSQL（独立服务）改为嵌入式 SQLite**（GitHub #372 定案 D，见 DESIGN-AI-SRE §7.1b / DB-SCHEMA §1a）。原因：**产品可重复部署须自包含、零外部依赖、零运维**；单客户/单部署 incident 量小，SQLite 单机容量/并发足够且免 DBA。本文档正文已整体改写为 SQLite 表达（DDL/类型/约束/索引）。
>
> 命名遵循 SQLite 惯例 + 既有 `sre_*` snake_case：`TEXT UUID PK` / `TEXT ISO-8601(UTC) 时间戳` / `CHECK 约束代替 ENUM` / `TEXT 存 JSON`。
> 与本仓库 SAS 业务库（school-admin，PostgreSQL）**不同 schema / 不同存储形态**；AI SRE 记录层为自包含 SQLite 文件，二者各自迁移、各自文档。

## 1a. 记录层选型：PG → SQLite（#372 定案 D）

| 维度 | v0.4.0 之前（PostgreSQL） | **v0.5.0（嵌入式 SQLite）** | 取舍理由 |
|------|--------------------------|------------------------------|----------|
| 存储形态 | 独立 PostgreSQL 服务（连接串/角色/RLS/分区） | **单文件 `sre.db`（app-local，随镜像数据卷）** | 可重复部署须自包含、零运维；无需 DBA/连接管理/独立服务存活兜底 |
| 部署/升级 | DB 迁移命令/角色授予/分区归档（DEVOPS 操作） | SQLite 文件随服务初始化；schema 版本号 + 幂等迁移（启动自迁移） | 一次部署单元即含全部状态；免外部迁移编排 |
| 容量模型 | 面向大量 per-system 多租户 | **单部署=单客户**，incident 量小（告警+报障量级/天）；单文件充足 | 命中「单客户 incident 量小」，规避 SQLite 写放大/并发短板 |
| 一致性 | 强一致（服务端事务） | WAL 模式 + 单写者自包含事务，单进程边界内强一致 | 记录层为「单实例 app 写 + 只读查询」，无跨节点分布诉求 |
| 审计隔离 | 角色最小权限 + RLS | app 写门（append-only writer）+ 触发器拒 UPDATE/DELETE + 文件级权限 | 见 §6（SQLite 无服务端角色/RLS，用 app 层 + 触发器 + OS 权限承接） |
| 查询 | PG 分区/索引 + SQL | **复合索引 + 视图/JSON 提取**（翻 pages / 游标） | 查询端点保留（DESIGN §12.2b），JSONB→TEXT 后索引策略见 §4 |

> **仍保留的查询端点**（#372 §12.2 契约不因存储更换而变，见 DESIGN §12.2b / DB-SCHEMA §7）：
> - `GET /api/sre/incidents`：列表 + 筛选（system_id/lifecycle/severity/source/时间区间…，白名单键、分页游标）。
> - `GET /api/sre/incidents/{id}`：单条详情（PII 掩码投影；`scope=full/trace/audit` 下钻）。
> 二者统一以 `lifecycle` 为对外权威投影（§3）。

## 1. 类型映射（SQLite，PG→SQLite）

| PostgreSQL (v0.4.0) | SQLite（v0.5.0） | 说明 |
|---------------------|------------------|------|
| `UUID` PK | `TEXT` PK | UUID 以字符串存储（`x'…'` 规范化可放宽），利于跨栈读写；由 app 生成 uuid v4 |
| `TIMESTAMPTZ` / `now()` | `TEXT ISO-8601(UTC)`，`strftime('%Y-%m-%dT%H:%M:%fZ','now')` | 统一 UTC RFC3339 文本；排序/区间可用文本比较。默认由列级 `DEFAULT` 或 app 写入 |
| ENUM 类型列 | `TEXT` + `CHECK(col IN ('a','b',…))` | 枚举白名单落到 CHECK 约束，禁止脏值；取值与 DESIGN §12.6 枚举集一致 |
| `INTEGER issue_id` | `INTEGER` | GitHub Issue ID 数值 |
| `JSONB` | `TEXT`（JSON 序列化）+ `CHECK(json_valid(col))` | SQLite `TEXT` 存 JSON；校验用 `json_valid`；无 `->>`/索引需用 JSON1 函数 + 表达式索引（见 §4） |
| RANGE 分区（occurred_at 按月/季） | **复合索引**（见各表 §5）+ 按龄归档用「筛选 + 迁移/删除 + 起始页触发器护栏」 | SQLite 无原生分区；改用 `(…, occurred_at)` 复合索引支撑时间过滤/排序与按龄归档；长留存保护依赖隐藏/回收策略（DESIGN §12.7b） |
| 服务端角色授予 / RLS | **app 写门 + 触发器 + 文件权限** | SQLite 无角色/RLS：授权在 app repository 层强制（只读 reader 不包含写方法）；审计表以 `BEFORE UPDATE/DELETE` 触发器拒绝（§6） |

**记录层 RDBMS 特性开关**（SQLite，`init` PRAGMA）：`PRAGMA journal_mode=WAL;`、`PRAGMA foreign_keys=ON;`、`PRAGMA busy_timeout=5000;`、`PRAGMA synchronous=NORMAL;`。WAL 提供并发读 + 单写者。

## 2. 版本历史

| 版本 | 日期 | 内容 |
|------|------|------|
| `v0.5.0` | 2026-09-09 | **记录层选型 PG→嵌入式 SQLite（#372 定案 D）**：`sre.db` 单文件自包含；DDL/类型/约束整体改写为 SQLite（TEXT UUID/TEXT ISO-8601、CHECK 替 ENUM、TEXT 替 JSONB + json_valid、RANGE 分区→复合索引）；审计隔离改用 app 写门 + `BEFORE UPDATE/DELETE` 触发器 + 文件权限（无 PG 角色/RLS）；保留查询端点（列表+详情）与 lifecycle 权威投影；新增 `schema_version` 运行时迁移表。语义/枚举集/权威投影规则（§3）不变。 |
| `0002_sre_lifecycle.sql` | #372 | （历史 PG 迁移，见 §2b）sre_incidents 增 lifecycle 列 + sre_incident_state_transitions + sre_incident_query_audit（增列不覆盖、RANGE 分区、权限）——**已被 v0.5.0 SQLite 迁移取代** |
| `0001_sre_incidents.sql` | baseline | （历史 PG 迁移，见 §2b）sre_incidents 主表 + 枚举——**已被 v0.5.0 SQLite 迁移取代** |

### 2b. 既有 PG 迁移历史（保留存档；不再作为新环境执行对象）

DB-SCHEMA v0.4.0 PostgreSQL 版的迁移（`db/migrations/0001_*.sql` / `0002_*.sql`）记载了本项目记录层的先期设计演进。**v0.5.0 起新环境不再执行 PG 迁移**，以 SQLite `init.sql` + 运行时 `schema_version` 取代；下表仅供追溯（历史 PG DDL 语义不变，但列由 §4 映射落到 SQLite `sre_incidents` 等表）。

| 迁移 | 日期 | 内容（历史 PG） |
|------|------|------|
| `db/migrations/0001_sre_incidents.sql` | baseline | `sre_incidents` 主表（检测+intake 统一真相源）+ 数据源/严重度/processing-status/triage/ack 枚举 |
| `db/migrations/0002_sre_lifecycle_observability.sql` | #372 | lifecycle 增列（`sre_incident_lifecycle_enum` + `sre_incidents.lifecycle`）+ 迁移历史表 + 查询审计表 + 分区/索引/权限 |

## 3. 权威投影规则（四字段联合）

一个 incident instance 承载四个状态字段，描述**同一事物的不同轴**，非双源漂移。语义与取值 v0.4.0 完全一致（存储由 PG ENUM 落到 TEXT + CHECK）：

| 字段 | 轴 | 作用域 | 对外是否权威 |
|------|----|--------|--------------|
| `status` | 处置管线 processing | detected 检测/自愈 管线 + intake | &#10007;（源流字段，保留） |
| `triage` | 三分类 | intake（dup/known/new 一次性判定） | &#10007; |
| `ack_status` | 报障回执闭环 | intake（received/processing/fixed/closed） | &#10007; |
| **`lifecycle`**（§12.6b） | **显式生命周期状态机** | 全来源 | **&#10003; 对外权威（列表/详情/down-drill 均以它为准）** |

**联合/投影规则**（`projectLifecycle()` 纯函数）：
1. **前向投影**（对外）：对外只暴露 `lifecycle`；`status/triage/ack_status` 作为各自轴的运行字段保留并给出，但不替代 lifecycle 判定。
2. **lifecycle 字段未显式落库时（检测源/存量迁移）** 由 legacy 投影引导一次性 seed：
   - detected 且 (status ∈ locating|healing|escalated) → `investigating`
   - detected/处理中 且 status=resolved|suppressed → `closed`
   - intake 且 triage=new → `reported`→`accepted_in_progress`（进入排查前）
   - intake 且 triage=dup|known → `closed@triage(并入)`（并入源，不入 investigating）
   - intake 且 ack_status=closed → `closed`
3. **反向护栏（防静默复活 AC-016）**：已 `closed` 的 incident，其下任一 legacy 字段被后端推进，不得将 lifecycle 拉回未完结处理态；唯一出路是**显式 reopen（带原因）**。lifecycle 迁移须经状态机校验（`machine.ts`）；不落迁移表的跳转在网关/读路径拒绝并做审计。
4. **Issue 映射（唯一真相源）**：Issue open→lifecycle 相关处理态；Issue closed→lifecycle closed（显式 close）；Issue reopen→显式 reopen 带原因。

## 4. 表清单

| 表 | 说明 | 源迁移 |
|----|------|--------|
| `schema_version` | 运行时 schema 版本（app 启动幂等迁移用，v0.5.0 新增） | init.sql |
| `sre_incidents` | 异常/报障统一真相源（detected+intake），lifecycle 列 | init.sql（0001+0002 语义并入） |
| `sre_incident_state_transitions` | lifecycle 迁移历史（谁/何时/依据/旧新 state）；append 型审计取证类，默认长留存 | init.sql（0002 语义） |
| `sre_incident_query_audit` | incident 查询审计（§12.2「谁查过什么」），append 型 | init.sql（0002 语义） |

> §12.1/12.4 的 `sre_audit_events` / `sre_decision_records`（动作审计 + 决策依据、WORM 哈希链）与 §7.2 其余引擎表
> （sre_systems/adapter/healing/escalation/allowlist/learning…）**不在记录层 SQLite 的 #372 定案 D 本地范围**——
> v0.5.0 先落 incident 记录层（本文件所载）；其余表若同样采用 SQLite 记录层，由后续 #相关 Issue 各自伴随落 DDL，先不建。

## 5. 详细表结构 + DDL

### 5.0 schema_version（init/运行时迁移，v0.5.0 新增）

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| version | TEXT | PK | 语义版本（如 `0.5.0`） |
| applied_at | TEXT(ISO-8601 UTC) | NOT NULL | 应用时刻 |
| note | TEXT | NULL | 迁移说明（如 `pg_to_sqlite_#372_D`） |

**DDL**
```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  note       TEXT
);
```
> app 启动流程：读 `schema_version` 最高版本 → 低于目标则按序执行幂等迁移（`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN`）+ 记一行 → 记录层就绪。跨进程/多 replica 场景由 app 写者单点 + WAL busy_timeout 保证不并发迁移（单部署单写者假设见 §1a）。

### 5.1 sre_incidents（init.sql，合并 0001 列 + 0002 lifecycle 增列）

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | TEXT | PK | UUID（app 生成 v4） |
| system_id | TEXT | NOT NULL | per-system 隔离命名空间（SIEM 语义等同 v0.4.0 UUID FK，此处无独立 sre_systems 表则存系统标识符字符串） |
| issue_id | INTEGER | NULL | 关联 GitHub Issue（唯一真相源） |
| source | TEXT | NOT NULL CHECK(source IN ('detected','intake')) | 检测 / 报障 |
| severity | TEXT | NOT NULL CHECK(severity IN ('P0','P1','P2','P3')) | 定级 |
| status | TEXT | NOT NULL CHECK(status IN ('detected','locating','healing','escalated','resolved','suppressed')) | processing 处置轴 |
| triage | TEXT | NULL CHECK(triage IN ('dup','known','new')) | intake 三分类（非 intake NULL） |
| ack_status | TEXT | NULL CHECK(ack_status IN ('received','processing','fixed','closed')) | intake 回执闭环（非 intake NULL） |
| **lifecycle** | TEXT | NOT NULL CHECK(lifecycle IN ('reported','triage','accepted_in_progress','investigating','closed')) DEFAULT 'reported' | **对外权威生命周期**（§12.6b） |
| lifecycle_updated_at | TEXT(ISO-8601 UTC) | NOT NULL | 最近一次 lifecycle 迁移时刻（timeline 锚） |
| lifecycle_reopen_reason | TEXT | NULL | 仅 closed→显式 reopen 时填（§12.6b 唯一出路） |
| affected_component | TEXT | NULL | 受影响组件 |
| anomaly_type | TEXT | NULL | 异常/报障类型标签 |
| reported_severity | TEXT | NULL | 报障者初步估计（intake） |
| symptom_desc | TEXT | NULL | 报障现象（intake；列表投影恒不含） |
| root_cause_hypotheses | TEXT | NULL CHECK(root_cause_hypotheses IS NULL OR json_valid(root_cause_hypotheses)) | JSON 数组（根因假设） |
| dedup_fingerprint | TEXT | NULL | 去重指纹 hash（含 system_id） |
| reporter_contact_ref | TEXT | NULL | 报障者回执联系引用（**脱敏/掩码**，NFR-S §5.8 例外） |
| source_channel | TEXT | NULL | intake 通道 webform/im/email/webhook 等 |
| raw_payload | TEXT | NULL CHECK(raw_payload IS NULL OR json_valid(raw_payload)) | 原始报文（可选，取证；最小留存自清理） |
| received_at / detected_at / resolved_at | TEXT(ISO-8601 UTC) | NULL | 关键时点 |
| created_at | TEXT(ISO-8601 UTC) | NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) | 入库时间 |

**DDL**（节选，完整以 `init.sql` 为真值源）
```sql
CREATE TABLE IF NOT EXISTS sre_incidents (
  id                      TEXT PRIMARY KEY,
  system_id               TEXT NOT NULL,
  issue_id                INTEGER,
  source                  TEXT NOT NULL CHECK(source IN ('detected','intake')),
  severity                TEXT NOT NULL CHECK(severity IN ('P0','P1','P2','P3')),
  status                  TEXT NOT NULL CHECK(status IN ('detected','locating','healing','escalated','resolved','suppressed')),
  triage                  TEXT CHECK(triage IN ('dup','known','new')),
  ack_status              TEXT CHECK(ack_status IN ('received','processing','fixed','closed')),
  lifecycle               TEXT NOT NULL DEFAULT 'reported'
                           CHECK(lifecycle IN ('reported','triage','accepted_in_progress','investigating','closed')),
  lifecycle_updated_at    TEXT NOT NULL,
  lifecycle_reopen_reason TEXT,
  affected_component      TEXT,
  anomaly_type            TEXT,
  reported_severity       TEXT,
  symptom_desc            TEXT,
  root_cause_hypotheses   TEXT CHECK(root_cause_hypotheses IS NULL OR json_valid(root_cause_hypotheses)),
  dedup_fingerprint       TEXT,
  reporter_contact_ref    TEXT,
  source_channel          TEXT,
  raw_payload             TEXT CHECK(raw_payload IS NULL OR json_valid(raw_payload)),
  received_at             TEXT,
  detected_at             TEXT,
  resolved_at             TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- 复合索引（SQLite；原 PG 单列 + RANGE 分区需求以复合索引承接 §4）
CREATE INDEX IF NOT EXISTS idx_inc_sys_fp           ON sre_incidents(system_id, dedup_fingerprint, ack_status);
CREATE INDEX IF NOT EXISTS idx_inc_sys_lifecycle    ON sre_incidents(system_id, lifecycle);
CREATE INDEX IF NOT EXISTS idx_inc_sys_severity     ON sre_incidents(system_id, severity);
CREATE INDEX IF NOT EXISTS idx_inc_sys_created      ON sre_incidents(system_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inc_issue            ON sre_incidents(issue_id);
CREATE INDEX IF NOT EXISTS idx_inc_sys_issue        ON sre_incidents(system_id, issue_id);
```
> 查询端点（list 过滤/游标、detail by id，契约见 DESIGN §12.2b）由上述 `(system_id, …)` 复合索引支撑；`lifecycle_updated_at` 作为对外 `updated_at` 语义锚用于默认排序。

### 5.2 sre_incident_state_transitions（init.sql，审计取证 append）

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | TEXT | PK | UUID |
| incident_id | TEXT | NOT NULL REFERENCES sre_incidents(id) | 归属 incident |
| system_id | TEXT | NOT NULL | per-system denorm（隔离查询） |
| issue_id | INTEGER | NULL | 关联 Issue |
| prev_state | TEXT | NOT NULL CHECK(prev_state IN (lifecycle 取值)) | 旧 lifecycle |
| new_state | TEXT | NOT NULL CHECK(new_state IN (lifecycle 取值)) | 新 lifecycle |
| trigger | TEXT | NOT NULL CHECK(trigger IN ('intake_normalize','intake_received','detector','triage_new','triage_merge','triage_known_issue','investigation_start','investigation_pause','fix_verify','manual_close','suppressed','explicit_reopen','issue_state_sync')) | 触发分类 |
| actor_type | TEXT | NOT NULL DEFAULT 'ai_sre' | ai_sre/detector/triage/intake_channel/human |
| actor_id | TEXT | NOT NULL DEFAULT 'ai-sre-service' | 触发者标识 |
| reason | TEXT | NULL | 依据/原因（reopen 必填） |
| reopen_reason | TEXT | NULL | closed→显式 reopen 冗余别名 |
| trace_id | TEXT | NULL | 端到端因果追踪（uuid） |
| policy_version | TEXT | NULL | 触发该迁移的策略版本 |
| occurred_at | TEXT(ISO-8601 UTC) | NOT NULL | 迁移发生时刻（timeline 排序键） |
| created_at | TEXT(ISO-8601 UTC) | NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) | 入库时间 |

**DDL**（节选）
```sql
CREATE TABLE IF NOT EXISTS sre_incident_state_transitions (
  id            TEXT PRIMARY KEY,
  incident_id   TEXT NOT NULL REFERENCES sre_incidents(id),
  system_id     TEXT NOT NULL,
  issue_id      INTEGER,
  prev_state    TEXT NOT NULL,
  new_state     TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  actor_type    TEXT NOT NULL DEFAULT 'ai_sre',
  actor_id      TEXT NOT NULL DEFAULT 'ai-sre-service',
  reason        TEXT,
  reopen_reason TEXT,
  trace_id      TEXT,
  policy_version TEXT,
  occurred_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(prev_state IN ('reported','triage','accepted_in_progress','investigating','closed')),
  CHECK(new_state  IN ('reported','triage','accepted_in_progress','investigating','closed')),
  CHECK(trigger IN ('intake_normalize','intake_received','detector','triage_new','triage_merge',
                    'triage_known_issue','investigation_start','investigation_pause','fix_verify',
                    'manual_close','suppressed','explicit_reopen','issue_state_sync'))
);
CREATE INDEX IF NOT EXISTS idx_tr_incident_time ON sre_incident_state_transitions(incident_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_tr_sys_time      ON sre_incident_state_transitions(system_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_tr_trace         ON sre_incident_state_transitions(trace_id);
-- append-only 护栏（审计取证类不得裸改/删/截断）
CREATE TRIGGER IF NOT EXISTS trg_tr_no_update BEFORE UPDATE ON sre_incident_state_transitions
  BEGIN SELECT RAISE(ABORT,'sre_incident_state_transitions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_tr_no_delete BEFORE DELETE ON sre_incident_state_transitions
  BEGIN SELECT RAISE(ABORT,'sre_incident_state_transitions is append-only'); END;
```
> 取证保留（NFR-T）：审计取证语料默认长留存不走日志回收；SQLite 下按龄归档 = 以 `occurred_at` 为界筛选 + 迁移/抽离 +（受触发器保护的 append 表不做行删除，归档走「整段抽离新库 + 起始标记」的保留策略，DESIGN §12.7b）。

### 5.3 sre_incident_query_audit（init.sql，append「谁查过什么」）

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | TEXT | PK | UUID |
| system_id_requested | TEXT | NOT NULL | 查询的系统命名空间（空串 `''` = 跨所辖全系统——见 DESIGN §7 空 scope 语义） |
| endpoint | TEXT | NOT NULL | `/api/sre/incidents` 或 `/api/sre/incidents/{id}` |
| method | TEXT | NOT NULL CHECK(method IN ('GET')) | GET |
| actor_id | TEXT | NOT NULL | 查询主体（query-console / gateway-identified） |
| scope | TEXT | NULL | detail: full/trace/audit（list 为 NULL） |
| filters | TEXT | NULL CHECK(filters IS NULL OR json_valid(filters)) | list 过滤白名单条件快照 |
| cursor | TEXT | NULL | 分页游标（原样，不记录联系字段） |
| matched_ids | TEXT | NULL CHECK(matched_ids IS NULL OR json_valid(matched_ids)) | 命中 incident_id 数组快照（受 limit 截断，对账用） |
| requested_at | TEXT(ISO-8601 UTC) | NOT NULL | 查询时刻 |
| created_at | TEXT(ISO-8601 UTC) | NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) | 入库时间 |

**DDL**（节选）
```sql
CREATE TABLE IF NOT EXISTS sre_incident_query_audit (
  id                   TEXT PRIMARY KEY,
  system_id_requested  TEXT NOT NULL,
  endpoint             TEXT NOT NULL,
  method               TEXT NOT NULL CHECK(method IN ('GET')),
  actor_id             TEXT NOT NULL,
  scope                TEXT,
  filters              TEXT CHECK(filters IS NULL OR json_valid(filters)),
  cursor               TEXT,
  matched_ids          TEXT CHECK(matched_ids IS NULL OR json_valid(matched_ids)),
  requested_at         TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_qa_sys_time ON sre_incident_query_audit(system_id_requested, requested_at);
CREATE INDEX IF NOT EXISTS idx_qa_incident ON sre_incident_query_audit(matched_ids);
-- append-only 护栏
CREATE TRIGGER IF NOT EXISTS trg_qa_no_update BEFORE UPDATE ON sre_incident_query_audit
  BEGIN SELECT RAISE(ABORT,'sre_incident_query_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_qa_no_delete BEFORE DELETE ON sre_incident_query_audit
  BEGIN SELECT RAISE(ABORT,'sre_incident_query_audit is append-only'); END;
```
> 隔离：查询写入仅授权账户可 INSERT（app repository 层校验 + 只暴露 append 方法，不暴露 update/delete）；触发器兜底拒绝裸 UPDATE/DELETE，防「谁查过什么」被抹。
> JSON 表达式索引（JSON1）：如需按 `filters` 内某键过滤，可建表达式索引，如
> `CREATE INDEX idx_qa_filter_lifecycle ON sre_incident_query_audit(json_extract(filters,'$.lifecycle'));`（仅在明确筛选热路径需要时加）。

## 6. 隔离与权限（SQLite 承接 §12.7 / §12.1，无 PG 角色/RLS）

- **记录层为单部署单客户 + app 单写者**：per-`system_id` 隔离在 **app repository 层强制**（读路径 `IncidentReader`/查询末尾恒补 `system_id` 谓词 + 越权拒绝），见 DESIGN §7/§12.2b；SQLite 内不再有 PG 那类角色授予。
- **append-only / 防篡改护栏**：审计取证类表（transitions / query_audit）以 `BEFORE UPDATE/DELETE` 触发器 `RAISE(ABORT,…)` 拒绝裸改/删（DDL §5.2/5.3）；正常写入仅经 app append-only writer。TRUNCATE 在 SQLite 等价为逐 DELETE（被触发器拦截）。
- **写权限收口**：对外引用 `sre.db` 的账户以文件级最小权限（OS 用户/卷权限）运行；WAL 副文件 `-wal`/`-shm` 同目录归属受限。
- **schema / 版本**：`schema_version` 由 app 启动幂等迁移维护，DBA 无独立角色表。
- **哈希链 / WORM（动作与决策审计，DESIGN §12.1/12.4）**：记录层 SQLite 内若承接 `sre_audit_events`/`sre_decision_records`，哈希链 / 只读校验以 app 见证层实现（本期先落在记录层 incident 表 + 触发器护栏，完整方案随 #Issue 后续落）。本文件 #372 范围表护栏即上表触发器。

## 7. 应用侧读路径与 SQL 适配

代码（`src/query/`）读路径经 `IncidentReader` 接口 + **进程内 SQLite repository**（以 `better-sqlite3`/内嵌驱动，同步读、WAL 并发）——与 app 「自包含单实例、无外部 DB 运维」运作一致（DESIGN §7.1b / DEPLOY）。
查询端点谓词（DESIGN §12.2b）：
- 列表 `GET /api/sre/incidents`：`WHERE system_id = :sid [AND lifecycle/severity/source/status/ack_status = :v] [AND created_at BETWEEN :s AND :e] [AND q LIKE …] ORDER BY lifecycle_updated_at … LIMIT/OFFSET(游标)`。
- 详情 `GET /api/sre/incidents/{id}`：主行按 `id` 取；`scope=trace` 由 `sre_incident_state_transitions WHERE incident_id = :id ORDER BY occurred_at` 组时间线；`scope=audit` 关联 transitions/动作审计概要（PII 掩码投影不变）。

> 与 v0.4.0 PG 语义等价要求：凡 SQLite repository 实现之谓词需产出与上表索引一致的过滤/排序结果；无外部 DSN 注入（单文件路径由 app 配置卷注入）。
