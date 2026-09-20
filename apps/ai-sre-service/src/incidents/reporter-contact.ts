/**
 * incidents/reporter-contact.ts
 *
 * 报障者运营回执联系信息的最小权限处理（NFR-S「报障回执最小权限例外」§5.8）。
 *
 * 目的绑定 + 最小化存储 + 脱敏/掩码展示：
 *   - reporter_contact_ref 仅存「脱敏后的引用/掩码」，供向原报障者回执；
 *   - 不进入通用监控/告警/检测数据与基线建模；
 *   - 不在公共渠道（Issue/Dashboard/审计）全量明文回写。
 *
 * 此为纯函数工具，不持有任何持久化状态。保留/清除周期由
 * RetentionPolicy（intake_retention ）调度控制，见 incident-store。
 */

/** 脱敏保留方式 */
export interface MaskedContact {
  /** 脱敏/掩码引用（存 sre_incidents.reporter_contact_ref），如邮箱尾号/手机尾号 */
  ref: string;
  /** 是否仍有原作者全量值在进程内暂存（供实际回执发送，不回写公共渠道） */
  resolved: string | null;
}

/** 解析出的回执联系信息（进程内临时持有，供真实回执发送；不入库明文） */
export interface ContactAddress {
  /** 联系类型：email / phone / chat_id / opaque */
  kind: string;
  /** 值（仅用于本次回执发送，不落盘明文） */
  value: string;
}

/**
 * 生成脱敏引用（reporter_contact_ref 入库值）。
 * 尽力识别 email / phone，其余 fallback 为 opaque hash 尾号。
 */
export function toMaskedContactRef(raw: unknown): MaskedContact {
  if (raw === null || raw === undefined) {
    return { ref: '', resolved: null };
  }
  let s: string;
  if (typeof raw === 'string') {
    s = raw.trim();
  } else if (typeof raw === 'object') {
    // 接受 {kind, value} 对象
    const o = raw as { kind?: string; value?: string };
    const v = typeof o.value === 'string' ? o.value.trim() : '';
    const k = typeof o.kind === 'string' ? o.kind.trim() : 'opaque';
    if (!v) return { ref: '', resolved: null };
    return maskByKind(k, v);
  } else {
    return { ref: '', resolved: null };
  }
  if (s.length === 0) return { ref: '', resolved: null };

  const kind = detectKind(s);
  return maskByKind(kind, s);
}

/** 按联系类型做掩码 */
function maskByKind(kind: string, value: string): MaskedContact {
  if (kind === 'email') {
    // user@example.com → u***@e***.com（保留首/末 + 域根）
    const at = value.indexOf('@');
    if (at > 0) {
      const local = value.slice(0, at);
      const domain = value.slice(at + 1);
      const dot = domain.indexOf('.');
      const domPart = dot > 0 ? domain.slice(0, dot) : domain;
      const masked = `${local[0]}***@${domPart[0]}***${dot > 0 ? domain.slice(dot) : ''}`;
      return { ref: masked, resolved: value };
    }
  }
  if (kind === 'phone') {
    // 前缀全星，仅保留国家码（+xx）与尾号末 4 位 —— 最小化展示。
    const digits = value.replace(/\D/g, '');
    let national: string;
    let countryCode = '';
    const ccMatch = /^\+\s*(\d{1,3})\b/.exec(value);
    if (ccMatch) {
      countryCode = ccMatch[1];
      national = digits.startsWith(countryCode)
        ? digits.slice(countryCode.length)
        : digits;
    } else {
      national = digits;
    }
    if (national.length >= 4) {
      const tail = national.slice(-4);
      const prefix = countryCode ? `+${countryCode} ` : '';
      return { ref: `${prefix}***${tail}`, resolved: value };
    }
  }
  // opaque/其它：保留末 4 位，前缀打星
  const tail = value.length >= 4 ? value.slice(-4) : value;
  const masked = `***${tail}`;
  return { ref: masked, resolved: value };
}

/** 探测联系源类型 */
function detectKind(s: string): string {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'email';
  if (/^\+?[\d\s-]{7,}$/.test(s) && /\d{3,}/.test(s) && !s.includes('@')) return 'phone';
  return 'opaque';
}

/**
 * 将脱敏 ref 解析为可发送地址；仅供回执发送进程内使用。
 * 若传入的是全量（服务内部从通道暂存态取），依样返回 ContactAddress。
 */
export function toContactAddress(contactRef: string): ContactAddress {
  const ref = (contactRef || '').trim();
  if (!ref) return { kind: 'unknown', value: '' };
  if (ref.includes('@')) return { kind: 'email', value: ref };
  if (/^\+?[\d*]/.test(ref)) return { kind: 'phone', value: ref };
  return { kind: 'opaque', value: ref };
}
