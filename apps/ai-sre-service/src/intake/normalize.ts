/**
 * intake/normalize.ts
 *
 * 报障 → 归一化结构化 incident（F-SRE-014 §3.11.2 / UC-SRE-016 step 1）。
 *
 * 关键字段：system_id（受影响系统标识）、symptom_desc（现象自由文本）、
 * reported_at（发生时间）、reporter_contact_ref（报障者运营回执联系信息）。
 *   缺失关键字段 → 返回 missing/errors，交由上层标记告警并提示补全重试
 *   （UC-SRE-016 异常流）。
 *
 * ⚠️ NFR-S §5.8：
 *   - reporter_contact_ref 以脱敏形式入库（reporter-contact.ts）；
 *   - 全量回执值仅支持「需回执发送」时由调用方从通道暂存，不入库明文；
 *   - raw_payload 为可选，仅入 normalize 产出（是否落库由 incident-store 依
 *     retention.rawPayloadKeepDays 决定，且不默认全量长期存档）。
 */

import * as crypto from 'crypto';
import {
  IntakeIncident,
  IncidentSeverity,
  NormalizeResult,
} from '../incidents/incident.types';
import { dedupFingerprint } from '../incidents/fingerprint';
import { toMaskedContactRef, MaskedContact } from '../incidents/reporter-contact';

/** 报障通道上报的原始报文（channel 无关，通用字段） */
export interface RawReport {
  /** 受影响系统标识（必填，被纳管系统） */
  system_id?: string;
  /** 现象描述（必填，自由文本） */
  symptom_desc?: string;
  /** 报障者初步影响/严重度估计（可选） */
  reported_severity?: string;
  /** 发生时间（可选；ISO 字符串或 epoch 秒/毫秒） */
  reported_at?: string | number;
  /** 受影响组件/服务（可选） */
  affected_component?: string;
  /** 报障者运营回执联系信息（必填原始值；入库前脱敏） */
  reporter_contact?: string | { kind?: string; value?: string };
  /**
   * 是否保留原始报文供取证（可选，缺省 false = 不保留，最小留存）。
   * true 时 raw_payload = 本报文原始对象，并受 rawPayloadKeepDays 清理（可由服务端强制）。
   */
  keep_raw?: boolean;
  /** 原始报文体（字段均已归一化到上面后，raw body 由 HTTP 层透传填入） */
  [key: string]: unknown;
}

/** 约定可用的严重度集合（自由文本亦可，尝试验证 P0-P3） */
const SEV_ORDER: Record<IncidentSeverity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** 关键字段清单（给提示用） */
const KEY_FIELDS = [
  'system_id',
  'symptom_desc',
  'reported_at',
  'reporter_contact',
] as const;

/** 轻量 normalize 现象/字段的空判断 */
function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  return false;
}

/** 将 reported_at 归一化为 ISO 字符串 */
function normalizeReportedAt(raw: string | number | undefined): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') {
    // 视为 epoch 秒（<1e12）或毫秒（>=1e12）
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 归一化严重度：P0-P3 或自由文本原样保留在 reported_severity */
function normalizeSeverity(systemId: string, rawSev: unknown): IncidentSeverity {
  // expected_severity：以报告方为准并近似映射 P0-P3；超出范围归 P3（初值，待排查校准）
  if (typeof rawSev !== 'string') {
    return systemId ? 'P3' : 'P3';
  }
  const up = rawSev.trim().toUpperCase();
  if (up in SEV_ORDER) return up as IncidentSeverity;
  // 关键字映射（保守）
  if (/紧急|严重|critical|blocker|致命|全不可用/i.test(up)) return 'P1';
  if (/高|high|影响面大|多用户/i.test(up)) return 'P2';
  return 'P3';
}

/**
 * 归一化：RawReport → NormalizeResult。
 */
export function normalizeReport(
  report: RawReport,
  meta: { sourceChannel: string; receivedAt: Date },
): NormalizeResult {
  const missing: string[] = [];
  const errors: string[] = [];

  // 关键字段校验（对齐 UC-SRE-016：缺关键字段 → 提示补全）
  if (isBlank(report.system_id)) missing.push('system_id');
  if (isBlank(report.symptom_desc)) missing.push('symptom_desc');
  const reportedAtIso = normalizeReportedAt(report.reported_at);
  if (!reportedAtIso) missing.push('reported_at');
  const masked: MaskedContact = toMaskedContactRef(
    report.reporter_contact === undefined ? undefined : report.reporter_contact,
  );
  if (isBlank(report.reporter_contact) || !masked.ref) missing.push('reporter_contact');

  // system_id 形式宽松校验（仅非空已在上；此处不做规则约束避免误伤跨系统标识）
  const systemId = String(report.system_id ?? '').trim();
  const symptom = String(report.symptom_desc ?? '').trim();
  const reportedSev = String(report.reported_severity ?? '').trim();

  if (missing.length > 0 || errors.length > 0 || !systemId || !symptom) {
    return {
      ok: false,
      missing,
      errors,
      // 让 errors 至少含一项解释性消息
    };
  }

  // 去重指纹：仅含 system_id + 归一化现象 token，作为「同根因/同现象」去重身份。
  // reported_severity 为自由文本/主观初估，并入指纹会导致同 system+同现象仅因严重度
  // 表述不同或缺省而被误判为多条 new（M1）；严重度差异交由 triage/模型层处理，不入指纹。
  const fingerprint = dedupFingerprint(systemId, symptom);

  const keepRaw = report.keep_raw === true;
  const rawPayload = keepRaw
    ? sanitizeRawPayload({ ...report, reporter_contact: masked.ref })
    : null;

  const incident: IntakeIncident = {
    incident_id: crypto.randomUUID(),
    system_id: systemId,
    source: 'intake',
    anomaly_type: 'functional', // 用户报障默认 functional（可用性盲区人工反馈）
    severity: normalizeSeverity(systemId, reportedSev || undefined),
    reported_severity: reportedSev || 'N/A',
    status: 'locating', // intake 进入排查定位
    symptom_desc: symptom,
    affected_component: isBlank(report.affected_component)
      ? undefined
      : String(report.affected_component).trim(),
    reporter_contact_ref: masked.ref, // 脱敏引用入库
    source_channel: meta.sourceChannel,
    raw_payload: rawPayload,
    dedup_fingerprint: fingerprint,
    triage: 'new', // 默认（triage 环节可重判）
    duplicate_of_id: null,
    issue_id: null,
    ack_status: 'received', // 受理
    received_at: meta.receivedAt.toISOString(),
    ack_attempts: 0,
    ack_last_result: null,
  };

  return { ok: true, missing: [], errors: [], incident };
}

/** 原始报文保留前脱敏：剔除全量回执联系值，避免 raw body 泄露 PII */
function sanitizeRawPayload(obj: Record<string, unknown>): Record<string, unknown> {
  const c = { ...obj };
  delete c.reporter_contact; // 全量回执值不落 raw
  return c;
}
