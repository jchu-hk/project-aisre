/**
 * test/audit.spec.ts —— T3.1 F-AUDIT 审计模块单测（Phase 2）
 *
 * 运行：cd apps/ai-sre-service && npx ts-node test/audit.spec.ts
 *
 * 覆盖（SPEC-PHASE2 §2 / DESIGN §2.1 / §3）：
 *  A. append-only：仅 append() 写路径；DB 触发器拒绝 UPDATE/DELETE；无改删 HTTP 端点（405）。
 *  B. 哈希链：seq 全局单调、prev_hash 链接、hash 可重算一致；genesis 前导固定。
 *  C. 查询过滤：who/时间范围/action_type/result/incident_id + 分页（page/size/total）。
 *  D. 篡改检测：直接改底层记录 → verify() 报告断链位置（AC-AUDIT-002）。
 *  E. HTTP 接线：GET events / events/{id} / verify 真实冒烟；非 GET → 405；非法参数 422。
 *  F. writer：有界异步队列 emit 非阻塞、flush 落盘；查询审计埋点写入 audit.query。
 */

import * as assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { DatabaseSync } from 'node:sqlite';
import { buildAudit, AuditRuntime, toEvent } from '../src/audit';
import { AuditEvent } from '../src/audit/audit-types';
import { computeHash, GENESIS_PREV_HASH } from '../src/audit/hash-chain';

let pass = 0;
function t(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(() => {
    pass++;
    console.log(`  ✓ ${name}`);
  });
}

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'audit.db');
}

function mkEvent(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    who_type: 'agent',
    who_id: 'ai-sre',
    when: '2026-09-20T10:00:00.000Z',
    action_type: 'restart',
    target_resource: 'sys-web/gateway',
    params_digest: 'k=v',
    why_source: 'alert',
    incident_id: null,
    session_id: null,
    approval_id: null,
    result: 'success',
    reason: null,
    ...over,
  };
}

/** 起一个只挂 audit handler 的 http server，返回 baseUrl + 关停函数 */
function startAuditServer(rt: AuditRuntime): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer();
  server.on('request', (req, res) => {
    if (rt.handle(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let body: any;
        try {
          body = JSON.parse(data);
        } catch {
          body = data;
        }
        resolve({ status: res.statusCode!, body });
      });
    }).on('error', reject);
  });
}

async function main() {
  // =============================================================== A. append-only
  console.log('== A. append-only（无改删接口 + WORM 触发器）==');
  const dbA = tmpDb();
  const storeA = buildAudit({ dbPath: dbA, auditQueries: false }).store;
  await t('append() 仅追加；无 update/delete 方法暴露', () => {
    storeA.append(mkEvent());
    assert.strictEqual(typeof (storeA as any).update, 'undefined');
    assert.strictEqual(typeof (storeA as any).delete, 'undefined');
    assert.strictEqual(storeA.count(), 1);
  });
  await t('DB 触发器拒绝 UPDATE（WORM）', () => {
    const raw = new DatabaseSync(dbA);
    assert.throws(() => raw.exec(`UPDATE audit_log SET result='failed' WHERE seq=1`), /append-only|denied/i);
    raw.close();
  });
  await t('DB 触发器拒绝 DELETE（WORM）', () => {
    const raw = new DatabaseSync(dbA);
    assert.throws(() => raw.exec(`DELETE FROM audit_log WHERE seq=1`), /append-only|denied/i);
    raw.close();
  });
  storeA.close();

  // =============================================================== B. 哈希链
  console.log('== B. 哈希链（seq 单调 / prev_hash / 可复算 / genesis）==');
  const storeB = buildAudit({ dbPath: tmpDb(), auditQueries: false }).store;
  await t('首条 seq=1 且 prev_hash=GENESIS', () => {
    const r = storeB.append(mkEvent({ action_type: 'a1' }));
    assert.strictEqual(r.seq, 1);
    assert.strictEqual(r.prev_hash, GENESIS_PREV_HASH);
  });
  await t('后续条 seq 递增且 prev_hash 链接前条 hash', () => {
    const r2 = storeB.append(mkEvent({ action_type: 'a2' }));
    assert.strictEqual(r2.seq, 2);
    const r1 = storeB.getById(storeB.all()[0].id)!;
    assert.strictEqual(r2.prev_hash, r1.hash);
  });
  await t('hash 可由 (seq, prev_hash, payload) 复算一致', () => {
    const r = storeB.all()[1];
    assert.strictEqual(computeHash(r.seq, r.prev_hash, r), r.hash);
  });
  await t('verify() 完整链 → ok=true', () => {
    const v = storeB.verify();
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.broken_at_seq, null);
    assert.strictEqual(v.checked, 2);
    assert.strictEqual(v.head_seq, 2);
  });
  await t('重开 store 后链尾回填连续（进程重启不断链）', () => {
    const p = tmpDb();
    const s1 = buildAudit({ dbPath: p, auditQueries: false }).store;
    s1.append(mkEvent({ action_type: 'x1' }));
    s1.append(mkEvent({ action_type: 'x2' }));
    s1.close();
    const s2 = buildAudit({ dbPath: p, auditQueries: false }).store;
    const r3 = s2.append(mkEvent({ action_type: 'x3' }));
    assert.strictEqual(r3.seq, 3);
    assert.strictEqual(s2.verify().ok, true);
    s2.close();
  });
  storeB.close();

  // =============================================================== C. 查询过滤
  console.log('== C. 查询过滤 + 分页 ==');
  const storeC = buildAudit({ dbPath: tmpDb(), auditQueries: false }).store;
  storeC.append(mkEvent({ who_id: 'alice', when: '2026-09-20T01:00:00.000Z', action_type: 'restart', result: 'success', incident_id: 'inc-1' }));
  storeC.append(mkEvent({ who_id: 'bob', when: '2026-09-20T02:00:00.000Z', action_type: 'scale', result: 'denied', reason: '越权', incident_id: 'inc-2' }));
  storeC.append(mkEvent({ who_id: 'alice', when: '2026-09-20T03:00:00.000Z', action_type: 'restart', result: 'failed', reason: 'timeout' }));
  await t('按 who 过滤', () => assert.strictEqual(storeC.query({ who: 'alice' }).total, 2));
  await t('按 action_type 过滤', () => assert.strictEqual(storeC.query({ action_type: 'restart' }).total, 2));
  await t('按 result 过滤', () => assert.strictEqual(storeC.query({ result: 'denied' }).total, 1));
  await t('按时间范围过滤（含边界）', () => {
    const r = storeC.query({ from: '2026-09-20T01:00:00.000Z', to: '2026-09-20T02:00:00.000Z' });
    assert.strictEqual(r.total, 2);
  });
  await t('按 incident_id 过滤', () => assert.strictEqual(storeC.query({ incident_id: 'inc-2' }).total, 1));
  await t('分页 page/size/total_pages', () => {
    const r = storeC.query({}, { page: 2, size: 2 });
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.total_pages, 2);
    assert.strictEqual(r.items[0].seq, 3); // 升序：第 2 页最后一条
  });
  storeC.close();

  // =============================================================== D. 篡改检测
  console.log('== D. 篡改检测（AC-AUDIT-002）==');
  const dbD = tmpDb();
  const storeD = buildAudit({ dbPath: dbD, auditQueries: false }).store;
  storeD.append(mkEvent({ action_type: 'op1' }));
  storeD.append(mkEvent({ action_type: 'op2' }));
  storeD.append(mkEvent({ action_type: 'op3' }));
  await t('未篡改 → verify ok', () => assert.strictEqual(storeD.verify().ok, true));
  await t('绕过触发器（DROP TRIGGER）篡改中间条 → verify 报断链位置', () => {
    const raw = new DatabaseSync(dbD);
    raw.exec('DROP TRIGGER trg_audit_no_update');
    raw.exec(`UPDATE audit_log SET action_type='tampered' WHERE seq=2`);
    raw.close();
    const v = storeD.verify();
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.broken_at_seq, 2);
    assert.ok(/篡改|不匹配/.test(v.reason!));
  });
  storeD.close();

  // =============================================================== E. HTTP
  console.log('== E. HTTP 端点（GET events/{id}/verify；非 GET 405；422）==');
  const rt = buildAudit({ dbPath: tmpDb(), defaultActor: 'auditor' });
  rt.store.append(mkEvent({ who_id: 'alice', action_type: 'restart', result: 'success', incident_id: 'inc-9' }));
  rt.store.append(mkEvent({ who_id: 'bob', action_type: 'scale', result: 'denied', reason: 'nope' }));
  const srv = await startAuditServer(rt);
  await t('GET /events → 分页列表', async () => {
    const r = await getJson(`${srv.url}/api/v1/audit/events`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.total, 2);
    assert.strictEqual(r.body.items.length, 2);
  });
  await t('GET /events?who=alice&action_type=restart → 过滤', async () => {
    const r = await getJson(`${srv.url}/api/v1/audit/events?who=alice&action_type=restart`);
    assert.strictEqual(r.body.total, 1);
    assert.strictEqual(r.body.items[0].who_id, 'alice');
  });
  await t('GET /events?result=denied → 过滤', async () => {
    const r = await getJson(`${srv.url}/api/v1/audit/events?result=denied`);
    assert.strictEqual(r.body.total, 1);
  });
  await t('GET /events?result=bogus → 422', async () => {
    const r = await getJson(`${srv.url}/api/v1/audit/events?result=bogus`);
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.field, 'result');
  });
  await t('GET /events/{id} → 单条', async () => {
    const id = rt.store.all()[0].id;
    const r = await getJson(`${srv.url}/api/v1/audit/events/${id}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.id, id);
  });
  await t('GET /events/{不存在} → 404', async () => {
    const r = await getJson(`${srv.url}/api/v1/audit/events/nope`);
    assert.strictEqual(r.status, 404);
  });
  await t('GET /verify → ok=true', async () => {
    const r = await getJson(`${srv.url}/api/v1/audit/verify`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
  });
  await t('DELETE /events/{id} → 405（append-only）', async () => {
    const id = rt.store.all()[0].id;
    const r = await new Promise<{ status: number }>((resolve) => {
      const req = http.request(`${srv.url}/api/v1/audit/events/${id}`, { method: 'DELETE' }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode! }));
      });
      req.end();
    });
    assert.strictEqual(r.status, 405);
  });
  await t('PUT /events/{id} → 405', async () => {
    const id = rt.store.all()[0].id;
    const r = await new Promise<{ status: number }>((resolve) => {
      const req = http.request(`${srv.url}/api/v1/audit/events/${id}`, { method: 'PUT' }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode! }));
      });
      req.end();
    });
    assert.strictEqual(r.status, 405);
  });
  await t('非 audit 路径 → handle 返回 false（交回后续链）', () => {
    let handled = false;
    const fakeReq = { url: '/health', method: 'GET', headers: {} } as any;
    const fakeRes = {} as any;
    handled = rt.handle(fakeReq, fakeRes);
    assert.strictEqual(handled, false);
  });
  await srv.close();
  // 查询本身被审计（audit.query 埋点）
  await rt.writer.flush();
  await t('查询行为写入 audit.query 事件（谁查询了审计）', () => {
    const q = rt.store.query({ action_type: 'audit.query' });
    assert.ok(q.total >= 1, '应至少记录一次查询审计');
    assert.strictEqual(q.items[0].who_id, 'auditor');
  });
  await rt.writer.close();
  rt.store.close();

  // =============================================================== F. writer 异步
  console.log('== F. writer 有界异步队列 ==');
  const rtF = buildAudit({ dbPath: tmpDb(), auditQueries: false, batchSize: 4, flushIntervalMs: 5 });
  await t('emit 非阻塞入队；flush 后落盘', async () => {
    for (let i = 0; i < 3; i++) rtF.writer.emit(mkEvent({ action_type: `w${i}` }));
    assert.strictEqual(rtF.store.count(), 0, 'emit 不应同步落盘');
    await rtF.writer.flush();
    assert.strictEqual(rtF.store.count(), 3);
    assert.strictEqual(rtF.writer.stats().persisted, 3);
  });
  await t('队列超限 → 丢弃计数（不阻塞）', async () => {
    const rtSmall = buildAudit({ dbPath: tmpDb(), auditQueries: false, maxQueue: 2, flushIntervalMs: 100000 });
    rtSmall.writer.emit(mkEvent({ action_type: 'e1' }));
    rtSmall.writer.emit(mkEvent({ action_type: 'e2' }));
    rtSmall.writer.emit(mkEvent({ action_type: 'e3' })); // 超限丢弃
    assert.strictEqual(rtSmall.writer.stats().dropped, 1);
    await rtSmall.writer.close();
    rtSmall.store.close();
  });
  await t('FR-AUDIT-005：failed/denied 缺 reason 时兜底非空', () => {
    const ev = toEvent({
      who_type: 'agent', who_id: 'x', when: '2026-09-20T00:00:00Z',
      action_type: 'op', target_resource: 'r', why_source: 'alert', result: 'denied',
    });
    assert.ok(ev.reason && ev.reason.length > 0);
  });
  await rtF.writer.close();
  rtF.store.close();

  console.log(`\n✅ audit.spec 全部通过（${pass} 项）`);
}

main().catch((e) => {
  console.error('\n❌ audit.spec 失败:', e);
  process.exit(1);
});
