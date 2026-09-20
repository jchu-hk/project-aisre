# AI SRE 运维 Agent — 技术架构设计（通用可插拔版）

| 项目 | 内容 |
|------|------|
| 文档编号 | DESIGN-AI-SRE |
| 版本 | v0.5.0 |
| 日期 | 2026-09-09 |
| 关联 Issue | GitHub Issue #370 / #371 / #372 / #373（#372 记录层选型已定案 D：PG→嵌入式 SQLite） |
| 上游需求 | FUNCTIONAL-SPEC-AI-SRE v0.5.0（透明性模块 F-SRE-015/016、NFR-T，已通过 REQ 自评升级为一等需求） |
| 作者 | ARCH（架构 Agent） |
| 状态 | Draft（待 DEV/DEVOPS/CHECKER 评审） |

---

## Changelog

| 版本 | 日期 | 变更说明 |
|------|------|----------|
| v0.5.0 | 2026-09-09 | 按 #372 定案 D 与用户 2026-09-09 确认的新设计方向增补：🆕 新增 §2.6 **分层架构总览**——将既有执行引擎明确为 **Layer1**（ai-sre-service + 记录层 SQLite + 记忆层 agent memory + 真相源 Issue 系统可选集成），并新增 **Layer2 沟通层**（agent，多通道多租户，接客户 微信/Slack/Teams/飞书，接 Layer1 升级/回执，接客户侧真相源回填）；🔁 §7.1/7.2 **记录层选型 PostgreSQL→嵌入式 SQLite（#372 定案 D）**，终端用 DB-SCHEMA(SQLite) 契约，保留查询端点（列表/详情 §12.2b）、lifecycle 权威投影不变；🆕 新增 §2.7 **配置双层架构**——第 1 层产品默认 `md playbook`（7 模块：PLAYBOOK/patrol/detection/triage/healing/reporting/analysis/communication），第 2 层部署者初设 `yaml`（systems/channels/routing/policy）；🆕 新增 §2.8 **动态能力配置机制**——md playbook 热加载（agent 工作前读最新 + watch reload + git 版本化回滚），安全红线（白名单外不自愈 / 冷启动不自愈 / 旁路不侵入 / 最小权限）**锁代码层不可配置绕过**；增补 §7.1b/§12.2b/§12.4b/§12.6b/§12.7b 记录层 SQLite 批注与 DB-SCHEMA/DATA-DICTIONARY 引用、ADR-013/014，更新 §10 NFR 与 §11 风险行。未改业务代码（DEV 职责）；未改 FUNCTIONAL-SPEC（REQ 职责）。 |
| v0.4.0 | 2026-09-06 | 新增「透明性与可观测性」设计章节（对应 FUNCTIONAL-SPEC v0.5.0 的 F-SRE-015/016、NFR-T、AC-015/016、UC-SRE-017/018 与「待 ARCH 细化」清单 T-ARCH-1..7）：落地 (1) T-ARCH-1 审计存储 schema——新增 append-only/WORM 专用取证审计表 `sre_audit_events`（含 mandatory 字段、哈希链防篡改、PII 掩码落地、per-system 隔离与索引），并与既有 `audit_logs` 复用/映射；(2) T-ARCH-2 incident 查询/列表 API 契约（restful 路由、分页/过滤白名单、鉴权隔离）；(3) T-ARCH-3 实时「正在做什么」暴露机制（短轮询 + SSE 事件流、时效上限量化）；(4) T-ARCH-4 运维控制台 UI 架构（组件划分、仅消费数据不承载决策、接入 #372/#373、权限模型）；(5) T-ARCH-5 决策依据/可解释分层（结构化 decision record + 输入快照/策略/基线引用 + 摘要式 rationale，支持重放）；(6) T-ARCH-6 incident 生命周期状态机显式建模（新增 `sre_incident_lifecycle_enum`、合法迁移表、与既有 Issue/status 状态映射、禁『关闭态静默复活』）；(7) T-ARCH-7 日志回收 vs 取证保留边界（分区与审计保留锁，不因回收丢失取证）；另补 §10 NFR 映射 NFR-O/T 行、§12.8 需求覆盖索引、ADR-009..012 与风险行。未改业务代码，未改 FUNCTIONAL-SPEC（REQ 职责）。 |
| v0.3.0 | 2026-09-05 | 按 #371 变更同步：(1) 新增**用户报障 intake 通道**——Intake 适配器/通道作为第二条输入源（与监控采集并列）、归一化→三分类 triage→关联/创建 Issue→触发排查/转 DEV→回执闭环，落地组件层 §2.5/§3.11、配置层 §2.4（`intake_channels`）、数据层 §7.2（`sre_incidents` 扩展字段 + `audit_logs` 枚举）、架构图 §8（含 NFR-S 报障回执最小权限例外约束）；(2) 显式澄清**功能正确性边界**：监控采集/检测范围=可用性/可靠性，功能正确性不自动检测、仅当泄露可观测信号时顺带检出，静默 bug 由 QA 功能测试 + F-SRE-014 用户报障兜底（§1/§3.4/§11）；并按 CHECKER 复审整改（Mermaid 边标签括号 + intake 激活态通道澄清） |
| v0.2.0 | 2026-09-05 | 架构重构：由「SAS 定制版」升级为「通用可部署、可学习、可支持新系统的 AI SRE」。核心变化：(1) 交付形态改为自包含容器镜像 + compose/helm 编排清单 + 一键接入脚本，配置与代码分离，镜像/代码零 SAS 硬编码（F-SRE-010）；(2) 新增 **System Adapter Layer** 插件层（接口抽象 + 可插拔 + 签名校验 + 热加载/回滚生命周期，F-SRE-011）；(3) 新增 **Learning Engine** 自学习引擎（冷启动→预热→已学习三态迁移，量化参数对齐 AC-012，F-SRE-012）；(4) 新增 **Multi-System Registry** 多系统命名空间隔离（F-SRE-013）；(5) Collector/Detector/Localizer/Healing/Executors/Escalation/Audit 全部泛化为「被纳管系统」表述，SAS 端口/容器数/路径移入「附录：参考实例配置」。保留 C1-C6 已落位安全设计并泛化 |
| v0.1.0 | 2026-09-05 | 初稿：基于 FUNCTIONAL-SPEC-AI-SRE v0.2.0，SAS 定制版总体架构、组件分解、数据流、自愈安全边界、Agent 生态集成、持久化草案、架构图与 ADR |

---

## 1. 概述与设计目标

### 1.1 定位

AI SRE 是一个**通用、可部署、可学习、可支持新系统**的常驻旁路运维 Agent。它以自包含可部署单元交付，通过配置驱动与适配器插件模型接入任意被纳管系统，并对每个接入系统独立进行行为学习与基线建模，实现「接入即用、越用越准」，对低风险可回滚故障执行受限自愈、对超出边界或高风险的故障告警升级。

**School Admin System（SAS）是 AI SRE 的第一个参考部署实例（reference deployment），而非唯一目标系统**：SAS 仅以一份默认示例配置 profile 随发行附带，可删除/替换，不享有任何硬编码特权。本架构所有组件均以「被纳管系统」通用表述，SAS 的拓扑/端口/路径/组件构成全部经配置/适配器注入。

三大核心能力定位（承自需求 §1）：

1. **可部署（Deployable，F-SRE-010）**：自包含镜像 + 编排清单 + 一键接入脚本交付，任意空环境凭最小配置即可启动并进入「待接入」状态。
2. **可学习（Can Learn，F-SRE-012）**：对新系统从冷启动逐步学习基线指标与异常模式，检测阈值与自愈策略随系统行为动态调整。
3. **可支持新系统（Support New System，F-SRE-011/013）**：接入新系统不改核心代码，只加配置或适配器；单实例可同时纳管多个系统，租户强隔离。

核心设计原则（承自 NFR）：

1. **旁路不侵入**：监控采集对主链路零侵入（< 1% CPU 额外负载），自愈动作全部经门禁且可观测、可追溯。
2. **最小权限 + 白名单 + 签名**：自愈能力是「受限能力」而非「全能 root」，动作白名单带显式授权与签名校验，受全局 kill-switch 与每日上限约束。
3. **可回滚、幂等、可观测**：每个自愈动作幂等、执行前留快照、执行后可回滚，审计日志完整、按系统隔离。
4. **配置驱动、插件可插拔**：系统差异全部配置/适配器注入，核心代码与镜像无任何系统特定硬编码。
5. **复用优先**：在 SAS 参考实例中复用现有监控/事件/审计基础设施；通用交付形态不依赖任何单一系统既有栈。

### 1.2 需求覆盖索引（F-SRE-010~016 落位速览）

| 需求 | 架构落位 |
|------|----------|
| **F-SRE-010 可部署性** | §2.1 交付形态（镜像+compose/helm+bootstrap）；§2.2 配置与代码分离；§9 ADR-004 可移植部署选型 |
| **F-SRE-011 系统接入适配器** | §3.1 System Adapter Layer（接口抽象/插件生命周期/签名校验/热加载回滚）；§9 ADR-005 适配器插件模型选型 |
| **F-SRE-012 自学习** | §3.2 Learning Engine（三态迁移量化参数对齐 AC-012、迁移先验、投毒/漂移防护）；§7.4 学习状态/基线存储；§9 ADR-006 自学习引擎选型 |
| **F-SRE-013 多系统/多租户** | §3.3 Multi-System Registry（per-system namespace 隔离）；§5.6 横向越权/凭证泄露遏制；§7.2 per-system 表草案；§9 ADR-007 多租户隔离方案 |
| **F-SRE-014 用户报障接入（Intake）** | §2.4 `intake_channels` 最小配置；§2.5/§3.11 Intake 适配器/通道 + 归一化→triage（重复/已知/新建）→关联 Issue→触发排查/转 DEV→回执闭环；§7.2 `sre_incidents` 归一化字段 + `audit_logs` 扩展；§5.8 报障回执最小权限例外；§8 架构图双输入源标注；ADR-008（含 NFR-S 报障回执最小权限例外） |
| **F-SRE-015 动作审计与决策透明** | §3.10 Audit Logger + §12.1 审计存储 schema（`sre_audit_events` append-only/WORM + 哈希链 + PII 掩码）；§12.4 决策依据/可解释分层（structured rationale + 快照/策略/基线引用，支持 AC-015a 重放）；ADR-009（审计取证存储）；ADR-011（决策可解释分层） |
| **F-SRE-016 实时状态与生命周期可见性** | §12.2 incident 查询/列表 API（#372）；§12.3 实时 active 状态暴露机制（#373，轮询+SSE）；§12.6 lifecycle 状态机显式建模（`sre_incident_lifecycle_enum` + 迁移表 + 与 Issue/status 映射）；§12.5 控制台 UI 架构（#373）；ADR-010（实时状态传递）、ADR-012（生命周期状态机建模） |

> 功能正确性边界（F-SRE-014 补位动机，承 §2 检测边界）：AI SRE 的自动化检测范围 = **可用性/可靠性**，不覆盖功能正确性；功能缺陷仅当泄露可观测信号时顺带检出，静默 bug 由 QA 功能测试 + 用户报障（F-SRE-014）兜底。两输入源分工见 §2.5/§8。
>
> 既有 C1-C6 安全设计（白名单+签名、AC 可测、防抖、回滚一致性、Redis 数据损坏判据、升级去重/自身运维归属）全部保留并泛化，见 §5。

---

## 2. 总体架构

### 2.1 交付形态与运行时选型（F-SRE-010）

AI SRE 以**自包含可部署单元**交付，三者缺一不可：

| 交付物 | 说明 |
|--------|------|
| **容器镜像 `ai-sre`**（带版本 + 签名） | 核心运行时本体；**不含任何系统特定硬编码**（含 SAS），跨环境复用同一镜像 |
| **编排清单**（docker-compose / helm chart 任一或两者） | 声明 AI SRE 服务的运行拓扑、资源配额、存储卷、Secret 挂载 |
| **一键接入脚本**（bootstrap/onboard） | 空环境解包后执行即启动并进入「待接入」状态，含镜像签名校验、最小配置装载、自检与就绪上报 |

**运行时选型结论**（承自 v0.1.0 ADR-001，泛化）：

- **核心运行时 = 独立常驻服务 `ai-sre-service`**（容器进程，规则+策略引擎驱动，7x24 低延迟，不依赖 LLM 即可完成采集/检测/分级/受限自愈）。
- **协作层 = 复用现有 Agent 生态**（write_message.py / agent-status / GitHub label / Dashboard / PM 调度），AI SRE 注册为 Agent 角色。
- **深度推理 = 按需云端 LLM**（复杂根因定位、告警文案生成走 OpenClaw gateway 云端模型，符合 HYBRID-ARCHITECTURE「本地流程编排 + 云端深度推理」分层）。

### 2.2 配置与代码分离（F-SRE-010 / NFR-X）

- **运行所需的一切差异**（目标系统地址/端口/路径、凭据引用、阈值、策略、告警通道）均通过配置文件 / 环境变量 / Secret 注入。
- 核心代码与镜像**不含任何系统特定硬编码**；SAS 仅以一份默认示例配置 profile（`profiles/sas.yaml`）随发行附带，可删除/替换。
- **凭配置即运行**：空环境仅提供最小配置即可启动并进入「待接入」状态（最小配置集合见 §2.4）。
- 自愈策略、白名单、阈值等策略同样配置化，版本化存储（§7）。

### 2.3 与「被纳管系统」的拓扑关系（泛化）

```
                  ┌───────────────────────────────────────┐
                  │  输入源②：用户报障 Intake (F-SRE-014) │
                  │  Web 表单 / IM / 邮件 / 工单 webhook…  │
                  │  （通道可配置，通用命名）              │
                  └───────────────────┬───────────────────┘
                                      │ 报障报文（含报障者运营回执联系信息，
                                      │ NFR-S「报障回执最小权限例外」约束）
                                      ▼
                  ┌───────────────────────────────────────┐
                  │ Intake Collector → Broker            │
                  │ 归一化为结构化 incident              │
                  │ → triage：重复/已知/新建 → 关联/创建  │
                  │   GitHub Issue                       │
                  └───────────────────┬───────────────────┘
                                      │ 结构化 incident
                                      │
   ┌───────────────────────────────────▼───────────────────────────────────┐
   │                         AI SRE 独立服务 (ai-sre-service)               │
   │  输入源①监控采集(可用性/可靠性) → Detector/Classifier → Localizer      │
   │    → Learning → Healing Decision Engine → Executors/Incident &        │
   │      Escalation Manager → Audit                                       │
   │  输入源②Intake → 归一化/triage → 定向排查(可观测信号?) / 转 DEV         │
   │  策略引擎(白名单/签名/熔断) · 多系统 Registry · Dashboard 同步         │
   └──────┬────────────────────────────────┬───────────────────────────────┘
          │ 受限自愈(白名单内)             │ 升级 / 转 DEV / 回执             │
          ▼                                ▼                                
   ┌─────────────────┐                  ┌────────────────────────────────┐
   │ 目标系统服务     │                  │ 被纳管系统拓扑/监控数据源         │
   │ restart/清理等   │                  │ System Adapter Layer(每系统一    │
   └─────────────────┘                  │ Adapter) 采集健康/资源/日志(只读)│
                                        └────────────────────▲───────────┘
                                        (输入源①：监控采集，可用性/可靠性)  │
   ┌─────────────────┐                ┌──────────────────────────────────┐
   │ 用户/外部访问    │                │ 多 Agent 协作层 (write_message.py) │
   │ (Coze proxy)    │                │ PM / DEV / QA / DEVOPS / CHECKER   │
   │ :5001 gateway   │                │ / OPS / ARCH / REQ → + AI SRE      │
   └─────────────────┘                │ 静默/功能正确性报障→经 Issue 转 DEV；│
                                      │ 回执状态经 Issue/Dashboard 闭环      │
                                      └──────────────────────────────────┘
```

> **两输入源分工**：输入源①「监控采集」探测的是**可用性/可靠性**信号（健康/资源/错误率/日志 ERROR/心跳），是 AI SRE 的主检测通道；输入源②「用户报障 Intake」补位「功能不工作但系统健康运行」的盲区，二者均汇入 Incident/Escalation Manager 统一处置（对应 F-SRE-007 去重/抑制）。功能正确性本身不在监控采集自动检测范围——仅当功能缺陷泄露可观测信号时才被①顺带检出；静默 bug 由 QA 功能测试 + ②用户报障兜底（详见 §1.2 功能正确性边界）。

> 说明：SAS 参考实例中，Adapter 复用其既有 13 容器监控/事件基础设施（Prometheus/Kafka/PostgreSQL/Redis/OPA）作为数据源；但通用交付形态不强制要求目标系统存在这些组件——无适配器时降级为通用 HTTP 探测 + 日志源 + 资源指标最小接入（F-SRE-011 降级路径）。

### 2.4 最小配置集合（Minimal Config）

对齐 AC-010 定义，空环境启动进入「待接入」所需最小配置（不含任何 SAS 特定项）：

```yaml
# minimal config — 凭此即可启动进入「待接入」状态
identity:            # AI SRE 自身身份/监听端口
  instance_id: ai-sre-01
  listen: "0.0.0.0:9090"
secrets:             # 密钥管理引用（非明文）
  signing_key_ref: "vault://ai-sre/signing-key"
alert_channels:      # 告警通道地址
  - type: write_message
    endpoint: "skills/agent-communication/scripts/write_message.py"
intake_channels:     # 用户报障入口通道（F-SRE-014），可为空或缺失 = 不启用 intake
  # - type: webhook     # 通道类型：webhook / im / email / webform / 工单 webhook 等
  #   endpoint: "..."   # 通道端点/绑定（通用命名，不写死某套工单系统）
systems: []          # 被纳管系统接入配置（可为空 = 待接入态）
```

> **`intake_channels` 可为空仅表示「待接入 / 未启用 intake」的空态基线**：凡已纳管进入使用、或需验收 AC-014 与 UC-SRE-016 的配置，必须启用 ≥1 个 intake 通道（SAS reference profile 默认启用 1 个 webhook / webform 通道）。

### 2.5 组件清单

| 组件 | 职责 | 部署形态 | v0.1.0 → v0.2.0 |
|------|------|----------|------------------|
| **System Adapter Layer（系统接入适配器层）** | 组件发现与建模、健康/资源/日志采集接口抽象、插件生命周期管理 | 每系统一个 Adapter 实例，独立进程/沙箱 | 🆕 新增（F-SRE-011） |
| **Learning Engine（自学习引擎）** | 三态迁移、基线拟合、阈值收敛、异常模式学习、迁移先验、投毒/漂移防护 | ai-sre-service 内常驻 | 🆕 新增（F-SRE-012） |
| **Multi-System Registry（多系统注册/命名空间隔离）** | per-system 配置/凭证/策略/审计命名空间管理，横向越权遏制 | ai-sre-service 内常驻 | 🆕 新增（F-SRE-013） |
| **Intake Adapter / Channel（用户报障接入）** | 收纳用户侧报障（Web 表单/IM/邮件/工单 webhook 等），归一化为结构化 incident（含 NFR-S 报障回执最小权限例外约束），triage 重复/已知/新建，触发排查或转 DEV，回执受理→处理→关单状态 | 每 intake 通道一个收集点；triager 常驻内服务 | 🆕 新增（F-SRE-014） |
| **SRE Collector（监控采集）** | 周期采集健康/容器/DB/缓存/磁盘/日志/心跳指标（范围=可用性/可靠性） | 内常驻循环（数据源经 Adapter 抽象） | ♻️ 泛化 |
| **Detector + Classifier（检测/分级）** | 规则+基线检测异常，映射 P0-P3 并给分级理由 | 同上 | ♻️ 泛化 |
| **Localizer（根因定位）** | 产出受影响组件、最近变更关联、根因假设 | 规则定位（本地）+ 复杂场景云端 LLM | ♻️ 泛化 |
| **Healing Decision Engine（自愈决策）** | 白名单/签名/kill-switch/熔断/防抖/SVA 门禁裁决 | 策略引擎（可复用 OPA 或独立策略层） | ♻️ 泛化 |
| **Healing Executors（自愈执行器 ×5）** | restart 容器/清磁盘/回滚/释放资源/重启缓存，含执行后验证 | 独立执行器模块，dry-run 可测 | ♻️ 泛化 |
| **Escalation Manager（告警升级）** | 去重/抑制/聚合，路由 PM/DEVOPS/DEV/QA，创建/关联 Issue | 同上 | ♻️ 泛化 |
| **Audit Logger（审计日志）** | 不可变、按系统隔离的审计记录，CHECKER 质检数据源 | 写 PostgreSQL（per-system 分区） | ♻️ 泛化+隔离 |
| **SRE Dashboard 集成** | agent-status 同步 + 运行状态看板 | 复用 Multi-Agent Dashboard + Grafana | 保留 |
| **LLM Adapter（深度推理）** | 复杂根因定位/告警文案按需云端 | gateway 云端模型调用 | 保留 |
| **记录层 SQLite（🆕 v0.5.0）** | incident/lifecycle/查询审计记录层持久化，自包含单文件 | ai-sre-service 数据卷内 `sre.db`（嵌入式） | 🆕 变更：PG→SQLite（#372 定案 D，见 §7.1b/DB-SCHEMA） |
| **Layer2 沟通层 Agent（🆕 v0.5.0）** | 面向客户终端的对外沟通编排层：多通道多租户发布/回执/升级话术、接客户真相源回填 | 独立 Agent 角色，多通道适配器（微信/Slack/Teams/飞书） | 🆕 新增（§2.6） |

---

### 2.6 分层架构总览：Layer1 执行引擎 + Layer2 沟通层（🆕 v0.5.0）

> 为承接「客户侧多通道运营沟通」与「执行层 + 状态层」职责分离，本节把总体架构显式拆为**两个 Layer**（既有 §2.1~§2.5 属 Layer1，内容保留；新增 Layer2）。这是**分层视角的增补**，不推翻既有的组件/数据流/安全设计。

```
┌──────────────────────── Layer2 沟通层（new） ────────────────────────┐
│  沟通编排 Agent（多通道多租户）                                        │
│   - 通道适配器：Client 微信 / Slack / Teams / 飞书（Lark）…            │
│   - 职责：向客户终端发布升级/告警/回执；接收客户侧确认/补充；多租户隔离 │
│   - 对外话术（playbook communication 模块驱动）；不承载自愈决策          │
└───────────────┬───────────────────────────────┬──────────────────────┘
                │ 升级/回执/状态（Layer1 输出）      │ 客户侧 issue 状态回填（真相源）
                ▼                                ▼
┌──────────────────────── Layer1 执行引擎（既有 ai-sre-service）─┐
│   §2.5 组件（System Adapter / Collector / Detector / Learning /  │
│   Healing / Escalation / Audit / lifetime…）                     │
│   ├─ 记录层：嵌入式 SQLite（sre.db，§7.1b，DB-SCHEMA SQLite）     │
│   ├─ 记忆层：agent memory（§6 记忆注释；已学习基线/先验/偏好）     │
│   └─ 真相源：GitHub Issue（客户 issue 系统，可选集成，issue_id）   │
└─────────────────────────────────────────────────────┬───────────────┘
                                                      │ 采集/自愈（白名单，旁路）
                                                      ▼
                                      ┌────────────────────────────────┐
                                      │ 被纳管系统（SAS 等）💻 ……      │
                                      └────────────────────────────────┘
```

- **Layer1 = 执行引擎（已有 `ai-sre-service`）**：承载采集/检测/分级/自愈决策/升级/审计/生命周期。自包含可重复部署单元（镜像 + 编排 + bootstrap，§2.1）。
- **记录层 = 嵌入式 SQLite**（#372 定案 D，§7.1b）：incident/lifecycle 迁移/查询审计单文件持久化，零外部 DB 运维。
- **记忆层 = agent memory**（§6 既有 Agent 生态集成项）：已学习基线、迁移先验、跨轮次偏好经 agent 记忆复用辅助 Layer1 决策与 Layer2 措辞。
- **真相源 = 客户 issue 系统（GitHub Issue，可选集成）**：Issue 为业务唯一真相源；未接真实网关时 best-effort/memory sink（见 README / DEPLOY §10.1）。
- **Layer2 = 沟通层（🆕）**：位于 Layer1 之外的 **agent**，负责把 Layer1 的升级/回执/状态以客户终端形态发布（微信/Slack/Teams/飞书），并接收客户侧补充/确认回填真相源。**Layer2 是无状态沟通编排，不含自愈/决策**（决策仍全归 Layer1 策略引擎与门禁）。

**Layer1→Layer2 边界与安全**：Layer2 仅消费 Layer1 已裁决的**输出**（升级/告警/回执）& 返回客户侧补充——永远不注入可触发自愈的命令；多租户 = 每客户终端通道隔离，越权发送/旁路 Layer1 直接下指令被拒（对齐 §5/ADR-003 分层授权 + AC-016b 隔离）。

### 2.7 配置双层架构（🆕 v0.5.0）

> 配置分两层承载「What 能力怎么动」（第 1 层 playbook，产品默认）与「Where/Who 部署差异」（第 2 层 yaml，部署者初设），与 §2.2「配置与代码分离」配套细化，均 versioned（git/快照）。

**第 1 层：产品默认 `md playbook`（markdown 能力剧本，随发行附带、零系统硬编码）** —— 说明 agent「有哪些能力模块、每个模块怎么做」。包含**顶层 `PLAYBOOK/` 入口 + 7 个能力模块**（patrol/detection/triage/healing/reporting/analysis/communication）：

| 目录 | 模块 | 内容管什么 |
|------|------|-----------|
| `PLAYBOOK/`（顶层入口） | — | 读取入口 + 红线声明 + 模块心智模型（决定启用哪几模块、默认门槛） |
| `PLAYBOOK/patrol` | 能力① 巡检 patrol | 巡检驱动：采集范围/周期/目标系统如何纳入 Layer1 巡检 |
| `PLAYBOOK/detection` | 能力② 检测 detection | 检测/分级：异常判定规则、P0-P3 定级门槛与学习态门禁（冷启动只提示/不自愈） |
| `PLAYBOOK/triage` | 能力③ 三分类 triage | 报障三类：dup/known/new 判定流程与准入（并入/新建→Issue） |
| `PLAYBOOK/healing` | 能力④ 自愈 healing | 自愈决策：白名单、可回滚姿态、门禁与升级分叉 |
| `PLAYBOOK/reporting` | 能力⑤ 报告 reporting | 报告/回执：结构化 incident、状态更新、关单/回执到客户 |
| `PLAYBOOK/analysis` | 能力⑥ 分析 analysis | 事后/根因分析模板：决策依据、重放、复盘（对齐 §12.4 决策分层） |
| `PLAYBOOK/communication` | 能力⑦ 沟通 communication | **沟通层话术**：Layer2 面向客户的多通道措辞/通道/语气/红线声明 |

> 即「顶层 `PLAYBOOK/` + 7 个能力模块（patrol / detection / triage / healing / reporting / analysis / communication）合集为发行随附的 md playbook 能力包」，各模块均可被部署者 yaml 选配/收紧但不可追加红线外动作。

**第 2 层：部署者初设 `yaml`（可部署 profile，越大系统/客户部署集差异越小）** —— 声明部署侧差异，覆盖：

```yaml
# deploy profile（sas.yaml 等，随发行示例，可替换）
systems:    # 被纳管系统索引（名/凭据 ns/profile_ref）
channels:   # Layer2 激活通道与路由（微信/Slack/Teams/飞书）
routing:    # 谁能收什么升级（按角色/客户/issue）
policy:     # 引用 playbook 版本 + 白名单/门禁/上限覆盖（只缩不扩红线）
```

> **两层合成规则**：产品 playbook 定义默认能力（可配置动作的上限/默认值），部署者 yaml 只做「选区 + 覆盖收紧」，不得**绕过** playbook 的安全红线（§2.8）。两者分离使同发行二进制可支撑不同客户运营形态，且不改核心代码。

### 2.8 动态能力配置机制：md playbook 热加载（🆕 v0.5.0）

> 配置与代码分离（§2.2）+ 双层配置（§2.7）落地为**动态能力开关**：agent 能力随 `md playbook` 变更实时可调而不改代码/镜像。

**Playbook 供给与热加载**
- **读取时点**：commit（能力入口）每次**执行前读取最新 playbook**，与运行中各自能力模块路由——先读后动，能力变更随下个动作即时生效。
- **watch reload**：可选文件监听（md 变更 → 触发 reload 事件 + 日志 + 版本快照），降低「改了没生效」滞后；非关键路径，失败不阻断读最新。
- **git 版本化回滚**：playbook 目录纳入 git；每次动作记录 `playbook_version`（对齐 §12.4 policy_version 引用）；变更可 `git revert` 回滚且留审计链。
- **准入校验**：md 结构/schema 校验 + 引用模块存在性校验，加载失败保持上一稳定版本并告警（fail-closed 到「上一可用」而非空跑）。

> 记 `playbook_version` 的落库点与 §12.4 决策/§7 lifecycle 的 `policy_version` 一致，保证「哪个剧本驱动了这次判定/自愈/话术」可重放（AC-015a）。

**安全红线 —— 锁代码层不可配置绕过（冷启动红线不因 playbook 变宽）**：

| 红线（不可用 playbook/yaml 关掉或放宽） | 出处 |
|------------------------------------------|------|
| **白名单外不自愈**：自愈动作仅限动作白名单（§5.1 C1），能力剧本只能描述怎么做、不能新增白名单外动作类型到可自语线 | §5.1 / ADR-003 |
| **冷启动不自愈**：冷启动态仅提示/告警不自动自愈（§3.2.3），不因 playbook 覆盖而放开 | §3.2.3 / AC-012 |
| **旁路不侵入**：监控零侵入、自愈经门禁可观测（§§1/5），playbook 不能把采集/自愈切到侵入/无人门禁模式 | §1 |
| **最小权限**：最小权限 + 白名单 + 签名 + kill-switch（§5），playbook/yaml 只缩不扩权限面 | §5 / ADR-003/007 |

> 这些红线**在代码层强制**（module 边界 + 校验 + 拒绝加载越权语义），`md playbook` 仅是能力描述，无法把它们配置成绕过——与「配置不降权限面」的部署者 yaml 上限相叠加，保证动态能力灵活性不反噬安全边界。

---

## 3. 组件分解

### 3.1 System Adapter Layer（系统接入适配器层，F-SRE-011）

**新增组件**。负责对被纳管系统的组件发现与建模，将系统差异封装在插件层，使核心代码零系统硬编码。

#### 3.1.1 接口抽象

```
interface SystemAdapter {
  // 身份与能力声明
  systemId(): string;
  capabilities(): AdapterCapability[];          // 声明支持发现/采集的组件类别
  minPrivilege(): PermissionDeclaration[];      // 最小权限声明（供沙箱校验）

  // 组件发现与建模
  discover(ctx): ComponentModel[];              // 服务/容器/DB/缓存/日志源/健康端点/磁盘
  model(): SystemTopology;                       // 归一化拓扑（组件→指标映射）

  // 采集（只读）
  collectHealth(ctx): HealthSample[];            // 健康端点探测
  collectResources(ctx): ResourceSample[];       // CPU/内存/磁盘/容器状态
  collectLogs(ctx): LogEvent[];                  // 日志源 ERROR/FATAL/panic
  collectDb(ctx): DbSample[];                    // 只读 DB 连接/慢查询/连接池
  collectCache(ctx): CacheSample[];              // 缓存内存/命中率/连接
}
```

组件发现与建模产出类别（能力取决于加载的适配器）：服务/容器、数据库、缓存/键值存储、日志源、健康端点、磁盘/资源。

#### 3.1.2 插件生命周期与安全（F-SRE-011 / M1）

| 生命周期阶段 | 机制 |
|--------------|------|
| **注册** | 新增系统 = 一份配置 +（可选）一个 Adapter 插件，不改核心代码 |
| **签名校验** | Adapter 包带签名（HMAC/证书），加载前验签；验签失败拒绝加载 |
| **最小权限声明** | Adapter 声明所需权限，与沙箱策略比对，超出声明即拒绝 |
| **沙箱隔离** | Adapter 运行于独立进程/沙箱，与核心服务内存/网络隔离，故障不污染其他系统 |
| **热加载** | 支持运行中热加载新 Adapter（不中断已纳管系统） |
| **回滚** | Adapter 升级失败可回滚到上一签名版本；加载/校验失败时拒绝加载并保持既有能力可用 |
| **拒载保护** | 任一缺陷/恶意 Adapter 不得攻陷或污染 AI SRE 实例及其纳管的其它系统 |

#### 3.1.3 内置参考适配器与降级路径

- **Generic HTTP Adapter（内置）**：对未提供专用适配器的系统，经通用 HTTP 健康探测 + 日志源 + 资源指标的最小接入（F-SRE-011 降级）。
- **SAS Adapter（内置参考）**：封装 SAS 的 13 容器/PostgreSQL/Redis/多前端入口的具体发现与采集逻辑，作为「如何写一个专用 Adapter」的参考实现与首个参考实例的默认接入方式。
- **Docker Adapter（内置）**：通用 Docker daemon 发现/采集（容器状态/资源/事件流），可复用于任何 Docker 化系统。

> SAS 的具体端口/容器数/路径**只出现在 SAS Adapter 与 SAS profile 内**，不出现在核心代码/镜像。

### 3.2 Learning Engine（自学习引擎，F-SRE-012）

**新增组件**。对每个接入系统独立进行基线学习与异常模式建模，阈值与自愈策略随系统行为动态调整。

#### 3.2.1 学习三态状态机（每系统独立）

```
  ┌──────────────┐  首轮发现+监控建立完成   ┌──────────────┐  收敛判据满足   ┌──────────────┐
  │  Cold Start  │ ──────────────────────► │   Warm-up    │ ──────────────► │   Learned    │
  │  冷启动       │                          │   预热       │                  │  已学习      │
  └──────────────┘                          └──────────────┘                  └──────────────┘
   保守通用阈值                                拟合正常区间(时/日/周周期、       系统特定阈值+异常模式，
   异常判定偏「提示」                           负载范围、延迟分布)               误报率显著下降
   不自动自愈                                                                  自动自愈按学习后策略
```

**三态迁移量化参数（对齐 AC-012，默认值可配置）**：

| 迁移 | 判据 | 量化参数 |
|------|------|----------|
| 冷启动 → 预热 | 完成首轮组件发现与监控建立后进入预热，持续采集 ≥ N 个观测窗口，覆盖指标类别 ≥ M 类，且无连续异常空窗 | **N=7**（完整日窗口或等量小时窗口）；**M=4**（服务健康/资源/日志/缓存或数据库） |
| 预热 → 已学习 | 最近连续 K 个观测窗口内基线波动 < X%（按指标类型分别度量）或误报率 < Y%，且相邻窗口阈值变化 < Z% 视为收敛 | **K=14**；**X=20%**；**Y=5%**；**Z=5%** |
| 跨系统迁移先验 | 达「已学习」所需观测窗口数较无先验冷启动减少 ≥ 25%，或冷启动→已学习总时长缩短 ≥ 25% | 迁移先验标记来源，QA 以同构样本对照验证 |

#### 3.2.2 学习功能模块

- **基线拟合**：对每指标拟合正常区间（均值/方差/时-日-周周期、负载范围、延迟分布）。
- **阈值收敛**：检测阈值随基线演化自动更新（如流量增长后正常 CPU 区间上移），更新可追溯。
- **异常模式学习**：学习异常指纹/告警模板，供 Detector 规则通道复用。
- **迁移先验库（Transfer Priors）**：从已学习系统提取同类技术栈先验（通用异常模式、告警模板），迁移到新系统缩短冷启动/预热；迁移前标记来源，避免过拟合异质系统。
- **投毒/漂移防护**：学习期剔除异常样本（被攻陷/故障系统的异常数据不参与拟合）；检测概念漂移并告警；基线重大变化经可解释审计与门禁（默认需人工确认）。
- **版本化与回退**：学习结果（阈值/规则/策略）版本化，支持回退到上一稳定基线（误学习可回退）。

#### 3.2.3 冷启动期安全姿态

冷启动态采用保守通用阈值，异常判定偏向「提示而非自动自愈」——即冷启动态仅告警/提示，不触发自动自愈；进入预热态后才逐步放开受限自愈，进入已学习态后按系统特定阈值执行完整自愈策略。

### 3.3 Multi-System Registry（多系统注册与命名空间隔离，F-SRE-013）

**新增组件**。管理多系统纳管与租户隔离：

- **系统注册**：维护 `sre_systems` 注册表（system_id 为主键），每个系统独立建模/监控/告警/学习（状态机互不干扰）。
- **命名空间隔离**：每系统一个 namespace，配置、凭证（Secret 引用）、自愈策略、告警通道、审计日志、学习状态**全部按 system_id 隔离**。
- **凭证命名空间/密钥隔离**：每系统凭证以独立 namespace 注入，系统 A 的凭证/令牌不得访问系统 B 资源；跨租户访问一律拒绝并告警（AC-013a）。
- **审计边界**：审计日志按系统隔离存储、仅追加写；被攻陷系统不得篡改/删除他系统审计，越权写审计触发告警（F-SRE-013）。
- **配额与横向扩展**：单实例纳管系统数可配，超阈值可多实例水平扩展分工纳管（NFR-X）。

### 3.4 SRE Collector（监控采集，泛化）

对应 F-SRE-001。采集源统一经 System Adapter Layer 抽象，核心不再直接感知具体系统：

| 采集项 | 数据源 | 采集方式（经 Adapter 抽象） |
|--------|--------|------------------------------|
| 服务健康 | 配置的健康端点 | HTTP 探针（状态码/时延/body） |
| 前端/入口可用性 | 配置的前端入口 | HTTP 探针 + 关键页面渲染 |
| 容器/进程 | 容器运行时（Docker 等） | 经 Docker Adapter：stats/事件流 |
| 数据库 | 被纳管系统数据库 | 只读连接（无写权限） |
| 缓存/键值存储 | 被纳管系统缓存 | 只读探测 |
| 磁盘/资源 | 宿主/数据卷 | CPU/内存/磁盘使用率、日志增长 |
| 日志 | 聚合日志源 | 订阅 ERROR/FATAL/panic |
| 心跳 | Agent 心跳 | 心跳文件/agent-status |

> **检测范围边界（功能正确性）**：上表全部采集项均为**可用性/可靠性**信号——服务健康/资源/错误率/日志 ERROR 簇/心跳，不覆盖「功能正确性」（业务逻辑对不对、返回结果正不正确）。仅当功能缺陷**泄露可观测信号**（后端抛异常→日志 ERROR 簇、5xx/错误率升高、DB 报错）时才被本通道**顺带**检出；**静默 bug**（返回 200 但结果错/页面空白不抛错）不产生上述信号，AI SRE 无法仅凭监控自动发现——此类由 **QA 功能测试** + **F-SRE-014 用户报障接入**兜底（见 §1.2/§3.11）。

采集节奏：关键健康检查 ≤ 60s，全量巡检 ≤ 5min（NFR-A）。采集器为无状态、可水平扩展的 worker 池，按 system_id 分片，结果写入事件总线（带 system_id 命名空间标记）。

### 3.5 Detector + Classifier（检测与分级，泛化）

对应 F-SRE-002/003。**规则 + 基线**双通道：

- **规则通道**：硬阈值（磁盘 85%=P2、95%/写满=P0；连接池 >80% 告警等）、状态机（健康检查连续 N 次失败 → P0）。阈值经 Learning Engine 按系统动态调整。
- **基线通道**：对比历史基线检测突变（错误率/5xx 比例升高、慢查询突增、内存持续高位）。基线来自 Learning Engine。

分级器输出 `{system_id, severity P0-P3, 分级理由, 受影响组件, 指标值, 检测时间}`。

### 3.6 根因定位（Localizer，泛化）

对应 F-SRE-004。分层定位：

1. **确定性定位（本地规则）**：容器 OOM 退出、磁盘写满、端口无响应、依赖不可达 → 匹配已知模式，产出根因假设与置信度。
2. **变更关联**：关联最近部署 commit、配置变更（读取部署快照表/变更日志）。
3. **深度定位（云端 LLM）**：低置信度/复杂堆栈 → 经 LLM Adapter 调云端模型，产出根因假设 + 建议处理动作。

输出 `{system_id, affected_component, recent_changes[], root_cause_hypothesis[], confidence, suggested_action}`。

### 3.7 Healing Decision Engine（自愈决策引擎）

对应 F-SRE-005/006/007 + C1/C3。**自愈执行的唯一裁决入口**，串行执行裁决链（任一不通过即转升级）：

```
裁决链：白名单命中(per-system) → 签名校验 → 全局 kill-switch 通过 → 分级/风险门禁
       → 学习态门禁(冷启动不自动自愈) → 防抖(no-flap/冷却/次数上限)
       → 每日/小时熔断上限 → SVA 门禁映射 → 干跑(dry-run)预演 → 执行 → 执行后验证
```

### 3.8 Healing Executors（自愈执行器 ×5，泛化）

对应 F-SRE-005 + C2。每类动作独立 Executor，统一契约：

```
interface Executor {
  actionType: 'container_restart' | 'disk_cleanup' | 'deploy_rollback'
            | 'resource_release' | 'cache_restart';
  preCheck(ctx): boolean;        // 前置条件校验（白名单/信号确认）
  dryRun(ctx): Plan;             // 干跑预演（可测性）
  execute(ctx): Result;          // 幂等执行
  postVerify(ctx): VerifyResult; // 执行后验证（健康/一致性）
}
```

> 动作名由 `redis_restart` 泛化为 `cache_restart`（覆盖任意缓存/键值存储，Redis 仅为 SAS 实例取值）。

| Executor | 允许自动执行条件（摘要，详见 §5 判定矩阵） | 执行后验证 |
|----------|--------------------------------------|-----------|
| container_restart | 无状态服务；二次独立信号确认；冷却期内无重复 | 健康检查恢复 |
| disk_cleanup | 85%≤使用率<95%；仅白名单临时文件/旧日志/孤儿镜像卷 | 磁盘使用率回落 + 受保护卷未动 |
| deploy_rollback | 同时满足 (a)上一稳定版本曾通过 QA 且健康 (b)变更窗内 (c)PM 软授权或严格门禁 | **Post-rollback 一致性校验（C4）** + 健康恢复 |
| resource_release | 僵尸进程/无状态连接池；无在途写；非联动故障 | 资源释放 + 服务健康 |
| cache_restart | 仅缓存/会话；确认非持久队列源；非数据损坏 | ping 恢复 + 数据损坏复核 |

**C2 落位**：五类 Executor 各自独立实现 + 独立 dry-run + 独立指标（`sre_healing_{actionType}_success/failure/latency`，带 system_id label），QA 可对每类单独注入故障逐类验收（AC-005a~d）。

### 3.9 Escalation Manager（告警升级）

对应 F-SRE-007 + C6。职责：

- **去重**：按异常指纹 `hash(system_id + anomaly_type + affected_component + 时间桶)` 去重。
- **抑制**：维护窗口/已知故障静默期内抑制。
- **聚合/收敛**：按 P0/P1 收敛通知（同一根因多次告警合并为 1 条升级），防告警疲劳与重复 Issue。
- **路由**：PM（P0/P1/需决策）、DEVOPS（部署/回滚/基础设施）、DEV（明确代码缺陷→创建 Issue）、QA（自愈后验证请求）。
- **可靠性**：升级链路失败 → 落盘持久化重试（Kafka 消费重试 + 保底落地 Issue）。

### 3.10 Audit Logger（审计日志）

对应 NFR-S/F-SRE-013 审计边界。不可变、**按 system_id 命名空间隔离**、仅追加写，是 CHECKER 质检的输入。写入失败则**阻止后续自愈**（fail-closed，UC-010）。越权写审计（跨 system_id）触发告警。

### 3.11 User Incident Intake（用户报障接入，F-SRE-014）

**新增组件**。为「功能不工作但系统健康运行」的盲区提供**用户侧报障入口**（第二输入源，与 §3.4 监控采集并列），补位功能正确性盲区（配合 QA 功能测试，见 §1.2 边界说明）。内部字段/通道均采用**通用命名**，不写死某套工单系统，经通道配置/适配器接入。

#### 3.11.1 Intake 通道与接口

- **可配置通道**：至少提供一个用户侧报障入口，支持 Web 表单 / IM / 邮件 / 工单 webhook 等（`intake_channels`，见 §2.4），每通道经统一 intake 接口收纳。
- **统一 intake 接口**：各通道适配为同一收报接口（接收报文 + 元数据：来源通道、接收时间戳），与 System Adapter Layer 类似以插件/配置方式接入，核心零通道硬编码。
- **旁路不侵入**：intake 只读接收用户反馈，不写回被纳管系统、不访问业务用户 PII。

#### 3.11.2 归一化（Normalize）

收到的报障内容归一化为统一 incident 结构，落 `sre_incidents`（§7.2），结构化字段至少含：受影响的系统标识（`system_id`，被纳管系统）、现象描述（自由文本 `symptom_desc`）、影响范围/严重度初步估计（`reported_severity`）、发生时间（`reported_at`）、报障者运营回执联系信息（`reporter_contact_ref`——用于回执，非业务用户 PII，采集与保留受 **NFR-S「报障回执最小权限例外」** 约束，见 §5.8）。来源通道 `source_channel` 与接收时间戳须保留以便追溯；**原始报文为可选项**——仅当取证/复核需要时保留（`raw_payload` 可空），且按最小留存周期自动清理（不默认全量长期存档）。

#### 3.11.3 关联 Issue（Issue 为唯一真相源）

归一化后的 incident 须关联或新建对应 GitHub Issue（`issue_id`），延续既有原则，保证与 PM 调度、DEV、QA 流程同源可见。（重复/已知归并不新建，见下。）

#### 3.11.4 三分类 triage（重复 / 已知 / 新建）

- **重复（Duplicate / dup）**：与同一根因/同现象既有 incident（或仍在抑制/冷却期）重复 → 合并、去重通知（对齐 F-SRE-007），仅更新既有记录，不新增 issue/incident 与告警（AC-014b）。
- **已知（Known）**：命中已在处理/已存在的 Issue 或已知根因 → 并入对应 Issue 并补充证据，不新建（AC-014b）。
- **新建（New）**：非重复亦非已知 → 作为新问题进入排查（AC-014a）。

#### 3.11.5 触发排查（Trigger）

新建/未知 incident → 触发对该系统的**定向排查**（结合最近变更、可用性/可靠性信号识别是否已泄露可观测信号）：

- 能定位到**可观测信号** → 按既有升级路径（回到 §3.9/Detector 通道）处理；
- 属**静默 / 功能正确性**类（无可观测信号）→ 转 **DEV** 走代码层排查修复（经 Issue）。

#### 3.11.6 反馈回执（Acknowledge & Close-loop，AC-014a）

向报障用户回执 incident 处理状态（**已受理 / 处理中 / 已修复**），并在 Issue/Dashboard 可见闭环；状态变更（受理→定位→修复→关单）可追踪可回查。回执仅使用 `reporter_contact_ref` 脱敏联系（受 §5.8 约束），不参与监控/告警/检测数据与基线建模。

#### 3.11.7 异常流（对 UC-SRE-016）

通道不可用 / 报文缺关键字段 → 标记告警并提示补全后重试；回执失败 → 重试并在 Issue/Dashboard 可见闭环。系统不可达/需取证时按最小留存周期保留原始报文（见 §3.11.2）。

---

## 4. 数据流与事件通道

### 4.1 事件通道选型

**结论：复用现有 Kafka 作为主事件总线；Redis Streams 作为轻量降级备选**（SAS 参考实例中复用其 kafka 容器；通用交付形态内嵌一个轻量事件总线实现，可配置替换为外部 Kafka）。该取舍见 **ADR-002**。

Kafka Topic 规划（每个消息体带 `system_id` 命名空间标记）：

| Topic | 生产者 | 消费者 | 语义 |
|-------|--------|--------|------|
| `sre.metrics.raw` | Collector（经 Adapter） | Detector | 原始采集快照（含 system_id） |
| `sre.anomaly.detected` | Detector | Localizer / Decision Engine / Learning Engine | 已分级异常事件（含 system_id） |
| `sre.intake.received` | Intake Channel / Collector | Intake Broker（归一化→triage） | 用户报障原始报文（F-SRE-014；可选原报文本经脱敏临时载入，含 system_id） |
| `sre.intake.normalized` | Intake Broker | triage / Escalation Manager / Localizer | 归一化结构化 incident + triage 结果（dup/known/new，含 system_id） |
| `sre.learning.update` | Learning Engine | Detector / Decision Engine | 基线/阈值/策略更新事件（版本化） |
| `sre.healing.command` | Decision Engine | Executors | 已裁决的自愈命令（含签名 + system_id） |
| `sre.healing.result` | Executors | Decision Engine / Audit | 执行结果（含验证） |
| `sre.escalation.request` | Escalation Manager | 外部协作层 | 升级请求（去重后） |

### 4.2 完整数据流链路

> 两条输入源在 Escalation/Incident Manager 汇合（输入源①监控采集、输入源②用户报障 Intake），两者均复用 `sre_incidents` 真相源与去重/抑制/升级链路。

```
  [被纳管系统监控数据] ──► [Adapter 发现/采集] ──► [检测] ──► [分级] ──► [学习] ──► [自愈/升级] ──► [审计]
        │                      │                   │          │          │           │               │
    (配置注入)          System Adapter Layer     Detector  Classifier Learning   Decision      Audit Logger
        │               (每系统一个实例)          (规则+基线) (P0-P3)   Engine    Engine        (不可变)
        │                      │                   │          │          │       (白名单+签名+    按 system_id
        │                      ▼                   ▼          ▼          ▼        熔断+防抖+门禁) 隔离
        │               sre.metrics.raw     sre.anomaly.detected  sre.learning.update  sre.healing.command ──► PostgreSQL
        │               (Kafka, 带system_id)   (Kafka)              (Kafka)             sre.healing.result
        │                                                        (基线/阈值版本化)          (Kafka)
        │                                                                                    │
        │                                                                    ┌──────────────┴───────────────┐
        │                                                                    ▼                              ▼
        │                                                          [白名单内+通过]               [白名单外/高风险]
        │                                                                    │                              │
        │                                                              Executors                    Escalation Manager
        │                                                             (5类+验证)                     (去重/抑制/聚合)
        │                                                                    │                              │
        │                                                                    ▼                              ▼
        │                                                           自愈成功记录                     升级 PM/DEVOPS/DEV/QA
        │                                                                    │                    (write_message + Issue)
        │                                                          postVerify 失败→转升级
```

---

## 5. 自愈执行安全边界

> 本章保留并泛化 v0.1.0 对 **C1（安全）、C3（防抖）、C4（回滚）、C5（判据）** 的落位，并与 SVA gate 对齐。

### 5.1 动作白名单 + 签名校验（C1）

- **白名单**：可自动执行动作维护在版本化、**per-system** 策略表 `sre_action_allowlist`（§7.2），每条含：`system_id / action_type / target_pattern / allowed / 前置条件 / daily_limit / hourly_limit / cooldown_seconds / requires_signature / requires_pm_auth / schema_version`。
- **签名**：自愈命令由 Decision Engine 签发，携带 `HMAC-SHA256(system_id + action_payload, sre_signing_key)` 签名；Executor 验签通过才执行。签名密钥与业务凭据分离，经密钥管理获取，不落盘明文。
- **凭证分离**：AI SRE 运行账户为独立受限账户（非 root），仅持监控只读 + 白名单内动作所需最小权限，**不持有被纳管系统数据库写权限、不访问 PII**。多系统场景下，每系统凭证独立命名空间注入。

### 5.2 与 SVA gate 的关系

AI SRE 的自愈动作属新增 Action Class `SRE_HEAL`：

| 自愈动作 | SVA 门禁 | 说明 |
|----------|----------|------|
| 重启容器（无状态） | 免门禁（白名单+签名+限流自动放行） | 低风险可回滚 |
| 清理磁盘（白名单内） | 免门禁 | 仅白名单临时文件/旧日志 |
| 连接池重建/释放资源 | 免门禁 | 仅无在途写且确认非联动 |
| 重启缓存（仅缓存/会话、非损坏） | 免门禁 | 受数据损坏检测硬约束 |
| **回滚部署** | **需 PM 软授权**（或严格门禁） | 触及发布/变更窗治理 |

> 所有「免门禁」动作仍必须通过 §5.1 白名单+签名+§5.3 kill-switch+§5.4 熔断/防抖+§3.2 学习态门禁；「免门禁」仅指**不需人工逐次审批**，非「无任何控制」。

### 5.3 全局紧急 kill-switch（C1）

- 单一全局熔断开关：`sre:kill_switch`（Redis flag，值 `armed`/`disarmed`），同时落盘备份到 PostgreSQL 审计记录。多系统部署下支持全局 + per-system 两级 kill-switch。
- 任一人（PM/CHECKER/人类）可一键置 `armed`；置位后：**所有自愈动作（含已在队列中的命令）立即中止**，Executor 拒绝执行并转升级。
- 自愈风暴、安全事件、大促/变更冻结期等场景强制置位。恢复需人工显式 `disarmed` 并记录审计。

### 5.4 熔断/退避/每日上限（C1/C3）

三层限流，全部在 Decision Engine 内以 Redis 计数器实现（默认值可配，按 system_id 维度独立计数）：

| 维度 | 默认值 | 超限动作 |
|------|--------|----------|
| 单服务自愈次数/小时 | 5 次/小时 | 熔断该服务，转升级 DEVOPS |
| 单系统自愈次数/日 | 可配 | 熔断该系统，转升级 PM |
| 全局自愈次数/日 | 50 次/日 | 全局熔断，置 kill-switch，转升级 PM |
| 单动作冷却期 | restart 10min / 回滚 30min / 清盘 60min | 冷却期内拒绝重复 |

**防抖（no-flap）**：同一异常指纹（含 system_id）在时间窗内反复「恢复→再告警」达 N 次（默认 3 次/30min）→ 判定 flap，停止自愈并转升级人工研判。

**退避**：自愈失败重试采用指数退避（1→2→4min），达上限（默认 3 次）停止重试转升级（UC-008）。

### 5.5 回滚后一致性校验（C4）

回滚执行器 `postVerify` 强制包含 **Post-rollback Consistency Verifier**：

1. **配置一致性**：对比版本快照的 env/config hash，检测配置漂移。
2. **依赖一致性**：依赖服务健康、DB migration 版本匹配、缓存 key schema 兼容。
3. **版本一致性**：确认回滚目标命中「最近一次 QA 签收通过」的版本集（快照含 QA 签收标记）。

任一校验失败 → 立即升级 DEVOPS，标注**紧急**，不自动二次回滚。

### 5.6 缓存「数据损坏」具体判据（C5，泛化）

`cache_restart` Executor 前置必须通过 Cache Data Corruption Detector，出现**任一**信号即判定「数据损坏」，**禁止重启**，转升级 DEVOPS：

1. 持久化文件（RDB/AOF 等）加载失败，或 `last_bgsave_status=err` / `last_write_status=err`。
2. 持久化文件校验工具（如 `redis-check-rdb`/`redis-check-aof`）校验失败。
3. 关键 key 类型不匹配（对预期类型做抽样）。
4. 持久队列数据源 key 的应用层 CRC/签名校验失败。
5. 主从复制 offset 持续倒退/不一致且无法自愈。

**「非损坏可重启」安全边界**（同时满足才可重启）：缓存仅作缓存/会话（配置白名单 key 前缀 + 无持久队列 key 前缀）且 `last_bgsave_status=ok` 且无上述 5 类信号。

### 5.7 横向越权与凭证泄露遏制（F-SRE-013 / AC-013a）

- 所有内部调用携带 `system_id`，Registry 层强制校验调用方命名空间，跨 system_id 访问一律拒绝并触发安全告警。
- 每系统凭证以独立 Secret namespace 注入，运行时内存按 system_id 隔离；系统 A 的凭证/令牌不得访问系统 B 资源。
- 任一系统被攻陷仅影响其自身 namespace，不越权影响他系统监控/自愈/审计。

### 5.8 报障回执最小权限例外（NFR-S / F-SRE-014 / UC-SRE-016）

为完成用户报障受理回执（§3.11），AI SRE 可采集报障者**运营回执联系信息**；此项严格受如下约束，且**不属于**访问业务用户 PII：

- **目的绑定**：仅用于向报障者回执本 incident 的处理状态（已受理/处理中/已修复），不用于任何其它目的。
- **仅回执用**：联系信息不进入通用监控/告警/检测数据，不参与异常检测与基线建模。
- **最小化存储**：仅存报障通道供给的最小回执字段（`reporter_contact_ref` 引用脱敏存储），不主动采集/挖掘额外个人属性。
- **保留周期受限**：按最小留存周期自动清理（默认随 incident 关单后 N 天内清除，可配置），不长期留存。
- **脱敏/掩码展示**：在 Issue/Dashboard/审计界面以脱敏/掩码形式展示（如尾号），不全量明文回写公共渠道。
- **审计隔离**：涉及该联系信息的读取/回执动作按 system 隔离写 append-only 审计，可追查不可篡改（扩展 §7.2 `audit_logs` 枚举）。

---

## 6. 与现有 Agent 生态集成（C6/F-SRE-009）

### 6.1 注册清单（落地项）

AI SRE（及 OPS）需注册进以下位置（现有枚举为 `{PM,DEV,QA,DEVOPS,CHECKER,ARCH,REQ}`）：

| 位置 | 现状 | 需变更 |
|------|------|--------|
| `skills/agent-communication/scripts/write_message.py` | `GITHUB_AGENT_LABELS` + `--from` choices 无 AI SRE | 新增 `"AI-SRE": "ai-sre"`（含 label 映射与 `--from` 枚举） |
| `agent-status.json` | 无 AI SRE | 由 write_message 自动写入 |
| GitHub label | 无 `ai-sre` | 新增 label `ai-sre` |
| Dashboard 面板 | 无 AI SRE | update_dashboard 渲染新角色卡 |
| `docs/SVA-GATE.md` | 无 AI SRE 角色 | 新增 AI SRE Role-Action 矩阵（含 `SRE_HEAL` 动作类） |

> ARCH 只输出**变更清单**，具体枚举/标签/面板落地由 DEVOPS/PM 在实施阶段执行。

### 6.2 多系统下的实例注册与区分

单实例同时纳管多个系统时，Agent 生态层只注册**一个 AI SRE Agent 身份**（`AI-SRE`），被纳管系统的区分在内部通过 `system_id` namespace 完成，不外泄为多个 Agent 角色：

- **通信层**：AI SRE 作为单一 Agent 通过 write_message.py 收发消息；升级消息体带 `system_id` 标记，便于 PM/DEVOPS 区分「哪个系统」出问题。
- **Issue 层**：跨系统事件各自创建/关联 Issue，Issue 标题/正文带系统标识（如 `[SAS]` 前缀）。
- **Dashboard**：AI SRE 卡片展示纳管系统数与各系统学习态（cold/warm/learned）、自愈计数、告警计数汇总。
- **水平扩展**：多实例部署时，每实例一个独立 AI SRE Agent 身份（如 `AI-SRE-01`/`AI-SRE-02`），各自分工纳管不同系统集，经 Registry 分片。

### 6.3 心跳与自身可用性兜底

- AI SRE 每 5min 写一次自身心跳（复用 agent-status.json）。
- **PM watchdog 兜底**：PM 侧检测 AI SRE 心跳超时 → 告警（UC-009）。
- **对等健康对账**：OPS 基础巡检作为 AI SRE 的独立第二观察者，交叉核对 AI SRE 是否在线，形成「PM watchdog + OPS 对等对账」双兜底。

### 6.4 AI SRE 自身运维归属（C6-m7）

| 事项 | 归属 |
|------|------|
| AI SRE 运行时部署/升级/回滚 | **DEVOPS**（超出 AI SRE 自愈权限，自身不回滚自己） |
| AI SRE 代码/配置变更 review | **PM 审批 + CHECKER 质检** |
| 自愈策略/白名单变更 | **PM 软授权**，变更走审计 |
| AI SRE 自身故障修复 | 心跳兜底检测 → **DEVOPS** |
| 纯运营值班/巡检 | **OPS**（与 DEVOPS 命名区分） |

---

## 7. 持久化与状态

### 7.1 存储选型

- 🔁 **incident 记录层（incident / lifecycle 迁移 / 查询审计）→ 嵌入式 SQLite**（v0.5.0 #372 定案 D，见 §7.1b）：自包含单文件 `sre.db`，零外部 DB 运维。取代 v0.4.0 此条所指的“incident→PostgreSQL”。
- **事件/决策审计取证（sre_audit_events/决策记录，§§12.1/12.4）+ 其余引擎表 → PostgreSQL**（新增 `sre_*` 表，全部带 `system_id` 隔离；若同样改走 SQLite 记录层由后续 #Issue 各落 DDL，见 DB-SCHEMA §4 注）。
- **限流/熔断/防抖计数器 → Redis**（高频、短生命周期，无需持久化，宕机可重置）。
- **事件流 → Kafka**（§4 主题，retention 72h）。

### 7.1b 记录层选型：PostgreSQL → 嵌入式 SQLite（🆕 v0.5.0，#372 定案 D）

- **决策**：incident 记录层（`sre_incidents` / `sre_incident_state_transitions` / `sre_incident_query_audit`）持久化由独立 PostgreSQL 服务改为**嵌入式 SQLite 单文件**（`ai-sre-service` 数据卷内 `sre.db`，WAL 模式，单进程写）。
- **理由**：产品可重复部署须**自包含、零外部依赖、零运维**（免 DBA/连接管理/独立服务求存兜底）；**单客户/单部署 incident 量小**，SQLite 单机容量/并发足够。与 §2.1 自包含镜像交付形态一致；与现有进程内 repository 参照实现架构天然契合（成熟即真库，不引入外部 DB）。
- **DDL/契约**：见 `docs/ai-sre/DB-SCHEMA.md`（已改版 SQLite：TEXT UUID / TEXT ISO-8601 时间 / ENUM→CHECK / JSONB→TEXT+json_valid / RANGE 分区→复合索引 / 无 PG 角色→app 写门 + `BEFORE UPDATE/DELETE` 触发器护栏）。
- **不因存储换而变更**：查询端点（列表+详情）、lifecycle 权威投影（§12.2b/§12.6b）、PII 掩码投影、Issue 唯一真相源全部保留（DESIGN §12；DB-SCHEMA §7）。

### 7.2 多系统命名空间表草案

> 命名遵循 DB-SCHEMA 既有命名（snake_case；记录层为 SQLite TEXT+CHECK 表达，见 DB-SCHEMA §4）。所有业务表带 `system_id` 实现 per-system 隔离；审计事件复用既有 `audit_logs`（扩展 `audit_action` 枚举 + `system_id` 列）。
>
> **ⓘ 表类型表达说明（v0.5.0）**：下表为各 `sre_*` 表的**设计纲要**（UUID/TIMESTAMPTZ/JSONB/ENUM 等为便于阅读的通配类型）。凡已落入记录层 SQLite 契约的表（`sre_incidents` / `sre_incident_state_transitions` / `sre_incident_query_audit`，即下列表 1 及相关生命周期/查询审计表），其**权威类型/约束以 `docs/ai-sre/DB-SCHEMA.md`(v0.5.0 SQLite) 为准并覆盖此“纲要”列**；其余未落 DDL 表待各自 #Issue 伴随产出 SQLite/PG 契约。

**表 0：`sre_systems` — 系统注册表（F-SRE-013 多系统纳管）**

| 字段 | 类型 | 说明 |
|------|------|------|
| system_id | UUID PK | 系统唯一标识 |
| name | VARCHAR(64) | 系统名（如 school-admin-system） |
| adapter_id | UUID FK→sre_adapters | 绑定的适配器 |
| profile_ref | VARCHAR(128) | 配置 profile 引用 |
| credential_ns | VARCHAR(64) | 凭证命名空间（Secret 引用） |
| learning_state | sre_learning_state_enum | cold_start/warm_up/learned |
| status | sre_system_status_enum | onboarding/active/degraded/offboarded |
| onboarded_at | TIMESTAMPTZ | 接入时间 |

**表 1：`sre_incidents` — 异常/报障事件（检测 + 用户报障 Intake 统一真相源）**

> 统一承载两条输入源的事件：①监控采集 Detector 检测到的可用性/可靠性异常；②用户报障 Intake 归一化后的结构化 incident（F-SRE-014）。两类共用 `system_id` 隔离；intake 来源用 `source='intake'` 区分，报障专属字段（`sample` 下方带 ✚）仅在 intake 时填写。 `severity/dedup_fingerprint/status 复用既有去重抑制与升级链路，保证 triage 与新检测事件同源可比较。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | 事件主键 |
| system_id | UUID FK→sre_systems | **命名空间隔离** |
| source | sre_incident_source_enum | **detected（监控采集）/ intake（用户报障）** |
| anomaly_type | VARCHAR(64) | service_down/disk_high/db_error/cache_error/...(detected) 或 functional/manual(reported) |
| severity | sre_severity_enum | 检测定级 P0-P3（intake 可先给初步估计再校准） |
| ✚ reported_severity | VARCHAR(32) | 报障者初步影响/严重度估计（intake） |
| status | sre_incident_status_enum | detected/locating/healing/escalated/resolved/suppressed（intake 见回执流程） |
| affected_component | VARCHAR(128) | 受影响组件/容器/服务 |
| ✚ symptom_desc | TEXT | 报障现象描述（自由文本，intake 归一化） |
| root_cause_hypotheses | JSONB | 根因假设数组（含置信度，排查后填充） |
| recent_changes | JSONB | 最近部署 commit/配置变更关联 |
| dedup_fingerprint | VARCHAR(64) | 去重指纹 hash（含 system_id；intake 去重复用于三分类） |
| ✚ triage | sre_incident_triage_enum | **重复 dup / 已知 known / 新建 new（F-SRE-014 三分类）** |
| ✚ duplicate_of_id | UUID FK→sre_incidents | triage=dup 时并入的既有 incident |
| ✚ issue_id | INTEGER | 关联/新建的 GitHub Issue（Issue 为唯一真相源） |
| ✚ reporter_contact_ref | VARCHAR(128) | 报障者运营回执联系信息引用（**脱敏存储，NFR-S §5.8 例外**；NULL=检测来源） |
| ✚ source_channel | VARCHAR(32) | intake 来源通道 webform/im/email/webhook/... |
| ✚ raw_payload | JSONB NULL | 原始报文（**可选**，仅取证需保留；按最小留存周期自动清理） |
| ✚ ack_status | sre_incident_ack_enum | **回执状态：received/processing/fixed/closed**（intake 回执闭环） |
| ✚ received_at | TIMESTAMPTZ | 报障/接收时间戳 |
| detected_at / resolved_at | TIMESTAMPTZ | 检测/解决时间 |

**表 2：`sre_healing_actions` — 自愈动作执行记录（C1/C2 审计核心）**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | 动作主键 |
| system_id | UUID FK→sre_systems | **命名空间隔离** |
| incident_id | UUID FK→sre_incidents | 关联事件 |
| action_type | sre_action_enum | container_restart/disk_cleanup/deploy_rollback/resource_release/cache_restart |
| target | VARCHAR(128) | 目标（容器/卷/服务名） |
| policy_version | VARCHAR(32) | 白名单策略版本 |
| signature | VARCHAR(128) | HMAC 签名（验签留痕） |
| dry_run_result | JSONB | 干跑计划 |
| result | sre_action_result_enum | success/failed/skipped/killswitched/escalated |
| post_verify_result | JSONB | 执行后验证（含 C4 一致性校验） |
| retry_count | SMALLINT | 重试次数 |
| started_at / finished_at | TIMESTAMPTZ | 起止时间 |

**表 3：`sre_escalations` — 升级记录（C6 去重/抑制留痕）**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | 升级主键 |
| system_id | UUID FK→sre_systems | **命名空间隔离** |
| incident_id | UUID FK→sre_incidents | 关联事件 |
| target_agent | VARCHAR(16) | PM/DEVOPS/DEV/QA |
| channel | VARCHAR(32) | write_message / Issue / 其他 |
| issue_id | INTEGER | 关联 GitHub Issue |
| dedup_fingerprint | VARCHAR(64) | 去重/抑制指纹 |
| status | sre_escalation_status_enum | pending/sent/acked/failed |
| sent_at / ack_at | TIMESTAMPTZ | 发送/确认时间 |

**表 4：`sre_action_allowlist` — 自愈白名单与策略（per-system 版本化）**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | 策略主键 |
| system_id | UUID FK→sre_systems | **per-system 策略隔离** |
| action_type | sre_action_enum | 动作类型 |
| target_pattern | VARCHAR(128) | 目标匹配模式 |
| allowed | BOOLEAN | 是否允许自动执行 |
| preconditions | JSONB | 前置条件 |
| daily_limit / hourly_limit | SMALLINT | 每日/小时上限（C1/C3） |
| cooldown_seconds | INTEGER | 冷却期 |
| requires_signature | BOOLEAN | 是否需签名 |
| requires_pm_auth | BOOLEAN | 是否需 PM 软授权（回滚=true） |
| schema_version | VARCHAR(32) | 策略版本 |
| updated_by / updated_at | VARCHAR(16)/TIMESTAMPTZ | 变更审计 |

### 7.3 适配器注册表草案

**表 5：`sre_adapters` — 适配器插件注册（F-SRE-011 生命周期）**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | 适配器主键 |
| adapter_type | VARCHAR(64) | generic_http/sas/docker/... |
| version | VARCHAR(32) | 插件版本 |
| signature | VARCHAR(128) | 插件签名（验签留痕） |
| permission_decl | JSONB | 最小权限声明 |
| status | sre_adapter_status_enum | active/rolling_back/rejected/disabled |
| loaded_at / rolled_back_at | TIMESTAMPTZ | 热加载/回滚时间 |

### 7.4 学习状态与基线存储草案（F-SRE-012）

**表 6：`sre_learning_state` — 每系统学习三态状态机**

| 字段 | 类型 | 说明 |
|------|------|------|
| system_id | UUID PK/FK→sre_systems | 每系统一行 |
| state | sre_learning_state_enum | cold_start/warm_up/learned |
| observation_windows | INTEGER | 已采集观测窗口数（对照 N） |
| metric_coverage | SMALLINT | 已覆盖指标类别数（对照 M） |
| consecutive_clean | INTEGER | 连续无异常空窗数 |
| last_transition_at | TIMESTAMPTZ | 上次迁移时间 |
| transfer_prior_used | BOOLEAN | 是否使用迁移先验 |
| transition_params | JSONB | N/M/K/X/Y/Z 参数快照 |

**表 7：`sre_baseline_profiles` — 基线/阈值（版本化，可回退）**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | 基线主键 |
| system_id | UUID FK→sre_systems | **per-system** |
| metric_type | VARCHAR(64) | 指标类别（服务健康/资源/日志/缓存/DB） |
| baseline | JSONB | 正常区间（均值/方差/周期/负载范围/延迟分布） |
| threshold | JSONB | 检测阈值 |
| version | VARCHAR(32) | 版本（可回退上一稳定版） |
| is_stable | BOOLEAN | 是否稳定（供回退锚点） |
| drift_flag | BOOLEAN | 概念漂移标记 |
| updated_at | TIMESTAMPTZ | 更新时间 |

**表 8：`sre_anomaly_patterns` — 学习的异常模式/告警模板**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | 模式主键 |
| system_id | UUID FK→sre_systems | **per-system**（或 NULL=跨系统通用） |
| pattern_fingerprint | VARCHAR(64) | 异常指纹 |
| pattern | JSONB | 异常模式/告警模板 |
| source | VARCHAR(32) | learned/transferred/manual |
| confidence | REAL | 置信度 |

**表 9：`sre_transfer_priors` — 跨系统迁移先验（标记来源）**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | 先验主键 |
| source_system_id | UUID | 来源系统（迁移前标记） |
| tech_stack | VARCHAR(64) | 同类技术栈标签 |
| prior | JSONB | 先验（通用异常模式/告警模板） |
| transfer_result | JSONB | 迁移效果（窗口数/时长缩短率，对照 AC-012 ≥25%） |
| created_at | TIMESTAMPTZ | 创建时间 |

**复用：`audit_logs` 扩展 `audit_action` 枚举 + `system_id` 列**（追加值）：
`sre_incident_detected, sre_healing_executed, sre_escalated, sre_killswitch_toggled, sre_policy_changed, sre_rollback_executed, sre_learning_transitioned, sre_adapter_loaded, sre_adapter_rolled_back, sre_cross_tenant_access_denied`

追加 intake/回执审计值：`sre_intake_received, sre_intake_normalized, sre_intake_triaged, sre_intake_issue_associated, sre_intake_acked, sre_intake_raw_cleaned, sre_intake_reporter_contact_accessed`（报障回执最小权限例外 §5.8：凡读取/回执 `reporter_contact_ref` 的动作用 `sre_intake_reporter_contact_accessed` 记录，按 system 隔离 append-only 可追查）。

---

## 8. 架构图

### 8.1 总体拓扑图

```mermaid
flowchart TB
    subgraph Delivery["交付物（自包含，F-SRE-010）"]
        IMG["ai-sre 镜像<br/>(版本+签名, 零硬编码)"]
        MAN["compose/helm 编排清单"]
        BOOT["bootstrap/onboard 脚本"]
    end

    subgraph SysA["被纳管系统 A（示例 = SAS）"]
        FEA["前端入口"]
        BEA["服务/后端"]
        DBA[("数据库")]
        CAA[("缓存/键值存储")]
        LOGA["日志源"]
        DISKA["磁盘/资源"]
    end

    subgraph SysB["被纳管系统 B（新系统）"]
        FEB["前端入口"]
        BEB["服务/后端"]
        DBB[("数据库")]
        CAB[("缓存/键值存储")]
        LOGB["日志源"]
        DISKB["磁盘/资源"]
    end

    subgraph Adapters["System Adapter Layer（插件层，F-SRE-011）"]
        direction LR
        GA["Generic HTTP Adapter"]
        SA["SAS Adapter（参考）"]
        DA["Docker Adapter"]
        BX["系统 B Adapter（可选）"]
    end

    subgraph SRE["ai-sre-service（通用核心）"]
        direction TB
        REG["Multi-System Registry<br/>(per-system namespace, F-SRE-013)"]
        COL["Collector 采集<br/>输入源①: 监控采集(可用性/可靠性)"]
        INTK["Intake Collector→Broker<br/>输入源②: 用户报障(F-SRE-014)<br/>归一化→triage→关联Issue"]
        DET["Detector/Classifier 检测分级"]
        LOC["Localizer 定位"]
        LRN["Learning Engine<br/>(三态, F-SRE-012)"]
        DEC["Healing Decision Engine 决策"]
        EXE["Healing Executors ×5 执行"]
        ESC["Incident/Escalation Mgr<br/>升级+去重/抑制/聚合"]
        AUD["Audit Logger 审计"]
        REG --> COL
        REG --> INTK
        COL --> DET --> LOC --> LRN
        INTK -->|triage: 重复/已知并入| ESC
        INTK -->|新建, 定向排查| LOC
        LRN --> DET
        LRN --> DEC
        DEC -->|白名单内| EXE
        DEC -->|白名单外/高风险| ESC
        EXE --> AUD
        ESC --> AUD
    end

    subgraph Intakers["用户报障入口（F-SRE-014，通道可配置）"]
        direction LR
        WEB["Web 表单"]
        IM["IM"]
        EM["邮件"]
        WH["工单 webhook"]
        WEB & IM & EM & WH --> INTK
    end

    subgraph Infra["事件/状态存储"]
        KAFKA[("Kafka 事件总线")]
        PG[("PostgreSQL")]
        REDIS[("Redis<br/>限流/kill-switch")]
    end

    subgraph Agents["多 Agent 协作层（write_message.py）"]
        PM["PM"]; DEV["DEV"]; QA["QA"]; DEVOPS["DEVOPS"]
        CHECKER["CHECKER"]; OPS["OPS"]
    end

    IMG --> SRE
    MAN --> SRE
    BOOT --> SRE

    FEA --> GA
    BEA --> GA
    DBA --> GA
    LOGA --> GA
    SysA --> SA
    SysA --> DA
    SysB --> BX

    GA --> COL
    SA --> COL
    DA --> COL
    BX --> COL

    COL --> KAFKA
    KAFKA --> DET
    DEC --> KAFKA
    KAFKA --> EXE
    EXE --> KAFKA
    ESC --> KAFKA
    AUD --> PG
    LRN --> PG
    DEC --> REDIS

    EXE -->|restart/清理（白名单）| BEA
    EXE -->|受限| CAA

    ESC -->|升级| PM
    ESC -->|升级| DEVOPS
    ESC -->|Issue / 排查| DEV
    INTK -->|静默/功能正确性→转 DEV| DEV
    INTK -->|回执受理/处理/关单| PM
    INTK -->|回执状态 Dashboard 同步| AUD
    ESC -->|验证请求| QA
    AUD -->|质检| CHECKER
```

### 8.2 自愈决策流程图

```mermaid
flowchart TD
    A["异常事件 sre.anomaly.detected<br/>(system_id, P0-P3)"] --> B{"白名单命中?<br/>sre_action_allowlist[system_id]"}
    B -- 否 --> X1["升级 Escalation Manager<br/>(白名单外)"]
    B -- 是 --> C{"签名校验通过?<br/>HMAC-SHA256(system_id+payload)"}
    C -- 否 --> X2["拒绝 + 审计<br/>(疑似被篡改)"]
    C -- 是 --> D{"全局/系统 kill-switch<br/>armed?"}
    D -- 是 --> X3["立即中止 + 转升级<br/>(kill-switch 生效)"]
    D -- 否 --> E{"学习态门禁?<br/>(冷启动不自动自愈)"}
    E -- 冷启动 --> X8["仅提示/告警<br/>(待进入预热态)"]
    E -- 预热/已学习 --> F{"风险/分级门禁?<br/>(数据丢失/联动/DB写/凭据轮换)"}
    F -- 高风险 --> X4["仅告警升级<br/>(F-SRE-006 边界)"]
    F -- 低风险 --> G{"需 PM 软授权?<br/>(仅回滚部署)"}
    G -- 是 --> H["先升级 PM 获软授权<br/>或受严格门禁"]
    H --> I
    G -- 否 --> I{"防抖校验?<br/>no-flap/冷却期"}
    I -- flap/冷却中 --> X5["熔断 + 转升级<br/>(防自愈风暴)"]
    I -- 通过 --> J{"次数/小时 + 每日上限?"}
    J -- 超限 --> X6["熔断/置 kill-switch<br/>转升级"]
    J -- 通过 --> K["dry-run 干跑预演"]
    K --> L["执行 Executor<br/>(幂等)"]
    L --> M{"postVerify 验证?"}
    M -- 失败 --> N{"重试 < 上限(3)?"}
    N -- 是 --> O["指数退避重试"]
    O --> L
    N -- 否 --> X7["停止重试 + 升级 PM/DEVOPS"]
    M -- 成功 --> P["回滚类额外做一致性校验(C4)"]
    P --> Q["记录成功 + 审计 + Dashboard 同步"]
```

### 8.3 系统接入 + 自学习三态迁移流程图

```mermaid
flowchart TD
    START["新增一份系统配置<br/>(+ 可选 Adapter 插件)"] --> VERIFY{"Adapter 签名/权限<br/>校验通过?"}
    VERIFY -- 否 --> REJ["拒绝加载, 保持既有能力<br/>告警(F-SRE-011 拒载保护)"]
    VERIFY -- 是 --> DISCOVER["组件发现与建模<br/>(服务/容器/DB/缓存/日志源/健康端点/磁盘)"]
    DISCOVER --> MODEL["产出系统拓扑 + 初始清单<br/>(接入原子性, 时间可度量)"]
    MODEL --> COLD["进入 冷启动 Cold Start<br/>保守通用阈值, 仅提示不自动自愈"]
    COLD --> WARMUP_Q{"采集 ≥ N 窗口?<br/>覆盖 ≥ M 指标类?<br/>无连续异常空窗?"}
    WARMUP_Q -- 否 --> COLD
    WARMUP_Q -- 是 --> WARM["进入 预热 Warm-up<br/>拟合正常区间(时/日/周周期)"]
    WARM --> PRIOR{"有同类已学习系统<br/>迁移先验?"}
    PRIOR -- 是 --> TRANSFER["应用迁移先验<br/>(标记来源, 缩短预热)"]
    TRANSFER --> WARM
    PRIOR -- 否 --> CONV_Q{"连续 K 窗口基线波动 < X%<br/>或误报率 < Y%?<br/>相邻阈值变化 < Z%?"}
    TRANSFER --> CONV_Q
    CONV_Q -- 否 --> DRIFT{"概念漂移/投毒?"}
    DRIFT -- 是 --> ALERT["漂移告警 + 剔除异常样本<br/>基线变化经审计门禁"]
    ALERT --> WARM
    DRIFT -- 否 --> WARM
    CONV_Q -- 是 --> LEARNED["进入 已学习 Learned<br/>系统特定阈值 + 异常模式, 误报率显著下降"]
    LEARNED --> EVOLVE{"系统行为变化?"}
    EVOLVE -- 是 --> UPDATE["自动更新阈值<br/>(可追溯, 版本化)"]
    UPDATE --> CONV_Q
    EVOLVE -- 否 --> LEARNED
    LEARNED --> ROLLBACK{"误学习/需回退?"}
    ROLLBACK -- 是 --> RB["回退上一稳定基线<br/>(验证误报率恢复)"]
    RB --> WARM
    ROLLBACK -- 否 --> LEARNED
```

### 8.4 事件总线数据流图

```mermaid
sequenceDiagram
    participant A as System Adapter
    participant C as Collector
    participant D as Detector/Classifier
    participant K as Kafka Bus
    participant L as Learning Engine
    participant E as Decision Engine
    participant X as Executors
    participant ES as Escalation Mgr
    participant AU as Audit/DB

    A->>C: 组件模型 + 指标流(system_id)
    C->>K: sre.metrics.raw (≤60s)
    K->>D: 消费指标
    D->>K: sre.anomaly.detected (分级 P0-P3)
    K->>L: 学习样本
    L->>K: sre.learning.update (基线/阈值版本化)
    K->>D: 更新阈值
    K->>E: 消费异常
    E->>E: 裁决链(白名单/签名/kill-switch/学习态/防抖/上限)
    alt 白名单内且通过
        E->>K: sre.healing.command (带签名+system_id)
        K->>X: 消费命令
        X->>X: 执行 + postVerify
        X->>K: sre.healing.result
        K->>AU: 审计写入(per-system)
    else 白名单外/高风险
        E->>ES: 升级
        ES->>ES: 去重/抑制/聚合
        ES->>AU: 审计写入(per-system)
    end
```

---

## 9. 部署与运行拓扑（F-SRE-010 交付增量）

- **交付单元**：`ai-sre` 镜像（版本+签名）+ `docker-compose.yml`/`helm chart` + `bootstrap.sh`（一键接入脚本，含镜像验签、最小配置装载、自检、就绪上报）。
- **配置注入**：目标系统地址/端口/路径/阈值/策略/告警通道全部经配置 + Secret 注入，无系统特定硬编码。
- **多实例水平扩展**：单实例纳管系统数达配额上限时，新增实例水平扩展分工纳管（经 Registry 分片，NFR-X）。
- **凭证**：签名密钥、每系统凭证经密钥管理（Secret namespace）注入，不落盘明文。
- **升级影响**：旁路服务，不动被纳管系统主链路，满足 NFR-A「单点故障不影响业务」；AI SRE 自身部署/升级受变更窗与门禁约束，由 DEVOPS 执行。

---

## 10. 非功能需求映射

| NFR | 架构落位 |
|-----|----------|
| A 可用性 | 独立旁路服务 + PM watchdog + OPS 对等对账双兜底 |
| R 可靠性 | Executor 幂等 + 快照留存 + Kafka 持久化重试 |
| S 安全性 | §5 白名单+签名+kill-switch+熔断+凭证分离+最小权限+per-system 审计隔离；§5.8 报障回执最小权限例外（非业务 PII，目的绑定/脱敏/最小留存） |
| P 性能 | 采集 <1% 负载；检测→告警 ≤2min；单动作 ≤60s 超时转升级 |
| O 可观测 | sre_* 指标 + 审计 + Grafana 看板 + 学习态/历史趋势；Agent 行为侧（做了什么/正在做什么）见 NFR-T/§12；🔁 记录层自包含 SQLite（sre.db）随镜像即含全部 incident/查询审计状态，免外部 DB 观测（§7.1b）；Layer2 对外沟通话术可观测（§2.6/playbook communication） |
| T 透明性/可审计/可追溯 | §12：审计取证表 `sre_audit_events` + 哈希链防篡改(PII掩码)+fail-closed；incident 查询 API(#372，读 SQLite 记录层，§12.2b)；实时状态(#373,轮询+SSE)；lifecycle 状态机显式建模；决策分层 rationale 支持重放（含 `playbook_version`，§2.8）；取证保留锁 |
| C 成本 | 复用现有监控/事件/存储栈（SAS 实例）；通用形态仅新增自包含服务；🔁 记录层改嵌入式 SQLite 免独立 DB/DEVOPS 成本（#372 定案 D） |
| X 可移植/可配置/可扩展 | 镜像零硬编码；配置驱动；Adapter 插件模型；多租户隔离（逻辑→资源级）；🆕 双层配置（md playbook 产品默认 + yaml 部署差异）与动态能力热加载（§2.7/§2.8，红线锁代码层）；🆕 Layer2 沟通层多通道多租户（微信/Slack/Teams/飞书，§2.6） |

---

## 11. 风险与对策

| 风险 | 对策 |
|------|------|
| AI SRE 被攻陷 → 武器化自愈 | 白名单+签名+kill-switch+每日上限+凭证分离（C1） |
| 自愈风暴/误伤健康服务 | no-flap + 冷却期 + 次数/小时上限（C3） |
| 回滚到坏版本/配置漂移 | 回滚目标命中 QA 签收版本集 + post-rollback 一致性校验（C4） |
| 缓存重启导致数据丢失 | 数据损坏 5 判据硬约束，损坏即禁重启（C5） |
| 告警疲劳/重复 Issue | 升级去重/抑制/聚合（C6） |
| AI SRE 自身单点故障 | PM watchdog + OPS 对等对账，DEVOPS 负责修复（C6-m7） |
| 恶意/缺陷 Adapter 污染实例 | 签名校验 + 沙箱隔离 + 拒载保护（F-SRE-011） |
| 学习被投毒/概念漂移带偏基线 | 异常样本剔除 + 漂移告警 + 基线变更审计门禁（F-SRE-012） |
| 多系统横向越权/凭证泄露 | per-system namespace + 跨租户访问拒绝 + 审计隔离（F-SRE-013） |
| 监控数据无限增长 | 保留周期可配 + 复用 Kafka 72h retention |
| 报障通道被滥用/原始报文长期留存 → PII 泄露 | 报障回执最小权限例外硬约束（§5.8）+ 原始报文可选且最小留存自动清理 + 目的绑定/脱敏展示/审计隔离（NFR-S / F-SRE-014） |
| 报障误收/重复告警疲劳 | intake triage 重复/已知合并 + 复用 F-SRE-007 去重抑制（AC-014b） |
| 静默功能 bug 漏检盲区 | QA 功能测试 + F-SRE-014 用户报障兜底（不承诺监控自动检出功能正确性） |
| 事后无法说清「为何自愈/判定」（黑盒决策） | 审计 + 决策依据分层落位（§12.4）+ 版本化策略/基线快照引用，支持 AC-015a 重放 |
| 审计被篡改/越权写他系统审计 | append-only/WORM + 哈希链 + per-system 隔离 + 越权写告警（§12.1，AC-015b） |
| incident 生命周期不可查/黑盒推进 | 显式状态机 + 状态迁移留痕 + 查询端点（§12.2/§12.6，AC-016） |
| 取证期日志被普通回收误删 | 审计/取证保留锁 + 分区隔离（§12.7，对齐 m4 保护） |
| 多系统查询越权泄露他系统 incident/audit | incident/实时/审计按 `system_id` 授权隔离 + 越权拒绝告警（§12.2/12.3/12.5，AC-016b） |
| 记录层 SQLite 文件损坏/单点 | WAL + 单进程写 + app 只读开关；必要时文件快照/备份；零对外服务故障面收窄为单文件（§7.1b，DB-SCHEMA §1a） |
| md playbook 能力被误配/越权放宽自愈 | 红线（白名单外不自愈/冷启动不自愈/旁路不侵入/最小权限）**锁代码层不可 playbook/yaml 绕过** + 准入校验 fail-closed 到上一可用版 + git 版本化回滚（§2.8/§5） |
| 沟通层（Layer2）被利用越权发信/注入自愈 | Layer2 仅消费 Layer1 已裁决输出集、回填客户侧补充；不暴露自愈入口；多租户通道隔离 + 越权发送拒绝（§2.6，ADR-014） |
| 动态能力变更后判定不可复现 | 每次动作记录 `playbook_version`/`policy_version` 入审计与决策引用，支持重放（§2.8/§12.4/ADR-014） |

---

## 12. 透明性与可观测性（F-SRE-015/016、NFR-T、#372/#373）

> 本章落地 FUNCTIONAL-SPEC v0.5.0 升级为一等需求的 «透明性/可观测性» 模块（F-SRE-015 动作审计与决策透明、F-SRE-016 实时状态与 incident 生命周期可见性、NFR-T），并逐项细化附录「待 ARCH 细化」清单 **T-ARCH-1..7** 的实现形态。设计约束沿用本架构既有原则：
>
> - **复用优先 / 🔁记录层自包含（NFR-C，v0.5.0）**：incident 记录层（真实/终态） = 嵌入式 SQLite `sre.db`（§7.1b，非外部共享 PostgreSQL 经自解析）；计数器/限流走 Redis；事件走 Kafka（§4.1 retention 72h）。审计/决策（§§12.1/12.4）如走 PostgreSQL 由各自 #Issue 定；记录层 PII/只读/取证护栏见 DB-SCHEMA §5/§6。
> - **per-system 隔离**（F-SRE-013/ADR-007）：一切可查询/可审计数据按 `system_id` 命名空间隔离授权；审计不得因隔离缺失，也不得被越权旁窥。
> - **fail-closed**（§3.10/UC-017）：不可审计即不可落地——审计写入失败必须阻止/阻断关联动作，不允许「只做不记」。
> - **Issue 为唯一真相源**：incident 查询、实时状态下钻、审计反查均以 GitHub Issue 为业务锚点；透明性模块只「记录/查询/可见」，不承载 AI SRE 决策逻辑，也不替代故障处置本身（处置仍归 F-SRE-005~008/014 既有角色）。
> - **REQ 已定边界（不臆测、不反向改写正文）**：决策可解释到「结构化 + 依据引用」粒度，不承诺逐 token 归档链式推理（因存储成本/隐私平衡，F-SRE-015/016 范围外）。

对本规格新增需求与既有 `sre_incidents.status`（processing 型）、`triage`、`ack_status` 三个字段的关系，本章取 **「增列不覆盖」** 策略：保留既有的检测/升级管线状态与回执状态字段，在其上显式新增**生命周期状态机**（§12.6）并以状态机为准对外暴露，避免破坏 v0.3.0 已落位 scheme 的去重/抑制/升级链路。

### 12.1 T-ARCH-1 审计日志存储 schema（append-only / 防篡改 / PII / 隔离 / 索引）

**目标**：承载 F-SRE-015 的 mandatory 字段（时间戳/actor/动作类型/输入/输出/决策依据），满足「按系统隔离、append-only、防篡改、保留周期可配、PII 脱敏」并可与 AC-015b 的越权写告警衔接。

**表 `sre_audit_events` — 动作级审计取证主表（新，append-only/WORM）**

> 命名遵循 DB-SCHEMA §2（snake_case/TIMESTAMPTZ/ENUM）。此为 AI SRE 动作级审计的 canonical 语料；与既有业务共用 `audit_logs`（SAS/跨系统业务审计）以 `envelope_uuid` 关联（见下「与既有 audit_logs 的关系」）。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | 事件主键 |
| system_id | UUID FK→sre_systems | **命名空间隔离（必填，不允许 NULL 越过）** |
| incident_id | UUID FK→sre_incidents NULL | 关联 incident（可 NULL=系统级/巡检类非 incident 动作） |
| issue_id | INTEGER NULL | 关联 GitHub Issue（业务锚点） |
| occurred_at | TIMESTAMPTZ | **动作发生时刻**（clock/normalized，见时序处理） |
| actor_type | sre_actor_enum | ai_sre / sub_component / intake_channel / human（区分自动与人工触发） |
| actor_id | VARCHAR(64) | ai_sre-service / detector / healer / intake-broker / triage / 运维操作者 |
| action_type | sre_audit_action_enum | 追加到既有 `audit_logs.audit_action` 的一致动作目录（检测/分级/自愈/升级/回执/关单/triage/状态迁移等） |
| input_snapshot_ref | JSONB NULL | **输入**：触发证据/快照引用（引用 id/路径/指针，非全量内联；含快照版本号） |
| output_ref | JSONB NULL | **输出**：动作结果状态与产出物引用（issue_id、incident_id、回执目标、自愈结果 id 等） |
| decision_basis_ref | UUID FK→sre_decision_records NULL | **决策依据**（结构化 rationale，T-ARCH-5/§12.4）；NULL=非决策型纯动作 |
| policy_version | VARCHAR(32) NULL | 命中/据以决策的版本化策略版本 |
| baseline_version | VARCHAR(32) NULL | 命中/据以决策的版本化学习基线（可空=无基线依赖动作） |
| trace_id | UUID | 整条因果链请求追踪 id（端到端传播） |
| prev_hash | CHAR(64) | SHA-256 前序哈希（同 system_id 链内前一条，见防篡改） |
| record_hash | CHAR(64) | 本条 `sha256(规范化字段 + prev_hash)`；签名见证见下节防篡改 |
| tamper_status | VARCHAR(16) | ok（默认，越权写/校验失败时置 alert） |
| created_at | TIMESTAMPTZ | 入库时间（写入审计链时机） |

**存储与保留（分区）**：按 `system_id`（首键）与 `occurred_at` 时间范围做 RANGE 分区（§12.7 统一回收/取证边界兼容）；查询索引 `(system_id, occurred_at)`、`(incident_id)`、`(issue_id)`、`(trace_id)`、`(actor_id, action_type)`。

**append-only / 防篡改（WORM·哈希链·签名选型）**：
- **方案选型**：对比（a）对象存储 WORM/S3 Object Lock、（b）独立区块链/外部见证、（c）应用层哈希链 + 数据库权限硬约束——结论取 **（c）为主 +（a）作为长留存归档层**：（a）作为唯一防篡改手段需移动审计出主库、查询不便且授权模型不同步；纯（b）成本与复杂度与规模不匹配。故采用 **PostgreSQL 上 append-only + 行级哈希链 + 分组签名**：
  - **append-only 硬约束**：建表后对 `UPDATE/DELETE/TRUNCATE` 通过触发器/`REVOKE` 拒绝；仅专有写入账户（AI-SRE audit writer）可 INSERT；其它账户（含只读查询）无写权力。
  - **哈希链**：每行 `record_hash = sha256(规范序列化字段 ∥ prev_hash)`，`prev_hash` 取同 `system_id` 链内前一条哈希，构成 per-system 哈希链，使单行改动必然断链、可被跨系统抽查校验发现（AC-015b）。
  - **轮流/分组签名**：按固定步长在链上插入「签名见证行」（用 KMS 持有的非落盘签名密钥做 HMAC/签名），配合审计只读校验器定期校验整链；sig 密钥经 Secret namespace 注入不落明文（NFR-S/C1 同源）。
  - **写入失败→fail-closed**：审计 INSERT 失败或链签名校验失败时阻断关联动作落地、将该动作转升级（对齐 §3.10/UC-017），不允许“动作完成但审计缺失”。
- **PII 脱敏/掩码落地（schema 层）**：`sre_audit_events` **不存**报障者完整联系信息；`reporter_contact_ref` 只存对 `sre_incidents` 脱敏引用的持有 token/掩码（如 `尾号*XXXX`），连接字段全量值经 §5.8 例外仅存于受理上下文的受限列并在展示/审计处以掩码呈现；读取/回执该 ref 的动作单独记 `sre_intake_reporter_contact_accessed`（§5.8）。本表设计不允许写入业务用户 PII 原文字段（schema 无此类列 + 写入网关白名单字段校验 = 物理层无 PII 落点）。
- **越权写 / 篡改告警**：跨 `system_id` 写、改已有行、链断裂、用非签名 writer 账户写——统一由审计守卫拦截并触发告警（AC-015b/F-SRE-013，衔接 §5.7 横向越权）。

**与既有 `audit_logs`（跨系统业务审计）的关系**：不新建替代、不重复矛盾——对外可见的「升级/Issue/通信/状态」等高阶外化动作继续镜像落 `audit_logs`（保持既有跨角色业务审计可读性），`sre_audit_events` 为 AI SRE 机器内部动作 + 决策依据的 canonical 取证语料；两者以 `trace_id`（/ `envelope_uuid`）关联，共 `system_id` 命名空间；存量在 §7.2 追加过的 `audit_action` 值保留。

### 12.2 T-ARCH-2 incident 查询 / 列表 API 契约（#372）

**形态**：REST（JSON）读接口，仅消费**持久化的一致状态（非内存快照**，对齐 AC-016）。🔁 v0.5.0：incident 记录层由 PostgreSQL 改为嵌入式 SQLite（#372 定案 D），故本契约的读目标实为 **SQLite `sre_incidents` 及关联表**（见 §12.2b / DB-SCHEMA §7）；最终路由前缀最终由 DEVOPS/网关统一定（见 §12.5 入口），此处给 API 形状约定。鉴权按 §12.5 读取令牌 → 后端强校验 `system_id ∈ 所辖集`，越权拒绝并告警（AC-016b）。

列表：`GET /incidents`
- Query（白名单）：`system_id`(可空=所辖全系统，非空时须在授权集内)、`status`/`lifecycle`、`source`(detected/intake)、`severity[]`、time 区间 `created_from / created_to`、`issue_id`、`q`(对现象/标题子串)、`sort/order`(默认 occurred_at desc)。
- 分页：游标分页 `cursor / limit`（默认 20，上限可配置）返回 `next_cursor/total`；不为 null 语义歧义（AC-016b：空子集→200 空数组而非报错）。
- 精简字段投影：返回列表行含`{id, system_name, lifecycle, severity, triage, source, affected_component, ack_status, issue_url, created_at, updated_at}`；**不回传**全文描述与任何联系字段。
- 响应：`{items:[...], next_cursor, count}`；错误用统一 `{code,message,field?}`（401/403/404/422/429）。

详情（单条 + 关联动作轨迹可下钻）：`GET /incidents/{incident_id}`（含 `scope=full|trace|audit`）
- `scope=full`：完整 incident 字段（**PII 相关联系字段一律掩码/不回**，经 `reporter_contact_ref` 掩码形态）。
- `scope=trace`：附加 incident 时间线（状态迁移每跳时间/触发者/依据，§12.6）；`scope=audit`：返回关联 `sre_audit_events` 动作轨迹（审计视角，含 decision_basis 概要而非原始全文）。

**审计**：所有查询请求经审计（只读 `action_type` 用 `sre_incident_query/read` 记入查询审计 `sre_incident_query_audit`，actor=query-console），支持事后「谁查过什么」。

**12.2b（🆕 v0.5.0 注释）**：查询只读源 = SQLite 记录层（`sre.db` `sre_incidents`，列表谓词与 `occured/created` 等索引见 DB-SCHEMA §7/SQLite 复合索引）；`scope=trace` 由 `sre_incident_state_transitions WHERE incident_id=? ORDER BY occurred_at` 组时间线，`scope=audit/决策` 经 refer DB-SCHEMA §5；过滤白名单 / PII 掩码 / 空子集 200 等同 v0.4 契约。

### 12.3 T-ARCH-3 实时状态（正在做什么）暴露机制（#373）

**范围**：AI SRE 当前 **active / 排查中任务**（正在巡检对象、正在对某服务自愈、正在排查某 incident、正在 triage 哪条报障、正在发送升级/回执）可查询——字段至少：current task/action、作用系统与对象、开始时间、当前阶段、进度/最近活动（完成态落在审计轨迹连结果，不常驻实时）。

**数据模型（实时态）**：内存活动注册表（热路径、低读延迟）+ 幂等镜像到 `sre_runtime_activity`（持久，重启可恢复续读）；仅存「进行中」，任务结束即写入 audit 并退出本轮展示。计数器存在 Redis（§4.1 约束）。

**传递机制选型（轮询 vs 事件流/长连接）**：对比轮询/短轮询 vs SSE vs WebSocket 长连接——结论取 **「短轮询为主 + SSE（Server-Sent Events）作为实时面增强」的两段组合**：
- **短轮询为主**：`GET /active-tasks`/`GET /systems/{system_id}/active-tasks` 返回当前 active+最近刚完成（默认 5s 新鲜度）；实现与鉴权最简单、无状态、利于多系统查询与横向扩展，适配「控制台按需翻页/检索（对账）」多数场景。
- **SSE 事件流**：`GET /active-tasks/stream`（EventSource）供控制台「实时正在做什么」看板单向监听；SSE 单向低开销、天然 HTTP 集成，避免 WebSocket 双向/长连接状态机复杂度（状态迁移同步在库中，SSE 仅是 UI 显示优化，非数据真实性来源）。
- **不做 WebSocket 双向推送**（不需客户端上行实时、增加有状态连接/鉴权/横向扩展成本）：ADR-010。
- Kafka 事件（sre.* topic）与实时状态**分开**：Kafka 负责动作/healing/triage 事件流水与重放，对外可见的「进行中」由注册表/镜像提供——避免把高频流用于低配额 UI 轮询。

**时效上限（量化，对齐 NFR-T「时效可见」）**：以“状态已公开可见的变化到查询能读到”的 **一致可见延迟 P99 ≤ 5s** 为目标（等于默认短轮询新鲜度；状态迁移在事务提交即库内可见，无非共享快照需要）；实时任务结束/重启续读不影响该界。实时 action 的**开始/阶段/最近活动**更新与审计最终落点不强绑定每跳（阶段级 heartbeat 可与审计分频率，避免高噪声刷审计），但**终态必须落在审计**（防“行动已做但审计缺终态”），对齐 fail-closed。

### 12.4 T-ARCH-5 决策依据 / 可解释分层（可复现，AC-015a）

**问题界定**：“决策依据（rationale）为什么这么做”既需机器可结构化/可查询，又需“能再次说清”，同时范围外约束要求不把每次内部逐 token 链式推理完整存档。故采用可解释分三层。

**可解释分层（三层）**：
1. **结构化决策记录（canonical）**：`sre_decision_records`（新表，`system_id`+`incident/issue` 归属）：decision_type(grading/triage/self-heal/escalate/rollback/close/reopen)、actor、决策结果、命中规则/条款 id、满足/违反的门禁项、置信度、被考虑的替代路线及其被拒理由引用、决策时间戳。
2. **引用层（快照/策略/基线）**：不内联全量数据，存 `input_snapshot_ref`（同一 incident 的可观测输入快照 id）、`policy_version`、`baseline_version`、相关 issue/incident id——重放时按版本取 policy/baseline 与快照即可**再算一遍得到一致决策**（对齐 F-SRE-015/NFR-T 可复现/AC-015a），不落图片/长文本字节。
3. **摘要层（仅概要）**：当决策确由云端 LLM 做复杂推理时，仅存**短摘要**（决策要点/依据引用/被排除路线一句话），并在 decision record 上置 `rationale_mode=summary`，不把推理链当规范文本整体归档（对齐范围外“不逐 token、降级保留决策摘要与依据引用”）。

**与版本化策略/基线对齐（Replay 契约）**：decision record + audit 行都要记触发当时的 policy/baseline **版本号**；版本化机制沿用 §7.2 版本化白名单/基线表，并新增 **md playbook 能力文档版次**（§2.8，记 `playbook_version`）。重放器 = ①取该行版本策略/基线 → ②取该 incident 输入快照 → ③跑同规则引擎 → ④比较断言分支是否一致/可解释；不一致即质检（CHECKER）/取证走查发现回归点。任何无 policy/baseline 版本可依的决策视为「不可复现」并在此前 fail-closed 拦截写出该决策审计（AC-015a 负侧）。

**12.4b（🆕 v0.5.0 注释）**：决策记录/决策依据相关表如果并入记录层，则同 SQLite 落地（DB-SCHEMA §4/§6），哈希链/只读校验由 app 见证层实现；§2.8 playbook/agent 能力文档版本纳入 policy_version 引用链，保证“哪个剧本驱动了这次判定/话术”可重放。

### 12.5 T-ARCH-4 运维控制台 UI 架构（做了什么/正在做什么，#373）

**定位与只读边界**：控制台 = 透明性运营侧**只读入口**，仅消费本模块暴露的数据端点；**不含任何 AI SRE 决策/写入/处置控制**（处置仍回 issue/既有角色）；也不承载审计写入。

**前端架构**：沿用仓库现有 Dashboard 前端栈（静态 SPA/轻量 VDOM，非重型框架新增组件），与控制台 DASHBOARD UI 同源同鉴权体系；经 BFF/网关层做鉴权聚合、PII 掩码、接口收敛后供 UI 消费（UI 不裸连后端）。后端可选用现有网关/AI-SRE 服务提供读端点（§12.2/12.3）。

**核心组件/页面划分**：
- Incident 列表页：检索/分页（§12.2 过滤白名单），行内展示 lifecycle/severity/triage/source/ack/issue 链接。
- Incident 详情页：字段 + `lifecycle` 时间线（每跳状态/时间/触发者/依据，scope=trace）+ 可下钻到动作（scope=audit，audit 反查决策依据概要）。
- 「正在做什么」实时看板：短轮询/SSE 拉 active task（§12.3），每秒刷新心跳即可；作用系统/对象/开始时间/阶段/最近活动。
- 「做了什么」Audit explorer：按 system/时间/action_type/incident 过滤审计动作与决策记录；**联系字段一律掩码**。
- 系统隔离选择器：UI 顶部按 `system_id` 切换（每系统视图独立），所辖权限在网关层限，越权请求进审计告警。

**权限模型（UI 侧落地）**：复用既有角色的读权限 + per-system scope；不做新的超大权限角色；操作员只能看“被授权系统的 incident/审计/实时”；UI 本身无改/删审计入口（只读、掩码、越权由后端协同拒绝）；可增加只读 OPS 看板默认视图。多系统下 UI 不感知底层实现，仅消费网关聚合后的结果。#373 交互/visual 细化归 ARCH/DEV 后续 UI-SPEC 迭代，本题专注结构与鉴权边界。

### 12.6 T-ARCH-6 incident 生命周期状态机显式建模

**新增 `sre_incident_lifecycle_enum`（显式化状态机，F-SRE-016）**（保留既有 `sre_incidents.status` processing 管线字段、`triage` 字段与 `ack_status`，二者描述**同一 incident 的不同视图**，重 def 以 lifecycle 为准对外）；状态机新增表示：`reported(报障/受纳) → triage(dup/known/new 三判并入) → accepted/in_progress(受理/处理中) → investigating(排查) → closed(关单)`；外加并入分支（dup/known→ 并入源 incident，不入 investigating；new→进入 investigating）。既有 detected 路径（监控源）在「进入处置」前并入 reported/或直接以 investigating 起步，由 §7.2 事件类型桥接。

**合法迁移表（可配、不默写跳跃；关单非“静默复活”）**：

| 从状态 | → 到状态 | 触发者/条件 | 依据 |
|--------|----------|-------------|------|
| reported | triage | intake/normalize | input+证据引用 |
| (detected 汇入) | reported / investigating | detector | 可观测信号 |
| triage | accepted/in_progress | triage=new | 判定 new |
| triage | closed(并入) | triage=dup/known | duplicate_of_id/known issue id（并入源） |
| accepted/in_progress | investigating | 定向排查触发 | 依据引用 |
| investigating | accepted/in_progress | 等待 DEV/人工 | 转出引用 |
| investigating | closed | 修复+验证 / 转 DEV 关单 | result+证据 |
| accepted/in_progress | closed | 人工/suppressed | 处置人+依据 |
| closed | closed | —— | ——（不允许） |
| **closed | （re）reopen-able（须显式）** | 人工 reopen 携带 reopen_reason | 审计新事件，非静默复苏 |
| await issue 同步任一态 | 对应 issue state | issue-state 变化回写 | audit 证据 |

- **防静默复活硬约束**：closed 的唯一合法出路是**显式 reopen/bug-bash**（带原因与关联证据、写新 audit 事件 + 打开新的 investigating），不允许 closed 被流程「不知情」拉回任何未完结处理态（AC-016）；任何对 lifecycle 的非迁移表跳转在网关层拒绝并在审计记录错误。

**落库/落接口**：incident 行 + 独立 `sre_incident_state_transitions`（谁/何时/依据/旧新 state）写迁移历史；对外 API（§12.2 scope=trace）即读该历史表 + 当前 lifecycle 字段。状态集合与迁移表用**配置驱动**（系统无关、可调整）而非写死代码枚举分支（对齐 NFR-X 可配置）。

**12.6b（🆕 v0.5.0 注释）**：lifecycle 相关表（`sre_incidents` 增列 + `sre_incident_state_transitions` + `sre_incident_query_audit`）为**嵌入式 SQLite 记录层**真值（#372 定案 D），权威类型/CHECK 取值表见 DB-SCHEMA §3/§5 与 DATA-DICTIONARY；枚举取值集、权威投影、Reopen 唯一出路在本节不变，存储形态由 PG 换 SQLite。

**与现有 Issue 状态映射**（Issue 为唯一真相源；issue 状态变化回写，Issue closed 对应 lifecycle closed，Issue reopen→显式 reopen 带原因；assigned/in-review→investigating/等待人工等按实情），见迁移表末行：Issue open→ lifecycle 相关处理态，Issue closed→closed；Issue title/body 保持带 system tag 前缀的做法（对齐 §6.2）。**给 DEV 的前置提示**：既有 `sre_incidents.status`/`triage`/`ack_status` 与本节 lifecycle 的关系需在实现时给出权威状态联合/投影规则（见 §12.8 为 DEV 说明），非“新增状态字段即内部两套漂移”。

### 12.7 T-ARCH-7 日志回收 vs 取证保留边界（分区与保留策略）

**12.7b（🆕 v0.5.0 注释）**：SQLite 记录层无原生 RANGE 分区 → 原“分区 per-table by occurred_at”在记录层改由**复合索引 + “筛选/归档迁移”**承接（DB-SCHEMA §5.2）；取证保留长留存、`BEFORE UPDATE/DELETE` 触发器护栏 + app append-only writer + 文件权限（无 PG 角色/RLS），按龄归档走“整段抽离 + 起始标记”而非行删除（DB-SCHEMA §6）。Kafka/监控指标/审计如仍走 PostgreSQL 的保留分区描述对本节其余部分适用。

**分层生命周期（谁回收、谁不回收）**：
- Kafka 事件（§4.1）：retention 72h，仅内部事件流水，不承担审计真相（真落在 PostgreSQL）。
- 通用监控/指标历史（PostgreSQL 普通业务表/指标视情况）：正常保留周期可配（默认如 30d，按系统）——走普通回收。
- **审计/取证语料（`sre_audit_events` + `sre_decision_records` + `sre_incident_state_transitions`）**：默认长留存且**不走普通日志回收路径**（NFR-T/C 例外）；按合规/取证需要配置独立保留与归档导出。
- **「正在调查/审计/取证的 incident」保护（对齐 m4）**：审计保留锁（investigation/hold flag）——某 incident（或某审计对象、某 issue 关联案件）被标记 under-audit / 被取证引用时，其关联的 audit/decision/原始快照/（需保留的 intake raw）**禁止被任何回收删**，直至人工/授权解除保护并在审计记录解除动作；任何回收作业扫描须先跳过带锁分区。

**分区与保留实现**：per-table 时间范围分区（RANGE on occurred_at/closed_at）便于按龄整体 DROP/归档而不触碰在途；审计表按 `system_id`（首）分区提供 per-system 独立留存/归档与越权分离；回收以“分区/建档移动”为先而非行级删除；保留策略表（表类 × system × 期限 × hold-flag）配置驱动。导出归档（合规需要）走对象存储 WORM 层（§12.1），并保留审计可查。

### 12.8 需求覆盖速览（透明性）+ 给 DEV 的前置清单

需求覆盖速览：F-SRE-015→§12.1/12.4；F-SRE-016→§12.2/12.3/12.5/12.6；NFR-T/O→本节 + §10 映射行；AC-015/016 → §12.1(AC-015b)/12.4(AC-015a)/12.2(AC-016b)/12.3(AC-016a)/12.6(AC-016)。

**进入实现（#372/#373）前给 DEV 的前置信息**（非代码，提示既订方案边界）：
- 明确 `sre_incidents.status`（processing）、`triage`、`ack_status`、新增 `lifecycle` 四者的权威投影/联合规则，避免双源漂移；incident → Issue → audit 引用统一 `trace_id/envelope` 链。
- 审计 append-only/哈希链/签名密钥经 KMS 注入、只读校验器与越权写告警、fail-closed 衔接（§12.1）。
- 查询 API 过滤白名单与 per-system 鉴权、PII 掩码投影（§12.2）；实时状态仅表驱动 + SSE 可选（§12.3），不做持久高频长连接。
- 决策分层引用版本（policy/baseline）+ 摘要式 rationale，禁用逐 token 落库（§12.4）；lifecycle 配置驱动 + reopen 带原因（§12.6）；审计/取证与日志回收分区与 hold lock（§12.7）。
- （v0.5.0）记录层 = 嵌入式 SQLite（sre.db）：SQLite DDL/`schema_version` 幂等迁移 per DB-SCHEMA(SQLite)，读路径（IncidentReader/repository）改走 SQLite 而不再含 PG DSN；Layer2 沟通层仅消费 Layer1 裁决输出/回填、不注入自愈命令（§2.6）；md playbook（Playbook 层）热加载 + `playbook_version` 入决策/审计（§2.8），安全红线不因 playbook 可配（§5/§2.8）。
---

## 架构决策记录 (ADR)

### ADR-001：AI SRE 运行时采用「独立常驻服务 + 复用 Agent 生态协作层」

- **背景**：AI SRE 需 7x24 全天候、≤60s 采集、≤2min 检测到告警、旁路不侵入。若完全复用 PM 会话运行时，会引入 LLM 推理延迟、Token 成本、且监控/自愈逻辑与 PM 调度耦合；若完全独立成系统，则无法融入现有多 Agent 协作。
- **决策**：核心运行时为独立常驻 `ai-sre-service`（规则+策略引擎驱动，确定性逻辑不依赖 LLM），协作层复用 write_message.py/agent-status/GitHub label/Dashboard 并注册为 Agent 角色，复杂根因定位按需云端 LLM。
- **理由**：符合 HYBRID-ARCHITECTURE「本地流程编排 0 成本 0 延迟 + 云端深度推理按需付费」分层。
- **影响**：新增自包含容器与受限运行账户；需将 AI SRE 注册进 Agent 生态（§6）。

### ADR-002：事件通道复用 Kafka（降级备选 Redis Streams）

- **背景**：监控→检测→分级→自愈/升级→审计需要可靠的异步事件通道，NFR-C 要求优先复用现有基础设施。
- **决策**：主通道复用现有 kafka 容器，新增 `sre.*` topic；Redis Streams 作为 Kafka 单机不可用时的轻量降级备选。通用交付形态内嵌轻量事件总线实现，可配置替换为外部 Kafka。
- **理由**：Kafka 支持持久化/重试/消费组，满足「告警不丢失 + 升级失败重试」；避免引入新消息中间件成本。
- **影响**：需建 topic 与配置 retention；实现 Kafka↔Redis Streams 降级切换逻辑（或先仅 Kafka，降级作为演进项）。

### ADR-003：自愈权限模型采用「分层授权：策略引擎自动放行低风险 + PM 软授权高风险 + 全局 kill-switch」

- **背景**：自愈能力是双刃剑——既要自动化简单故障恢复，又要防止被攻陷后放大攻击、以及误伤生产。
- **决策**：新增 Action Class `SRE_HEAL` 并入 SVA gate；低风险动作经白名单+签名+限流自动放行；回滚部署必须 PM 软授权或严格门禁；全局 kill-switch 可一键冻结全部自愈。
- **理由**：在「自动化收益」与「安全可控」间平衡；高风险操作保留人工裁决，低风险操作快速恢复减少 MTTR。
- **影响**：需扩展 docs/SVA-GATE.md 增加 AI SRE Role-Action 矩阵；实现策略引擎 + kill-switch + 签名体系。

### ADR-004：交付形态采用「自包含容器镜像 + 编排清单 + 一键接入脚本」（F-SRE-010）

- **背景**：AI SRE 需部署到任意新环境（新主机/集群/云账号/本地），且配置与代码分离、凭配置即运行。
- **决策**：以自包含镜像（带版本+签名）+ compose/helm 编排清单 + bootstrap 脚本交付；镜像/代码零系统硬编码，SAS 仅以默认示例 profile 随发行附带；配置经文件/环境变量/Secret 注入。
- **理由**：容器镜像天然可移植（同一镜像跨环境复用，仅差异在配置与 Secret）；编排清单声明运行拓扑/配额/Secret 挂载；bootstrap 脚本实现「空环境凭最小配置启动进入待接入态」。
- **影响**：DEV/DEVOPS 需产出镜像构建链、编排清单模板与接入脚本；建立最小配置 schema 与校验。

### ADR-005：系统接入采用「Adapter 插件模型（接口抽象 + 可插拔 + 签名 + 沙箱）」（F-SRE-011）

- **背景**：接入新系统须不改核心代码，且需防止恶意/缺陷适配器攻陷或污染实例。
- **决策**：定义 `SystemAdapter` 接口抽象（发现/建模/采集），插件包带签名与最小权限声明、运行于独立进程/沙箱，支持热加载与回滚；内置 Generic HTTP Adapter（降级路径）、SAS Adapter（参考）、Docker Adapter。
- **理由**：插件模型将系统差异封装在插件层，核心零硬编码；签名+沙箱+拒载保护满足「任一缺陷适配器不得攻陷实例」；热加载/回滚满足生命周期管理。
- **影响**：需实现插件运行时（沙箱、签名校验、热加载/回滚）；定义 Adapter 接口契约与最小权限声明规范。

### ADR-006：自学习引擎采用「三态状态机 + 量化迁移判据 + 迁移先验库」（F-SRE-012）

- **背景**：AI SRE 需对新系统学习基线指标与异常模式，且学习结果可测、可回退、防投毒/漂移。
- **决策**：实现 per-system 三态状态机（冷启动/预热/已学习），量化迁移判据对齐 AC-012（N=7/M=4、K=14/X=20%/Y=5%/Z=5%、迁移缩短 ≥25%）；冷启动态仅提示不自动自愈；学习结果版本化可回退；迁移先验标记来源；异常样本剔除 + 概念漂移告警 + 基线变更审计门禁。
- **理由**：三态+量化参数使「可学习」可被 QA 独立验证；冷启动保守姿态降低早期误自愈风险；版本化+回退保证误学习可恢复；投毒/漂移防护防止基线被带偏。
- **影响**：需实现基线拟合/阈值收敛/异常模式学习算法、迁移先验库、学习状态持久化（§7.4）。

### ADR-007：多系统隔离采用「per-system 命名空间 + 凭证命名空间隔离 + 审计隔离」（F-SRE-013）

- **背景**：单实例同时纳管多个系统，需防止横向越权、凭证泄露、跨系统审计篡改。
- **决策**：每系统独立 namespace，配置/凭证/策略/审计/学习状态全部按 `system_id` 隔离；凭证以独立 Secret namespace 注入，跨租户访问强制拒绝并告警；审计日志按系统隔离存储、仅追加写；高敏感/高合规系统触发资源级隔离（独立进程/独立存储）。
- **理由**：逻辑隔离（namespace）为主、资源隔离为触发式升级，兼顾成本与安全；满足 F-SRE-013/NFR-X 与 AC-013a 横向越权负向验收。
- **影响**：所有业务表加 `system_id` 列（§7.2）；Registry 层强制命名空间校验；Secret 管理按 namespace 隔离。

### ADR-008：用户报障接入采用「可配置 intake 通道 + 归一化 + triage 三分类 + 复用 incident/Issue 闭环」（F-SRE-014）

- **背景**：AI SRE 只检测可用性/可靠性，「功能不工作但系统健康运行」的盲区需用户侧兜底；且接入须系统无关，不写死某套工单系统。
- **决策**：新增一组可配置 intake 通道（Web 表单/IM/邮件/工单 webhook 等，见 `intake_channels` §2.4），经统一 intake 接口收纳为第二输入源；报障归一化为结构化 incident（复用 `sre_incidents`，落 §3.11/§7.2 字段）；triage 重复/已知/新建三分类（对齐 F-SRE-007 去重抑制，AC-014a/014b）；新建触发定向排查或转 DEV，均经 Issue；向报障者回执受理→处理→关单，回执联系信息受 NFR-S「报障回执最小权限例外」约束（§5.8）。
- **理由**：补位功能正确性盲区（配合 QA 测试），保持「Issue 为唯一真相源」与既有 Agent/PM/DEV 流程同源；复用现有 incident/升级/审计链路而不引入整套路工单系统，维持通用可插拔；最小权限例外把「回执所需联系信息」明确为受限非-PII。
- **影响**：需实现各 intake 通道适配与统一收纳接口；扩展 `sre_incidents`/`audit_logs`（§7.2）；triage + 回执闭环逻辑；配置 schema 增 `intake_channels`（可为空/缺失 = 不启用）。

### ADR-009：审计取证存储采用「PostgreSQL append-only + 行级哈希链 + KMS 分组签名（WORM 归档层备用）」

- **背景**：F-SRE-015/NFR-T/T-ARCH-1 要求每一动作留 audit（时间戳/actor/输入/输出/依据），append-only、防篡改、per-system 隔离。若仅靠 DB 权限无法抗越权/篡改侦测，防篡改方案需在成本、查询便利与可审计间取舍，并要与既有跨角色 `audit_logs` 互不矛盾。
- **决策**：新增 canonical 取证表 `sre_audit_events`（mandatory 字段 + decision_basis/policy/baseline/trace_id + prev_hash），本表 UPDATE/DELETE/TRUNCATE 拒绝、仅专有 writer 可 INSERT；行级 SHA-256 哈希链（per system_id 链）+ 用 KMS 持有的签名密钥做步长见证签名；审计只读校验器定期验链；PII 不落 schema（联系字段仅在受理语境掩码），跨 system_id 写/断链/非授权 writer 触发越权写告警；`audit_logs` 承接高阶外化/业务审计并镜像同源 events；审计作为长留存取证语料，合规归档层可选对象存储 WORM（§12.1/§12.7）。
- **理由**：应用层哈希链 + 数据库硬权限约束在 NFR-C 成本下达成可证伪防篡改，保留 PostgreSQL 上可查询可审计能力；KMS/Secret 签名密钥不落明文满足 NFR-S/C1；独立取证表避免与业务 audit_logs 混合导致的保留/越写粒度漂移，同时用 trace_id/envelope 与既有审计桥接；fail-closed 写失败阻断动作（AC-015b）。
- **影响**：需实现审计写入网关（白名单字段校验/掩码）、哈希链与签名见证、只读校验器与越权写告警、表分区与保留锁（§12.7）。

### ADR-010：实时「正在做什么」暴露采用「短轮询为主 + SSE 单向事件流为辅」，不引入 WebSocket 双向长连接

- **背景**：F-SRE-016/T-ARCH-3 需运维侧能查询 AI SRE 正在做什么（active/排查中任务），时效上限需量化（NFR-T「时效可见」），并要服务 #373 看板。
- **决策**：在内存活动注册表 + `sre_runtime_activity` 幂等镜像上，提供 `GET /active-tasks`（短轮询，按需/对账）与 `GET /active-tasks/stream`（SSE 单向供实时看板）两种读接口；状态完成即迁出实时并落 audit；目标一致可见延迟 P99≤5s；不采用 WebSocket 双向长连接，Kafka 事件（sre.*）与实时 UI 查询分开（Kafka 管事件流水/重放，实时 UI 管增量展示）。
- **理由**：多数「查询/对账」场景需无状态、易扩展、鉴权简单——短轮询最直接；SSE 单向低开销天然 HTTP，够 UI 实时增强用而无状态机复杂度；WebSocket 双向对无上行操作需求属于过度设计并引入有状态连接/横向扩展/鉴权成本；区分事件流与实时 UI 避免以低频 UI 轮询消费高频 Kafka。
- **影响**：需实现 active-task 注册表与镜像、短轮询 + SSE 接口、终态落 audit 的衔接，以及 5s 新鲜度语义/监控；SSE 仅为展示优化，非数据真实性源（真相在库）。

### ADR-011：决策依据采用「结构化 decision record + 快照/策略/基线版本引用 + 摘要式 rationale」三层可解释分层

- **背景**：NFR-T/F-SRE-015/AC-015a 要求决策（分级/triage/自愈/升级）可在版本化策略与输入快照下重放自明，又因范围外约束不逐 token 归档链式推理。
- **决策**：决策分三层——①结构化 `sre_decision_records`（类型/actor/结果/命中规则/门禁/替代路线拒绝/置信度）；②引用层（`input_snapshot_ref`、`policy_version`、`baseline_version`、issue/incident id）供重放器按版本+快照重跑；③`rationale_mode=full|summary`（复杂 LLM 推理仅存短摘要，不存全文链）。
- **理由**：“能再次说清为何如此判定”可考究为「引用版本化规则/基线+同输入可重算一致」这一机器可验证契约，而非保存可读全文；满足 AC-015a 可复现又不无限放大存储/隐私开销并遵守范围外边界；无版本可依的决策视为不可复现并被 fail-closed 前置拦截。
- **影响**：需实现 decision record 存储/写入网关/掩码、重放器（取版本策略+快照）、rationale 摘要在 LLM 路径接入时生成并落引用，版本引用与 §7.2 版本化策略/基线对齐。

### ADR-012：incident 生命周期采用「显式状态机 + 合法迁移表（配置驱动）+ 保留既有 status/triage/ack 三字段投影」建模

- **背景**：F-SRE-016/T-ARCH-6 需把 incident 流转显式化为可查询状态机（报障→triage→受理→排查→关单），防关闭态静默复活。而既有 `sre_incidents.status`（processing 型）等是本架构 v0.3.0 已落位的去重/抑制/升级链路所用。
- **决策**：以「增列不覆盖」策略新增 `sre_incident_lifecycle_enum` 作为对外规范状态 + `sre_incident_state_transitions` 迁移历史；合法迁移表 + reopened（带原因）显式；closed 唯一出路是显式 reopen；`status/triage/ack_status` 保留作为操作面/源流字段并与 lifecycle 给出权威投影（实现期由 DEV 定义联合/投影规则，见 §12.8）。迁移表与状态集合配置驱动，与 Issue 状态映射（open/assigned/in-progress↔investigating 等、Issue closed↔lifecycle closed、Issue reopen→显式 reopen）。
- **理由**：满足 F-SRE-016 的可查询、留痕、防重生（AC-016）同时不破坏既有监控/自愈/escalation 链路；配置驱动对齐 NFR-X 可配置、不硬编码分支；Issue 为唯一真相源便于与 PM/DEV 流程同步。
- **影响**：需实现 lifecycle 枚举/迁移守卫/reopen 原因、迁移历史表与 API scope=trace 读接口，及与既有三字段的投影规则与 issue 状态同步。

### ADR-013：incident 记录层采用「嵌入式 SQLite」（#372 定案 D，替代独立 PostgreSQL）

- **背景**：AI SRE 需可重复部署到任意空环境（§2.1），而 v0.4.0 将 incident/状态/审计落 PostgreSQL 独立服务，带来连接管理、角色/RLS、分区归档等外部 DB 运维（需 DEVOPS/DBA），与“单客户 incident 量小、须零运维自包含”矛盾。
- **决策**：记录层（`sre_incidents` / `sre_incident_state_transitions` / `sre_incident_query_audit`）持久化改为**嵌入式 SQLite 单文件** `sre.db`（WAL、单进程写、`TEXT` 时戳/`TEXT` UUID/`CHECK` 替 ENUM/`json_valid` 替 JSONB/复合索引替 RANGE 分区/`schema_version` 幂等迁移）；审计隔离以 app 写门 + `BEFORE UPDATE/DELETE` 触发器 + 文件权限承接。记录层 SQL 与 DDL 见 `docs/ai-sre/DB-SCHEMA.md`(v0.5.0)。
- **理由**：自包含、零外部 DB 运维、随镜像即含全部状态；单部署=单客户、incident 量小命中 SQLite 适用域；查询端点、PII 掩码、lifecycle 权威投影、Issue 唯一真相源均不因存储换而变。
- **影响**：需实现 SQLite init/迁移与 repository 读路径（替换进程内参照/避免含 PG DSN）；若后续其余表（audit/systems…）也走 SQLite 由各自 #Issue 落 DDL。

### ADR-014：加入 Layer2 沟通层 + 双层配置（md playbook / yaml）+ 动态能力热加载，安全红线锁代码层

- **背景**：需支撑“客户侧多通道运营沟通”且职责与既有执行引擎分离（不改自愈决策归属）；需要“产品默认能力 vs 部署差异”解耦、以及能力随时可调而不改代码/镜像。
- **决策**：分层视角明确 **Layer1 = 既有 `ai-sre-service`（执行 + 记录层 SQLite + 记忆层 agent memory + 真相源 Issue）**，新增 **Layer2 沟通层 agent**（多通道：客户 微信/Slack/Teams/飞书；多租户隔离；只发布 Layer1 已裁决输出/回填客户侧补充，不注入自愈命令）。配置双层：第 1 层产品默认 **md playbook**（`PLAYBOOK/` + patrol/detection/triage/healing/reporting/analysis/communication 七能力模块）、第 2 层部署者初设 **yaml**（systems/channels/routing/policy，只缩不扩红线）。动态能力机制：md 热加载（agent 工作前读最新 + 可选 watch reload + git 版本化回滚 + `playbook_version` 记录对齐 §12.4 重放）；安全红线（白名单外不自愈 / 冷启动不自愈 / 旁路不侵入 / 最小权限）**锁代码层、不可用 playbook/yaml 配置绕过**。
- **理由**：Layer2/Layer1 分离避免沟通 Agent 取得自愈能力放大攻击面（对齐 ADR-003 分层授权）；md+yaml 分层使同发行二进制支撑不同客户运营形态、能力变更不发布镜像；红线锁代码层保障“动态灵活的灵活性不反噬安全边界”。
- **影响**：需实现 SQLite 记录层、Layer2 沟通通道适配器与多租户路由（§2.6）、playbook 目录/schema 校验/热加载/watch/git、playbook_version 加入决策与审计引用；Layer2 不含决策，越权发送/旁路 Layer1 下指令被拒。

---

*本文档为架构设计，不包含业务代码实现。技术选型落地、`ai-sre-service` 实现、Adapter 插件运行时、学习引擎、SVA-GATE/Agent 生态注册由 DEV/DEVOPS 在评审通过后执行。*

---

## 附录：参考实例配置（School Admin System）

> 本附录收编 SAS 作为 AI SRE 第一个参考部署实例的具体参数。**均为示例配置，非代码硬编码、非规范性约束**：AI SRE 本体镜像/代码不含任何 SAS 拓扑/端口/路径/组件构成，SAS 仅以一份默认示例配置 profile（`profiles/sas.yaml`）随发行附带，可删除/替换。

| 类别 | SAS 示例值 | 注入方式 |
|------|-----------|----------|
| 容器 | 13 个 Docker 容器 | SAS profile → SAS Adapter / Docker Adapter |
| 后端健康端点 | `:3000/api/health` | SAS profile（health_endpoint 字段） |
| 前端入口 | admin（:8080）、portal（:8081）等多入口 | SAS profile（frontends 列表） |
| 数据库 | PostgreSQL | SAS Adapter 只读连接（无写权限） |
| 缓存/键值存储 | Redis（缓存/会话用途） | SAS Adapter 只读探测 + 数据损坏检测 |
| 存储 | 文件存储、宿主与数据卷磁盘 | SAS Adapter 资源采集 |
| 日志源 | 聚合日志流（kafka 主题） | SAS Adapter 日志订阅 |
| 事件/监控基础设施 | Prometheus/Kafka/PostgreSQL/Redis/OPA（复用） | SAS profile（可选复用） |
| 运维团队 | PM/DEV/QA/DEVOPS/OPS/CHECKER/ARCH/REQ | 协作层（write_message.py） |

- 上述取值仅用于说明与测试场景构造；AI SRE 从被纳管系统配置读取，不写死进镜像/代码。
- 接入 SAS 时，仅需提供一份含上述取值的 SAS 配置 profile（+ 内置 SAS Adapter），即可完成组件发现、建模与纳管，进入学习三态。
- `:3000`/`:8080`/`:8081` 等 token 仅出现在 SAS profile / SAS Adapter / 本附录，不出现于 AI SRE 核心代码/镜像（对应 AC-011 负向验收）。
