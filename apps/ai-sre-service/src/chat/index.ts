/**
 * chat/index.ts —— F-CHAT 公开 API 聚合（Phase 2）
 *
 * 便于 main.ts 一行接入：
 *   buildChat({ dbPath, approval, audit, secret }) → { store, engine, handle, sweep }
 * 其中 sweep 为空闲超时扫描器（active 会话 idle → expired，FR-CHAT-003）。
 *
 * 与 F-APPROVE 集成：工具调用 gate 复用 ApprovalEngine.judgeOperation（DESIGN §6.3）。
 * 与 F-AUDIT 集成：每条消息/动作/会话事件经 AuditWriter 异步发审计（FR-CHAT-006）。
 */

import { ChatStore, ChatStoreOptions } from './chat-store';
import { ChatEngine, ChatEngineOptions, DEFAULT_IDLE_MS } from './chat-engine';
import { buildChatHandle, ChatHandle, CHAT_BASE_PATH } from './http';
import { AuditWriter } from '../audit';
import { ApprovalEngine } from '../approval';

export * from './chat-types';
export { ChatStore } from './chat-store';
export { ChatEngine, DEFAULT_IDLE_MS } from './chat-engine';
export { buildChatHandle, CHAT_BASE_PATH } from './http';
export { RateLimiter } from './rate-limit';
export { scanInjection, contentDigest } from './injection';
export {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  digestRefreshToken,
  constantTimeEqual,
  MAX_ACCESS_TTL_SECONDS,
} from './jwt';
export { SYSTEM_PROMPT, buildModelContext, redactSecrets } from './system-prompt';
export { authorize, hasPermission, isDangerousAction, permissionForAction } from './rbac';

export interface BuildChatOptions extends ChatStoreOptions {
  /** F-APPROVE 审批引擎（工具调用 gate 必需） */
  approval: ApprovalEngine;
  /** F-AUDIT 写入器（可选） */
  audit?: AuditWriter;
  /** JWT 签名密钥（生产经 Secret 注入；缺省用 env CHAT_JWT_SECRET 或开发缺省） */
  secret?: string;
  issuer?: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  idleMs?: number;
  clock?: () => string;
  nowSeconds?: () => number;
  enforceCsrf?: boolean;
  /** 空闲扫描间隔（ms）；0 → 不启动后台扫描（单测手动 expireIdle）。 */
  sweepIntervalMs?: number;
}

export interface ChatRuntime {
  store: ChatStore;
  engine: ChatEngine;
  handle: ChatHandle;
  /** 手动触发一次空闲过期扫描。 */
  sweep: () => number;
  close: () => void;
}

/** 构建 chat 运行时（不直接挂 http；由 main.ts 并入单一 request 监听器）。 */
export function buildChat(opts: BuildChatOptions): ChatRuntime {
  const store = new ChatStore(opts);
  const secret = opts.secret ?? process.env.CHAT_JWT_SECRET ?? 'dev-insecure-chat-secret-change-me';
  const engineOpts: ChatEngineOptions = {
    store,
    approval: opts.approval,
    audit: opts.audit,
    secret,
    issuer: opts.issuer,
    accessTtlSeconds: opts.accessTtlSeconds,
    refreshTtlSeconds: opts.refreshTtlSeconds,
    idleMs: opts.idleMs ?? DEFAULT_IDLE_MS,
    clock: opts.clock,
    nowSeconds: opts.nowSeconds,
  };
  const engine = new ChatEngine(engineOpts);
  const handle = buildChatHandle({ engine, enforceCsrf: opts.enforceCsrf });

  let timer: NodeJS.Timeout | null = null;
  const interval = opts.sweepIntervalMs ?? 60_000;
  if (interval > 0) {
    timer = setInterval(() => {
      try {
        store.expireIdle(new Date().toISOString());
        engine.rateLimiter.sweep();
      } catch {
        /* 扫描异常不崩主链路 */
      }
    }, interval);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    store,
    engine,
    handle,
    sweep: () => store.expireIdle(new Date().toISOString()).length,
    close: () => {
      if (timer) clearInterval(timer);
      timer = null;
      store.close();
    },
  };
}
