# AI SRE 部署编排骨架（DEVOPS / M1）

> 关联 Issue #370 — DESIGN-AI-SRE v0.2.0 / FUNCTIONAL-SPEC-AI-SRE v0.3.1
> 本目录为 AI SRE 的【编排与配置】骨架，不含业务代码、不硬编码任何被纳管系统。

## 文件清单

| 文件 | 说明 |
|------|------|
| `../docker-compose.ai-sre.yml` | AI SRE 编排清单（服务拓扑/存储卷/Secret 挂载/健康检查/资源配额） |
| `profiles/minimal.yaml` | 最小配置（系统无关，空系统 = 待接入态，对齐 AC-010） |
| `profiles/sas.yaml` | SAS 参考实例配置 profile（示例值，非硬编码，可删除/替换） |

## 配置与代码分离（F-SRE-010）

- 编排清单【不写死】任何被纳管系统（含 SAS）的端口/地址/路径/组件。
- 目标系统差异全部经「配置卷」`/etc/ai-sre/config` 注入。
- SAS 仅以 `profiles/sas.yaml` 作为默认示例 profile 随发行附带。

## 部署先决条件（供 M6 部署使用，系统无关命名）

部署 `ai-sre-service` 前需准备以下配置/环境项（均系统无关命名，SAS 差异在 profile 内注入）：

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `AI_SRE_IMAGE` | env | 是 | AI SRE 镜像地址（带版本+签名） |
| `AI_SRE_CONFIG_DIR` | env/卷 | 是 | 配置卷路径（挂载到 `/etc/ai-sre/config`） |
| `AI_SRE_INSTANCE_ID` | env | 是 | 实例标识（多实例时区分 AI-SRE-01/02） |
| `AI_SRE_LISTEN` | env | 默认 | 监听地址，默认 `0.0.0.0:9090` |
| `AI_SRE_PORT` | env | 默认 | 宿主映射端口，默认 `9090` |
| `AI_SRE_SIGNING_KEY_REF` | secret | 是 | 自愈命令签名密钥引用（HMAC，非明文） |
| `EVENT_BUS_DSN` | env | 否 | 事件总线 DSN（Kafka/Redis Streams），M1 可空 |
| `STATE_STORE_DSN` | env | 否 | 状态库 DSN（PostgreSQL，审计/学习/限流），M1 可空 |
| `AGENT_WRITE_MESSAGE` | env | 默认 | 告警升级写消息脚本路径 |
| `ai_sre_signing_key` | docker secret | 是* | 签名密钥（生产注入，M1 骨架注释） |

> *签名密钥为自愈安全边界核心（C1），生产部署必须经 Secret/Vault 注入，不落盘明文。

## 启动示例（骨架验证）

```bash
cd /workspace/projects/workspace
AI_SRE_CONFIG_DIR=$(pwd)/infra/ai-sre/profiles \
docker compose -f infra/docker-compose.ai-sre.yml config   # 校验语法
```
