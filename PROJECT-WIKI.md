# PROJECT-WIKI — project-aisre（AI SRE 运维 Agent）

> 本文档是 **project-aisre** 的项目 wiki：版本、架构、运行环境、URL、部署、集成与文档索引。
> 关联上游 Issue：#370（总览）/ #371（报障接入）/ #372（查询 API）。

---

## 1. 版本

| 项 | 值 |
|----|----|
| 服务版本 | `@school-admin/ai-sre-service` **v0.1.0** |
| 运行要求 | Node **≥22**，依赖仅 `js-yaml` |
| 功能规格 | `FUNCTIONAL-SPEC-AI-SRE.md` **v0.4.0** |
| 设计文档 | `DESIGN-AI-SRE.md` **v0.3.0** |
| 当前阶段 | **POC / 试运行**（首个纳管实例 = School Admin System） |

---

## 2. 产品定位

- **角色**：旁路（out-of-band）运维 Agent，团队里「全天候在线的运维同事」。
- **四性**：可部署、可学习、可支持新系统、多系统多租户隔离。
- **检测边界**：只检测**可用性/可靠性**信号；功能正确性由 QA 测试 + 用户报障 intake 兜底。
- **安全红线**：白名单外不自愈、冷启动不自愈、一切动作可审计可追溯（Code-bound，见 FUNCTIONAL-SPEC §8）。

---

## 3. 系统架构

```
                        ┌─────────────────────────────────────────┐
   用户报障 intake ───▶ │           ai-sre-service (:9090)          │
   (webhook/webform)    │                                            │
                        │  adapters (generic_http / 可插拔专用)      │
   被纳管系统 ◀─────────┤     ├ discover / model（组件发现建模）       │
   (SAS 等, 只读探测)    │     ├ collectHealth / Resources / Logs     │
                        │  incidents（triage dup/known/new）         │
   Issue 真相源 ◀──────▶ │  lifecycle 状态机 + 查询 API + 审计        │
   (GitHub, 可选集成)    └─────────────────────────────────────────┘
```

- **配置与代码分离**：所有环境差异（地址/端口/路径/凭据引用/阈值/策略/告警通道）经配置注入，
  核心代码/镜像不含任何被纳管系统硬编码。
- **记录层**：自包含 SQLite（对齐 #372 定案 D），存 incident / lifecycle / 审计，零运维、可独立交付。
- **真相源**：可选集成 GitHub Issue（客户的 issue 系统），非 AI-SRE 自有存储。

---

## 4. 运行环境（测试环境）

| 项 | 值 |
|----|----|
| 容器 | `ai-sre-service`（镜像 `ai-sre:test-env`，healthy） |
| 实例 ID | `ai-sre-test-01` |
| 监听 | `0.0.0.0:9090`（宿主 `9090->9090`） |
| 被纳管系统 | `school-admin-system`（adapter `generic_http`） |
| Intake 通道 | `ops_webhook` → `POST /api/sre/intake/ops_webhook` |
| 真实 GitHub Issue 网关 | ⛔ 未接（best-effort / memory sink） |
| 真实回执外发 | ⛔ 未接（write_message.py 未接线） |

---

## 5. HTTP 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 概览（实例 / 接入态 / intake 通道 / 适配器） |
| `/health` | GET | 健康检查（instance / intake / systems） |
| `/api/sre/intake/{channel}` | POST | 用户报障收报（归一化 → triage → Issue → 回执） |
| `/api/sre/intake/status` | GET | intake 状态 |
| `/api/sre/incidents` | GET | incident 列表（过滤白名单 + 游标分页 + per-system ACL） |
| `/api/sre/incidents/{id}` | GET | incident 详情（scope=full\|trace\|audit） |

### 外部访问（经 Coze 代理）

| 端点 | 外部 URL |
|------|---------|
| 健康检查 | `https://aade13aa-91de-4793-9a07-a613f42a5cc4.dev.coze.site/ai-sre/health` |
| 报障 intake | `POST https://aade13aa-91de-4793-9a07-a613f42a5cc4.dev.coze.site/ai-sre/api/sre/intake/ops_webhook` |

> 路由：Coze 代理 `/ai-sre/*` → 宿主 nginx(:5000) `location /ai-sre/` → `127.0.0.1:9090`（前缀剥离）。

---

## 6. 配置 profile

| 文件 | 说明 |
|------|------|
| `config/default.yaml` | 缺省最小配置（systems 为空 = 待接入态） |
| `config/examples/school-admin-system.yaml` | SAS 参考实例 profile（可删除/替换，无硬编码特权） |
| `infra/ai-sre/profiles/minimal.yaml` | 编排最小 profile |
| `infra/ai-sre/profiles/sas.yaml` | 编排 SAS profile |
| `infra/ai-sre/active/school-admin-system.test.yaml` | 测试环境激活配置 |

---

## 7. 文档索引

| 文档 | 版本 | 内容 |
|------|------|------|
| `FUNCTIONAL-SPEC-AI-SRE.md` | v0.4.0 | 功能需求 F-SRE-001~017、用例、NFR、范围外 |
| `DESIGN-AI-SRE.md` | v0.3.0 | 技术架构（适配器模型 / 生命周期 / intake / query） |
| `DEPLOY-AI-SRE.md` | runbook | Docker/compose 部署 + intake 启用 + E2E 验证 |
| `DB-SCHEMA.md` | — | 数据表 schema 契约 |
| `DATA-DICTIONARY.md` | — | 字段字典 |

---

## 8. 与 SAS 的集成

AI SRE 是**独立于 SAS 交付**的运维组件，当前部署用于支撑 SAS 的系统运营与故障排查。
SAS 侧登记见 `PROJECT-WIKI.md`（SAS 项目）与 `docs/school-admin-system/SPEC-SYSTEM-DESIGN.md`（§系统架构）。

---

## 9. 已知边界 / 待办

| 项 | 状态 |
|----|------|
| 真实 GitHub Issue 网关 | 未接（best-effort/memory sink） |
| 真实回执外发（write_message） | 未接 |
| RDBMS 持久化 | 进程内参照实现；`sre_systems` 外键待落地后补 REFERENCES |
| 事件流（Kafka/总线） | 骨架无依赖；真实总线由 DEVOPS 接入 |
| 专用适配器（Docker/DB/缓存） | 未实现，当前为 generic_http 降级（资源/日志占位） |
| 发现结果持久化 / 资产 wiki | **未实现**（discovery 产物为内存态，不落盘） |
