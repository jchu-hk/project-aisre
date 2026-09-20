/**
 * adapters/adapter.interface.ts
 *
 * System Adapter Layer 核心契约（F-SRE-011 / DESIGN §3.1）。
 *
 * 定义所有系统适配器（专用或通用降级）必须实现的能力。
 * 类型与词汇均使用「被纳管系统」通用表述
 * （service/container/database/cache/logSource/healthEndpoint/disk），
 * 不得含有任何被纳管系统（SAS）的具体端口/容器名/路径。
 */

import {
  ComponentKind,
  ComponentModel,
  SystemTopology,
  PermissionDeclaration,
} from '../config/types';

/** 适配器声明的能力类别（组件发现/采集类别） */
export type AdapterCapability =
  | 'discover'
  | 'health'
  | 'resources'
  | 'logs'
  | 'db'
  | 'cache';

/** 采集上下文（运行期注入，含系统 id 与可选凭据引用） */
export interface AdapterContext {
  systemId: string;
  /** 该系统的接入配置（经 profile 注入） */
  systemConfig: Record<string, unknown>;
  /** 采集时间（由调用方统一，保证样本可比） */
  now?: Date;
}

/** 健康探测样本 */
export interface HealthSample {
  componentId: string;
  endpoint?: string;
  ok: boolean;
  statusCode?: number;
  latencyMs?: number;
  message?: string;
  sampledAt: string;
}

/** 资源采集样本（CPU/内存/磁盘/容器状态等） */
export interface ResourceSample {
  componentId: string;
  kind: ComponentKind;
  metric: string;
  value: number;
  unit?: string;
  sampledAt: string;
}

/** 日志事件样本（ERROR/FATAL/panic 等） */
export interface LogEvent {
  componentId: string;
  level: string;
  message: string;
  source?: string;
  timestamp: string;
}

/** 只读数据库探测样本 */
export interface DbSample {
  componentId: string;
  metric: string; // 连接数 / 慢查询 / 连接池使用率 / ...
  value: number;
  unit?: string;
  sampledAt: string;
}

/** 缓存/键值存储探测样本 */
export interface CacheSample {
  componentId: string;
  metric: string; // 内存 / 命中率 / 连接数 / ...
  value: number;
  unit?: string;
  sampledAt: string;
}

/**
 * SystemAdapter —— 所有系统适配器必须实现的核心接口。
 *
 * 契约对齐 DESIGN §3.1.1。采集方法均为只读（旁路不侵入），
 * 不做任何写操作。
 */
export interface SystemAdapter {
  /** 声明本适配器负责的系统 id */
  systemId(): string;

  /** 声明支持的能力/采集类别 */
  capabilities(): AdapterCapability[];

  /** 最小权限声明（供沙箱/加载前校验） */
  minPrivilege(): PermissionDeclaration[];

  /** 组件发现与建模：产出被纳管系统的组件清单 */
  discover(ctx: AdapterContext): Promise<ComponentModel[]>;

  /** 返回归一化系统拓扑（组件 -> 指标映射） */
  model(ctx?: AdapterContext): Promise<SystemTopology>;

  /** 健康端点探测（只读） */
  collectHealth(ctx: AdapterContext): Promise<HealthSample[]>;

  /** 资源采集（CPU/内存/磁盘/容器状态，只读） */
  collectResources(ctx: AdapterContext): Promise<ResourceSample[]>;

  /** 日志源 ERROR/FATAL/panic 采集（只读） */
  collectLogs(ctx: AdapterContext): Promise<LogEvent[]>;

  /** 只读数据库探测（连接/慢查询/连接池） */
  collectDb?(ctx: AdapterContext): Promise<DbSample[]>;

  /** 缓存/键值存储探测（内存/命中率/连接） */
  collectCache?(ctx: AdapterContext): Promise<CacheSample[]>;

  /** 适配器自身健康（区分「适配器故障」与「被纳管系统故障」） */
  health(): Promise<{ ok: boolean; detail?: string }>;
}
