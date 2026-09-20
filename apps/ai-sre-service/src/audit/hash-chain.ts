/**
 * audit/hash-chain.ts —— SHA-256 哈希链（F-AUDIT 防篡改 / DESIGN §3）
 *
 * 每条记录：hash = H(seq ‖ prev_hash ‖ canonical(payload))
 *   - canonical(payload)：确定性序列化（键固定顺序，null 显式表示），保证任意进程可重算一致。
 *   - genesis：首条 seq=1，prev_hash 为固定前导 GENESIS_PREV_HASH（全 0 的 sha256 十六进制）。
 *   - seq 全局单调。链头 (seq, hash) 可外锚定（git/对象存储/Issue 评论）形成不可回改见证点。
 *
 * 本模块为纯函数（无 IO/无状态），便于离线重算与单测（AC-AUDIT-002）。
 */

import * as crypto from 'crypto';
import { AuditEvent, AuditRecord } from './audit-types';

/** genesis 前导：全 0 的 sha256 十六进制（固定、可复算） */
export const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * 参与哈希的载荷字段（顺序即 canonical 顺序；与 AuditRecord 的链外字段无关）。
 * 显式列出以确保 schema 演进时不误纳入链接字段本身。
 */
const PAYLOAD_KEYS: ReadonlyArray<keyof AuditEvent> = [
  'who_type',
  'who_id',
  'when',
  'action_type',
  'target_resource',
  'params_digest',
  'why_source',
  'incident_id',
  'session_id',
  'approval_id',
  'result',
  'reason',
];

/**
 * canonical 序列化：把 payload 拼成确定性字符串。
 * 采用长度前缀 `k:len=v;` 消除键值歧义（避免分隔符注入导致不同 payload 同串）。
 * null 显式编码为 `~`（与空串 `''` 区分）。
 */
export function canonicalPayload(ev: AuditEvent): string {
  const parts: string[] = [];
  for (const k of PAYLOAD_KEYS) {
    const v = ev[k];
    if (v === null || v === undefined) {
      parts.push(`${k}:~`);
    } else {
      const s = String(v);
      parts.push(`${k}:${Buffer.byteLength(s, 'utf8')}=${s}`);
    }
  }
  return parts.join(';');
}

/** 计算单条记录 hash = H(seq ‖ prev_hash ‖ canonical(payload)) */
export function computeHash(seq: number, prevHash: string, ev: AuditEvent): string {
  const material = `${seq}\u0000${prevHash}\u0000${canonicalPayload(ev)}`;
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

/** 由事件 + 链尾 (seq, hash) 构造完整可落盘记录（id 由调用方注入或此处生成） */
export function linkRecord(
  ev: AuditEvent,
  prevSeq: number | null,
  prevHash: string | null,
  id: string,
): AuditRecord {
  const seq = (prevSeq ?? 0) + 1;
  const ph = prevHash ?? GENESIS_PREV_HASH;
  const hash = computeHash(seq, ph, ev);
  return { ...ev, id, seq, prev_hash: ph, hash };
}

/**
 * 校验一段连续记录（按 seq 升序）的哈希链完整性。
 * @returns 断链位置（null=完整）
 */
export function verifyChain(
  records: ReadonlyArray<AuditRecord>,
  expectedFirstPrev: string = GENESIS_PREV_HASH,
): { broken_at_seq: number | null; reason: string | null } {
  let prevHash = expectedFirstPrev;
  let prevSeq: number | null = null;
  for (const r of records) {
    if (prevSeq !== null && r.seq !== prevSeq + 1) {
      return { broken_at_seq: r.seq, reason: `seq 不连续：期望 ${prevSeq + 1} 实为 ${r.seq}` };
    }
    if (r.prev_hash !== prevHash) {
      return { broken_at_seq: r.seq, reason: `prev_hash 不匹配（seq=${r.seq}）` };
    }
    const expect = computeHash(r.seq, r.prev_hash, r);
    if (expect !== r.hash) {
      return { broken_at_seq: r.seq, reason: `记录内容被篡改（哈希不匹配，seq=${r.seq}）` };
    }
    prevHash = r.hash;
    prevSeq = r.seq;
  }
  return { broken_at_seq: null, reason: null };
}
