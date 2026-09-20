/**
 * intake/acknowledger.ts
 *
 * 报障回执（F-SRE-014 §3.11.6 / NFR-S §5.8）：向报障者回执受理→定位→修复→关单。
 *
 * best-effort：回执通道失败 → 重试（Incident.ack_attempts 递增），并在
 * Issue / ack_last_result 让闭环可见（AC-014a；UC-SRE-016 回执失败分支）。
 * 回执仅以脱敏 reporter_contact_ref 定向到原报障者，未接入真实通道返回
 * 可观测状态（供 DEVOPS/Dashboard 接入真实 E-mail/IM sink）。
 */

import {
  IntakeIncident,
  IncidentAckStatus,
} from '../incidents/incident.types';
import { IncidentStore } from '../incidents/incident-store';

export interface AckBackend {
  /** 向原报障者（脱敏 ref）发送一条回执；返回 ok / err */
  send(inc: IntakeIncident, status: IncidentAckStatus, message: string): Promise<AckSendResult>;
}

export interface AckSendResult {
  ok: boolean;
  error?: string;
}

/** 状态推进顺序（受理→处理→修复→关单）允许非跳步（可跳越） */
const ORDER: IncidentAckStatus[] = ['received', 'processing', 'fixed', 'closed'];

/**
 * 默认回执后端：未接入真实通道时的 best-effort log sink。
 * 它不向外部发请求；records 到内存供 Dashboard/Issue 展示「已受理/处理中/已修复/已关单」。
 * 真实 email/im/webhook 由外部注入。
 */
export class LogAckBackend implements AckBackend {
  readonly sent: Array<{ incidentId: string; status: IncidentAckStatus; message: string; at: string }> =
    [];
  async send(
    inc: IntakeIncident,
    status: IncidentAckStatus,
    message: string,
  ): Promise<AckSendResult> {
    // 模拟偶发失败以验证重试闭环（前 1 次投递失败便于测试重试）
    if (this.failNextOnce) {
      this.failNextOnce = false;
      return { ok: false, error: 'simulated channel unavailable' };
    }
    this.sent.push({
      incidentId: inc.incident_id,
      status,
      message,
      at: new Date().toISOString(),
    });
    return { ok: true };
  }
  failNextOnce = false;
}

/**
 * 回执器：封装状态推进与 best-effort 重试。
 * maxAttempts 每次 send 尝试上限（默认 3）。
 */
export class Acknowledger {
  constructor(
    private readonly store: IncidentStore,
    private readonly backend: AckBackend = new LogAckBackend(),
    private readonly maxAttempts = 3,
  ) {}

  /**
   * 向报障者推进到 next 状态；失败重试并在 incident 上记录 ack_last_result。
   * 成功后同步 IncidentStore.setAckStatus。
   */
  async acknowledge(id: string, next: IncidentAckStatus, detail?: string): Promise<boolean> {
    const inc = this.store.getById(id);
    if (!inc) return false;

    const message = buildAckMessage(inc, next, detail);
    let lastErr: string | undefined;
    let ok = false;
    for (let attempt = 1; attempt <= this.maxAttempts && !ok; attempt++) {
      inc.ack_attempts += 1;
      const r = await this.backend.send(inc, next, message);
      if (r.ok) {
        ok = true;
        ok = this.store.setAckStatus(id, next);
      } else {
        lastErr = r.error ?? 'unknown';
        inc.ack_last_result = `attempt#${attempt} failed: ${lastErr}`;
      }
    }
    if (ok) inc.ack_last_result = `sent(${next})`;
    else inc.ack_last_result = `all ${this.maxAttempts} attempts failed: ${lastErr}`;
    return ok;
  }

  /** 便捷：一整串闭环（受理→处理→…）按需调用 */
  ackReceived(id: string) {
    return this.acknowledge(id, 'received');
  }
  ackProcessing(id: string) {
    return this.acknowledge(id, 'processing');
  }
  ackFixed(id: string) {
    return this.acknowledge(id, 'fixed');
  }
  ackClosed(id: string) {
    return this.acknowledge(id, 'closed');
  }
}

/** 脱敏回执文案（不出现全量联系人明文，仅命名通道与状态） */
function buildAckMessage(
  inc: IntakeIncident,
  next: IncidentAckStatus,
  detail?: string,
): string {
  const label = ORDER.indexOf(next) >= 0 ? next : 'received';
  const seg = [
    `[报障#${inc.reported_severity || 'N/A'}|${inc.system_id}] 状态=${label}`,
    `系统: ${inc.system_id} | 来源通道: ${inc.source_channel}`,
  ];
  if (detail) seg.push(`说明: ${detail}`);
  return seg.join('\n');
}
