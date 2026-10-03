/**
 * chat/chat-types.ts —— F-CHAT 类型定义（Phase 2 / DESIGN §2.4 §5 §6）
 *
 * 对齐 DESIGN-PHASE2-AUDIT-APPROVE-CHAT.md：
 *   §2.4 chat_session / chat_message（服务端权威会话 + 消息与操作绑定 session_id+user）
 *   §5   鉴权：短期 JWT access（≤1h）+ refresh 轮换（one-time-use）+ jti 吊销表
 *   §5   RBAC：角色 = {值班 SRE, 平台负责人, 安全负责人, 审计员}，策略矩阵
 *   §6   防注入：通道分离 / 注入模式检测 / 工具调用必经 F-APPROVE / 检索内容不可信
 *
 * 本文件为纯定义（无 IO），便于单测与跨模块共享。
 */

/** 对话角色（DESIGN §5 RBAC；与 approval 的角色集一致，另加中文别名映射） */
export type ChatRole = 'oncall_sre' | 'platform_owner' | 'security_owner' | 'auditor';

/** 中文角色名（SPEC FR-CHAT-002）；配置/UI 可读 */
export const ROLE_LABELS: Readonly<Record<ChatRole, string>> = {
  oncall_sre: '值班SRE',
  platform_owner: '平台负责人',
  security_owner: '安全负责人',
  auditor: '审计员',
};

/** 会话状态（DESIGN §2.4 state） */
export type SessionState = 'active' | 'expired' | 'revoked';

/** 消息角色（DESIGN §2.4 chat_message.role） */
export type MessageRole = 'user' | 'assistant' | 'system';

/** 会话记录（DESIGN §2.4 chat_session） */
export interface ChatSession {
  session_id: string;
  user_id: string;
  roles: ChatRole[];
  /** OIDC 来源（issuer） */
  issuer: string | null;
  /** OIDC 主体（sub） */
  sub: string | null;
  created_at: string;
  last_active_at: string;
  /** 空闲到期时刻（默认 +30min） */
  idle_expire_at: string;
  state: SessionState;
  /** IP/UA 摘要（限流与异常检测） */
  client_fingerprint: string;
  /** CSRF 令牌（cookie 模式双提交） */
  csrf_token: string;
}

/** 会话消息（DESIGN §2.4 chat_message；内容仅存摘要，禁全量明文落盘） */
export interface ChatMessage {
  msg_id: string;
  session_id: string;
  role: MessageRole;
  /** 内容摘要（脱敏/哈希化；FR-CHAT-006 追溯用） */
  content_digest: string;
  /** 注入检测命中标记（FR-CHAT-004） */
  injected_flag: boolean;
  /** 由此消息触发的动作类型（如 restart），无则 null */
  triggered_action: string | null;
  /** 触发的审批单（工具调用经 F-APPROVE 时回填） */
  approval_id: string | null;
  created_at: string;
}

/** JWT access token 声明（DESIGN §5；无敏感字段，仅身份/会话锚点） */
export interface AccessTokenClaims {
  sub: string;
  roles: ChatRole[];
  session_id: string | null;
  /** 签发时刻（epoch 秒） */
  iat: number;
  /** 到期时刻（epoch 秒；exp - iat ≤ 3600） */
  exp: number;
  /** 唯一令牌 id，用于吊销表（登出即作废） */
  jti: string;
  iss: string;
}

/** 校验后的令牌结果 */
export interface TokenVerifyResult {
  ok: boolean;
  claims?: AccessTokenClaims;
  code?: 'malformed' | 'bad_signature' | 'expired' | 'revoked' | 'bad_claims';
}

/** refresh token 轮换入参 */
export interface RefreshResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** RBAC 权限类别 */
export type ChatPermission =
  | 'chat.query' // 只读查询状态
  | 'action.execute' // 发起操作（经白名单/审批）
  | 'approval.decide' // 审批决定
  | 'approval.review' // 二次复核
  | 'audit.read' // 读审计
  | 'whitelist.change'; // 白名单变更

/** 各角色权限矩阵（DESIGN §5：审计员→只读；SRE→初审；平台/安全→复核；白名单变更→仅平台负责人） */
export const ROLE_PERMISSIONS: Readonly<Record<ChatRole, ReadonlyArray<ChatPermission>>> = {
  // 值班 SRE：只读 + 发起操作（经白名单/审批）+ 初审
  oncall_sre: ['chat.query', 'action.execute', 'approval.decide', 'audit.read'],
  // 平台负责人：只读 + 发起 + 审批 + 复核 + 白名单变更
  platform_owner: [
    'chat.query',
    'action.execute',
    'approval.decide',
    'approval.review',
    'audit.read',
    'whitelist.change',
  ],
  // 安全负责人：只读 + 发起 + 审批 + 复核（白名单变更须平台负责人）
  security_owner: ['chat.query', 'action.execute', 'approval.decide', 'approval.review', 'audit.read'],
  // 审计员：仅只读（含审计读）
  auditor: ['chat.query', 'audit.read'],
};

/** 注入检测结果（FR-CHAT-004） */
export interface InjectionScan {
  /** 是否命中注入模式 */
  suspicious: boolean;
  /** 命中的模式名（枚举式，不泄露检测实现细节） */
  patterns: string[];
  /** 风险分（0-100） */
  score: number;
  /** 是否应拒绝执行（高危样本 → 直接拒绝 + 记可疑事件） */
  blocked: boolean;
}

/** 动作意图（由消息解析出的「待执行动作」；合法性判决权在 Policy Gate/F-APPROVE） */
export interface ActionIntent {
  operation: string;
  target_resource: string;
  env?: string | null;
  params?: Record<string, unknown>;
  summary?: string;
}

/** 动作处理结果（经 F-APPROVE 判定后） */
export interface ActionOutcome {
  /** 是否命中白名单直接放行 */
  allowed: boolean;
  /** 未命中时创建的审批单 */
  approval_id: string | null;
  state: string | null;
  /** 因 RBAC 拒绝（审计员发起危险操作）→ HTTP 403 语义 */
  denied_by_rbac: boolean;
  reason: string;
}

/** 稳定的 chat 错误码 */
export type ChatErrorCode =
  | 'unauthenticated'
  | 'unauthorized'
  | 'session_not_found'
  | 'session_expired'
  | 'session_revoked'
  | 'csrf_failed'
  | 'rate_limited'
  | 'invalid_input'
  | 'injection_blocked'
  | 'token_reuse_detected'
  | 'method_not_allowed';
