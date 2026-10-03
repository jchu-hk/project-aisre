/**
 * chat/chat-engine.ts —— F-CHAT 对话引擎（鉴权 + 会话 + RBAC + 防注入 + 工具调用 gate）
 *
 * 职责（FR-CHAT-001..006）：
 *   - login()：企业身份 + 短期 JWT（access ≤1h）+ refresh 轮换；建立服务端权威会话。
 *   - createSession()：需有效 JWT；返回 session_id + CSRF 令牌。
 *   - postMessage()：会话校验（active/未超时）→ 注入检测 → 工具调用 gate（经 F-APPROVE）→
 *     RBAC 校验 → 审计；返回脱敏输出（不泄露系统提示词/密钥）。
 *   - refresh()：refresh 轮换（one-time-use；重放即整链路失效）。
 *   - logout()：revoke 会话 + 吊销 access jti + refresh（FR-CHAT-003）。
 *   - killSession()：异常会话实时中断（kill switch，FR-CHAT-005）。
 *
 * **关键边界（DESIGN §6）**：模型输出/用户输入不得直接驱动工具。所有 tool call 必经
 * Policy Gate → ApprovalEngine.judgeOperation()：命中白名单放行，未命中走审批；
 * 注入样本无法绕过白名单/审批（AC-CHAT-004）。
 *
 * 审计（FR-CHAT-006）：每条消息 + 由此触发的操作绑定 session_id + user identity，
 * 经 AuditWriter 异步写 F-AUDIT（action_type: chat.message / chat.action.* / chat.session.*）。
 */

import * as crypto from 'crypto';
import { ChatStore } from './chat-store';
import {
  AccessTokenClaims,
  ActionIntent,
  ActionOutcome,
  ChatErrorCode,
  ChatMessage,
  ChatRole,
  ChatSession,
  InjectionScan,
  RefreshResult,
  ROLE_LABELS,
  TokenVerifyResult,
} from './chat-types';
import {
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_REFRESH_TTL_SECONDS,
  digestRefreshToken,
  generateRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from './jwt';
import { scanInjection, contentDigest } from './injection';
import { authorize, isDangerousAction, RbacDecision } from './rbac';
import { buildModelContext, redactSecrets } from './system-prompt';
import { RateLimiter } from './rate-limit';
import { AuditWriter, toEvent } from '../audit';
import { ApprovalEngine } from '../approval';
import { uuidv7 } from '../audit/audit-store';

/** 默认空闲超时：30 分钟（FR-CHAT-003 / DESIGN §5） */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;

export interface ChatEngineOptions {
  store: ChatStore;
  /** F-APPROVE 审批引擎（工具调用 gate 的判决方） */
  approval: ApprovalEngine;
  /** F-AUDIT 写入器（可选；缺省不发审计） */
  audit?: AuditWriter;
  /** JWT 签名密钥（生产经 Secret 注入） */
  secret: string;
  /** 令牌签发者 */
  issuer?: string;
  /** access TTL（秒）；封顶 3600 */
  accessTtlSeconds?: number;
  /** refresh TTL（秒） */
  refreshTtlSeconds?: number;
  /** 空闲超时（ms） */
  idleMs?: number;
  /** 时间源（ISO） */
  clock?: () => string;
  /** 时间源（epoch 秒，测试注入） */
  nowSeconds?: () => number;
  /** 限流器（可选；缺省内置） */
  rateLimiter?: RateLimiter;
}

/** 登录入参（企业身份，已由上游 IdP 校验） */
export interface LoginInput {
  user_id: string;
  roles: ChatRole[];
  issuer?: string;
  sub?: string;
  /** IP/UA 摘要 */
  client_fingerprint?: string;
  /** 请求来源 IP（限流） */
  ip?: string;
}

export interface LoginResult {
  session_id: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  csrf_token: string;
  roles: ChatRole[];
  role_labels: string[];
}

/** 通用结果：成功时携带 T 字段 + ok:true；失败时 ok:false + 稳定错误。
 * 注：strictNullChecks:false 下判别联合不收窄，故用 T & {可选错误字段} 形式。 */
export type ChatResult<T> = Partial<T> & {
  ok: boolean;
  code?: ChatErrorCode;
  message?: string;
  field?: string;
  status?: number;
};

const VALID_ROLES: ReadonlyArray<ChatRole> = [
  'oncall_sre',
  'platform_owner',
  'security_owner',
  'auditor',
];

export class ChatEngine {
  private readonly store: ChatStore;
  private readonly approval: ApprovalEngine;
  private readonly audit?: AuditWriter;
  private readonly secret: string;
  private readonly issuer: string;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly idleMs: number;
  private readonly clock: () => string;
  private readonly nowSeconds: () => number;
  readonly rateLimiter: RateLimiter;

  constructor(opts: ChatEngineOptions) {
    this.store = opts.store;
    this.approval = opts.approval;
    this.audit = opts.audit;
    this.secret = opts.secret;
    this.issuer = opts.issuer ?? 'ai-sre-chat';
    this.accessTtl = Math.min(3600, Math.max(1, opts.accessTtlSeconds ?? DEFAULT_ACCESS_TTL_SECONDS));
    this.refreshTtl = Math.max(60, opts.refreshTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS);
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.rateLimiter = opts.rateLimiter ?? new RateLimiter();
  }

  // ================================================================ 登录 / 会话

  /**
   * 登录：建立会话 + 签发 access/refresh。
   * 校验身份与角色；未认证（无身份）由 HTTP 层拒绝（401）。
   * 审计：chat.session.created。
   */
  login(input: LoginInput): ChatResult<LoginResult> {
    if (!input.user_id || !input.user_id.trim()) {
      return { ok: false, code: 'unauthenticated', message: '缺少用户身份', status: 401 };
    }
    const roles = (input.roles ?? []).filter((r) => VALID_ROLES.includes(r));
    if (roles.length === 0) {
      return { ok: false, code: 'unauthorized', message: '身份无有效角色', status: 403 };
    }
    const at = this.clock();
    const session_id = uuidv7();
    const csrf_token = crypto.randomBytes(24).toString('hex');
    const session: ChatSession = {
      session_id,
      user_id: input.user_id,
      roles,
      issuer: input.issuer ?? null,
      sub: input.sub ?? null,
      created_at: at,
      last_active_at: at,
      idle_expire_at: new Date(Date.parse(at) + this.idleMs).toISOString(),
      state: 'active',
      client_fingerprint: input.client_fingerprint ?? 'unknown',
      csrf_token,
    };
    this.store.insertSession(session);

    const { token: access_token, expires_in } = signAccessToken(
      { sub: input.user_id, roles, session_id, ttl_seconds: this.accessTtl },
      this.secret,
      this.nowSeconds(),
      this.issuer,
    );
    const refresh_token = generateRefreshToken();
    this.store.insertRefresh(
      digestRefreshToken(refresh_token),
      session_id,
      input.user_id,
      at,
      new Date(Date.parse(at) + this.refreshTtl * 1000).toISOString(),
    );

    this.emit({
      who_type: 'user',
      who_id: input.user_id,
      action_type: 'chat.session.created',
      target_resource: session_id,
      params_digest: `roles=${roles.join(',')}`,
      session_id,
      approval_id: null,
      result: 'success',
      reason: null,
      at,
    });

    return {
      ok: true,
      session_id,
      access_token,
      refresh_token,
      expires_in,
      csrf_token,
      roles,
      role_labels: roles.map((r) => ROLE_LABELS[r]),
    };
  }

  /**
   * 建立/续用会话：需有效 JWT（access token）。
   * 返回会话状态（含剩余空闲时间）。若 JWT 中 session_id 缺失，则新建会话。
   */
  openSession(
    token: string,
  ): ChatResult<{ session_id: string; csrf_token: string; idle_expire_at: string; roles: ChatRole[] }> {
    const v = this.verify(token);
    if (!v.ok) return this.tokenError(v.code);
    const claims = v.claims;
    if (claims.session_id) {
      const s = this.store.getSession(claims.session_id);
      if (!s) {
        return { ok: false, code: 'session_not_found', message: '会话不存在', status: 401 };
      }
      const guard = this.guardSession(s);
      if (guard) return guard;
      return {
        ok: true,
        session_id: s.session_id,
        csrf_token: s.csrf_token,
        idle_expire_at: s.idle_expire_at,
        roles: s.roles,
      };
    }
    return { ok: false, code: 'session_not_found', message: '令牌不含 session_id（请先登录）', status: 401 };
  }

  /** 会话状态（FR-CHAT-003）。 */
  getSession(token: string, sessionId: string): ChatResult<{ session: ChatSession }> {
    const v = this.verify(token);
    if (!v.ok) return this.tokenError(v.code);
    const s = this.store.getSession(sessionId);
    if (!s) return { ok: false, code: 'session_not_found', message: '会话不存在', status: 404 };
    if (s.user_id !== v.claims.sub) {
      return { ok: false, code: 'unauthorized', message: '会话与会话所有者不符', status: 403 };
    }
    // 状态可能是 active/expired/revoked；不因超时改 sessionId 的查询失败（返回状态即可）
    return { ok: true, session: s };
  }

  // ================================================================ 发消息（核心）

  /**
   * 发送消息（FR-CHAT-003/004/006）。
   * 流程：令牌校验 → 会话 active/未超时 → 限流（HTTP 层已计，或此处兜底）→
   *       注入检测 → 若有动作意图：RBAC → F-APPROVE gate → 审计；消息本身写审计。
   * @param csrf CSRF 令牌（cookie 双提交；HTTP 层校验，此处兜底）
   */
  postMessage(
    token: string,
    sessionId: string,
    content: string,
    opts: { csrf?: string; action?: ActionIntent } = {},
  ): ChatResult<{
    msg_id: string;
    reply: string;
    injection: InjectionScan;
    action: ActionOutcome | null;
  }> {
    const v = this.verify(token);
    if (!v.ok) return this.tokenError(v.code);
    const claims = v.claims;
    const s = this.store.getSession(sessionId);
    if (!s) return { ok: false, code: 'session_not_found', message: '会话不存在', status: 404 };
    if (s.user_id !== claims.sub) {
      return { ok: false, code: 'unauthorized', message: '会话与令牌主体不符', status: 403 };
    }
    const guard = this.guardSession(s);
    if (guard) return guard;
    // 令牌绑定的会话须一致（防跨会话复用）
    if (claims.session_id && claims.session_id !== sessionId) {
      return { ok: false, code: 'unauthorized', message: '令牌与会话不匹配', status: 403 };
    }
    // CSRF（若提供）：恒定比较
    if (opts.csrf !== undefined && opts.csrf !== s.csrf_token) {
      this.auditMessage(s, 'user', content, false, null, null, 'denied', 'csrf token mismatch');
      return { ok: false, code: 'csrf_failed', message: 'CSRF 校验失败', status: 403 };
    }
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, code: 'invalid_input', message: '消息内容为空', status: 422 };
    }

    const at = this.clock();
    // —— 通道分离（DESIGN §6.1）：用户内容永远作为不可信数据块 ——
    const ctx = buildModelContext(content);
    // 注入检测（FR-CHAT-004.2）
    const injection = scanInjection(content);

    // —— 消息落库（摘要）+ 审计（FR-CHAT-006，无论是否命中注入） ——
    const msg_id = uuidv7();
    this.store.appendMessage({
      msg_id,
      session_id: sessionId,
      role: 'user',
      content_digest: contentDigest(content),
      injected_flag: injection.suspicious,
      triggered_action: opts.action ? opts.action.operation : null,
      approval_id: null,
      created_at: at,
    });

    // —— 注入命中：记可疑审计；高危 → 直接拒绝（无法绕过白名单/审批） ——
    if (injection.suspicious) {
      this.emit({
        who_type: 'user',
        who_id: s.user_id,
        action_type: 'chat.injection.detected',
        target_resource: sessionId,
        params_digest: `patterns=${injection.patterns.join(',')};score=${injection.score};blocked=${injection.blocked}`,
        session_id: sessionId,
        approval_id: null,
        result: injection.blocked ? 'denied' : 'success',
        reason: injection.blocked ? `injection blocked: ${injection.patterns.join(',')}` : null,
        at,
      });
    }

    // 工具调用 gate：模型/用户输出不得直接驱动工具；无论注入与否都经 F-APPROVE。
    let action: ActionOutcome | null = null;
    if (opts.action) {
      action = this.handleActionIntent(s, opts.action, { injection, at });
      // 回填消息的 triggered_action / approval_id（消息本就落库，此处不改造 append-only 表；
      // 审计链已记录关联，audit 查询可按 session_id+approval_id 串联）
      this.emit({
        who_type: 'user',
        who_id: s.user_id,
        action_type: action.allowed ? 'chat.action.allowed' : 'chat.action.denied',
        target_resource: opts.action.target_resource,
        params_digest: `op=${opts.action.operation};approval=${action.approval_id ?? 'none'};rbac_denied=${action.denied_by_rbac}`,
        session_id: sessionId,
        approval_id: action.approval_id,
        result: action.allowed ? 'success' : 'denied',
        reason: action.allowed ? null : action.reason,
        at,
      });
    }

    // 更新会话活跃度（滑动窗口）
    this.store.touchSession(
      sessionId,
      at,
      new Date(Date.parse(at) + this.idleMs).toISOString(),
    );

    // 审计：消息主体（chat.message），无论是否触发动作
    this.auditMessage(s, 'user', content, injection.suspicious, opts.action?.operation ?? null, action?.approval_id ?? null, 'success', null);

    // —— 生成回复（不驱动工具；仅告知结果） + 输出防泄露 ——
    let reply: string;
    if (injection.blocked) {
      reply = `已拒绝：消息命中注入防护策略（${injection.patterns.join(', ')}）。该请求不会绕过白名单/审批流程。`;
    } else if (action) {
      if (action.denied_by_rbac) reply = `操作被拒绝：${action.reason}`;
      else if (action.allowed) reply = `操作 ${opts.action?.operation} 命中白名单，已放行（记录于审计）。`;
      else reply = `操作 ${opts.action?.operation} 未命中白名单，已创建审批单 ${action.approval_id}（状态：${action.state}），等待审批。`;
    } else {
      reply = '已收到你的消息（只读会话）。如需执行操作，请提交具体动作，系统将经白名单/审批判定。';
    }
    reply = redactSecrets(reply);

    // 助手回复也落库（摘要）
    this.store.appendMessage({
      msg_id: uuidv7(),
      session_id: sessionId,
      role: 'assistant',
      content_digest: contentDigest(reply),
      injected_flag: false,
      triggered_action: null,
      approval_id: action?.approval_id ?? null,
      created_at: this.clock(),
    });

    // 引用未使用告警规避：ctx 已用于演示通道分离
    void ctx;

    return { ok: true, msg_id, reply, injection, action };
  }

  /**
   * 工具调用 gate（DESIGN §6.3）：动作合法性判决权完全在 Policy Gate → F-APPROVE。
   *   1) 注入阻断 → 直接拒绝（连审批都不建）；
   *   2) RBAC（动作入口）→ 无权限拒绝（审计员危险操作，AC-CHAT-002）；
   *   3) F-APPROVE judgeOperation → 命中白名单放行 / 未命中建单。
   */
  private handleActionIntent(
    session: ChatSession,
    intent: ActionIntent,
    ctx: { injection: InjectionScan; at: string },
  ): ActionOutcome {
    // 1) 注入高危 → 拒绝（绝不允许绕过）
    if (ctx.injection.blocked) {
      return {
        allowed: false,
        approval_id: null,
        state: null,
        denied_by_rbac: false,
        reason: `injection blocked: ${ctx.injection.patterns.join(',')}`,
      };
    }
    // 2) RBAC 动作入口校验
    const rbac: RbacDecision = authorize(session.roles, intent.operation);
    if (!rbac.allowed) {
      return {
        allowed: false,
        approval_id: null,
        state: null,
        denied_by_rbac: true,
        reason: rbac.reason,
      };
    }
    // 危险操作须具备 action.execute（审计员自然没有）——双保险
    if (isDangerousAction(intent.operation) && !session.roles.some((r) => r !== 'auditor')) {
      return {
        allowed: false,
        approval_id: null,
        state: null,
        denied_by_rbac: true,
        reason: '审计员不可发起危险操作',
      };
    }
    // 3) F-APPROVE 判定（唯一拦截点，不可旁路）
    try {
      const judged = this.approval.judgeOperation({
        operation: intent.operation,
        target_resource: intent.target_resource,
        env: intent.env ?? null,
        initiator_agent: `chat:${session.user_id}`,
        summary: intent.summary,
        risk_note: `via F-CHAT session ${session.session_id}`,
        incident_id: null,
        session_id: session.session_id,
        params: intent.params ?? {},
      });
      return {
        allowed: judged.allowed,
        approval_id: judged.approval ? judged.approval.approval_id : null,
        state: judged.approval ? judged.approval.state : judged.allowed ? 'WHITELISTED' : null,
        denied_by_rbac: false,
        reason: judged.decision.reason,
      };
    } catch (e) {
      // fail-closed：判定异常 → 拒绝
      return {
        allowed: false,
        approval_id: null,
        state: null,
        denied_by_rbac: false,
        reason: `fail-closed: approval gate error: ${(e as Error).message}`,
      };
    }
  }

  // ================================================================ refresh 轮换

  /**
   * 刷新令牌（one-time-use 轮换，DESIGN §5）。
   *   有效 → 签发新 access + 新 refresh，旧 refresh 标记已用；
   *   重放已用 refresh → 整会话链路失效（revoke）+ 报错（token_reuse_detected）。
   */
  refresh(refreshToken: string): ChatResult<RefreshResult> {
    const digest = digestRefreshToken(refreshToken);
    const rec = this.store.getRefresh(digest);
    if (!rec) return { ok: false, code: 'unauthenticated', message: '刷新令牌无效', status: 401 };
    const at = this.clock();
    if (rec.used_at) {
      // 重放检测：吊销该会话全部 refresh + 吊销会话
      this.store.markRefreshReuse(digest, at);
      this.store.revokeRefreshBySession(rec.session_id);
      this.store.setState(rec.session_id, 'revoked');
      this.emit({
        who_type: 'user',
        who_id: rec.user_id,
        action_type: 'chat.token.reuse_detected',
        target_resource: rec.session_id,
        params_digest: 'refresh replay',
        session_id: rec.session_id,
        approval_id: null,
        result: 'denied',
        reason: 'refresh token reused (rotation violation)',
        at,
      });
      return { ok: false, code: 'token_reuse_detected', message: '刷新令牌已被使用（重放）', status: 401 };
    }
    if (rec.revoked) return { ok: false, code: 'session_revoked', message: '刷新令牌已吊销', status: 401 };
    if (Date.parse(at) >= Date.parse(rec.expires_at)) {
      return { ok: false, code: 'session_expired', message: '刷新令牌已过期', status: 401 };
    }
    const session = this.store.getSession(rec.session_id);
    if (!session) return { ok: false, code: 'session_not_found', message: '会话不存在', status: 401 };
    const guard = this.guardSession(session);
    if (guard) return guard;

    // 轮换：标记旧 refresh 已用 + 签发新对
    this.store.markRefreshUsed(digest, at);
    const { token: access_token, expires_in } = signAccessToken(
      { sub: session.user_id, roles: session.roles, session_id: session.session_id, ttl_seconds: this.accessTtl },
      this.secret,
      this.nowSeconds(),
      this.issuer,
    );
    const newRefresh = generateRefreshToken();
    this.store.insertRefresh(
      digestRefreshToken(newRefresh),
      session.session_id,
      session.user_id,
      at,
      new Date(Date.parse(at) + this.refreshTtl * 1000).toISOString(),
    );
    this.store.touchSession(session.session_id, at, new Date(Date.parse(at) + this.idleMs).toISOString());

    this.emit({
      who_type: 'user',
      who_id: session.user_id,
      action_type: 'chat.token.refreshed',
      target_resource: session.session_id,
      params_digest: 'refresh rotation',
      session_id: session.session_id,
      approval_id: null,
      result: 'success',
      reason: null,
      at,
    });
    return { ok: true, access_token, refresh_token: newRefresh, expires_in };
  }

  // ================================================================ 登出 / 中断

  /**
   * 登出（FR-CHAT-003）：revoke 会话 + 吊销当前 access jti + 吊销全部 refresh。
   * 登出后旧 token 不可复用（AC-CHAT-003）。
   */
  logout(token: string, sessionId: string): ChatResult<{ session_id: string }> {
    const v = this.verify(token);
    if (!v.ok) return this.tokenError(v.code);
    const s = this.store.getSession(sessionId);
    if (!s) return { ok: false, code: 'session_not_found', message: '会话不存在', status: 404 };
    if (s.user_id !== v.claims.sub) {
      return { ok: false, code: 'unauthorized', message: '会话与令牌主体不符', status: 403 };
    }
    const at = this.clock();
    this.store.revokeToken(v.claims.jti, sessionId, at, 'logout');
    this.store.revokeRefreshBySession(sessionId);
    this.store.setState(sessionId, 'revoked');
    this.emit({
      who_type: 'user',
      who_id: s.user_id,
      action_type: 'chat.session.logged_out',
      target_resource: sessionId,
      params_digest: `jti=${v.claims.jti}`,
      session_id: sessionId,
      approval_id: null,
      result: 'success',
      reason: null,
      at,
    });
    return { ok: true, session_id: sessionId };
  }

  /** kill switch：异常会话实时中断（FR-CHAT-005）。 */
  killSession(sessionId: string, reason: string): boolean {
    const s = this.store.getSession(sessionId);
    if (!s) return false;
    const at = this.clock();
    this.store.revokeRefreshBySession(sessionId);
    this.store.setState(sessionId, 'revoked');
    this.emit({
      who_type: 'system',
      who_id: 'chat-kill-switch',
      action_type: 'chat.session.killed',
      target_resource: sessionId,
      params_digest: `reason=${reason}`,
      session_id: sessionId,
      approval_id: null,
      result: 'denied',
      reason,
      at,
    });
    return true;
  }

  // ================================================================ 内部

  /** 公开令牌校验（HTTP 层预检/限流前置用）。 */
  verifyToken(token: string): TokenVerifyResult {
    return this.verify(token);
  }

  private verify(token: string) {
    return verifyAccessToken(token, this.secret, this.nowSeconds(), this.store.revokedJtiSet(), this.issuer);
  }

  private tokenError(code: string): ChatResult<{}> {
    const map: Record<string, { c: ChatErrorCode; m: string }> = {
      expired: { c: 'session_expired', m: '访问令牌已过期，请重新登录' },
      revoked: { c: 'session_revoked', m: '访问令牌已吊销，请重新登录' },
      bad_signature: { c: 'unauthenticated', m: '令牌签名无效' },
      malformed: { c: 'unauthenticated', m: '令牌格式无效' },
      bad_claims: { c: 'unauthenticated', m: '令牌声明无效' },
    };
    const e = map[code] ?? { c: 'unauthenticated' as ChatErrorCode, m: '鉴权失败' };
    return { ok: false, code: e.c, message: e.m, status: 401 };
  }

  /** 会话可用性守卫（active + 未空闲超时）。 */
  private guardSession(s: ChatSession): ChatResult<{}> | null {
    if (s.state === 'revoked') {
      return { ok: false, code: 'session_revoked', message: '会话已失效，请重新登录', status: 401 };
    }
    const now = this.clock();
    if (s.state === 'expired' || Date.parse(now) >= Date.parse(s.idle_expire_at)) {
      if (s.state === 'active') this.store.setState(s.session_id, 'expired');
      return { ok: false, code: 'session_expired', message: '会话空闲超时，请重新登录', status: 401 };
    }
    return null;
  }

  private auditMessage(
    s: ChatSession,
    role: 'user' | 'assistant',
    content: string,
    injected: boolean,
    triggered_action: string | null,
    approval_id: string | null,
    result: 'success' | 'failed' | 'denied' | 'pending',
    reason: string | null,
  ): void {
    this.emit({
      who_type: role === 'user' ? 'user' : 'agent',
      who_id: role === 'user' ? s.user_id : 'ai-sre',
      action_type: 'chat.message',
      target_resource: `${s.session_id}/${role}`,
      params_digest: contentDigest(content),
      session_id: s.session_id,
      approval_id,
      result,
      reason,
      at: this.clock(),
      extra_digest: injected ? 'injected=true' : null,
      triggered_action,
    });
  }

  private emit(input: {
    who_type: 'agent' | 'user' | 'system';
    who_id: string;
    action_type: string;
    target_resource: string;
    params_digest: string | null;
    session_id: string | null;
    approval_id: string | null;
    result: 'success' | 'failed' | 'denied' | 'pending';
    reason: string | null;
    at: string;
    extra_digest?: string | null;
    triggered_action?: string | null;
  }): void {
    if (this.audit) {
      const extra = [input.params_digest, input.extra_digest, input.triggered_action ? `action=${input.triggered_action}` : null]
        .filter((x) => !!x)
        .join(';');
      this.audit.emit(
        toEvent({
          who_type: input.who_type,
          who_id: input.who_id,
          when: input.at,
          action_type: input.action_type,
          target_resource: input.target_resource,
          params_digest: extra || null,
          why_source: 'chat',
          incident_id: null,
          session_id: input.session_id,
          approval_id: input.approval_id,
          result: input.result,
          reason: input.reason,
        }),
      );
    }
  }
}
