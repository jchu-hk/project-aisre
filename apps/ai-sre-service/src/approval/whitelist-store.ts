/**
 * approval/whitelist-store.ts —— 白名单版本存储接口（抽象）
 *
 * 定义 WhitelistEngine 依赖的最小只读/追加接口，便于：
 *   - 生产：ApprovalStore 实现（SQLite 单文件 + WAL，不可变版本快照）。
 *   - 单测：可注入内存实现（构造 fail-closed 异常场景）。
 *
 * 运行时**只读**当前生效版本；版本追加仅由审批通过后落库（FR-APPROVE-005）。
 */

import {
  WhitelistVersion,
  WhitelistEntry,
  WhitelistEntryDiff,
} from './approval-types';

export interface WhitelistEngineStore {
  /** 当前生效版本（最新）；无 → null。 */
  currentVersion(): WhitelistVersion | null;
}

export interface WhitelistStore extends WhitelistEngineStore {
  getVersion(version: number): WhitelistVersion | null;
  listVersions(): WhitelistVersion[];
  appendWhitelistVersion(v: {
    entries: WhitelistEntry[];
    created_by: string;
    created_at: string;
    approval_id: string | null;
    diff_from_prev: WhitelistEntryDiff[] | null;
  }): WhitelistVersion;
}
