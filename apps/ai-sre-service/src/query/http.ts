/**
 * query/http.ts —— incident 查询 API 的 HTTP 接线层（Issue #372 / DESIGN §12.2）
 *
 * 把纯读路径 reader.ts 暴露为不带副作用的 GET 端点：
 *   GET /api/sre/incidents/{incident_id}
 *   GET /api/sre/incidents          （列表：过滤白名单 + 游标分页 + per-system ACL）
 *
 * 约定与守卫：
 *   - 本层为只读；不承载任何 lifecycle 推进 / 关单 / reopen（处置走 Issue/既有角色）。
 *   - 主进程单一 request 监听器串行：intake.handle → query.handle → 基础 base。
 *     本 handler 命中（含 4xx）即返回 true（已写响应）；否则 false 交回 base。
 *   - per-system ACL（AC-016b / §12.2）：授权可读 system_id 集；显式传入非所辖
 *     system_id → 403（越权者视角等同不存在，在此以 403 明确告知而非透传他系统内容）。
 *     system_id 省略 = 扫所辖全部。所辖集为空 → fail-closed 返回空（不报错）。
 *   - 统一错误体 { code, message, field? }（401/403/404/422/429 语义由网关做，此处
 *     至 4xx 判定不依赖外部鉴权；actor 默认 query-console，可经 x-sre-actor 头部注入）。
 *   - 每次查询写 query audit（append 型，谁/何时/按何条件/命中哪些 incident）；写库
 *     在本层走进程内 LifecycleLedger 参照实现（DEVOPS 接 PG 时同谓词落 sre_incident_query_audit）。
 *
 * 返回/时序与 reader 对齐：
 *   GET /api/sre/incidents?system_id=&status=&lifecycle=&source=&severity[]=
 *      &created_from=&created_to=&issue_id=&q=&sort=&order=&cursor=&limit=
 *     → 200 { items:[精简投影…], next_cursor, count }
 *   GET /api/sre/incidents/{id}?scope=full|trace|audit
 *     → 200 detail；scope 外的值 → 422 {field:'scope'}
 *   not found → 404；越权（detail/list 显式给非所辖 system）→ 403。
 */

import { IncomingMessage, ServerResponse } from 'http';
import { IncidentStore } from '../incidents/incident-store';
import { LifecycleLedger } from '../lifecycle/ledger';
import {
  listIncidents,
  getIncidentDetail,
  ReaderOpts,
} from './reader';
import {
  IncidentListQuery,
  CursorPaging,
  QUERY_FILTER_ALLOWLIST,
  QueryErrorBody,
} from './types';

export const QUERY_PATH = '/api/sre/incidents'; // 列表前缀/详情前缀

export interface QueryDeps {
  store: IncidentStore;
  ledger: LifecycleLedger;
  /** 可省略；省略=不限（仅限受信任的本地/网关已鉴权上下文）。 */
  aclSystems?: ReadonlyArray<string>;
  issueBaseUrl?: string | null;
  defaultActor?: string;
}

export type QueryHandle = (req: IncomingMessage, res: ServerResponse) => boolean;

/** 精确“列表”与“详情”两个 GET 路由的 CPU 处理器 */
export function buildQueryHandle(deps: QueryDeps): QueryHandle {
  const readerOpts: ReaderOpts = {
    aclSystems: deps.aclSystems,
    issueBaseUrl: deps.issueBaseUrl ?? null,
  };
  const actor = deps.defaultActor ?? 'query-console';

  return (req, res): boolean => {
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') return false;
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0];
    // audit actor：优先取上游网关注入的账号头（x-sre-actor），否则回落默认（query-console）
    const hdr = req.headers['x-sre-actor'];
    const actorId = (Array.isArray(hdr) ? hdr[0] : hdr)?.trim() || actor;

    // —— 详情 /api/sre/incidents/{id} ——
    const detail = matchDetail(path);
    if (detail) {
      handleDetail(detail, rawUrl, deps, readerOpts, actorId, res);
      return true;
    }
    // —— 列表 ——
    if (path === QUERY_PATH) {
      handleList(rawUrl, deps, readerOpts, actorId, res);
      return true;
    }
    return false; // 非 query 路由：交回 base
  };
}

// ------------------------------------------------------------------ list

function handleList(
  rawUrl: string,
  deps: QueryDeps,
  readerOpts: ReaderOpts,
  actor: string,
  res: ServerResponse,
): void {
  const params = parseQuery(rawUrl);
  // —— 参数合法性 ——
  const systemRequested: string | undefined = params.get('system_id')?.[0];
  const err = validateListParams(params);
  if (err) {
    writeError(res, 422, err);
    return;
  }

  // per-system 越权（系统符实存在但不在所辖集）
  if (systemRequested && deps.aclSystems && !deps.aclSystems.includes(systemRequested)) {
    writeError(res, 403, { code: 'forbidden_system', message: '无权读取该系统 incident', field: 'system_id' });
    return;
  }

  // —— 组装领域查询 ——
  const q: IncidentListQuery = {};
  if (systemRequested) q.system_id = systemRequested;
  const status = params.get('status');
  if (status) q.status = status.length === 1 ? status[0] : status;
  const lifecycle = params.get('lifecycle');
  if (lifecycle) q.lifecycle = lifecycle.length === 1 ? lifecycle[0] : lifecycle;
  const source = params.get('source')?.[0];
  if (source) q.source = source;
  const severity = params.get('severity');
  if (severity && severity.length) q.severity = severity;
  if (params.has('created_from')) q.created_from = params.get('created_from')![0];
  if (params.has('created_to')) q.created_to = params.get('created_to')![0];
  const issue_id = params.get('issue_id')?.[0];
  if (issue_id !== undefined && issue_id !== '') q.issue_id = Number(issue_id);
  const full = params.get('q')?.[0];
  if (full !== undefined) q.q = full;

  const paging: CursorPaging & { sort?: string } = {};
  const limitRaw = params.get('limit')?.[0];
  if (limitRaw !== undefined) paging.limit = Number(limitRaw);
  const cursor = params.get('cursor')?.[0];
  if (cursor) paging.cursor = cursor;
  const sortRaw = params.get('sort')?.[0];
  const order = params.get('order')?.[0]?.toLowerCase();
  paging.sort = composeSort(sortRaw, order); // 缺省 '-created_at'（§12.2 缺省 occurred_at desc）

  // —— 读 ——
  const result = listIncidents(deps.store, deps.ledger, q, paging, readerOpts);

  // —— query audit（append；filters 白名单快照 + matched_ids 落 filters.matched_ids，
  //    供 scope=audit / DEVOPS PG 对账，见 ledger.queryAuditForIncident）——
  audited(
    deps.ledger,
    actor,
    QUERY_PATH,
    systemRequested ?? '',
    q,
    cursor,
    result.items.map((r) => r.id),
  );

  writeJson(res, 200, {
    items: result.items,
    next_cursor: result.next_cursor,
    count: result.count,
  });
}

// -------------------------------------------------------------- detail

function handleDetail(
  id: string,
  rawUrl: string,
  deps: QueryDeps,
  readerOpts: ReaderOpts,
  actor: string,
  res: ServerResponse,
): void {
  if (!id) {
    writeError(res, 404, { code: 'not_found', message: 'incident 不存在' });
    return;
  }
  const params = parseQuery(rawUrl);
  const scopeRaw = params.get('scope')?.[0] ?? 'full';
  if (scopeRaw !== 'full' && scopeRaw !== 'trace' && scopeRaw !== 'audit') {
    writeError(res, 422, { code: 'invalid_scope', message: 'scope 仅支持 full|trace|audit', field: 'scope' });
    return;
  }
  const inc = deps.store.getById(id);
  if (!inc) {
    writeError(res, 404, { code: 'not_found', message: 'incident 不存在', field: 'id' });
    return;
  }
  // per-system 越权读 → 403（不可见语义；即便存在也不回内容）
  if (deps.aclSystems && !deps.aclSystems.includes(inc.system_id)) {
    writeError(res, 403, { code: 'forbidden_system', message: '无权读取该系统 incident' });
    return;
  }
  const detail = getIncidentDetail(deps.store, deps.ledger, id, scopeRaw as 'full' | 'trace' | 'audit', readerOpts);
  if (!detail) {
    writeError(res, 404, { code: 'not_found', message: 'incident 不存在', field: 'id' });
    return;
  }
  // —— query audit：命中恰为该 incident（matched_ids=[id]，供 scope=audit 反向可见谁查过）——
  auditedForDetail(
    deps.ledger,
    actor,
    `${QUERY_PATH}/${encodeURIComponent(id)}`,
    inc.system_id,
    scopeRaw as 'full' | 'trace' | 'audit',
    [id],
  );
  writeJson(res, 200, detail);
}

// ------------------------------------------------------------- helpers

/** 命中 /api/sre/incidents/{id} → 返回 id；否则 null */
function matchDetail(path: string): string | null {
  const prefix = QUERY_PATH + '/';
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (!rest || rest.includes('/')) return null; // 更深层不属于本端（交由 base 404）
  const id = decodeURIComponent(rest);
  return id || null;
}

/** 解析 query string 为 多值 map（重复/逗号都切成数组） */
function parseQuery(rawUrl: string): Map<string, string[]> {
  const idx = rawUrl.indexOf('?');
  if (idx < 0) return new Map();
  const map = new Map<string, string[]>();
  const search = rawUrl.slice(idx + 1);
  for (const part of search.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = decodeURIComponent(part.slice(0, eq < 0 ? undefined : eq));
    const rawV = eq < 0 ? '' : part.slice(eq + 1);
    const v = decodeURIComponent(rawV);
    const entries =
      k === 'severity' || k === 'status' || k === 'lifecycle'
        ? v.split(',').filter(Boolean)
        : [v];
    if (!k) continue;
    const cur = map.get(k) ?? [];
    for (const e of entries) cur.push(e);
    map.set(k, cur);
  }
  return map;
}

/** 列表参数合法性（仅结构化校验；不触发白名单外字段拒绝——那些直接忽略） */
function validateListParams(params: Map<string, string[]>): QueryErrorBody | null {
  const limitRaw = params.get('limit')?.[0];
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1) {
      return { code: 'invalid_limit', message: 'limit 须为 ≥1 整数', field: 'limit' };
    }
  }
  const issueRaw = params.get('issue_id')?.[0];
  if (issueRaw !== undefined && issueRaw !== '') {
    const n = Number(issueRaw);
    if (!Number.isInteger(n) || n < 0) {
      return { code: 'invalid_issue_id', message: 'issue_id 须为正整数', field: 'issue_id' };
    }
  }
  // 语义：sort body/order 解析非法 → reader 容错回落，不硬 422（宽松）。
  return null;
}

/** 组装 reader.sort 字符串（§12.2 默认 occurred_at desc） */
function composeSort(sortRaw: string | undefined, order: string | undefined): string {
  const body = (sortRaw ?? 'created_at').toLowerCase();
  const hasPrefix = body.startsWith('-');
  const clean = body.replace(/^-/, '');
  if (clean !== 'created_at' && clean !== 'lifecycle_updated_at' && clean !== 'severity') {
    // 非法 sort 字段 → 回落到默认（created_at desc），不报错
    return '-created_at';
  }
  const desc = hasPrefix || order === 'desc';
  return (desc ? '-' : '') + clean;
}

/** 写 list 查询审计（filters 仅白名单快照；matched_ids 置于 filters 内供反查；list scope=NULL） */
function audited(
  ledger: LifecycleLedger,
  actor: string,
  endpoint: string,
  systemRequested: string,
  q: IncidentListQuery,
  cursor: string | undefined,
  matchedIds: string[],
): void {
  // 过滤白名单快照（§12.2；仅审计非敏感结构化键——不含 PII）
  const filters: Record<string, unknown> = {};
  const applyIf = (k: keyof IncidentListQuery, v: unknown): void => {
    if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) {
      if ((QUERY_FILTER_ALLOWLIST as readonly string[]).includes(k as string)) filters[k as string] = v;
    }
  };
  applyIf('system_id', q.system_id);
  applyIf('status', q.status);
  applyIf('lifecycle', q.lifecycle);
  applyIf('source', q.source);
  applyIf('severity', q.severity);
  applyIf('created_from', q.created_from);
  applyIf('created_to', q.created_to);
  if (q.issue_id != null) applyIf('issue_id', q.issue_id);
  applyIf('q', q.q);

  // matched_ids 与 filters 同 jsonb（DB sre_incident_query_audit 分列；进程内归入 filters）
  if (matchedIds.length) filters['matched_ids'] = matchedIds;

  ledger.appendQueryAudit({
    system_id_requested: systemRequested,
    endpoint,
    method: 'GET',
    actor_id: actor,
    scope: null,
    filters: Object.keys(filters).length ? filters : null,
    cursor: cursor ?? null,
  });
}

/** 写单条 detail 查询审计（filters 不含匹配集之外的查询条件，仅 record 命中 incident） */
function auditedForDetail(
  ledger: LifecycleLedger,
  actor: string,
  endpoint: string,
  systemId: string,
  scope: 'full' | 'trace' | 'audit',
  matchedIds: string[],
): void {
  const filters: Record<string, unknown> = {};
  filters['matched_ids'] = matchedIds;
  ledger.appendQueryAudit({
    system_id_requested: systemId,
    endpoint,
    method: 'GET',
    actor_id: actor,
    scope,
    filters,
    cursor: null,
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function writeError(res: ServerResponse, status: number, body: QueryErrorBody): void {
  writeJson(res, status, { ok: false, ...body } as unknown as Record<string, unknown>);
}
