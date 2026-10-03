/**
 * chat/rbac.ts —— 基于角色的访问控制（F-CHAT / FR-CHAT-002 / DESIGN §5）
 *
 * 角色 = {值班 SRE, 平台负责人, 安全负责人, 审计员}；策略矩阵映射
 * 「可见资源 + 可执行动作 + 可审批动作」（chat-types.ROLE_PERMISSIONS）。
 *
 * 双点校验之一：Chat Gateway（动作入口）。query 层另有数据过滤校验（DESIGN §5）。
 * 关键规则（AC-CHAT-002）：审计员发起危险操作 → 拒绝（403）；平台负责人可发起对应审批。
 */

import { ChatRole, ChatPermission, ROLE_PERMISSIONS } from './chat-types';

/** 判定某角色集合是否具备某权限（任一角色具备即通过）。 */
export function hasPermission(roles: ReadonlyArray<ChatRole>, perm: ChatPermission): boolean {
  return roles.some((r) => (ROLE_PERMISSIONS[r] ?? []).includes(perm));
}

/**
 * 动作 → 所需权限映射。
 *   只读动作（query/status/audit）→ chat.query / audit.read；
 *   操作类（restart/scale/…）→ action.execute；
 *   审批类 → approval.decide / approval.review；
 *   白名单变更 → whitelist.change（仅平台负责人）。
 */
export function permissionForAction(action: string): ChatPermission {
  const a = (action ?? '').toLowerCase();
  if (a.startsWith('audit.')) return 'audit.read';
  if (a.startsWith('approval.review') || a === 'review') return 'approval.review';
  if (a.startsWith('approval.')) return 'approval.decide';
  if (a.startsWith('whitelist.')) return 'whitelist.change';
  if (a === 'query' || a === 'status' || a === 'read') return 'chat.query';
  return 'action.execute';
}

/** 判断某动作是否属于「危险操作」（审计员不可执行；用于 AC-CHAT-002）。 */
export function isDangerousAction(operation: string): boolean {
  const op = (operation ?? '').toLowerCase();
  return [
    'restart',
    'scale',
    'delete',
    'drop',
    'truncate',
    'exec',
    'exec_cmd',
    'network',
    'firewall',
    'policy',
    'revert',
    'migrate',
    'deploy',
  ].some((k) => op.includes(k));
}

export interface RbacDecision {
  allowed: boolean;
  required: ChatPermission;
  reason: string;
}

/**
 * 授权判定（动作入口）。
 * @param roles 当前会话角色集
 * @param action 动作名（如 restart / audit.read / whitelist.change）
 */
export function authorize(roles: ReadonlyArray<ChatRole>, action: string): RbacDecision {
  const required = permissionForAction(action);
  if (!hasPermission(roles, required)) {
    return {
      allowed: false,
      required,
      reason: `角色 [${roles.join(',')}] 不具备权限 ${required}（动作 ${action}）`,
    };
  }
  return { allowed: true, required, reason: 'ok' };
}
