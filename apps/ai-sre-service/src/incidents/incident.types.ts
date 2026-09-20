/**
 * incidents/incident.types.ts
 *
 * sre_incidents 统一事件（检测 + 用户报障 Intake）的领域类型。
 * 对齐 DESIGN §7.2 表 1 的字段与枚举。
 *
 * ⚠️ NFR-S「报障回执最小权限例外」（§5.8）：
 *   reporter_contact_ref 为「脱敏存储」的引用/掩码（非明文全量），
 *   raw_payload 可空、按最小留存自动清理；二者均不进入监控/告警/检测数据。
 */

/** source：detected（监控采集）/ intake（用户报障） */
export type IncidentSource = 'detected' | 'intake';

/** severity：检测定级 P0-P3 */
export type IncidentSeverity = 'P0' | 'P1' | 'P2' | 'P3';

/** 三分类 triage：重复 dup / 已知 known / 新建 new（F-SRE-014） */
export type IncidentTriage = 'dup' | 'known' | 'new';

/**
 * 回执状态 ack_status：received / processing / fixed / closed
 * 对应报障回执流程（受理→定位→修复→关单）。
 */
export type IncidentAckStatus = 'received' | 'processing' | 'fixed' | 'closed';

/** 回执通道（受 NFR-S 绑定：仅用于向原报障者回执本 incident 状态）。 */
export type AckChannel = 'email' | 'im' | 'webhook' | 'webform' | 'log';

/**
 * 归一化后的用户报障 incident（source='intake'）。
 * 仅含报障接入所需字段；通用命名，系统无关。
 */
export interface IntakeIncident {
  /** 系统无关主键（uuid v4） */
  incident_id: string;
  /** 受影响系统标识（被纳管系统；对应 sre_systems.system_id） */
  system_id: string;
  /** source 恒为 intake（区分检测来源） */
  source: IncidentSource;
  /** 异常类型：functional（功能）/ manual（人工上报），intake 场景取 functional/manual */
  anomaly_type: string;
  /** 归一化后定级（intake 可由初步估计校准） */
  severity: IncidentSeverity;
  /** 报障者初步影响/严重度估计（自由文本） */
  reported_severity: string;
  /** 状态：intake 走回执流程，初始为 locating */
  status: string;
  /** 现象描述（自由文本，intake 归一化） */
  symptom_desc: string;
  /** 受影响组件/服务（系统无关，可选） */
  affected_component?: string;
  /**
   * 报障者运营回执联系信息（已脱敏，引用/掩码形式）。
   * NFR-S §5.8 例外：脱敏存储、目的绑定、不进入通用监控/检测数据。
   */
  reporter_contact_ref: string | null;
  /** 来源通道：webhook/im/email/webform/... */
  source_channel: string;
  /**
   * 原始报文（可选，JSON）。仅取证/复核需要时保留；
   * 按最小留存周期 rawPayloadKeepDays 自动清理（不默认全量长期存档）。
   */
  raw_payload: unknown | null;
  /** 去重指纹 hash（含 system_id；intake 去重 → 三分类） */
  dedup_fingerprint: string;
  /** 三分类判定（归并后填） */
  triage: IncidentTriage;
  /** triage=dup 时并入的既有 incident_id */
  duplicate_of_id: string | null;
  /** 关联/新建的 GitHub Issue（Issue 为唯一真相源；unknown 时未定） */
  issue_id: number | null;
  /** 回执状态 */
  ack_status: IncidentAckStatus;
  /** 报障/接收时间戳（ISO） */
  received_at: string;
  /** 探测系统时生成的排查时间戳（可选） */
  detected_at?: string;
  /** 解决/关单时间戳（可选，回执闭环） */
  resolved_at?: string | null;
  /** 回执尝试记录数（best-effort 重试计数） */
  ack_attempts: number;
  /** 最近一次回执结果/错误描述（Issue/Dashboard 可视） */
  ack_last_result?: string | null;
}

/** 归一化校验返回：要么缺关键字段告警，要么产出结构化 incident */
export interface NormalizeResult {
  ok: boolean;
  /** 缺关键字段列表（ok=false 供提示补全重试） */
  missing: string[];
  /** 不合法的字段/错误描述 */
  errors: string[];
  /** 归一化产出（ok=true 时有值） */
  incident?: IntakeIncident;
}
