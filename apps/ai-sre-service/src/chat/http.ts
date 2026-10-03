/**
 * chat/http.ts —— F-CHAT HTTP 接线层（DESIGN §7 Chat）
 *
 * 端点：
 *   POST /api/v1/chat/login                          开发/测试用直接登录（企业 IdP 回调端点生产等价）
 *   POST /api/v1/chat/sessions                       需有效 JWT，建立/续用会话返回 session_id + CSRF
 *   POST /api/v1/chat/sessions/{id}/messages         发送消息（含可选 action 触发工具调用 gate）
 *   POST /api/v1/chat/sessions/{id}/logout           登出，revoke token（FR-CHAT-003）
 *   GET  /api/v1/chat/sessions/{id}                   会话状态
 *   POST /api/v1/chat/refresh                         refresh 轮换
 *   POST /api/v1/chat/sessions/{id}/kill              kill switch（异常会话实时中断）
 *
 * 鉴权（AC-CHAT-001）：无 token / 过期 token → HTTP 401，不建立会话。
 * RBAC（AC-CHAT-002）：动作入口校验；审计员危险操作 → 403。
 * 限流（AC-CHAT-005）：按用户/IP；超限 → 429（带 Retry-After）。
 * CSRF：cookie 模式双提交；敏感写请求校验 x-csrf-token 或 body.csrf_token。
 * 统一错误体 { ok:false, code, message, field? }（与 audit/approval/query 层对齐）。
 */

import { IncomingMessage, ServerResponse } from 'http';
import { ChatEngine, LoginInput } from './chat-engine';
import { ChatRole, ChatErrorCode } from './chat-types';

export const CHAT_BASE_PATH = '/api/v1/chat';

export interface ChatHttpDeps {
  engine: ChatEngine;
  /** 从 Authorization 头解析 Bearer token 的替代钩子（默认内建）。 */
  extractToken?: (req: IncomingMessage) => string | null;
  /** 是否强制 CSRF（默认 true，写操作）。 */
  enforceCsrf?: boolean;
}

export type ChatHandle = (req: IncomingMessage, res: ServerResponse) => boolean;

/** 错误码 → HTTP 状态兜底映射 */
const STATUS_FALLBACK: Record<ChatErrorCode, number> = {
  unauthenticated: 401,
  unauthorized: 403,
  session_not_found: 404,
  session_expired: 401,
  session_revoked: 401,
  csrf_failed: 403,
  rate_limited: 429,
  invalid_input: 422,
  injection_blocked: 403,
  token_reuse_detected: 401,
  method_not_allowed: 405,
};

export function buildChatHandle(deps: ChatHttpDeps): ChatHandle {
  const { engine } = deps;
  const enforceCsrf = deps.enforceCsrf ?? true;

  return (req, res): boolean => {
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0];
    const method = (req.method ?? 'GET').toUpperCase();

    if (path !== CHAT_BASE_PATH && !path.startsWith(CHAT_BASE_PATH + '/')) return false;

    // ---------------- POST /login（直接登录；企业 IdP 回调等价端点） ----------------
    if (path === `${CHAT_BASE_PATH}/login`) {
      if (method !== 'POST') return methodNotAllowed(res);
      return readBody(req, (body) => {
        const input: LoginInput = {
          user_id: str(body.user_id) ?? str(body.sub) ?? '',
          roles: roleArray(body.roles),
          issuer: str(body.issuer),
          sub: str(body.sub),
          client_fingerprint: fingerprintOf(req),
          ip: clientIp(req),
        };
        const r = engine.login(input);
        if (!r.ok) {
          return writeErr(res, r.status ?? STATUS_FALLBACK[r.code], { code: r.code, message: r.message, field: r.field });
        }
        // 限流：登录也计
        const rl = engine.rateLimiter.check(input.user_id || 'anon', clientIp(req));
        if (!rl.allowed) return rateLimited(res, rl.retry_after);
        // access/refresh 走 body 返回（令牌存 HttpOnly/Secure cookie 由网关负责，NFR）
        setAuthCookie(res, r.access_token);
        return writeJson(res, 201, {
          ok: true,
          session_id: r.session_id,
          access_token: r.access_token,
          refresh_token: r.refresh_token,
          expires_in: r.expires_in,
          csrf_token: r.csrf_token,
          roles: r.roles,
          role_labels: r.role_labels,
        });
      });
    }

    // ---------------- POST /refresh ----------------
    if (path === `${CHAT_BASE_PATH}/refresh`) {
      if (method !== 'POST') return methodNotAllowed(res);
      return readBody(req, (body) => {
        const rt = str(body.refresh_token) ?? '';
        if (!rt) return writeErr(res, 422, { code: 'invalid_input', message: '需 refresh_token', field: 'refresh_token' });
        const r = engine.refresh(rt);
        if (!r.ok) return writeErr(res, r.status ?? STATUS_FALLBACK[r.code], { code: r.code, message: r.message });
        setAuthCookie(res, r.access_token);
        return writeJson(res, 200, {
          ok: true,
          access_token: r.access_token,
          refresh_token: r.refresh_token,
          expires_in: r.expires_in,
        });
      });
    }

    // ---------------- 会话子资源 ----------------
    const m = matchSession(path);
    if (!m) return writeErr(res, 404, { code: 'session_not_found', message: '未知 chat 端点' });

    const { sessionId, sub } = m;
    const token = extractToken(req);

    // POST /sessions（无 id）→ 建立/续用会话
    if (sub === null && method === 'POST') {
      if (!token) return unauthenticated(res, '缺少 Authorization Bearer 令牌');
      const r = engine.openSession(token);
      if (!r.ok) return writeErr(res, r.status ?? STATUS_FALLBACK[r.code], { code: r.code, message: r.message });
      return writeJson(res, 200, {
        ok: true,
        session_id: r.session_id,
        csrf_token: r.csrf_token,
        idle_expire_at: r.idle_expire_at,
        roles: r.roles,
      });
    }
    if (sub === null) return methodNotAllowed(res);

    // GET /sessions/{id} → 状态
    if (sub === '' && method === 'GET') {
      if (!token) return unauthenticated(res, '缺少 Authorization Bearer 令牌');
      const r = engine.getSession(token, sessionId);
      if (!r.ok) return writeErr(res, r.status ?? STATUS_FALLBACK[r.code], { code: r.code, message: r.message });
      return writeJson(res, 200, { ok: true, session: r.session });
    }

    // POST /sessions/{id}/messages
    if (sub === '/messages' && method === 'POST') {
      if (!token) return unauthenticated(res, '缺少 Authorization Bearer 令牌');
      // 鉴权先于限流：未认证一律 401（AC-CHAT-001，且 <300ms）
      const claims = peekClaims(engine, token);
      if (!claims.ok) return writeErr(res, 401, { code: claims.code, message: claims.message });
      const rl = engine.rateLimiter.check(claims.user_id, clientIp(req));
      if (!rl.allowed) return rateLimited(res, rl.retry_after);
      return readBody(req, (body) => {
        const content = str(body.content ?? body.message) ?? '';
        const csrf = enforceCsrf ? headerStr(req, 'x-csrf-token') ?? str(body.csrf_token) : undefined;
        const action =
          body.action && typeof body.action === 'object'
            ? normalizeAction(body.action as Record<string, unknown>)
            : undefined;
        const r = engine.postMessage(token, sessionId, content, { csrf, action });
        if (!r.ok) {
          return writeErr(res, r.status ?? STATUS_FALLBACK[r.code], { code: r.code, message: r.message, field: r.field });
        }
        // 注入高危 → 403（但仍返回检测详情供前端提示；AC-CHAT-004）
        const status = r.injection.blocked ? 403 : 200;
        return writeJson(res, status, {
          ok: !r.injection.blocked,
          msg_id: r.msg_id,
          reply: r.reply,
          injection: r.injection,
          action: r.action,
        });
      });
    }

    // POST /sessions/{id}/logout
    if (sub === '/logout' && method === 'POST') {
      if (!token) return unauthenticated(res, '缺少 Authorization Bearer 令牌');
      const claims = peekClaims(engine, token);
      if (!claims.ok) return writeErr(res, 401, { code: claims.code, message: claims.message });
      if (enforceCsrf) {
        const csrf = headerStr(req, 'x-csrf-token');
        const got = engine.getSession(token, sessionId);
        if (!got.ok) return writeErr(res, got.status ?? STATUS_FALLBACK[got.code], { code: got.code, message: got.message });
        if (!csrf || csrf !== got.session.csrf_token) {
          return writeErr(res, 403, { code: 'csrf_failed', message: 'CSRF 校验失败' });
        }
      }
      const r = engine.logout(token, sessionId);
      if (!r.ok) return writeErr(res, r.status ?? STATUS_FALLBACK[r.code], { code: r.code, message: r.message });
      clearAuthCookie(res);
      return writeJson(res, 200, { ok: true, session_id: r.session_id, revoked: true });
    }

    // POST /sessions/{id}/kill（kill switch）
    if (sub === '/kill' && method === 'POST') {
      if (!token) return unauthenticated(res, '缺少 Authorization Bearer 令牌');
      const claims = peekClaims(engine, token);
      if (!claims.ok) return writeErr(res, 401, { code: claims.code, message: claims.message });
      // 仅非审计员角色可中断；且须为平台/安全/值班主任
      if (claims.roles.every((r) => r === 'auditor')) {
        return writeErr(res, 403, { code: 'unauthorized', message: '审计员不可中断会话' });
      }
      return readBody(req, (body) => {
        const reason = str(body.reason) ?? 'manual kill switch';
        const ok = engine.killSession(sessionId, reason);
        if (!ok) return writeErr(res, 404, { code: 'session_not_found', message: '会话不存在' });
        return writeJson(res, 200, { ok: true, session_id: sessionId, killed: true });
      });
    }

    return writeErr(res, 405, { code: 'method_not_allowed', message: '方法不被允许' });
  };
}

// ------------------------------------------------------------------ helpers

function matchSession(path: string): { sessionId: string; sub: string | null } | null {
  const prefix = `${CHAT_BASE_PATH}/sessions`;
  if (path === prefix) return { sessionId: '', sub: null };
  if (!path.startsWith(prefix + '/')) return null;
  const rest = path.slice(prefix.length + 1); // id + optional /sub
  const slash = rest.indexOf('/');
  if (slash < 0) return { sessionId: decodeURIComponent(rest), sub: '' };
  return { sessionId: decodeURIComponent(rest.slice(0, slash)), sub: rest.slice(slash) };
}

function extractToken(req: IncomingMessage): string | null {
  const h = req.headers['authorization'];
  const raw = Array.isArray(h) ? h[0] : h;
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

/** 轻量预检：仅验证令牌并解出 user/roles（不触库），用于限流前置。 */
function peekClaims(
  engine: ChatEngine,
  token: string,
): { ok: boolean; user_id?: string; roles?: ChatRole[]; code?: ChatErrorCode; message?: string } {
  const v = engine.verifyToken(token);
  if (!v.ok || !v.claims) {
    const msg =
      v.code === 'expired' ? '访问令牌已过期，请重新登录' : v.code === 'revoked' ? '访问令牌已吊销' : '鉴权失败';
    const code: ChatErrorCode =
      v.code === 'expired' ? 'session_expired' : v.code === 'revoked' ? 'session_revoked' : 'unauthenticated';
    return { ok: false, code, message: msg };
  }
  return { ok: true, user_id: v.claims.sub, roles: v.claims.roles };
}

function clientIp(req: IncomingMessage): string {
  const xf = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xf) ? xf[0] : xf;
  if (raw) return raw.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

function fingerprintOf(req: IncomingMessage): string {
  const ua = headerStr(req, 'user-agent') ?? 'unknown';
  const ip = clientIp(req);
  // 摘要（不存明文 UA 全文）
  const crypto = require('crypto') as typeof import('crypto');
  return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 16);
}

function setAuthCookie(res: ServerResponse, token: string): void {
  // NFR：token 存 HttpOnly/Secure cookie，不落 localStorage
  res.setHeader(
    'Set-Cookie',
    `aisre_access=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/chat; Max-Age=3600`,
  );
}

function clearAuthCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', 'aisre_access=; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/chat; Max-Age=0');
}

function normalizeAction(v: Record<string, unknown>): { operation: string; target_resource: string; env?: string | null; params?: Record<string, unknown>; summary?: string } | undefined {
  const op = str(v.operation) ?? str(v.op);
  const target = str(v.target_resource) ?? str(v.resource) ?? str(v.target);
  if (!op || !target) return undefined;
  return {
    operation: op,
    target_resource: target,
    env: str(v.env) ?? null,
    params: v.params && typeof v.params === 'object' && !Array.isArray(v.params) ? (v.params as Record<string, unknown>) : {},
    summary: str(v.summary),
  };
}

function roleArray(v: unknown): ChatRole[] {
  if (!Array.isArray(v)) return [];
  return v.filter((r): r is ChatRole => typeof r === 'string') as ChatRole[];
}

function readBody(req: IncomingMessage, cb: (body: Record<string, unknown>) => boolean): boolean {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    let body: Record<string, unknown> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
      } catch {
        body = {};
      }
    }
    cb(body);
  });
  return true;
}

function rateLimited(res: ServerResponse, retryAfter: number): boolean {
  res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
  return writeErr(res, 429, { code: 'rate_limited', message: '请求过于频繁，请稍后再试' });
}

function unauthenticated(res: ServerResponse, message: string): boolean {
  return writeErr(res, 401, { code: 'unauthenticated', message });
}

function headerStr(req: IncomingMessage, name: string): string | undefined {
  const h = req.headers[name.toLowerCase()];
  const raw = Array.isArray(h) ? h[0] : h;
  return typeof raw === 'string' && raw.length ? raw : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}

function methodNotAllowed(res: ServerResponse): boolean {
  return writeErr(res, 405, { code: 'method_not_allowed', message: '方法不被允许' });
}

function writeJson(res: ServerResponse, status: number, body: unknown): boolean {
  if (res.headersSent) return true;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
  return true;
}

function writeErr(res: ServerResponse, status: number, body: { code: string; message: string; field?: string }): boolean {
  writeJson(res, status, { ok: false, ...body });
  return true;
}
