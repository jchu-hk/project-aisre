/**
 * test/helpers.ts —— #372 query/HTTP 单测辅助
 *
 * 提供：
 *   - mkIncident(...)：快速构造一条 IntakeIncident（写入 IncidentStore）
 *   - seedDeltaStore(...)：按 system 构造两张含 duration 差异的 incident 表（sys-web / sys-db），
 *     便于「同一 system/lifecycle/severity/source/time/issue」各维度过滤验证。
 *   - aclFor(store)：返回 store 中出现的全部 system_id（作「所辖全系统」）。
 *   - 内嵌 startHttpServer(...)：把既有 main 单监听器（intake→query→base）逻辑拉平成一个
 *     可在单测里起真实 node http server 的 helper（不引 main.ts，避免副作用/配置依赖）。
 */

import * as http from 'http';
import { AddressInfo } from 'net';
import { IncidentStore } from '../src/incidents/incident-store';
import { IntakeIncident } from '../src/incidents/incident.types';
import { LifecycleLedger } from '../src/lifecycle/ledger';
import { buildQueryHandle } from '../src/query/http';

let seq = 0;
/** 生成稳定递增 uuid 形 id（避免依赖 crypto 顺序）不可变前缀便于确定性 */
function uuid(i: number): string {
  const hex = i.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface MkOptions {
  system_id?: string;
  source?: 'detected' | 'intake';
  severity?: string;
  status?: string;
  triage?: string;
  ack_status?: string;
  symptom?: string;
  affected_component?: string;
  issue_id?: number | null;
  received_at?: string;
  detected_at?: string;
  resolved_at?: string | null;
  anomaly_type?: string;
}

/** 构造并 upsert 一条 IntakeIncident 到 store；返回该 incident */
export function mkIncident(store: IncidentStore, opts: MkOptions = {}): IntakeIncident {
  const id = opts.received_at // 用传入时间保证确定性指纹不冲突由调用方给 system/symptom
    ? uuid(++seq)
    : uuid(++seq);
  const sys = opts.system_id ?? 'sys-web';
  const src = opts.source ?? 'intake';
  const sev = opts.severity ?? 'P2';
  const inc: IntakeIncident = {
    incident_id: id,
    system_id: sys,
    source: src,
    anomaly_type: opts.anomaly_type ?? (src === 'detected' ? 'latency' : 'functional'),
    severity: sev as IntakeIncident['severity'],
    reported_severity: opts.severity ?? '中',
    status: opts.status ?? (src === 'detected' ? 'locating' : 'locating'),
    symptom_desc: opts.symptom ?? `现象 ${id.slice(0, 6)} (${sys})`,
    affected_component: opts.affected_component ?? (src === 'detected' ? 'gateway' : 'frontend'),
    reporter_contact_ref: src === 'intake' ? 'ops***1234' : null,
    source_channel: src === 'intake' ? 'webform' : 'detector',
    raw_payload: null,
    dedup_fingerprint: `fp:${sys}:${opts.symptom ?? 'default'}`,
    triage: (opts.triage as IntakeIncident['triage']) ?? (src === 'intake' ? 'new' : 'dup'),
    duplicate_of_id: null,
    issue_id: opts.issue_id ?? null,
    ack_status: ((opts.ack_status as IntakeIncident['ack_status']) || 'received'),
    received_at: opts.received_at ?? '2026-09-04T12:00:00.000Z',
    detected_at: opts.detected_at,
    resolved_at: opts.resolved_at ?? null,
    ack_attempts: 0,
    ack_last_result: null,
  };
  store.upsert(inc);
  return inc;
}

/** 预置一组有差异 incident（跨 system/severity/lifecycle/source/issue/time）供过滤与 ACL 测试 */
export function seedDeltaStore(): IncidentStore {
  const store = new IncidentStore();
  // — sys-web（intake 主系统）—
  mkIncident(store, { system_id: 'sys-web', source: 'intake', severity: 'P1', triage: 'new', ack_status: 'closed', issue_id: 1001, received_at: '2026-09-04T08:00:00Z' });
  mkIncident(store, { system_id: 'sys-web', source: 'intake', severity: 'P0', triage: 'new', ack_status: 'processing', symptom: '致命 OOM', received_at: '2026-09-04T09:00:00Z' });
  mkIncident(store, { system_id: 'sys-web', source: 'detected', severity: 'P2', status: 'resolved', symptom: 'det gate timeout', received_at: '2026-09-04T10:00:00Z' });
  mkIncident(store, { system_id: 'sys-web', source: 'intake', severity: 'P3', triage: 'dup', ack_status: 'received', symptom: '再次同类白屏', received_at: '2026-09-04T11:00:00Z' });
  // — sys-db（第二系统，用于跨租户 ACL 负侧）—
  mkIncident(store, { system_id: 'sys-db', source: 'detected', severity: 'P0', status: 'healing', symptom: '连接池耗尽', received_at: '2026-09-04T12:00:00Z' });
  mkIncident(store, { system_id: 'sys-db', source: 'intake', severity: 'P2', triage: 'known', issue_id: 2002, symptom: '慢查询', received_at: '2026-09-04T13:00:00Z' });
  return store;
}

export function aclFor(store: IncidentStore): string[] {
  return Array.from(new Set(store.all().map((i) => i.system_id)));
}

// ------------------------------------------------------------------ http 起服
/**
 * 起一个真实 http server，仿 main.ts 链：query.handle → base(/health,/)。
 * intake 不注册（query 读路径可独立验证）；@returns 服务 baseUrl（含端口）。
 */
export function startSreServer(opts: { store: IncidentStore; ledger?: LifecycleLedger; acl?: string[] }): Promise<string> {
  const ledger = opts.ledger ?? new LifecycleLedger();
  const store = opts.store;
  const acl = opts.acl ?? aclFor(store);
  const query = buildQueryHandle({
    store,
    ledger,
    aclSystems: acl,
    issueBaseUrl: null,
    defaultActor: 'query-console',
  });
  // intake 未启用（只验证 query + base）
  const server = http.createServer();
  server.on('request', (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (query(req, res)) return;
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ai-sre-service (test)\n');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      // 存 server 引用，便于按 url 关停
      (globalThis as unknown as Record<string, unknown>).__sreTestServers =
        (globalThis as unknown as Record<string, unknown>).__sreTestServers ?? new Map<string, http.Server>();
      ((globalThis as unknown as Record<string, unknown>).__sreTestServers as Map<string, http.Server>).set(String(port), server);
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

export async function closeSreServer(): Promise<void> {
  const g = globalThis as unknown as { __sreTestServers: Map<string, http.Server> };
  const m = g.__sreTestServers ?? new Map<string, http.Server>();
  for (const [, server] of [...m]) {
    await new Promise<void>((res) => server.close(() => res()));
  }
  m.clear();
}
