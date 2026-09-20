# project-aisre — AI SRE

> **AI SRE（Site Reliability Engineering / 站点可靠性工程）**：一个**通用、可部署、可学习、可支持新系统**的旁路运维 Agent 服务。
>
> 它作为团队里一位「全天候在线的运维同事」，主动巡检、主动发现问题、主动汇报、按授权边界自主处置——而非被动等待告警。

首个参考部署实例（POC / 试运行）为 **School Admin System（SAS）**。

---

## 定位

| 维度 | 说明 |
|------|------|
| 可部署（Deployable） | 自包含交付（容器镜像 + 编排清单 + 一键接入脚本），任意新环境凭配置即可运行 |
| 可支持新系统 | 接入新系统不改核心代码，只加配置或适配器，即完成组件发现、建模与纳管 |
| 可学习（Self-learning） | 对每个接入系统做行为学习与基线建模，越用越准 |
| 多系统多租户 | 单实例可纳管多系统，配置/凭证/策略强隔离 |

**检测边界**：AI SRE 检测的是**可用性/可靠性**信号（服务健康/资源/错误率/日志异常/心跳），
**不**检测功能正确性（业务逻辑对不对）。功能缺陷由 **QA 测试** + **用户报障 intake（F-SRE-014）** 兜底。

---

## 目录结构

```
project-aisre/
├── apps/ai-sre-service/      # 服务源码（Node ≥22，依赖仅 js-yaml）
├── docs/ai-sre/              # 文档集（功能规格 / 设计 / 部署 / DB schema / 数据字典）
├── infra/
│   ├── docker-compose.ai-sre.yml      # 可运行编排清单
│   ├── docker-compose.ai-sre.m1.yml   # M1 编排骨架
│   └── ai-sre/                        # 编排骨架 + 配置 profile（系统无关）
└── PROJECT-WIKI.md           # 项目 wiki（版本 / 架构 / 部署 / 集成）
```

---

## 快速开始

```bash
cd apps/ai-sre-service
npm install          # 仅 js-yaml
npm run typecheck    # tsc --noEmit
npm run build        # tsc -p tsconfig.build.json
npm run test:intake  # 冒烟自测
npm start            # node dist/main.js  → 监听 0.0.0.0:9090
```

Docker 部署见 [`docs/ai-sre/DEPLOY-AI-SRE.md`](docs/ai-sre/DEPLOY-AI-SRE.md) 与 `infra/docker-compose.ai-sre.yml`。

---

## 文档

| 文档 | 版本 | 回答的问题 |
|------|------|-----------|
| [FUNCTIONAL-SPEC-AI-SRE.md](docs/ai-sre/FUNCTIONAL-SPEC-AI-SRE.md) | v0.4.0 | 它做什么（F-SRE-001~017 功能需求） |
| [DESIGN-AI-SRE.md](docs/ai-sre/DESIGN-AI-SRE.md) | v0.3.0 | 它怎么工作（通用可插拔架构） |
| [DEPLOY-AI-SRE.md](docs/ai-sre/DEPLOY-AI-SRE.md) | runbook | 它怎么部署（Docker/compose + intake 启用 + E2E） |
| [DB-SCHEMA.md](docs/ai-sre/DB-SCHEMA.md) | — | 数据表结构契约 |
| [DATA-DICTIONARY.md](docs/ai-sre/DATA-DICTIONARY.md) | — | 字段字典 |

---

## 关联 Issue

- **#370** — AI SRE 总览
- **#371** — F-SRE-014 用户报障接入（已闭环）
- **#372** — incident 查询 API

---

## License

Private / 内部项目（见仓库可见性设置）。
