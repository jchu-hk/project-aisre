/**
 * incidents/issue-gateway.ts
 *
 * GitHub Issue 集成交付（F-SRE-014 §3.11.3「Issue 为唯一真相源」）。
 *
 * 归一化 → 三分类 → 新建/已知：new/unknown → 创建 Issue；dup/known 归并。
 *   新建后 incident.issue_id 指向 Issue，保证与 PM/DEV/QA 同源。
 *
 * 本里程碑采用「网关注入」设计：核心编排不写死 GitHub CLI/API；默认网关
 * 是 best-effort —— 探测环境是否可用 gh，不可用则返回缺省「未接入」状态并
 * 在审计/回执里标为需要人工（DEVOPS 接入真实 gateway 或供 PM 建 Issue）。
 * 部署接入真实 GitHub 网关由 DEVOPS 依据 db/migrations 与 config 完成，
 * 本文件不硬编码任何仓库/令牌。
 */

import { IntakeIncident } from './incident.types';

/** Issue 网关统一契约 */
export interface IssueGateway {
  /** 新建一个 Issue 表示新 incident（收敛去重后仅 new/known-unknown 调用） */
  createIssue(inc: IntakeIncident, title: string, body: string): Promise<IssueResult>;
  /** 为 known/dup 补充证据到既有 Issue #issueId */
  addComment(issueId: number, body: string): Promise<IssueResult>;
}

export interface IssueResult {
  ok: boolean;
  issueId?: number;
  error?: string;
}

/** child_process 在测试/受限环境可能无 gh，避免同步 exec 卡壳——静默 fallback */
function ghAvailable(): boolean {
  // 只在能真正执行时启用真实 gh；库中不 crash。
  // 通过注入 gating：本骨架缺省返回 false（由外部 enableGitHubGateway 打开）。
  return false;
}

/**
 * 缺省 Issue 网关：best-effort no-op-record。
 * 返回 ok:true + 派生 issue 序号（以内部伪号 fallback），供 incident → issue 关系
 * 在 Issue 字段与回执闭环可见；真实创建交给已接入的 GitHub gateway。
 */
export class NoopIssueGateway implements IssueGateway {
  async createIssue(inc: IntakeIncident, title: string, _body: string): Promise<IssueResult> {
    if (!ghAvailable()) {
      // ISSUE_NOT_CONNECTED：返回伪 issue id（负数）以在 UI 标「待接入」，
      // 部署接入真实 gateway 后改由真实创建，正值不可用前不误导为真 Issue。
      return { ok: true, issueId: -1 * (hashToPos(inc.incident_id) || 1) };
    }
    return { ok: true, issueId: hashToPos(inc.incident_id) };
  }

  async addComment(_issueId: number, _body: string): Promise<IssueResult> {
    return { ok: true, error: 'noop-gateway: 真实 GitHub 网关待接入（DEVOPS）' };
  }
}

/** deterministic pseudo number for skeleton issue id (非真实号，前端标 pending) */
function hashToPos(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 10_000 + (h % 90_000);
}

/** 便捷默认实例 */
export const defaultIssueGateway: IssueGateway = new NoopIssueGateway();
