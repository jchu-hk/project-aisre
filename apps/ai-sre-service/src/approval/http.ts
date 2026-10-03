/**
 * approval/http.ts —— F-APPROVE HTTP 接线层（DESIGN §7）
 *
 * 端点（对齐 DESIGN §7 Approval）：
 *   POST /api/v1/approvals                    创建审批单（未命中白名单时由 agent 调用）
 *   GET  /api/v1/approvals/{id}               单据详情 + 事件流
 *   GET  /api/v1/approvals?state&type&page&size  列表（审批人收件箱）
 *   POST /api/v1/approvals/{id}/decision      body {decision:approve|reject|request_info, reason}
 *   POST /api/v1/approvals/{id}/execute       执行并回写结果（批准后）
 *   POST /api/v1/approvals/judge              操作前判定（命中放行 / 未命中自动建单）
 *   GET  /api/v1/whitelist/versions           版本列表（只读）
 *   GET  /api/v1/whitelist/versions/{v}       指定版本完整条目（AC-APPROVE-001，只读）
 *   GET  /api/v1/whitelist/current            当前生效版本
 *
 * RBAC：actor 经 x-sre-actor 注入，actor_role 经 x-sre-role 注入（缺省 oncall_sre）；
 * 细粒度鉴权由上游 Chat Gateway 完成，本层只做步骤/角色规则校验（DESIGN §5/§7）。
 * 统一错误体 { ok:false, code, message, field? }（与 audit/query 层对齐）。
 */

import { IncomingMessage, ServerResponse } from 'http';
import { ApprovalEngine } from './approval-engine';
import {
  ApprovalErrorCode,
  ApprovalRole,
  ApprovalState,
  ApprovalType,
  Decision,
} from './approval-types';

export const APPROVAL_PATH = '/api/v1/approvals';
export const WHITELIST_PATH = '/api/v1/whitelist';

const VALID_ROLES: ReadonlyArray<ApprovalRole> = [
  'oncall_sre',
  'platform_owner',
  'security_owner',
  'auditor',
];
const VALID_STATES: ReadonlyArray<ApprovalState> = [
  'DRAFT',
  'SUBMITTED',
  'PENDING_2ND',
  'APPROVED',
  'EXECUTE',
  'DONE',
  'FAILED',
  'REJECTED',
  'EXPIRED',
];
const VALID_TYPES: ReadonlyArray<ApprovalType> = ['operation', 'whitelist_change'];
const VALID_DECISIONS: ReadonlyArray<Decision> = ['approve', 'reject', 'request_info'];

export interface ApprovalHttpDeps {
  engine: ApprovalEngine;
  defaultActor?: string;
  defaultRole?: ApprovalRole;
}

export type ApprovalHandle = (req: IncomingMessage, res: ServerResponse) => boolean;

export function buildApprovalHandle(deps: ApprovalHttpDeps): ApprovalHandle {
  const { engine } = deps;
  const defActor = deps.defaultActor ?? 'approval-console';
  const defRole: ApprovalRole = deps.defaultRole ?? 'oncall_sre';

  return (req, res): boolean => {
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0];
    const method = (req.method ?? 'GET').toUpperCase();

    const hdrActor = req.headers['x-sre-actor'];
    const actor = (Array.isArray(hdrActor) ? hdrActor[0] : hdrActor)?.trim() || defActor;
    const hdrRole = req.headers['x-sre-role'];
    const roleRaw = (Array.isArray(hdrRole) ? hdrRole[0] : hdrRole)?.trim() || defRole;

    // ---------- 白名单（只读） ----------
    if (path === WHITELIST_PATH || path.startsWith(WHITELIST_PATH + '/')) {
      return handleWhitelist(path, method, engine, res);
    }

    // ---------- 审批 ----------
    if (path !== APPROVAL_PATH && !path.startsWith(APPROVAL_PATH + '/')) return false;

    // 判定（POST）
    if (path === `${APPROVAL_PATH}/judge`) {
      if (method !== 'POST') return methodNotAllowed(res);
      return readBody(req, (body) => {
        const op = str(body.operation);
        const resource = str(body.target_resource);
        if (!op || !resource) {
          writeError(res, 422, { code: 'invalid_input', message: '需 operation 与 target_resource', field: !op ? 'operation' : 'target_resource' });
          return true;
        }
        const r = engine.judgeOperation({
          operation: op,
          target_resource: resource,
          env: str(body.env) || null,
          initiator_agent: str(body.initiator_agent) || actor,
          summary: str(body.summary) || undefined,
          risk_note: str(body.risk_note) || undefined,
          incident_id: str(body.incident_id) || null,
          session_id: str(body.session_id) || null,
          params: isObj(body.params) ? body.params : {},
          high_risk: body.high_risk === true,
        });
        writeJson(res, 200, {
          ok: true,
          allowed: r.allowed,
          decision: r.decision,
          approval_id: r.approval ? r.approval.approval_id : null,
          state: r.approval ? r.approval.state : null,
        });
        return true;
      });
    }

    // 创建审批单（POST /approvals）
    if (path === APPROVAL_PATH) {
      if (method === 'GET') return handleList(rawUrl, engine, res);
      if (method !== 'POST') return methodNotAllowed(res);
      return readBody(req, (body) => {
        const summary = str(body.summary);
        const resource = str(body.target_resource);
        const type: ApprovalType = VALID_TYPES.includes(body.type as ApprovalType)
          ? (body.type as ApprovalType)
          : 'operation';
        if (!summary || !resource) {
          writeError(res, 422, { code: 'invalid_input', message: '需 summary 与 target_resource' });
          return true;
        }
        if (type === 'whitelist_change' && !Array.isArray(body.entries)) {
          writeError(res, 422, { code: 'invalid_input', message: 'whitelist_change 需 entries[]', field: 'entries' });
          return true;
        }
        const req0 = engine.createApproval({
          type,
          summary,
          target_resource: resource,
          risk_note: str(body.risk_note) || 'unspecified',
          initiator_agent: str(body.initiator_agent) || actor,
          incident_id: str(body.incident_id) || null,
          session_id: str(body.session_id) || null,
          high_risk: body.high_risk === true || type === 'whitelist_change',
          payload:
            type === 'whitelist_change'
              ? { entries: Array.isArray(body.entries) ? body.entries : [], reason: str(body.reason) || str(body.risk_note) || 'whitelist change' }
              : {
                  action_type: str(body.action_type) || 'operation',
                  target_resource: resource,
                  params: isObj(body.params) ? body.params : {},
                  env: str(body.env) || 'unknown',
                  high_risk: body.high_risk === true,
                },
        });
        writeJson(res, 201, { ok: true, approval: req0 });
        return true;
      });
    }

    // /approvals/{id}
    const id = matchId(path, APPROVAL_PATH);
    if (id !== null) {
      if (!id) return (writeError(res, 404, { code: 'not_found', message: '未知审批端点' }), true);
      if (method !== 'GET') return methodNotAllowed(res);
      const detail = engine.getDetail(id);
      if (!detail) return (writeError(res, 404, { code: 'not_found', message: '审批单不存在', field: 'id' }), true);
      writeJson(res, 200, detail);
      return true;
    }

    // /approvals/{id}/decision
    const dec = matchAction(path, APPROVAL_PATH, 'decision');
    if (dec !== null) {
      if (method !== 'POST') return methodNotAllowed(res);
      return readBody(req, (body) => {
        const decision = str(body.decision) as Decision;
        if (!VALID_DECISIONS.includes(decision)) {
          writeError(res, 422, { code: 'invalid_input', message: 'decision ∈ approve|reject|request_info', field: 'decision' });
          return true;
        }
        const r = engine.decide(dec, {
          decision,
          reason: str(body.reason) ?? '',
          actor: str(body.actor) || actor,
          actor_role: (VALID_ROLES.includes(roleRaw as ApprovalRole) ? (roleRaw as ApprovalRole) : defRole),
        });
        if (!r.ok) {
          const err = r as Extract<typeof r, { ok: false }>;
          writeDecisionError(res, err.code, err.message, err.field);
          return true;
        }
        writeJson(res, 200, { ok: true, state: r.next_state, approval: r.request });
        return true;
      });
    }

    // /approvals/{id}/execute
    const exec = matchAction(path, APPROVAL_PATH, 'execute');
    if (exec !== null) {
      if (method !== 'POST') return methodNotAllowed(res);
      return readBody(req, (body) => {
        const r = engine.recordExecution(exec, {
          ok: body.ok !== false,
          actor: str(body.actor) || actor,
          reason: body.reason == null ? null : String(body.reason),
        });
        if (!r.ok) {
          const err = r as Extract<typeof r, { ok: false }>;
          writeDecisionError(res, err.code, err.message, err.field);
          return true;
        }
        writeJson(res, 200, { ok: true, state: r.next_state, approval: r.request });
        return true;
      });
    }

    writeError(res, 404, { code: 'not_found', message: '未知审批端点' });
    return true;
  };
}

// ------------------------------------------------------------------ handlers

function handleWhitelist(
  path: string,
  method: string,
  engine: ApprovalEngine,
  res: ServerResponse,
): boolean {
  if (method !== 'GET') return methodNotAllowed(res);
  const wl = engine.whitelistEngine();
  if (path === `${WHITELIST_PATH}/current`) {
    const v = wl.currentVersionNumber();
    if (v === null) return (writeJson(res, 200, { ok: true, version: null, entries: [] }), true);
    writeJson(res, 200, { ok: true, ...engine.getWhitelistVersion(v) });
    return true;
  }
  if (path === `${WHITELIST_PATH}/versions`) {
    writeJson(res, 200, { ok: true, versions: engine.listWhitelistVersions() });
    return true;
  }
  const v = matchVersion(path);
  if (v !== null) {
    if (v === 0) return (writeError(res, 422, { code: 'invalid_input', message: '版本号须为正整数', field: 'version' }), true);
    const version = engine.getWhitelistVersion(v);
    if (!version) return (writeError(res, 404, { code: 'not_found', message: '白名单版本不存在', field: 'version' }), true);
    writeJson(res, 200, { ok: true, ...version });
    return true;
  }
  writeError(res, 404, { code: 'not_found', message: '未知白名单端点' });
  return true;
}

function handleList(rawUrl: string, engine: ApprovalEngine, res: ServerResponse): boolean {
  const params = parseQuery(rawUrl);
  const state = params.get('state')?.[0];
  if (state && !VALID_STATES.includes(state as ApprovalState)) {
    return (writeError(res, 422, { code: 'invalid_input', message: `state ∈ ${VALID_STATES.join('|')}`, field: 'state' }), true);
  }
  const type = params.get('type')?.[0];
  if (type && !VALID_TYPES.includes(type as ApprovalType)) {
    return (writeError(res, 422, { code: 'invalid_input', message: `type ∈ ${VALID_TYPES.join('|')}`, field: 'type' }), true);
  }
  const page = numOrUndef(params.get('page')?.[0]);
  if (page === -1) return (writeError(res, 422, { code: 'invalid_input', message: 'page 须为 ≥1 整数', field: 'page' }), true);
  const size = numOrUndef(params.get('size')?.[0]);
  if (size === -1) return (writeError(res, 422, { code: 'invalid_input', message: 'size 须为 ≥1 整数', field: 'size' }), true);
  const r = engine.list(
    { state: state as ApprovalState, type: type as ApprovalType },
    { page: page || undefined, size: size || undefined },
  );
  writeJson(res, 200, r);
  return true;
}

// ------------------------------------------------------------------ helpers

function matchId(path: string, base: string): string | null {
  const prefix = `${base}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest.includes('/')) return null;
  return rest ? decodeURIComponent(rest) : '';
}

/** /base/{id}/action → 返回 id；非本 action 返回 null */
function matchAction(path: string, base: string, action: string): string | null {
  const prefix = `${base}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const parts = rest.split('/');
  if (parts.length !== 2 || parts[1] !== action) return null;
  return parts[0] ? decodeURIComponent(parts[0]) : '';
}

/** /whitelist/versions/{v} → 返回 v；'' → 0；非本端点 → null */
function matchVersion(path: string): number | null {
  const prefix = `${WHITELIST_PATH}/versions/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest.includes('/')) return null;
  if (!rest) return 0;
  const n = Number(rest);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function writeDecisionError(
  res: ServerResponse,
  code: ApprovalErrorCode,
  message: string,
  field?: string,
): boolean {
  const status =
    code === 'not_found' ? 404 : code === 'invalid_state' || code === 'expired' ? 409 : 422;
  writeError(res, status, { code, message, field });
  return true;
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

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function numOrUndef(v: string | undefined): number | undefined | -1 {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return -1;
  return n;
}

function parseQuery(rawUrl: string): Map<string, string[]> {
  const idx = rawUrl.indexOf('?');
  if (idx < 0) return new Map();
  const map = new Map<string, string[]>();
  for (const part of rawUrl.slice(idx + 1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = decodeURIComponent(part.slice(0, eq < 0 ? undefined : eq));
    if (!k) continue;
    const v = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1));
    const cur = map.get(k) ?? [];
    cur.push(v);
    map.set(k, cur);
  }
  return map;
}

function methodNotAllowed(res: ServerResponse): boolean {
  writeError(res, 405, { code: 'method_not_allowed', message: '方法不被允许' });
  return true;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function writeError(
  res: ServerResponse,
  status: number,
  body: { code: string; message: string; field?: string },
): void {
  writeJson(res, status, { ok: false, ...body });
}
