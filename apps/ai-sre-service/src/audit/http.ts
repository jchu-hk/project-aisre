/**
 * audit/http.ts —— F-AUDIT 查询 API 的 HTTP 接线层（DESIGN §3 / §7）
 *
 * 把只读审计投影暴露为 GET 端点（append-only；**无 PUT/PATCH/DELETE**）：
 *   GET /api/v1/audit/events?who&from&to&action_type&result&page&size
 *     → 200 { items:[…], page, size, total, total_pages }
 *   GET /api/v1/audit/events/{id}
 *     → 200 单条 / 404
 *   GET /api/v1/audit/verify?from&to
 *     → 200 { ok, checked, head_seq, head_hash, broken_at_seq?, reason? }
 *
 * 约定与守卫（与 query/http.ts 对齐）：
 *   - 本层只读；不承载任何写。任何非 GET 请求命中 audit 路径 → 405（append-only 明示拒绝）。
 *   - 主进程单一 request 监听器串行：intake.handle → audit.handle → query.handle → base。
 *     本 handler 命中（含 4xx/405）即返回 true（已写响应）；否则 false 交回后续链。
 *   - RBAC（DESIGN §7：读=审计员/负责人）：actor 经 x-sre-actor 注入，默认 audit-console；
 *     本层只记录（查询行为本身被审计，SPEC §2.5），细粒度角色校验由上游网关完成。
 *   - 每次查询写一条 audit_meta 事件（action_type=audit.query）。
 *
 * 返回风格对齐：统一错误体 { ok:false, code, message, field? }。
 */

import { IncomingMessage, ServerResponse } from 'http';
import { AuditStore } from './audit-store';
import { AuditWriter } from './audit-writer';
import { AuditQuery, AuditPaging, AuditResult } from './audit-types';

export const AUDIT_PATH = '/api/v1/audit';

const VALID_RESULTS: ReadonlyArray<AuditResult> = ['success', 'failed', 'denied', 'pending'];

export interface AuditHttpDeps {
  store: AuditStore;
  /** 可选：写入查询审计（谁查询了审计）。缺省则不写。 */
  writer?: AuditWriter;
  /** 默认主体（缺省 audit-console） */
  defaultActor?: string;
  /** 默认 why_source 白名单以外**不做**过滤（宽松） */
  now?: () => string;
}

export type AuditHandle = (req: IncomingMessage, res: ServerResponse) => boolean;

export function buildAuditHandle(deps: AuditHttpDeps): AuditHandle {
  const actor = deps.defaultActor ?? 'audit-console';
  const now = deps.now ?? (() => new Date().toISOString());

  return (req, res): boolean => {
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0];
    if (path !== AUDIT_PATH && !path.startsWith(AUDIT_PATH + '/')) return false;

    // —— append-only 明示：非 GET 一律 405 ——
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      writeError(res, 405, {
        code: 'method_not_allowed',
        message: '审计端点为 append-only，仅支持 GET',
      });
      return true;
    }

    const hdr = req.headers['x-sre-actor'];
    const actorId = (Array.isArray(hdr) ? hdr[0] : hdr)?.trim() || actor;

    // —— verify /api/v1/audit/verify ——
    if (path === `${AUDIT_PATH}/verify`) {
      const params = parseQuery(rawUrl);
      const from = params.get('from')?.[0];
      const to = params.get('to')?.[0];
      const result = deps.store.verify(from, to);
      auditQuery(deps, actorId, path, { from, to });
      writeJson(res, 200, result);
      return true;
    }

    // —— 详情 /api/v1/audit/events/{id} ——
    const detail = matchDetail(path);
    if (detail !== null) {
      if (!detail) {
        writeError(res, 404, { code: 'not_found', message: '审计记录不存在' });
        return true;
      }
      const rec = deps.store.getById(detail);
      if (!rec) {
        writeError(res, 404, { code: 'not_found', message: '审计记录不存在', field: 'id' });
        return true;
      }
      auditQuery(deps, actorId, path, { id: detail });
      writeJson(res, 200, rec);
      return true;
    }

    // —— 列表 /api/v1/audit/events ——
    if (path === `${AUDIT_PATH}/events`) {
      const params = parseQuery(rawUrl);
      const q: AuditQuery = {};
      const who = params.get('who')?.[0];
      if (who) q.who = who;
      const from = params.get('from')?.[0];
      if (from) q.from = from;
      const to = params.get('to')?.[0];
      if (to) q.to = to;
      const actionType = params.get('action_type')?.[0];
      if (actionType) q.action_type = actionType;
      const resultRaw = params.get('result')?.[0];
      if (resultRaw) {
        if (!VALID_RESULTS.includes(resultRaw as AuditResult)) {
          writeError(res, 422, {
            code: 'invalid_result',
            message: `result 仅支持 ${VALID_RESULTS.join('|')}`,
            field: 'result',
          });
          return true;
        }
        q.result = resultRaw as AuditResult;
      }
      const incident = params.get('incident_id')?.[0];
      if (incident) q.incident_id = incident;
      const session = params.get('session_id')?.[0];
      if (session) q.session_id = session;
      const approval = params.get('approval_id')?.[0];
      if (approval) q.approval_id = approval;

      const paging: AuditPaging = {};
      const pageRaw = params.get('page')?.[0];
      if (pageRaw !== undefined) {
        const n = Number(pageRaw);
        if (!Number.isInteger(n) || n < 1) {
          writeError(res, 422, { code: 'invalid_page', message: 'page 须为 ≥1 整数', field: 'page' });
          return true;
        }
        paging.page = n;
      }
      const sizeRaw = params.get('size')?.[0];
      if (sizeRaw !== undefined) {
        const n = Number(sizeRaw);
        if (!Number.isInteger(n) || n < 1) {
          writeError(res, 422, { code: 'invalid_size', message: 'size 须为 ≥1 整数', field: 'size' });
          return true;
        }
        paging.size = n;
      }

      const page = deps.store.query(q, paging);
      auditQuery(deps, actorId, path, { ...q, page: page.page, size: page.size });
      writeJson(res, 200, page);
      return true;
    }

    // /api/v1/audit 根 或 更深层 → 404（本层接管 AUDIT_PATH 命名空间）
    writeError(res, 404, { code: 'not_found', message: '未知审计端点' });
    return true;
  };
}

// ------------------------------------------------------------------ helpers

/** 命中 /api/v1/audit/events/{id} → 返回 id；'' 表示空 id；null 表示非本端点 */
function matchDetail(path: string): string | null {
  const prefix = `${AUDIT_PATH}/events/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest.includes('/')) return null;
  return rest ? decodeURIComponent(rest) : '';
}

/** 记录「谁查询了审计」（SPEC §2.5 / DESIGN §3：查询行为本身写 audit_meta 事件） */
function auditQuery(
  deps: AuditHttpDeps,
  actor: string,
  endpoint: string,
  params: Record<string, unknown>,
): void {
  if (!deps.writer) return;
  const now = deps.now ?? (() => new Date().toISOString());
  deps.writer.emit({
    who_type: 'user',
    who_id: actor,
    when: now(),
    action_type: 'audit.query',
    target_resource: endpoint,
    params_digest: digestOf(params),
    why_source: 'query',
    incident_id: null,
    session_id: null,
    approval_id: null,
    result: 'success',
    reason: null,
  });
}

/** 脱敏入参摘要：仅结构化键的键名 + 长度，禁全量明文（DESIGN §2.1） */
function digestOf(params: Record<string, unknown>): string | null {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== null);
  if (!keys.length) return null;
  return `keys=${keys.sort().join(',')}`;
}

/** 解析 query string 为多值 map */
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
