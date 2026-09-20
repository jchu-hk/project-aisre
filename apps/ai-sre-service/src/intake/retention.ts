/**
 * intake/retention.ts
 *
 * NFR-S「报障回执最小权限例外」保留周期调度（DESIGN §3.11.2 / §5.8）：
 *   - raw_payload 原始报文：按 rawPayloadKeepDays 自动清理（可配置缺省 30 天）；
 *     不默认全量长期存档。
 *   - reporter_contact_ref：报障者回执联系（脱敏引用），在 incident 关单后
 *     contactKeepDaysAfterClose 天内清除（可配置缺省 7 天）。
 *
 * 采用「惰性清理 + 可手动/启动调 runOnce」两用；时钟可注入便于自测。
 */

import { IncidentStore } from '../incidents/incident-store';

export interface RetentionPolicy {
  rawPayloadKeepDays: number;
  contactKeepDaysAfterClose: number;
}

export interface CleanupReport {
  clearedRaw: number;
  clearedContact: number;
  scanned: number;
}

/**
 * RetentionSweeper —— 扫一遍 store：
 *   1. raw_payload 存在且 age > rawPayloadKeepDays → 置 null（保留 structured 不丢）
 *   2. 已 closed（ack_status=closed）且 关单时间 age > contactKeepDaysAfterClose
 *      → reporter_contact_ref 置 null / 空（彻底删联系，保留 incident 其余字段审计）
 */
export class RetentionSweeper {
  constructor(
    private readonly store: IncidentStore,
    private readonly policy: RetentionPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  runOnce(): CleanupReport {
    const nowMs = this.now().getTime();
    const rawKeepMs = this.policy.rawPayloadKeepDays * 24 * 3600 * 1000;
    const contactKeepMs = this.policy.contactKeepDaysAfterClose * 24 * 3600 * 1000;
    let clearedRaw = 0;
    let clearedContact = 0;

    for (const inc of this.store.all()) {
      // raw_payload 清理
      if (inc.raw_payload != null) {
        const createdAt = new Date(inc.received_at).getTime();
        if (Number.isFinite(createdAt) && nowMs - createdAt > rawKeepMs) {
          // 仅当保留期已过且有效期窗口到，清空 raw（最小值保留）
          inc.raw_payload = null;
          clearedRaw++;
        }
      }
      // reporter_contact_ref 清理（关单后）
      if (inc.ack_status === 'closed' && inc.reporter_contact_ref) {
        const resolvedAt = inc.resolved_at ? new Date(inc.resolved_at).getTime() : nowMs;
        if (Number.isFinite(resolvedAt) && nowMs - resolvedAt > contactKeepMs) {
          inc.reporter_contact_ref = ''; // 联系信息清空（保留 incident 供审计）
          clearedContact++;
        }
      }
    }
    return { scanned: this.store.all().length, clearedRaw, clearedContact };
  }
}
