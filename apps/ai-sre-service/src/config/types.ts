/**
 * config/types.ts
 *
 * 系统无关的 AI SRE 运行时配置类型定义（F-SRE-010 / §2.2 配置与代码分离）。
 *
 * ⚠️ 严格约束：本文件中的所有类型均为「系统无关」的通用表述，
 * 不得包含任何被纳管系统（含 School Admin System）的端口/容器名/路径/具体值。
 * 具体系统的拓扑/凭据/阈值只出现在发行附带的示例配置 profile 中
 * （见 config/examples/），通过配置注入，绝不硬编码进代码。
 */

/** 被纳管 system/组件的能力类别（服务/容器/数据库/缓存/日志源/健康端点/磁盘） */
export type ComponentKind =
  | 'service'
  | 'container'
  | 'database'
  | 'cache'
  | 'logSource'
  | 'healthEndpoint'
  | 'disk';

/** 组件发现与建模产出的归一化组件条目 */
export interface ComponentModel {
  id: string;
  kind: ComponentKind;
  name: string;
  /** 与组件关联的地址/端点（经配置注入，非硬编码） */
  endpoints?: string[];
  /** 组件元数据（标签/角色等，系统相关，经适配器填充） */
  labels?: Record<string, string>;
  /** 该组件关联的指标类别 */
  metrics?: string[];
}

/** 归一化系统拓扑：组件集合到指标类别的映射 */
export interface SystemTopology {
  systemId: string;
  components: ComponentModel[];
  /** 组件 id -> 贡献的指标类别列表 */
  metricMap: Record<string, string[]>;
}

/** AI SRE 自身身份与监听配置 */
export interface SreIdentity {
  /** 实例 id，多实例部署时用于区分（如 ai-sre-01） */
  instance_id: string;
  /** 服务监听地址，如 0.0.0.0:9090 */
  listen: string;
}

/** 密钥管理引用（非明文落盘） */
export interface SecretsConfig {
  /** 签名密钥引用，如 vault://ai-sre/signing-key */
  signing_key_ref?: string;
  [key: string]: unknown;
}

/** 告警通道描述 */
export interface AlertChannel {
  type: string;
  endpoint: string;
  [key: string]: unknown;
}

/**
 * 报障入口通道类型（F-SRE-014 / DESIGN §3.11 / §2.4 intake_channels）。
 * 支持 Web 表单 / IM / 邮件 / 工单 webhook 等；每通道经统一 intake 接口收纳。
 * 通用命名，不写死某套工单系统——经配置注入。
 */
export type IntakeChannelType =
  | 'webhook'
  | 'webform'
  | 'im'
  | 'email'
  | 'ticket'
  | string;

/**
 * 单个用户报障入口通道配置（intake_channels）。
 * intake_channels 为空或缺失 = 「待接入 / 不启用 intake」的空态基线，
 * 此时不注册任何 intake HTTP 入口、不报错。
 */
export interface IntakeChannel {
  /** 通道类型：webhook/webform/im/email/ticket/... */
  type: IntakeChannelType;
  /** 通道端点/绑定（通用命名，不写死某套工单系统） */
  endpoint: string;
  /** 可选：该通道内部名称（溯源用途） */
  name?: string;
  /** 该通道是否启用（缺省 true） */
  enabled?: boolean;
  /** 通道特定扩展（经配置注入，核心零通道硬编码） */
  [key: string]: unknown;
}

/**
 * 报障原始报文/回执联系信息保留策略（NFR-S「报障回执最小权限例外」）。
 * 违背硬性：reporter_contact_ref 脱敏存储；raw_payload 可空 + 最小留存自动清理。
 */
export interface IntakeRetention {
  /**
   * 供截 arg 脱敏展示/report 联系字段屏蔽的保存策略。
   * raw_payload（原始报文，可选）自动清理留存天数（缺省 30）。
   * 值为 AUTO_CLEAN 且 >0 才启用定时清理。
   */
  rawPayloadKeepDays: number;
  /**
   * reporter_contact_ref（报障者运营回执联系信息）在 incident 关单后
   * 清除的天数（随 incident 关单后 N 天内清除，可配置，缺省 7）。
   */
  contactKeepDaysAfterClose: number;
}

/**
 * 单个被纳管系统的接入配置（系统无关）。
 * systems: [] 表示「待接入」态。
 */
export interface SystemConfig {
  /** 系统唯一标识 */
  system_id: string;
  /** 绑定适配器类型（generic_http/docker/自定义） */
  adapter: string;
  /** 该系统的配置 profile 引用 */
  profile_ref?: string;
  /** 凭证命名空间引用（Secret 引用，非明文） */
  credential_ns?: string;
  /** 系统相关采集/发现配置（全经 profile/配置注入，无核心硬编码） */
  [key: string]: unknown;
}

/** 适配器声明的最小权限项 */
export interface PermissionDeclaration {
  action: string;
  target: string;
  read_only: boolean;
}

/**
 * AI SRE 运行时顶层配置。
 * 结构与发行示例配置（config/examples/*.yaml）对齐，但此处仅描述契约，
 * 不含任何具体值。
 */
export interface SreConfig {
  identity: SreIdentity;
  secrets?: SecretsConfig;
  alert_channels: AlertChannel[];
  /**
   * 用户报障入口通道列表（F-SRE-014）。
   * 可为空或缺失 = 「待接入 / 不启用 intake」的空态基线（不注册、不报错）。
   */
  intake_channels?: IntakeChannel[];
  /**
   * 报障保留策略（可选，缺省用 NFR-S 安全缺省）。
   * 仅 intake 启动时消费；无值则用内置缺省。
   */
  intake_retention?: IntakeRetention;
  /** 被纳管系统列表（可为空 = 待接入态） */
  systems: SystemConfig[];
}

/** 列出一个 system 是否为「空环境/待接入」态 */
export function isOnboarding(config: SreConfig): boolean {
  return !config.systems || config.systems.length === 0;
}

/** 判断 intake 是否启用（至少一个已启用通道） */
export function isIntakeEnabled(config: SreConfig): boolean {
  const channels = config.intake_channels ?? [];
  return channels.some((c) => c.enabled !== false);
}

/**
 * 返回 intake 保留策略（合并配置缺省）。
 * rawPayloadKeepDays 缺省 30；contactKeepDaysAfterClose 缺省 7。
 */
export function intakeRetention(config: SreConfig): IntakeRetention {
  const r = config.intake_retention;
  const keepDays = r && typeof r.rawPayloadKeepDays === 'number'
    ? r.rawPayloadKeepDays
    : 30;
  const contactDays = r && typeof r.contactKeepDaysAfterClose === 'number'
    ? r.contactKeepDaysAfterClose
    : 7;
  return {
    rawPayloadKeepDays: keepDays,
    contactKeepDaysAfterClose: contactDays,
  };
}
