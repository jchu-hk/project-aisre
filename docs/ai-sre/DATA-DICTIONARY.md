# AI SRE — 数据字典（Data Dictionary）

> 覆盖 AI SRE 服务（`apps/ai-sre-service`）**嵌入式 SQLite 记录层**（`sre_*` 表，见 `DB-SCHEMA.md`）的字段语义。
> 与 `docs/ai-sre/DB-SCHEMA.md` 配套；字段级真值源见 `apps/ai-sre-service/db/sqlite/init.sql`。
> v0.5.0 起：记录层由 PostgreSQL 改为**嵌入式 SQLite**（#372 定案 D），类型表达随之更新：
> ENUM → `TEXT`+`CHECK`、`TIMESTAMPTZ` → `TEXT ISO-8601(UTC)`、`JSONB` → `TEXT`(JSON 校验)、UUID → `TEXT`；**字段语义不变**。
> 本文档聚焦 #372（lifecycle 可观测）语义，亦为 `sre_*` 全字段的中央术语表。
> 免责：SAS 业务库用词（school-admin，PostgreSQL）不在本文档。

## 领域术语

| 术语 | 含义 |
|------|------|
| **Incident** | AI SRE 统一承载的「异常/报障」真相源条目（检测 detected + 用户报障 intake 两条输入源同表，`source` 区分）。 |
| **source** | incident 来源：`detected`（监控采集 Detector 检测）或 `intake`（用户报障归一化，F-SRE-014）。 |
| **lifecycle** | **对外权威生命周期**——受控显式状态机（§12.6b）：`reported→triage→accepted_in_progress→investigating→closed`，外加 triage dup/known 并入分支与 closed→显式 reopen 唯一出路。**对外列表/详情/轨迹下钻一律以 lifecycle 为权威。** |
| **状态四轴** | `status`(processing 处置轴)、`triage`(三分类轴)、`ack_status`(回执闭环轴)、`lifecycle`(生命周期轴)。四者正交、非双源漂移；权威投影规则见 DB-SCHEMA §3。 |
| **state_transitions** | lifecycle 迁移历史事件（append 型，存 `sre_incident_state_transitions`）；`scope=trace` 直接用它对单条 incident 下钻时间线（每跳 时间/触发者/依据/旧新 state）。 |
| **query_audit** | 查询审计（append-only，存 `sre_incident_query_audit`）；记录「谁通过哪一端点/什么维度查过哪些 incident」，对齐 §12.2 事后可查。 |
| **Issue** | GitHub Issue，业务唯一真相源；`issue_id` 关联 incident。Issue closed→lifecycle closed（显式），Issue reopen→显式 reopen 带原因。 |
| **reporter_contact_ref** | 报障者回执联系信息，**脱敏引用/掩码**存储（§5.8）；回执后用，关单后 N 天清除；绝不以明文落通用列/进入详情投影。 |
| **dup/known/new** | F-SRE-014 三分类：重复并入 / 已知根因并入 / 新建。dup/known 不入 investigating（lifecycle→closed@triage 并入）；new→accepted→investigating。 |

## 字段字典（schema_version，v0.5.0 运行时迁移）

| 字段 | 字典 |
|------|------|
| `version` | 语义版本号（`0.5.0`…），app 启动幂等迁移读它判断补迁移。 |
| `applied_at` | 该版本应用时刻（ISO-8601 UTC）。 |
| `note` | 迁移说明（如 `pg_to_sqlite_#372_D`）。 |

## 字段字典（sre_incidents）

类型表达（SQLite）：`id TEXT(UUID)`；枚举列 `TEXT`+`CHECK(…IN …)`；`_at` 时间 `TEXT ISO-8601(UTC)`；JSON 列（root_cause_hypotheses/raw_payload…）`TEXT` + `json_valid` 校验。语义如下：

| 字段 | 类型 | 语义 / 字典 |
|------|------|------|
| `id` | TEXT(UUID) | 事件主键（app 生成 uuid v4）。 |
| `system_id` | TEXT | **per-system 隔离命名空间**（SIEM 标识串；v0.5.0 SQLite 记录层无独立 sre_systems FK 表时存系统标识字符串）。 |
| `issue_id` | INTEGER | 关联 GitHub Issue（唯一真相源）。 |
| `source` | TEXT CHECK('detected','intake') | 来源：检测 / 报障。 |
| `severity` | TEXT CHECK(P0..P3) | 检测定级 P0-P3。 |
| `status` | TEXT CHECK(detected..suppressed) | processing 处置轴。 |
| `triage` | TEXT NULL CHECK(dup,known,new) | 报障三分类（一次性判定；非 intake NULL）。 |
| `ack_status` | TEXT NULL CHECK(received..closed) | intake 回执闭环轴。 |
| `lifecycle` | TEXT NOT NULL CHECK(reported..closed) DEFAULT 'reported' | 见上「lifecycle」。默认 `reported`；对外权威。 |
| `lifecycle_updated_at` | TEXT(ISO-8601 UTC) | 最近一次合法 lifecycle 迁移时刻；对外 detail 的 `updated_at` 语义锚（time-range/排序）。 |
| `lifecycle_reopen_reason` | TEXT NULL | 仅当 recent 迁移是 `closed`→显式 reopen 时填充（§12.6b 唯一出路）；非 reopen 恒 NULL。 |
| `affected_component` | TEXT | 受影响组件/容器/服务。 |
| `anomaly_type` | TEXT | 异常/报障类型标签（service_down/disk_high/db_error/cache_error/functional/manual 等）。 |
| `reported_severity` | TEXT | 报障者初步影响/严重度估计（intake）。 |
| `symptom_desc` | TEXT | 报障现象描述（intake；列表投影恒不含全文）。 |
| `root_cause_hypotheses` | TEXT(JSON) | 根因假设数组（含置信度，排查后填充）。 |
| `dedup_fingerprint` | TEXT | 去重指纹 hash（含 system_id；intake 去重复用于三分类）。 |
| `reporter_contact_ref` | TEXT | 报障者回执联系引用（脱敏/掩码；NULL=检测来源）。 |
| `source_channel` | TEXT | intake 通道 webform/im/email/webhook/… |
| `raw_payload` | TEXT NULL(JSON) | 原始报文（可选，仅取证保留；按最小留存自动清理）。 |
| `received_at`/`detected_at`/`resolved_at` | TEXT(ISO-8601 UTC) | 报障/检测/解决时点。 |
| `created_at` | TEXT(ISO-8601 UTC) | 入库时间。 |

## 字段字典（sre_incident_state_transitions）—— 生命周期迁移历史（#372）

| 字段 | 语义 |
|------|------|
| `incident_id` | 归属 incident（FK→sre_incidents(id)）。 |
| `system_id` | per-system 隔离命名空间（独立归档/隔离查询）。 |
| `issue_id` | 关联 GitHub Issue（若有）。 |
| `prev_state` / `new_state` | lifecycle 迁移 旧→新（CHECK：reported/triage/accepted_in_progress/investigating/closed）。same（closed→closed）被迁移校验拒绝，不落库。 |
| `trigger` | 触发分类（intake_normalize/intake_received/detector/triage_new/triage_merge/triage_known_issue/investigation_start/investigation_pause/fix_verify/manual_close/suppressed/explicit_reopen/issue_state_sync）。 |
| `actor_type` / `actor_id` | 触发者类型与标识（ai_sre/detector/triage/intake_channel/human；如 `ai-sre-service`）。 |
| `reason` | 依据/原因（自由文本；reopen 必填）。 |
| `reopen_reason` | 冗余：若为显式 reopen 则非空（便利按 reopen 聚合/审计）。 |
| `trace_id` | 端到端因果追踪 id（跨 incident/Issue/audit 链 §12.8）。 |
| `policy_version` | 触发该迁移所据的策略版本（§12.4 重放契约）。 |
| `occurred_at` | 迁移发生时刻（timeline 排序键；SQLite 下配合 `(incident_id,occurred_at)`/`(system_id,occurred_at)` 复合索引查询）。 |

## 字段字典（sre_incident_query_audit）—— 查询审计（#372）

| 字段 | 语义 |
|------|------|
| `system_id_requested` | 查询主体请求的系统命名空间；经解析可为「所辖某 system」或空串表示跨所辖全系统。 |
| `endpoint` / `method` | 被查询端点与 HTTP 动词（如 `GET /api/sre/incidents`）。 |
| `actor_id` | 查询主体标识（`query-console` 或网关注入账号）。 |
| `scope` | detail 端点下钻范围 `full/trace/audit`；list 端点为空 NULL。 |
| `filters` | 列表过滤白名单条件快照（status/lifecycle/severity/source/system_id/time/issue_id/q 等），存 JSON(TEXT)。 |
| `cursor` | 分页游标（原样，不记录联系字段，见白名单）。 |
| `matched_ids` | 本次返回的 incident_id 数组快照（受 limit 截断，仅对账用，非逐项全文）。 |
| `requested_at` | 查询发起时刻。 |

> 实现注（#372 进程内参照 ledger 改版）：SQLite repository 把「命中集」存于 `sre_incident_query_audit.matched_ids`(JSON TEXT)，
> 供 `queryAuditForIncident(id)` 反查某 incident 被谁查过；谓词同源，两处等价。

## PII / 掩码 / 投影白名单（read-side）

- **列表投影（list item，§12.2b）恒不含**：`symptom_desc` 全文、`raw_payload`、`reporter_contact_ref` 原始值。返回：`id, system_name, lifecycle, severity, triage, source, affected_component, ack_status, issue_url, created_at, updated_at(lifecycle_updated_at)` 等精简字段 + 掩码联系（详情返 `reporter_contact_ref` 掩码）。
- **详情 `scope=full`**：追加内部字段但对 **PII 一律掩码/不回原始**：`reporter_contact_ref` 以掩码形态；`raw_payload` 不回。
- **`scope=audit`**：返回关联 `sre_incident_state_transitions`（trace 视角）或动作审计概要；仅含 decision basis *概要* 而非逐 token 全文（§12.4b）。
- 联系字段掩码函数见 `src/incidents/reporter-contact.ts`。
