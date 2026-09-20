# AI SRE 运维 Agent — 文档索引

> 本目录是 **AI SRE（系统维护自带 Agent）** 的自包含文档集，描述它是什么、如何工作、如何部署。
> 关联 Issue: **#370（AI SRE 总览）** / **#371（F-SRE-014 用户报障接入，已闭环）**。

AI SRE 是一个独立的运维 Agent 服务（`apps/ai-sre-service/`，Node ≥22 HTTP 服务，默认 `0.0.0.0:9090`），
用于对**被纳管系统**（当前首个实例为 School Admin System / SAS）做系统运营与异常/缺陷自动排查。
它是 SAS 之外**独立交付**的组件，通过「用户报障 intake」通道接收报障并进行三分类（dup / known / new）。

## 文档清单

| 文档 | 版本 | 回答的问题 |
|------|------|-----------|
| [FUNCTIONAL-SPEC-AI-SRE.md](./FUNCTIONAL-SPEC-AI-SRE.md) | v0.4.0 | **它做什么**（功能需求规格，含 F-SRE-014 报障接入） |
| [DESIGN-AI-SRE.md](./DESIGN-AI-SRE.md) | v0.3.0 | **它怎么工作**（技术架构设计，通用可插拔版） |
| [DEPLOY-AI-SRE.md](./DEPLOY-AI-SRE.md) | runbook | **它怎么部署**（Docker/compose 部署 + intake 启用 + E2E 验证） |

## 代码与编排位置

| 位置 | 说明 |
|------|------|
| `apps/ai-sre-service/` | 服务源码（Node ≥22，依赖仅 `js-yaml`，独立于 SAS backend/frontend） |
| `infra/docker-compose.ai-sre.yml` | 可运行的编排清单（本地构建源码镜像 + 健康检查） |
| `infra/docker-compose.ai-sre.m1.yml` | M1 编排骨架（byte-identical 历史件） |
| `infra/ai-sre/` | 编排骨架 + 配置 profile（系统无关，SAS 差异经配置卷注入） |
| `apps/ai-sre-service/src/intake/README.md` | intake 模块（F-SRE-014）实现说明 + QA 验证清单 |

## 当前部署状态（测试环境）

| 项 | 状态 |
|----|------|
| 容器 `ai-sre-service` | ✅ Up (healthy)，映射 `0.0.0.0:9090->9090` |
| Intake 通道 | ✅ 启用 `ops_webhook` → `POST /api/sre/intake/ops_webhook` |
| 被纳管系统注册 | ✅ `school-admin-system`（adapter `generic_http`） |
| 真实 GitHub Issue 网关 | ⛔ 未接（best-effort/memory sink，见 DEPLOY §10.1） |
| 真实回执外发（write_message） | ⛔ 未接（见 DEPLOY §10.2） |

### 外部访问（经 Coze 代理）

| 端点 | 外部 URL |
|------|---------|
| 健康检查 | `https://aade13aa-91de-4793-9a07-a613f42a5cc4.dev.coze.site/ai-sre/health` |
| 报障 intake | `POST https://aade13aa-91de-4793-9a07-a613f42a5cc4.dev.coze.site/ai-sre/api/sre/intake/ops_webhook` |

> 路由映射：Coze 代理 `/ai-sre/*` → 宿主 nginx(:5000) `location /ai-sre/` → `127.0.0.1:9090`（前缀已剥离）。

## 与 SAS 的集成关系

AI SRE 是**独立于 SAS 的运维组件**，当前被部署用于支撑 SAS 的系统运营与故障排查。
SAS 侧如何引用/登记 AI-SRE，见：
- `PROJECT-WIKI.md`（测试环境 URL、架构组件、OPS 监控、文档清单）
- `docs/school-admin-system/SPEC-SYSTEM-DESIGN.md`（§系统架构，AI-SRE 组件登记）
