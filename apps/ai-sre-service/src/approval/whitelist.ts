/**
 * approval/whitelist.ts —— 版本化白名单引擎（F-APPROVE-001/002/005 / DESIGN §2.2 §4）
 *
 * 职责：
 *   - 载入当前生效版本（内存缓存 + 版本变更热更新，判定目标 < 50ms，DESIGN §8）。
 *   - 操作前判定：命中 → 放行；未命中 → 由 approval-engine 创建审批请求。
 *   - **fail-closed**：载入/匹配任何异常（无版本、版本缺失、正则/构造异常）→ 一律 deny
 *     （策略引擎任何不确定 → 默认拒绝，绝不默认放行，DESIGN §4）。
 *   - 白名单变更 diff：before/after 条目级差异（FR-APPROVE-005 / AC-APPROVE-005）。
 *
 * 运行时**只读**当前生效版本；变更走审批（本模块只暴露 applyDiff 供批准后落新版本，
 * 由 approval-engine 在审批通过时调用，不对外暴露直改接口）。
 */

import { WhitelistEngineStore } from './whitelist-store';
import {
  WhitelistEntry,
  WhitelistDecision,
  WhitelistEntryDiff,
} from './approval-types';

/** 判定请求上下文 */
export interface WhitelistCheckInput {
  operation: string;
  target_resource: string;
  /** 运行环境（用于 condition.env 判定；缺省量 null 视为「不限 env」的条目可命中） */
  env?: string | null;
}

export class WhitelistEngine {
  private readonly store: WhitelistEngineStore;
  /** 当前生效版本缓存（版本变更热更新） */
  private cachedVersion: number | null = null;
  private cachedEntries: WhitelistEntry[] | null = null;

  constructor(store: WhitelistEngineStore) {
    this.store = store;
  }

  /** 载入当前生效版本到内存；异常一律抛出（由 check 转 fail-closed）。 */
  private load(): { version: number; entries: WhitelistEntry[] } {
    const cur = this.store.currentVersion();
    if (cur === null) throw new Error('whitelist has no version (fail-closed)');
    if (this.cachedVersion !== cur.version || this.cachedEntries === null) {
      this.cachedVersion = cur.version;
      this.cachedEntries = cur.entries;
    }
    return { version: cur.version, entries: this.cachedEntries };
  }

  /** 当前版本号（拿不到 → null）。 */
  currentVersionNumber(): number | null {
    const cur = this.store.currentVersion();
    return cur ? cur.version : null;
  }

  /**
   * 操作前白名单判定（FR-APPROVE-002）。
   * 命中 → { allowed:true, matched }；未命中 → { allowed:false }。
   * 任何异常 → { allowed:false, reason:'fail-closed…' }（绝不默认放行）。
   */
  check(input: WhitelistCheckInput): WhitelistDecision {
    const t0 = Date.now();
    try {
      const { version, entries } = this.load();
      const matched = entries.find((e) => this.matches(e, input)) ?? null;
      const elapsed = Date.now() - t0;
      if (matched) {
        return {
          allowed: true,
          matched,
          reason: `whitelist hit: ${matched.operation}@${matched.resource_scope} (v${version})`,
          version,
          elapsed_ms: elapsed,
        };
      }
      return {
        allowed: false,
        matched: null,
        reason: `whitelist miss: no entry for operation=${input.operation} resource=${input.target_resource}`,
        version,
        elapsed_ms: elapsed,
      };
    } catch (e) {
      // fail-closed：策略引擎任何异常 → 默认拒绝
      return {
        allowed: false,
        matched: null,
        reason: `fail-closed: whitelist evaluation error: ${(e as Error).message}`,
        version: null,
        elapsed_ms: Date.now() - t0,
      };
    }
  }

  /** 单条命中：operation 精确 + resource_scope 匹配 + condition.env 通过 + 有效期内。 */
  private matches(entry: WhitelistEntry, input: WhitelistCheckInput): boolean {
    if (entry.operation !== input.operation) return false;
    if (!scopeMatches(entry.resource_scope, input.target_resource)) return false;
    if (!conditionMatches(entry.condition, input.env ?? null)) return false;
    if (!inWindow(entry, new Date().toISOString())) return false;
    return true;
  }

  /**
   * 白名单变更 diff（before → after 条目级）。
   * 以 `${operation}::${resource_scope}` 为条目键；新增/删除/修改分别标记。
   */
  static diff(before: WhitelistEntry[], after: WhitelistEntry[]): WhitelistEntryDiff[] {
    const key = (e: WhitelistEntry) => `${e.operation}::${e.resource_scope}`;
    const beforeMap = new Map(before.map((e) => [key(e), e]));
    const afterMap = new Map(after.map((e) => [key(e), e]));
    const out: WhitelistEntryDiff[] = [];
    for (const [k, b] of beforeMap) {
      const a = afterMap.get(k);
      if (!a) out.push({ op: 'remove', before: b, after: null });
      else if (JSON.stringify(b) !== JSON.stringify(a))
        out.push({ op: 'modify', before: b, after: a });
    }
    for (const [k, a] of afterMap) {
      if (!beforeMap.has(k)) out.push({ op: 'add', before: null, after: a });
    }
    return out;
  }
}

/** resource_scope 匹配：'*' 通配 / 精确 / 'prefix/…' 前缀（按段边界）。 */
export function scopeMatches(scope: string, resource: string): boolean {
  if (scope === '*') return true;
  if (scope === resource) return true;
  // 前缀匹配：scope 为 resource 的段前缀（如 system/sys-web 命中 system/sys-web/gateway）
  if (resource.startsWith(scope + '/')) return true;
  return false;
}

/** condition 匹配：env 白名单；condition 为 null/无 env → 不限 env。 */
export function conditionMatches(
  condition: WhitelistEntry['condition'],
  env: string | null,
): boolean {
  if (!condition || !condition.env || condition.env.length === 0) return true;
  if (env === null) return false; // 有条件但未声明 env → 不命中
  return condition.env.includes(env);
}

/** 有效期窗口判定：effective_from ≤ now ≤ effective_to（null 视为无界）。 */
export function inWindow(entry: WhitelistEntry, now: string): boolean {
  if (entry.effective_from && now < entry.effective_from) return false;
  if (entry.effective_to && now > entry.effective_to) return false;
  return true;
}
