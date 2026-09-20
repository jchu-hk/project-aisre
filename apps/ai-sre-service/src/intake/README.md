# User Incident Intake（用户报障接入）— F-SRE-014 / M2 增量

对齐 `docs/ai-sre/FUNCTIONAL-SPEC-AI-SRE.md` F-SRE-014、AC-014a/014b、
UC-SRE-016、NFR-S「报障回执最小权限例外」与
`docs/ai-sre/DESIGN-AI-SRE.md` §3.11 / §2.4 / §5.8 / §7.2。

## 组成部分

| 文件 | 职责 |
|------|------|
| `src/intake/normalize.ts` | 报文→结构化 incident（归一化 + 缺关键字段校验） |
| `src/intake/triage / incidents/incident-store.ts` | 三分类 dup/known/new + 去重指纹 + Issue 关联决策 |
| `src/intake/ingestion.ts` | intake→归一化→triage→Issue→回执 编排 |
| `src/intake/acknowledger.ts` | 回执受理→定位→修复→关单（best-effort + 重试） |
| `src/intake/retention.ts` | NFR-S §5.8 保留周期（raw 30 天 / 关单后 contact 7 天，可配置） |
| `src/incidents/reporter-contact.ts` | 回执联系信息脱敏（邮箱/手机尾号掩码，入库非明文） |
| `src/incidents/fingerprint.ts` | 去重指纹 hash（F-SRE-007 对齐） |
| `src/incidents/issue-gateway.ts` | Issue 集成接口 + 缺省 best-effort gateway |
| `src/intake/http-intake.ts` | webhook/webform HTTP 收报通道（可配置，空=不启用） |
| `db/migrations/0001_sre_incidents.sql` | `sre_incidents` schema 契约（DESIGN §7.2） |
| `src/config/types.ts` | `intake_channels` / `intake_retention` 配置类型 |
| `test/intake.smoke.ts` | 冒烟自测 |

## 运行自测

```bash
cd apps/ai-sre-service
npm run typecheck     # tsc --noEmit
npm run build         # tsc -p tsconfig.build.json
npm run test:intake   # ts-node test/intake.smoke.ts   (N 个断言)
```

## HTTP 语义（webhook/webform 通道）

配置文件内 `intake_channels` 启用 ≥1 才注册收报路由；空/缺失 = 待接入，不注册不报错。

```
POST {base}/api/sre/intake/{channelName}   Content-Type: application/json 或 form
body(top-level 或 {payload|incident:{...}})：
  system_id           必填 被纳管系统标识
  symptom_desc        必填 现象自由文本
  reported_at         必填 ISO 或 epoch
  reporter_contact    必填 报障者运营回执联系信息(脱敏入库)
  reported_severity   可填 初步严重度/影响
  keep_raw            可填 是否暂存原始报文(raw_payload, 按 NFR-S 最小留存清理)
```

响应：
- `200` 受理（new/known）或归并（dup），含 incident_id / triage / duplicate_of_id / acked
- `428` 缺关键字段 → `required_fields_hint` 提示补全重试（UC-SRE-016 异常流）

## QA 验证清单（给 QA，供 AC-014a/014b）

1. 新报障 → `triage=new`、回执 acked=true（受理）；`/api/sre/intake/status` states 递增。
2. 同 system 同现象重复提交 → `dup`，返回 `duplicate_of_id`（指向既有 incident）、不新建——断 AC-014a 负向 + F-SRE-007 去重。
3. 命中同一 open Issue #n 的补充报障 → `known`，并入既有 Issue，不新建。
4. 缺 `system_id`/`symptom_desc`/`reported_at`/`reporter_contact` 任一 → HTTP 428 缺补全。
5. 回执仅用脱敏 `reporter_contact_ref`（邮箱显示 `u***@d***.com`），数据库落 `reporter_contact_ref` 非明文（NFR-S §5.8）。
6. `raw_payload` 仅 `keep_raw=true` 时暂存 JSON，并按 rawPayloadKeepDays 自动清空；联系人脱敏引用在关单后 contactKeepDaysAfterClose 天清除。
7. `intake_channels` 置空启动 → 服务正常、无 intake 路由（待接入空态基线）。

## 未决 / 交付边界（留给 DEVOPS/后续）

- **真实 GitHub / Issue 网关 & 真实回执通道**：本骨架 `issue-gateway` 与 `acknowledger` 为 best-effort / 内存 sink（not 真实外发）。接入真实仓库与 email/IM/webhook sink 由 DEVOPS 按 `db/migrations` 与通道配置完成；Issue 号与回执在未接入网关时以 mock/内存标记呈现。
- **RDBMS 持久化**：`sre_incidents` 迁移已给契约；进程内参照实现满足自测，`system_id` 外键随 F-SRE-013 `sre_systems` 落地后补 `REFERENCES`。
- **事件流 `sre.intake.received/normalized`**：本模块标注了事件语义；接入外部 Kafka/事件总线发布由 DEVOPS 在真实总线环境完成（本骨架无 Kafka 依赖）。
