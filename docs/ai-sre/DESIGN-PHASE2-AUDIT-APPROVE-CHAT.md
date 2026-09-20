# AI-SRE Phase 2 — 审计 / 审批 / 鉴权对话 架构设计

| 项目 | 内容 |
|------|------|
| 文档编号 | DESIGN-PHASE2-AUDIT-APPROVE-CHAT |
| 版本 | v0.1.0 |
| 作者 | ARCH（架构 Agent） |
| 日期 | 2026-09-20 |
| 状态 | Draft（待 DEV / DEVOPS / CHECKER 评审） |
| 上游需求 | SPEC-PHASE2-AUDIT-APPROVE-CHAT v0.1（F-AUDIT / F-APPROVE / F-CHAT） |
| 关联 | DESIGN-AI-SRE v0.5.0（Phase 1 分层：adapters / lifecycle / incidents / intake / query） |

---

## 1. 总体架构

Phase 2 不新增独立服务，而是**在 Phase 1 既有分层内插入三个横切模块**，并对 `adapters` 层做「强制拦截点」加固。

```
                    ┌──────────────────────────────────────────────┐
   F-CHAT 新入口 →   │  Chat Gateway (authn/authz/session/ratelimit) │  ← 新模块 B
                    └───────────────┬──────────────────────────────┘
                                    │ (user identity, session_id)
   intake / 定时任务 ───────────────┤
                                    ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  lifecycle 引擎：check → approve → execute → verify            │
   │     │ 每个阶段发审计事件                                          │
   │     ▼                                                            │
   │  Policy Gate（新模块 A：F-APPROVE 判定，fail-closed）            │
   │     │ 命中白名单 → 放行                                           │
   │     │ 未命中     → 挂起 + 创建 approval_request                   │
   │     ▼                                                            │
   │  adapters 层（工具/系统调用）── 强制拦截点：写前判定 + 写后审计     │
   └───────┬───────────────────────────────┬─────────────────────────┘
           │ 审计事件（异步）                │ 查询（RBAC）
           ▼                                ▼
   ┌───────────────────┐          ┌──────────────────────────┐
   │ Audit Writer →    │ 读投影→   │ query 层（既有）：        │
   │ audit_log 哈希链  │──────────│ 审计/审批/会话 查询 API   │
   │ (append-only/WORM)│          └──────────────────────────┘
   └───────────────────┘
           ▲ incidents：audit/approval 均带 incident_id 外键
```

**接入点**

| 层 | 接入方式 |
|----|----------|
| adapters | 每个 adapter 调用前经 Policy Gate 做白名单判定；调用后（成功/失败）向 Audit Writer 发事件。**唯一强制拦截点**，不可绕过。 |
| lifecycle | 在 `check` 与 `execute` 之间插入 `approve` 子阶段；状态流转发审计事件，与审批状态机对齐。 |
| incidents | `audit_log.incident_id` / `approval_request.incident_id` 外键关联，复盘时可串起全链路。 |
| intake | 入口生成 `trace_context(who/why/incident_id)`，透传至审计与审批。 |
| query | F-AUDIT/审批/会话查询复用 query 层，新增只读查询处理器并加 RBAC 过滤。 |
| Chat Gateway | 新入口，触发的操作统一走 adapters → F-APPROVE → F-AUDIT 主链路，不直连工具。 |

**新模块**：A=Policy & Approval Engine；B=Chat Gateway（Authn/Authz/Session/Guard）；C=Audit Writer + 哈希链存储。三者均为进程内模块，复用 Phase 1 服务边界。

---

## 2. 数据模型

> 终端沿用 Phase 1 选型 D（嵌入式 SQLite，DB-SCHEMA 契约）；下述为逻辑模型。

### 2.1 `audit_log`（append-only）
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUIDv7（时间有序） |
| `seq` | INTEGER | 全局单调递增序号（哈希链锚点） |
| `who_type` / `who_id` | TEXT | agent / user / system + 身份标识 |
| `when` | TIMESTAMP(UTC) | 事件时间 |
| `action_type` | TEXT | 操作类型枚举（如 restart/scale/whitelist.update/chat.message） |
| `target_resource` | TEXT | 目标资源标识 |
| `params_digest` | TEXT | 入参摘要（脱敏，禁全量明文） |
| `why_source` | TEXT | 触发来源（intake/chat/schedule/alert） |
| `incident_id` / `session_id` | TEXT NULL | 关联外键（F-AUDIT-004） |
| `approval_id` | TEXT NULL | 关联审批单 |
| `result` | TEXT | success / failed / denied / pending |
| `reason` | TEXT | 失败/拒绝原因（非空约束见 FR-005） |
| `prev_hash` / `hash` | TEXT | 哈希链（见 §3） |

索引：`(when)`、`(who_id, when)`、`(action_type, when)`、`(result)`、`(incident_id)`、`(session_id)`。**无 UPDATE/DELETE 接口**。

### 2.2 `whitelist_version`（版本化白名单）
| 字段 | 说明 |
|------|------|
| `version` | 版本号（自增，不可变快照） |
| `entries_json` | 该版本完整条目集（快照） |
| `created_by` / `created_at` | 创建者/时间 |
| `approval_id` | 使其生效的审批单 |
| `diff_from_prev` | 相对前一版本 diff |

`whitelist_entry` 条目：`action_type / resource_scope / condition(env 限定) / effective_from / effective_to`。**运行时只读当前生效版本**，变更走 §4 审批。

### 2.3 `approval_request`（事件流）
| 字段 | 说明 |
|------|------|
| `approval_id` PK | |
| `type` | operation / whitelist_change |
| `summary` / `target_resource` / `risk_note` | 操作摘要/资源/风险（FR-APPROVE-003） |
| `initiator_agent` | 发起 agent |
| `incident_id` / `session_id` | 关联上下文 |
| `required_roles` | 需审角色（含高风险二次复核标记） |
| `state` | 当前状态（见 §4） |
| `ttl_expire_at` | 超时时刻（默认 +30min） |
| `payload_ref` | 待执行操作载荷引用 |

`approval_event`（不可变）：`approval_id / from_state / to_state / actor / actor_role / reason / at`——审批单为事件流，状态变更追加记录。

### 2.4 `chat_session`
| 字段 | 说明 |
|------|------|
| `session_id` PK | |
| `user_id` / `roles` | 身份与 RBAC 角色 |
| `issuer` / `sub` | OIDC 来源 |
| `created_at` / `last_active_at` / `idle_expire_at` | 会话生命周期（默认 30min 空闲超时） |
| `state` | active / expired / revoked |
| `client_fingerprint` | IP/UA 摘要（限流与异常检测） |

`chat_message`：`msg_id / session_id / role(user|assistant) / content_digest / injected_flag / created_at`——消息与触发的操作绑定 `session_id + user`（FR-CHAT-006）。

---

## 3. 审计日志 append-only 实现

**存储选型**：沿用 Phase 1 选型 D —— **嵌入式 SQLite**（单文件、WAL 模式），追加语义 + 应用层封禁。写入路径：`app buffer（有界队列）→ 异步批量落盘`，主操作不被阻塞（< 100ms，FR 非功能）。

**防篡改（双机制）**
1. **哈希链**：每条记录 `hash = H(seq ‖ prev_hash ‖ canonical(payload))`；`seq` 全局单调。定期将链头 `(seq, hash)` 锚定到外部只读位置（如 git 提交 / append-only 对象存储 / 发布到 Issue 评论），形成不可回改的见证点。
2. **WORM 语义**：应用层无 UPDATE/DELETE；DB 层通过触发器/只读账号强制拒绝改删；校验任务可离线重算全链，任一记录被篡改即报告断链位置（AC-AUDIT-002）。

**查询**：query 层只读投影 + 上述索引；支持 `who / when 范围 / action_type / result` 过滤分页，时间有界查询目标 < 2s（AC-AUDIT-003）。查询行为本身**写一条 audit_meta 事件**（谁查询了审计）。

**保留**：默认 ≥ 180 天，按合规策略可配置；分区/归档不破坏哈希链完整性。

---

## 4. 审批工作流状态机

```
        ┌───────────┐  命中白名单 → 直接 EXECUTE（记审计，不建单）
        │  CHECK    │────────────────────────────────────────┐
        └─────┬─────┘                                        │
              │ 未命中 / 白名单变更                             ▼
              ▼                                          ┌─────────┐
        ┌───────────┐   SRE 初审批准   ┌──────────────┐   │ EXECUTE │
        │ SUBMITTED │─────────────────▶│ PENDING_2ND  │──▶│(执行+回写)│
        │(待初审)   │                  │(高风险二次)  │   └────┬────┘
        └─────┬─────┘  低风险→ 直接   └──────┬───────┘        │
              │        跳转 APPROVED          │ 复核批准      ▼
              │  退回补充 → DRAFT             ▼            ┌─────────┐
              │  (可重提)              ┌────────────┐      │DONE/FAIL│
              └── 超时 / 拒绝 ────────▶│  REJECTED  │      └─────────┘
                                      │ (终态)     │
                                      └────────────┘
   任意活动态 ── TTL(默认30min) 到期 ──▶ EXPIRED(=拒绝语义, 记审计)
```

**状态集**：`DRAFT → SUBMITTED → PENDING_2ND → APPROVED → EXECUTE → DONE | FAILED`；旁路终态 `REJECTED / EXPIRED`。

**角色与步骤**（FR-APPROVE-004/005）
1. 发起：agent 自动建单（SUBMITTED）。
2. 初审：**值班 SRE** 批准 / 拒绝 / 退回补充。
3. 复核：**高风险操作强制**，由**平台负责人/安全负责人**二次确认（PENDING_2ND）。
4. 执行：批准后由发起 agent/指定执行者执行，结果回写审批单。
5. 超时：TTL 到期 → EXPIRED（记 `result=denied`）。
6. 白名单变更：单独审批类型，须**至少一名平台负责人**批准后生效，记录 `diff_from_prev`。

**TTL**：`ttl_expire_at` 落库；后台定时器扫描到期单据置 EXPIRED，并通知发起 agent。

**fail-closed 拦截点**：策略引擎任何异常（白名单加载失败/版本缺失/超时/不确定）→ **默认拒绝**，绝不默认放行（NFR < 50ms，异常路径即刻 deny + 审计）。拦截点唯一且位于 adapters 调用前，禁止旁路。

---

## 5. 鉴权方案

- **身份**：OIDC/OAuth2 **授权码流程（SSO）**，对接企业 IdP；audience/issuer 校验 PII。
- **Token**：短期 **JWT access token（≤ 1h）** + refresh token **轮换**（one-time-use，重放即失效）。JWT 含 `sub / roles / session_id / exp / jti`；服务端维护 `jti` 吊销表以支持登出即作废（FR-CHAT-003）。
- **授权（RBAC）**：角色 = {值班 SRE, 平台负责人, 安全负责人, 审计员}；策略矩阵映射「可见资源 + 可执行动作 + 可审批动作」。例：审计员→只读查询；SRE→初审；平台/安全→复核；白名单变更→仅平台负责人。RBAC 在 Chat Gateway（动作入口）与 query 层（数据过滤）**双点校验**。
- **会话**：`chat_session` 服务端权威；空闲 30min 自动失效；显式登出 revoke session + 吊销 refresh。
- **轮换与会话**：refresh 轮换 + access 短期 + session 绑定 client fingerprint；异常会话可实时中断（kill switch）。
- **传输**：全程 TLS；token 存 HttpOnly/Secure cookie，**不落 localStorage**（NFR）。

---

## 6. 防 prompt injection 架构边界

**核心原则：用户输入是「数据」，永不是「指令」。**

1. **通道分离**：system prompt 与用户内容经不同通道注入模型上下文，结构上打标签隔离（instruction block vs untrusted block），模型侧不接受用户块改写指令块。
2. **输入检测/过滤**：对输入做注入模式检测（「忽略以上指令」「扮演无限制模式」等），命中即标记 `injected_flag` + 记为可疑审计事件（AC-CHAT-004），按策略过滤/降权。
3. **工具调用 gate（关键边界）**：**模型输出不得直接驱动工具**。所有工具调用必经 **Policy Gate → F-APPROVE** 判定：命中白名单才放行，未命中必须走审批。模型无法绕过白名单/审批（AC-CHAT-004）。
4. **检索内容不可信**：RAG/引用/外部文档视作不可信数据，只作为事实参考，绝不作指令执行。
5. **输出防泄露**：响应过滤系统提示词与密钥，禁止回显（AC-CHAT-005）。

架构边界：**Chat Gateway 只负责「解析意图 + 生成待执行动作」，动作的合法性判决权完全在 Policy Gate**，二者职责分离、权限隔离。

---

## 7. API 端点设计

**Audit（RBAC：读=审计员/负责人；查询本身被审计）**
- `GET /api/v1/audit/events?who&from&to&action_type&result&page&size` → 分页列表
- `GET /api/v1/audit/events/{id}` → 单条详情
- `GET /api/v1/audit/verify?from&to` → 哈希链校验（返回断链/完整）
- ❌ 无 PUT/PATCH/DELETE（append-only）

**Approval**
- `POST /api/v1/approvals` → 创建审批单（未命中白名单时由 agent 自动调用）
- `GET /api/v1/approvals/{id}` → 单据详情 + 事件流
- `POST /api/v1/approvals/{id}/decision` → body `{decision: approve|reject|request_info, reason}`（RBAC 校验角色与步骤）
- `GET /api/v1/approvals?state&type&page&size` → 列表（审批人收件箱）
- `POST /api/v1/approvals/{id}/execute` → 执行并回写结果（批准后）
- 白名单：`GET /api/v1/whitelist/versions`、`GET /api/v1/whitelist/versions/{v}`（只读）；变更经 `POST /api/v1/approvals`（type=whitelist_change）

**Chat**
- `POST /api/v1/chat/sessions` → 需有效 JWT，建立会话返回 `session_id`
- `POST /api/v1/chat/sessions/{id}/messages` → 发送消息（SSE 流式响应，首字节 < 2s）
- `POST /api/v1/chat/sessions/{id}/logout` → 登出，revoke token
- `GET /api/v1/chat/sessions/{id}` → 会话状态
- 鉴权失败统一 **HTTP 401**（< 300ms，AC-CHAT-001）

---

## 8. 安全与性能要点 / Out of Scope

**安全**
- 唯一强制拦截点在 adapters 层，不可绕过；策略引擎 fail-closed。
- 审计写入异步（有界队列 + 本地缓冲），主链路 < 100ms；保留 ≥ 180 天。
- 限流按用户/IP；CSRF 防护（cookie 模式）；CSP 与输出过滤防泄露。
- 最小权限：白名单运行时只读；审批单不可变事件流；哈希链对外锚定。

**性能**
- 白名单判定 < 50ms（内存缓存当前版本 + 版本变更事件热更新）。
- 审批创建→通知审批人 < 5s（异步通知）。
- 审计查询时间有界 < 2s（索引 + 分区）。
- Chat 首字节 < 2s，鉴权失败 < 300ms。

**Out of Scope**（承 SPEC §6）
- 模型微调/提示工程优化（仅做注入防护）；Phase 1 监控链路改造；多租户计费/开放注册；多级复杂审批编排（本阶段仅两层 + 超时拒绝）；审计跨区域容灾与备份。

---

## 附：需求覆盖索引

| 需求 | 落位 |
|------|------|
| F-AUDIT-001~005 | §2.1 / §3 / §7 |
| F-APPROVE-001~006 | §1 / §2.2 / §2.3 / §4 / §7 |
| F-CHAT-001~006 | §2.4 / §5 / §6 / §7 |
