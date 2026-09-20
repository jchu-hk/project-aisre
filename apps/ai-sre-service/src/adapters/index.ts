/**
 * adapters/index.ts
 *
 * 适配器注册表入口（代码侧，M1 最小实现）。
 *
 * 维护「适配器类型名 -> 构造工厂」的映射。当前仅内置通用 HTTP 降级适配器；
 * SAS Adapter / Docker Adapter 为 M2+ 交付物（deferred）。
 * 新增专用适配器 = 在此注册一个工厂 + 加载其包（不改核心采集流程，F-SRE-011）。
 */

import { SystemAdapter } from './adapter.interface';
import { GenericHttpAdapter } from './generic-http.adapter';

/** 适配器工厂：给定 system_id 与接入配置，产出适配器实例 */
export type AdapterFactory = (
  systemId: string,
  systemConfig: Record<string, unknown>,
) => SystemAdapter;

const registry: Record<string, AdapterFactory> = {
  generic_http: (id, cfg) => new GenericHttpAdapter(id, cfg),
  // 语义别名，便于配置书写
  'generic-http': (id, cfg) => new GenericHttpAdapter(id, cfg),
};

/** 按类型名创建适配器实例（未注册则回退到通用 HTTP 降级） */
export function createAdapter(
  adapterType: string,
  systemId: string,
  systemConfig: Record<string, unknown>,
): SystemAdapter {
  const factory = registry[adapterType] ?? registry['generic_http'];
  return factory(systemId, systemConfig);
}

/** 列出已注册的适配器类型名（供健康端点/诊断展示） */
export function registeredAdapterTypes(): string[] {
  return Object.keys(registry);
}
