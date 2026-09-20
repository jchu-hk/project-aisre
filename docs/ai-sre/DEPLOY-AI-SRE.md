# DEPLOY-AI-SRE.md — AI-SRE Service 部署/启用 Runbook（测试环境）

> 关联 Issue: **#370 / #371** · DESIGN-AI-SRE · FUNCTIONAL-SPEC-AI-SRE
> 部署角色: **DEVOPS** · 目标环境: **测试环境 (test-env)**
> 服务本体: `apps/ai-sre-service/`（独立 Node ≥22 HTTP 服务，默认 `0.0.0.0:9090`，依赖仅 `js-yaml`）
> 交付目标: 部署 `ai-sre-service` 到测试环境，并**启用「用户报障 intake」(F-SRE-014)** + 注册 `school-admin-system`。

---

## 0. 状态速览（部署完成核对）

| 项 | 状态 | 说明 |
|----|------|------|
| 镜像 | ✅ | `ai-sre:test-env`（本地构建自源码，多阶段） |
| 容器 | ✅ | `ai-sre-service` Up (healthy)，映射 `0.0.0.0:9090->9090` |
| 网络 | ✅ | 计入既有 `school-admin-network`（= compose 的 `school-network`），backend 容器内可达 |
| 现有容器 | ✅ | 未改动/未重建主 compose 的既有 14 个容器（仅 `cloudflared` 为历史 exited，与本次无关） |
| Intake | ✅ | 启用 1 通道 `ops_webhook` → `POST /api/sre/intake/ops_webhook` |
| Systems 注册 | ✅ | `school-admin-system`（generic_http） |
| E2E 验证 | ✅ | health 200；new / dup / 428 四用例全过 |
| 真实 GitHub Issue 网关 | ⛔ | **未接**（需代码注入，见 §10.1） |
| 真实回执外发(write_message) | ⛔ | **未接**（需代码注入，见 §10.2） |

---

## 1. 前置依赖

- **Node.js ≥ 22**（镜像内为 `node:22-alpine`）。仅本地直接跑 `npm run dev` 时需要本机 node。
- **Docker / docker compose**（本机既有 Docker 29.x + compose v5）。
- **既有主 compose**：`infra/docker-compose.yml`（测试环境的 14 容器），网络实际名 `school-admin-network`。
- 交付源码已由 QA 验证：`apps/ai-sre-service/`（`dist/` 存在，`npm run build` 可复现）。

> ⚠️ **本机 Docker build 说明**：部署宿主机缺省 `bridge` 网络不可用（沙箱特性，`network bridge not found`），
> 因此 **`docker build` 需显式 `--network host`**（运行期不影响；容器最终计入既存 `school-admin-network`）。

---

## 2. 新增/改动清单（diffs 与新增文件）

| 文件 | 类型 | 说明 |
|------|------|------|
| `apps/ai-sre-service/Dockerfile` | 新增 | 多阶段（build 依赖 + dist + 生产依赖；最小权限 user；`CMD node dist/main.js`） |
| `apps/ai-sre-service/.dockerignore` | 新增 | 排除 node_modules/dist/test 等 |
| `apps/ai-sre-service/package-lock.json` | 新增 | npm-10 兼容锁（原目录无锁文件；为确保可重现构建而补） |
| `infra/docker-compose.ai-sre.yml` | 改写 | **可运行**的表征：本地构建源码镜像 + 挂启用配置 + 计入 school-network + 健康检查 |
| `infra/docker-compose.ai-sre.m1.yml` | 新增 | **保留原 M1 编排骨架**（byte-identical 到 HEAD），避免 schema 与交付代码不符的历史件丢失 |
| `infra/ai-sre/active/school-admin-system.test.yaml` | 新增 | 测试环境启用配置（intake 开 + system 注册 + 保留策略，无明文 secret） |
| `docs/ai-sre/DEPLOY-AI-SRE.md` | 新增 | 本 runbook |

**未改** `apps/ai-sre-service/src/**` 及任何 SAS（backend/frontend）源码。

---

## 3. 构建镜像

```bash
cd /workspace/projects/workspace
# 关键：部署宿主 bridge 缺失，构建必须走 host 网络
docker build --network host -t ai-sre:test-env apps/ai-sre-service
# 或
docker compose -f infra/docker-compose.ai-sre.yml build
```

构建产物（Dockerfile 多阶段）：
- build 阶段：`npm install` → `npm run build`（tsc）产出 `dist/`；
- runtime 阶段：仅 `node_modules`(生产依赖=js-yaml) + `dist/`，`USER ai-sre`（非 root）、`read_only`、`cap_drop ALL`。

> **为什么不 `npm ci`？** 服务目录原无 `package-lock.json`，且交付宿主 npm 为 12（其生成的锁与
> `node:22-alpine` 内 npm 10 不兼容 → npm ci 报 `Cannot read properties of undefined (reading 'extraneous')`）。
> 已在容器内用 npm10 重新生成 `package-lock.json`，Dev/构建建议改 `npm ci`（待 CI 锁校验后再切），见 §9。

---

## 4. 配置参考（逐项）

启用配置在 `infra/ai-sre/active/school-admin-system.test.yaml`，经只读卷挂到容器 `/etc/ai-sre`，
由镜像默认 `SRE_CONFIG_PATH=/etc/ai-sre/school-admin-system.test.yaml` 加载。

### 4.1 `identity`
```yaml
identity:
  instance_id: ai-sre-test-01   # 实例标识（多实例时区分）
  listen: "0.0.0.0:9090"        # 监听地址；服务只绑 IPv4
```
> 只绑 IPv4 → compose physical check 用 `127.0.0.1` 而非 `localhost`（busybox wget 解析 localhost 会先试 `::1` 导致 refused）。

### 4.2 `secrets`（**不落明文**）
```yaml
secrets:
  signing_key_ref: "vault://ai-sre/signing-key"   # 仅【引用】，非明文值
```
真实签名密钥经 Secret/Vault/环境变量注入；本仓库配置只见引用（NFR-S / F-SRE-010）。

### 4.3 `alert_channels`（告警外发）
```yaml
alert_channels:
  - type: write_message
    endpoint: "skills/agent-communication/scripts/write_message.py"
```
> 本服务骨架的采集/升级循环未启动（M2+），故该通道当前为**声明待用**，不主动外发；见 §10.2。

### 4.4 `intake_channels`（用户报障入口，F-SRE-014）
```yaml
intake_channels:
  - type: webhook
    name: ops_webhook          # 路由: POST /api/sre/intake/ops_webhook
    verb: POST
    path: "/api/sre/intake/ops_webhook"
    enabled: true
```
- **≥1 个 enabled 通道 ⇒ intake 注册并启用**（`/health.intake.enabled=true`）。
- `intake_channels: []` 或缺失 ⇒ 待接入态（不注册不报错）。
- 校验：仅启用通道才注册路由，名称默认 `name`，可自定义 `path`。

### 4.5 `systems`（被纳管系统注册）
```yaml
systems:
  - system_id: school-admin-system
    name: "School Admin System"
    adapter: generic_http          # 内置通用 HTTP 只读适配器（无 Docker/DB 专用适配器，M2+）
    profile_ref: "infra/ai-sre/active/school-admin-system.test.yaml"
    credential_ns: "sas"           # 凭证命名空间引用（无明文）
    health_endpoints:
      - name: backend
        url: "http://school-admin-backend:3000/api/health"   # 容器内同网络解析 ✓(自验 rc=0)
      - name: backend-host
        url: "http://localhost:3000/api/health"              # 宿主探测用
      - name: frontend-admin
        url: "http://school-admin-frontend:80/"
    log_sources: [{ type: container_logs, match: "school-admin-backend,school-admin-frontend" }]
    resource_probes: [{ type: disk, mount: "/data" }]
```
> **接入真实 host/container 地址经配置注入**，代码与镜像零 SAS 硬编码（F-SRE-010）。
> generic_http 仅做只读健康/建模，不写回纳管系统（旁路）。

### 4.6 `intake_retention`（NFR-S §5.8 保留策略）
```yaml
intake_retention:
  rawPayloadKeepDays: 30        # 原始报文最小留存；到期自动清空（AUTO_CLEAN）
  contactKeepDaysAfterClose: 7  # 报障者回执联系(脱敏 ref)关单后清除天数
```

---

## 5. 运行（compose，推荐）

```bash
cd /workspace/projects/workspace
docker compose -f infra/docker-compose.ai-sre.yml up -d            # 起服务（已构建镜像则不用 --build）
docker compose -f infra/docker-compose.ai-sre.yml logs -f ai-sre-service
docker compose -f infra/docker-compose.ai-sre.yml ps
```

**host 直跑（本地调试，不走 Docker）：**
```bash
cd apps/ai-sre-service
npm run build                                  # tsc 产出 dist/
SRE_CONFIG_PATH=../../infra/ai-sre/active/school-admin-system.test.yaml \
  node dist/main.js                            # 或 npm run dev
```

预期启动日志：
```
加载配置: /etc/ai-sre/school-admin-system.test.yaml
实例: ai-sre-test-01
状态: 已接入 1 个系统
  - system_id=school-admin-system adapter=generic_http capabilities=[discover, health, resources, logs]
监听 http://0.0.0.0:9090 (GET /health)
User Intake (F-SRE-014): 启用 1 通道
  - POST /api/sre/intake/ops_webhook (channel=ops_webhook)
```

---

## 6. 启用 Intake 步骤（F-SRE-014）

1. 确保启用配置含 ≥1 **enabled: true** 的通道（见 §4.4）。
2. 重启服务（compose `up -d` 或容器 recreate）。
3. 校验：`GET /api/sre/intake/status` → `enabled:true`，`routes` 含 `ops_webhook`；
   `GET /health.intake.enabled` → `true`。
4. 关单体：将 `intake_channels` 置 `[]` 或删字段，重启后 `/health.intake.enabled` 回 `false`（待接入态）。

---

## 7. 注册 Systems 步骤

见 §4.5。要点：
- `adapter` 用交付代码内置别名 `generic_http`（语义统一；注册表亦接受 `generic-http`）。
- backend/container host 必须能被 ai-sre 容器解析：health url 用 compose 服务名 `school-admin-backend:3000`。
- 生效标志：`/health.systems` 出现 `{system_id: school-admin-system, adapter: generic_http}`，且 `onboarding:false`。
- 校验连通：`docker exec ai-sre-service wget -qO- http://school-admin-backend:3000/api/health`。

---

## 8. 验证命令（验收 → 自验全过）

```bash
B=http://localhost:9090
# A. 健康
curl -s $B/health                      # 200; intake.enabled=true; systems 含 school-admin-system
curl -s $B/api/sre/intake/status       # enabled=true, routes 含 ops_webhook
# B. 新建报障 (new) → 200
curl -s -X POST $B/api/sre/intake/ops_webhook -H 'Content-Type: application/json' -d '{
  "system_id":"school-admin-system","symptom_desc":"导出按钮点了没反应",
  "reported_severity":"P2","reported_at":"2026-09-05T13:00:00Z","reporter_contact":"ops@example.com"}'
#   期望: {"ok":true,"triage":"new","acked":true,"message":"已受理..."}
# C. 同 system+同现象重复 → 200 dup（duplicate_of_id 指向原 incident，不新建）
curl -s -X POST $B/api/sre/intake/ops_webhook -H 'Content-Type: application/json' -d '{同上 symptom_desc 一致}'
# D. 缺关键字段(reported_at/reporter_contact) → HTTP 428 + missing_required_fields
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/api/sre/intake/ops_webhook \
  -H 'Content-Type: application/json' -d '{"system_id":"school-admin-system","symptom_desc":"only symptom"}'
#     → 428
```

**实测结果（2026-09-05）**

| 用例 | 期望 | 实测 |
|------|------|------|
| `GET /health` | 200, intake.enabled=true, school-admin-system 在册 | ✅ 200 全符 |
| intake 路由 | ops_webhook 已注册 | ✅ `/api/sre/intake/ops_webhook` POST |
| 新报障 | 200 triage=new, acked=true | ✅ |
| 同报障重复 | 200 triage=dup, duplicate_of_id, 不新增 | ✅ states 保持不随 dup 新建 |
| 缺字段 | 428 + required_fields_hint | ✅ |
| 容器健康 | healthy | ✅ |
| backend 容器内连通 | 200 {"status":"ok"} | ✅ |

---

## 9. 运行在运维（logs / 重启 / 保留清理 / 回滚）

- **日志**：`docker compose -f infra/docker-compose.ai-sre.yml logs -f ai-sre-service`
- **重启**：`docker compose -f infra/docker-compose.ai-sre.yml restart`（保留卷 `ai-sre-state`）
  > ⚠️ 本交付的 store 是**进程内内存**（无 RDBMS 接入）；重启即清空 incident。持久化需后续 DEVOPS 接入
  > PostgreSQL 的 `sre_incidents` 迁移（`apps/ai-sre-service/db/migrations/0001_sre_incidents.sql`）——见 §10.3。
- **保留清理**：`RetentionSweeper` 惰性清理，rawPayloadKeepDays(30)/contact 关单后(7)到期清空；当前 run() 由骨架在收报流程附带。
- **改配置即刻生效**：改 `infra/ai-sre/active/school-admin-system.test.yaml` → `docker compose ... up -d`(recreate)。
- **回滚/下线**：`docker compose -f infra/docker-compose.ai-sre.yml down`，不影响 SAS 14 容器；
  若需复用原 M1 编排骨架，见 `infra/docker-compose.ai-sre.m1.yml`（schema 与交付代码不符，仅供演进参考，不可直接跑）。
- **切换 lockfile 策略**：交付宿主 npm12 生成的锁与镜像内 npm10 不兼容；若将来在 npm10/CI 环境启用
  **`npm ci`**，请先在该环境重生成 `package-lock.json` 再做 CI 锁提交。

---

## 10. 未接项清单（未决/交付边界）

### 10.1 ⛔ 真实 GitHub Issue 网关（**未接，需 DEV 代码注入**）
交付代码 `src/incidents/issue-gateway.ts` 的 `ghAvailable()` **硬编码返回 false**，
即使本机已装 `gh` 且登录（`jchu-hk`)也走 `NoopIssueGateway`：new 时返回 **负的伪 issue id**（10xxx），不建真 Issue；
`addComment` 返回 noop。**这在启用配置下产生 `issue_id:null`/负值是预期**（非故障）。
**接入路径**（后续超 scope 的代码改动，非本 runbook 所属）：判定过程摘除硬编码 gate，改为
在 `GITHUB_TOKEN`/repo env 存在时调用 `gh issue create`，并把 `IntakeService` 构造注入真实 gateway。
- 说明当前仅能做到“审计/回执里可见（issue 待接入标记）”。

### 10.2 ⛔ 真实回执外发（**未接，需 DEV 代码注入**）
`buildIntake`（`src/intake/index.ts`）创建 `new Acknowledger(store)`，回执后端缺省为**进程内 `LogAckBackend`**
（内存 sent[] + 每次 send 在 incident 记录 ack 状态）。response 里 `acked:true`/`ack_status=received`
即“落盘/内存日志可见闭环 + 重试显示”（AC-014a）。真实 `write_message.py` **外发**需把 acknowledge
**backend 换成 write_message-sink**（代码注入，非配置项）。本 runbook §4.3 的 `alert_channels: write_message`
是**声明待用**，当前不触发外发。

### 10.3 ⛔ RDBMS 持久化（未接，后续 DEVOPS）
进程内 IncidentStore 不接库；`sre_incidents` DDL 仅契约（`db/migrations/0001_*.sql`），未 apply 到 test PG。

### 10.4 ⚠️ 网络 / 容器约束（环境所致，非故障）
- 宿主 Docker 缺省 bridge 缺失 → build 须 `--network host`（运行网络不计此限）。
- runtime 镜像无 curl（busybox wget 可用）；health 用 `127.0.0.1`。
- runtime 无 `write_message.py` 脚本（该通道容器内不可外发，已在 §10.2 说明）。

---

## 11. 引用

- DESIGN-AI-SRE.md §2.4（最小配置/`intake_channels`）/ §3.11（intake）/ §5.8（NFR-S 保留最小权限）/ §7.2（schema）
- FUNCTIONAL-SPEC-AI-SRE.md F-SRE-014 / AC-014a/b / UC-SRE-016
- `apps/ai-sre-service/src/intake/README.md`（运行自测与校验清单，QA 依据）
- `apps/ai-sre-service/config/default.yaml` · `config/examples/school-admin-system.yaml`（schema 参考）
