/**
 * intake/index.ts —— 公开 API 聚合（F-SRE-014 用户报障接入）。
 *
 * 便于 main.ts 一行接入：启用配置中有 active intake_channels 时，构建
 * IncidentStore + IntakeService + 回执/保留，并产出收报 CPU 处理器。
 * 空配置或全禁用 → disabled=true（不注册、不报错 = 待接入态，符合 AC 空态基线）。
 */

import { SreConfig, intakeRetention } from '../config/types';
import { IncidentStore } from '../incidents/incident-store';
import { IntakeService } from './ingestion';
import { RetentionSweeper } from './retention';
import { MountedRoute, makeIntakeHandle, planIntakeRoutes, IntakeHandle } from './http-intake';

export interface IntakeRuntime {
  service: IntakeService;
  store: IncidentStore;
  sweeper: RetentionSweeper;
  routes: MountedRoute[];
  /** 收报 CPU 处理器（disabled=true 时始终返回 false，不影响基础路由） */
  handle: IntakeHandle;
  /** 是否处于「待接入 / 未启用」态 */
  disabled: boolean;
}

/** 根据配置构建 intake 运行时（不直接挂 http；由 main.ts 接入单一 request 监听器） */
export function buildIntake(config: SreConfig): IntakeRuntime {
  const channels = (config.intake_channels ?? []).filter((c) => c.enabled !== false);
  const store = new IncidentStore();
  const retention = intakeRetention(config);
  const sweeper = new RetentionSweeper(store, retention);
  if (channels.length === 0) {
    return {
      service: new IntakeService(store),
      store,
      sweeper,
      routes: [],
      handle: () => false,
      disabled: true,
    };
  }
  const service = new IntakeService(store);
  const routes = planIntakeRoutes(config);
  const handle = makeIntakeHandle(routes, service);
  return { service, store, sweeper, routes, handle, disabled: false };
}
