/**
 * chat/jwt.ts —— 短期 JWT（HS256）+ refresh token 轮换（F-CHAT / FR-CHAT-001 / DESIGN §5）
 *
 * 自实现 HS256（node:crypto HMAC-SHA256），**不引入重型框架**（对齐服务既有
 * 「内建能力优先」约束：依赖仅 js-yaml）。满足：
 *   - access token 有效期 ≤ 1h（默认 3600s），含 sub / roles / session_id / exp / jti（DESIGN §5）；
 *   - 恒定时间签名比较（防时序侧信道）；
 *   - exp/签发者/必需声明校验；
 *   - jti 吊销表由 ChatStore 维护（登出即作废，FR-CHAT-003）。
 *
 * 纯函数（无 IO）；时间源可注入以支持确定性单测。
 */

import * as crypto from 'crypto';
import { AccessTokenClaims, ChatRole, TokenVerifyResult } from './chat-types';

/** access token 最大有效期（秒）——SPEC FR-CHAT-001：≤ 1h */
export const MAX_ACCESS_TTL_SECONDS = 3600;
/** 默认 access token 有效期（秒） */
export const DEFAULT_ACCESS_TTL_SECONDS = 3600;
/** 默认刷新令牌有效期（秒）——7 天 */
export const DEFAULT_REFRESH_TTL_SECONDS = 7 * 24 * 3600;

const VALID_ROLES: ReadonlyArray<ChatRole> = [
  'oncall_sre',
  'platform_owner',
  'security_owner',
  'auditor',
];

export interface JwtSignOptions {
  secret: string;
  /** 自定义时钟（epoch 秒），默认 由调用方传入 nowSeconds */
  issuer?: string;
}

export interface AccessTokenInput {
  sub: string;
  roles: ChatRole[];
  session_id: string | null;
  /** 有效期（秒）；封顶 3600 */
  ttl_seconds?: number;
}

/** base64url 编码（无 padding） */
export function b64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url 解码（宽松，接受 padding） */
export function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const norm = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(norm, 'base64');
}

/** HS256 签名：HMAC-SHA256(signingInput) */
function signHs256(secret: string, signingInput: string): string {
  return b64urlEncode(crypto.createHmac('sha256', secret).update(signingInput, 'utf8').digest());
}

/**
 * 签发 access token（HS256 JWT compact 序列化）。
 * @param nowSeconds 当前 epoch 秒（注入以便确定性测试）
 */
export function signAccessToken(
  input: AccessTokenInput,
  secret: string,
  nowSeconds: number,
  issuer = 'ai-sre-chat',
): { token: string; claims: AccessTokenClaims; expires_in: number } {
  const ttl = Math.min(
    MAX_ACCESS_TTL_SECONDS,
    Math.max(1, Math.floor(input.ttl_seconds ?? DEFAULT_ACCESS_TTL_SECONDS)),
  );
  const claims: AccessTokenClaims = {
    sub: input.sub,
    roles: input.roles.filter((r) => VALID_ROLES.includes(r)),
    session_id: input.session_id,
    iat: nowSeconds,
    exp: nowSeconds + ttl,
    jti: crypto.randomUUID(),
    iss: issuer,
  };
  const header = { alg: 'HS256', typ: 'JWT' };
  const signingInput = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(claims))}`;
  const signature = signHs256(secret, signingInput);
  return { token: `${signingInput}.${signature}`, claims, expires_in: ttl };
}

/**
 * 校验 access token：
 *   1. 结构（三段）；2. 签名（恒定时间比较）；3. exp 未过期；4. iss/sub/roles 声明合法；
 *   5. jti 是否被吊销（revokedJti 集合由调用方提供）。
 * 任一步失败返回稳定错误码（不抛异常）。
 */
export function verifyAccessToken(
  token: string,
  secret: string,
  nowSeconds: number,
  revokedJti: ReadonlySet<string> = new Set(),
  expectedIssuer?: string,
): TokenVerifyResult {
  if (typeof token !== 'string' || !token) return { ok: false, code: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, code: 'malformed' };
  }
  const [h, p, sig] = parts;
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(b64urlDecode(h).toString('utf8'));
    payload = JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch {
    return { ok: false, code: 'malformed' };
  }
  if (!header || typeof header !== 'object' || (header as { alg?: string }).alg !== 'HS256') {
    return { ok: false, code: 'malformed' };
  }
  const expectedSig = signHs256(secret, `${h}.${p}`);
  const got = Buffer.from(sig);
  const want = Buffer.from(expectedSig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return { ok: false, code: 'bad_signature' };
  }
  const c = payload as Partial<AccessTokenClaims>;
  if (
    !c ||
    typeof c.sub !== 'string' ||
    !c.sub ||
    typeof c.exp !== 'number' ||
    typeof c.iat !== 'number' ||
    typeof c.jti !== 'string' ||
    !c.jti ||
    !Array.isArray(c.roles)
  ) {
    return { ok: false, code: 'bad_claims' };
  }
  if (expectedIssuer && c.iss !== expectedIssuer) return { ok: false, code: 'bad_claims' };
  // 有效期上限自检（防伪造超长 token 被篡改签名后通过；此处双保险）
  if (c.exp - c.iat > MAX_ACCESS_TTL_SECONDS) return { ok: false, code: 'bad_claims' };
  if (nowSeconds >= c.exp) return { ok: false, code: 'expired' };
  if (revokedJti.has(c.jti)) return { ok: false, code: 'revoked' };

  const roles = (c.roles as unknown[]).filter((r): r is ChatRole =>
    typeof r === 'string' && VALID_ROLES.includes(r as ChatRole),
  );
  const claims: AccessTokenClaims = {
    sub: c.sub,
    roles,
    session_id: typeof c.session_id === 'string' ? c.session_id : null,
    iat: c.iat,
    exp: c.exp,
    jti: c.jti,
    iss: typeof c.iss === 'string' ? c.iss : '',
  };
  return { ok: true, claims };
}

/** 生成不透明 refresh token（随机 256-bit，hex） */
export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** refresh token 的存储摘要（不落明文；SHA-256） */
export function digestRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 恒定时间字符串比较（防时序侧信道；长度不等直接 false） */
export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
