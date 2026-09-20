/**
 * lifecycle/types.ts —— lifecycle 相关共享类型（ledger 元数据等）
 */

import { LifecycleState } from './state';

/**
 * incident 行的生命周期元数据（进程内参照 = DB sre_incidents 增列）。
 * 保存：当前 lifecycle、最近一次迁移时刻、reopen_reason（同一 incident 行内冗余，
 * 便于只查 sre_incidents 不必 join transitions 的读路径与 seed 投影）。
 */
export interface IncLifecycleMeta {
  lifecycle: LifecycleState;
  lifecycle_updated_at: string; // ISO
  lifecycle_reopen_reason: string | null;
}
