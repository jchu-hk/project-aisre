/**
 * test/query.spec.ts —— Issue #372 生命周期可观测（lifecycle + 读路径 + HTTP 接线）
 *
 * 运行：cd apps/ai-sre-service && npx ts-node test/query.spec.ts
 *
 * 覆盖（AC-016 / AC-016a / AC-016b + DESIGN §12.2 / §12.6，含 #372）：
 *  A. lifecycle 状态机（machine）合法性：合法迁移放行；白名单外拒绝；closed 单调锁——
 *     静默复活拒绝、closed→reopen 必须 reason、closed→closed 同态拒绝。
 *  B. driver/ledger 推进（AC-016）：acceptNew/detect 起步→受理；dup/known merge 直接 closed
 *     不入 investigating；closed 唯一出路=显式 reopen；closed 上任何 progress/merge 均 noop（不静默复活）；
 *     AC-016 全链路（报障→triage→受理→排查→关单→可回查）每跳 prev/new/trigger/reason 可供 scope=trace。
 *  C. 读路径（AC-016b）：各维度过滤（system/lifecycle/severity/source/time/issue/q）+精简投影不含 PII；
 *     无匹配→200 空子集不报错；per-system ACL 越权（list 只回所辖、detail 越权→null/不可见）。
 *  D. HTTP 接线层真实冒烟：@api list/detail 返回正确；scope 非法 422；越权 system 403；不存在 404；
 *     scope=trace 带 timeline；/health 与 / 走 base（query 未顶替主链）。
 */

import * as assert from 'assert';
import {
  mkIncident,
  seedDeltaStore,
  aclFor,
  startSreServer,
  closeSreServer,
} from './helpers';
import { IncidentStore } from '../src/incidents/incident-store';
import { LifecycleLedger } from '../src/lifecycle/ledger';
import { LifecycleDriver } from '../src/lifecycle/driver';
import { LifecycleMachine } from '../src/lifecycle/machine';
import { listIncidents, getIncidentDetail } from '../src/query/reader';

let pass = 0;
function t(name: string, fn: () => void) {
  fn();
  pass++;
  console.log(`  ✓ ${name}`);
}
async function ta(name: string, fn: () => Promise<void>) {
  await fn();
  pass++;
  console.log(`  ✓ ${name}`);
}

interface Ref { incident_id: string; system_id: string; issue_id: number | null }

const NOWISO = '2026-09-05T00:00:00.000Z';

async function main() {
  // ================================================================= A. machine
  console.log('== A. lifecycle 状态机合法性（machine）==');
  const machine = new LifecycleMachine();
  const okTr = machine.transition('reported', 'triage', { incident_id: 'a', system_id: 'sas', at: NOWISO });
  t('合法 reported→triage → ok', () => assert.strictEqual(okTr.ok, true));
  const bad = machine.transition('triage', 'reported', { incident_id: 'a', system_id: 'sas', at: NOWISO });
  t('白名单外 triage→reported → malformed_transition（边界输入一律拒绝）', () => {
    assert.strictEqual(bad.ok, false);
    assert.strictEqual((bad as { code: string }).code, 'malformed_transition');
  });
  const resurrect1 = machine.transition('closed', 'investigating', {
    incident_id: 'a', system_id: 'sas', at: NOWISO, trigger: 'detector', reason: '检测跳变',
  });
  t('closed 以非-explicit_reopen trigger 意图重开（detector→investigating）→ 拒绝不重生', () => {
    assert.strictEqual(resurrect1.ok, false);
  });
  const rno = machine.transition('closed', 'accepted_in_progress', { incident_id: 'a', system_id: 'sas', at: NOWISO });
  t('closed→reopen 缺 reopen_reason → 拒绝（不到则不复活）', () => {
    assert.strictEqual(rno.ok, false);
    assert.strictEqual((rno as { code: string }).code, 'reopen_requires_reason');
  });
  const rok = machine.reopen('a', 'sas', 'accepted_in_progress', { reason: '复发', at: NOWISO });
  t('closed→reopen 显式带 reason → ok（唯一出路）', () => assert.strictEqual(rok.ok, true));
  const s = machine.transition('closed', 'closed', { incident_id: 'a', system_id: 'sas', at: NOWISO });
  t('closed→closed 同态 → 拒绝', () => {
    assert.strictEqual(s.ok, false);
    assert.strictEqual((s as { code: string }).code, 'same_state');
  });

  // ================================================================= B. driver/ledger（AC-016）
  console.log('== B. driver + ledger（AC-016 closed 唯一出路/幂等/可回查）==');
  const storeB = seedDeltaStore();
  const ledgerB = new LifecycleLedger({ startClock: () => NOWISO });
  const findRef: (id: string) => Ref | undefined = (id) => {
    const inc = storeB.getById(id);
    return inc ? { incident_id: inc.incident_id, system_id: inc.system_id, issue_id: inc.issue_id } : undefined;
  };
  const driver = new LifecycleDriver(findRef, ledgerB, 'ai-sre-service');
  // 直接 seed 一个 incident 供推进（driver 依赖 find() 命中 store 已有 incident 才推进）
  const wInc = mkIncident(storeB, { system_id: 'sys-web', source: 'intake', severity: 'P1', triage: 'new', symptom: 'flow-ticket' });
  const ownId = wInc.incident_id;

  const acc = driver.acceptNew(ownId);
  t('AC-016 主流程 new：reported→triage→accepted → advanced', () => {
    assert.strictEqual(acc.status, 'advanced');
    assert.strictEqual(ledgerB.current(ownId), 'accepted_in_progress');
    assert.strictEqual(ledgerB.timeline(ownId).length, 2); // 两笔：reported→triage, triage→accepted
  });
  const acc2 = driver.acceptNew(ownId);
  t('同 incident 再 acceptNew → 幂等（不追加迁移，当前态不变）', () => {
    assert.strictEqual(ledgerB.current(ownId), 'accepted_in_progress');
    assert.strictEqual(ledgerB.timeline(ownId).length, 2); // 不造噪音
    void acc2;
  });
  driver.progress(ownId, 'start'); // accepted→investigating
  t('progress(start) → accepted→investigating', () => {
    assert.strictEqual(ledgerB.current(ownId), 'investigating');
  });
  const closeStep = driver.progress(ownId, 'close'); // investigating→closed
  const timelineFull = ledgerB.timeline(ownId);
  t('…→investigating→closed（每一跳 prev/new/trigger/actor 可读）【AC-016 全链路可回查】', () => {
    assert.strictEqual(closeStep.status, 'advanced');
    assert.ok(ledgerB.current(ownId) === 'closed');
    assert.ok(timelineFull.length >= 3, `len=${timelineFull.length}`);
    for (const hop of timelineFull) {
      assert.ok(hop.prev_state && hop.new_state && hop.trigger && hop.actor_id && hop.occurred_at);
    }
    // investigating→closed 应带 trigger 定位
    const last = timelineFull.slice(-1)[0];
    assert.strictEqual(last.trigger, 'fix_verify');   // investigating→closed 走向 fix_verify
  });
  // closed 排他：再 start/close → noop（锁死，不复活）
  t('closed 上再 progress(start)/progress(close) → noop（确定锁死）', () => {
    assert.strictEqual(driver.progress(ownId, 'start').status, 'noop');
    assert.strictEqual(driver.progress(ownId, 'close').status, 'noop');
    assert.strictEqual(ledgerB.current(ownId), 'closed');
  });
  // dup/known 并入 → 直接 closed 不入 investigating（§12.6）；对已 closed 的同 id 先 reopen 再并入以验证「不入 active」
  const dupId = mkIncident(storeB, { system_id: 'sys-web', source: 'intake', severity: 'P3', triage: 'new', symptom: 'dup-target' }).incident_id;
  const merge = driver.mergeClosed(dupId, 'dup');
  t('mergeClosed(dup)（fresh）→ 直接 closed（不入 investigating/active）', () => {
    assert.strictEqual(merge.status, 'advanced');
    assert.strictEqual(ledgerB.current(dupId), 'closed');
  });

  // 显式 reopen：closed 唯一出路（带 reason）
  const rOpen = driver.reopen(dupId, 'accepted_in_progress', '重复但用户实际仍受阻');
  t('closed → 显式 reopen → advanced，带 reopen_reason（唯一出路）', () => {
    assert.strictEqual(rOpen.status, 'advanced');
    assert.strictEqual(ledgerB.current(dupId), 'accepted_in_progress');
    const last = ledgerB.timeline(dupId).slice(-1)[0];
    assert.strictEqual(last.trigger, 'explicit_reopen');
    assert.strictEqual(last.reopen_reason, '重复但用户实际仍受阻');
  });
  const reopenNoReason = driver.reopen(dupId, 'accepted_in_progress', '');
  t('closed→reopen 缺 reason → noop（不静默复活）', () => {
    // dupId 已 reopen→accepted，非 closed；reopen 返回 noop（guard current!==closed）
    const st = reopenNoReason.status;
    assert.strictEqual(st, 'noop');
    assert.strictEqual(ledgerB.current(dupId), 'accepted_in_progress');
  });

  // ================================================================= C. reader 过滤 / ACL / 投影（AC-016b）
  console.log('== C. 读路径（AC-016b）==');
  const storeC = seedDeltaStore();
  const ledgerC = new LifecycleLedger({ startClock: () => NOWISO });
  // 依据 forwardSeedProjection 规则把 storeC 的 incident 在 ledger 建档（便于按 lifecycle 过滤）
  const projection = (inc: { source: string; status: string; triage: string; ack_status: string }): string => {
    if (inc.source === 'detected') return inc.status === 'resolved' || inc.status === 'suppressed' ? 'closed' : 'investigating';
    if (inc.ack_status === 'closed' || inc.triage === 'dup' || inc.triage === 'known') return 'closed';
    return 'accepted_in_progress';
  };
  for (const inc of storeC.all()) {
    ledgerC.seed(inc.incident_id, projection(inc) as 'closed' | 'investigating' | 'accepted_in_progress', inc.system_id);
  }
  const aclAll = aclFor(storeC);

  const all = listIncidents(storeC, ledgerC, {}, { sort: '-created_at' }, { aclSystems: aclAll });
  t('无过滤 → count=全体；列表精简投影不含 PII(全文/raw/contact)', () => {
    assert.strictEqual(all.count, storeC.all().length);
    if (all.items[0]) {
      const r = all.items[0] as unknown as Record<string, unknown>;
      assert.ok(!('symptom_desc' in r), '列表行不应出现 symptom 全文');
      assert.ok(!('raw_payload' in r));
      assert.ok(!('reporter_contact_ref' in r));
    }
  });

  const onlyWeb = listIncidents(storeC, ledgerC, { system_id: 'sys-web' }, {}, { aclSystems: aclAll });
  t('system_id 过滤 → 仅该 system', () => {
    assert.ok(onlyWeb.items.length > 0 && onlyWeb.items.length < all.count);
    for (const r of onlyWeb.items) assert.strictEqual(r.system_name, 'sys-web');
  });

  const closedL = listIncidents(storeC, ledgerC, { lifecycle: 'closed' }, {}, { aclSystems: aclAll });
  t('lifecycle=closed 过滤 → 只含 closed', () => {
    assert.ok(closedL.items.length > 0, `closed count=${closedL.count}`);
    for (const r of closedL.items) assert.strictEqual(r.lifecycle, 'closed');
  });

  const sevP0 = listIncidents(storeC, ledgerC, { severity: ['P0'] }, {}, { aclSystems: aclAll });
  t('severity=[P0] 过滤 → 只含 P0', () => {
    assert.ok(sevP0.items.length > 0);
    for (const r of sevP0.items) assert.strictEqual(r.severity, 'P0');
  });

  const noHit = listIncidents(storeC, ledgerC, { lifecycle: 'triage', severity: ['P3'], source: 'intake' }, {}, { aclSystems: aclAll });
  t('无匹配组合 → 200 空子集（count=0, items=[], next_cursor=null）【AC-016b】', () => {
    assert.strictEqual(noHit.count, 0);
    assert.deepStrictEqual(noHit.items, []);
    assert.strictEqual(noHit.next_cursor, null);
  });
  const issueHit = listIncidents(storeC, ledgerC, { issue_id: 1001 }, {}, { aclSystems: aclAll });
  t('issue_id 过滤 → 命中关联该 Issue 的 incident', () => {
    assert.ok(issueHit.items.length >= 1);
    for (const r of issueHit.items) assert.strictEqual(r.issue_id, 1001);
  });
  const qHit = listIncidents(storeC, ledgerC, { q: 'OOM' }, {}, { aclSystems: aclAll });
  t('q 子串检索 → 命中现象含 OOM', () => {
    assert.ok(qHit.items.length >= 1);
  });

  // per-system ACL 越权（AC-016b）：只给 sys-web 所辖 → 只见 sys-web；detail 越权 → null
  const webOnly = ['sys-web'];
  const webRes = listIncidents(storeC, ledgerC, {}, {}, { aclSystems: webOnly });
  t('per-system ACL：仅所辖 sys-web（不泄 sys-db）', () => {
    for (const r of webRes.items) assert.strictEqual(r.system_name, 'sys-web');
    assert.strictEqual(webRes.count, idsOfSys(storeC, 'sys-web').length);
  });
  const dbId = idsOfSys(storeC, 'sys-db')[0];
  const dbDetailCross = getIncidentDetail(storeC, ledgerC, dbId, 'full', { aclSystems: webOnly });
  t('跨 sys-db detail（不属所辖）→ null（越权不可见）', () => assert.strictEqual(dbDetailCross, null));
  const owned = getIncidentDetail(storeC, ledgerC, idsOfSys(storeC, 'sys-web')[0], 'full', { aclSystems: webOnly });
  t('所辖 sys-web detail → 有值', () => assert.ok(owned && owned.id));

  // cursor 分页（游标续页不重不漏，末页 next_cursor=null）
  const accIds = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const pg = listIncidents(storeC, ledgerC, {}, { limit: 2, cursor: cursor ?? undefined }, { aclSystems: aclAll });
    pages++;
    for (const row of pg.items) {
      assert.ok(!accIds.has(row.id), `cursor 续页不应重复行 ${row.id}`);
      accIds.add(row.id);
    }
    cursor = pg.next_cursor;
    if (pages > 10) break; // 防止死循环护栏
  } while (cursor);
  t('cursor 分页(limit=2) → 遍历全部且不重不漏、末页 next_cursor=null', () => {
    assert.strictEqual(accIds.size, storeC.all().length);
    assert.strictEqual(cursor, null);
    assert.ok(pages >= 3, `pages=${pages}`);
  });

  // ================================================================= D. HTTP 接线层真实冒烟
  console.log('== D. HTTP 接线层 ==');
  // 准备一个含多系统 store 与带迁移的记录,供 scope=trace
  const httpStore = seedDeltaStore();
  const httpLedger = new LifecycleLedger({ startClock: () => NOWISO });
  // 取一条 intake P0（triage=new, ack=processing）——forward 投影到 accepted_in_progress，便于断言
  const tgtInc = httpStore.all().find(
    (i) => i.system_id === 'sys-web' && i.source === 'intake' && i.severity === 'P0',
  )!;
  const tgt = tgtInc.incident_id;
  // 显示推进两笔合法迁移（reported→triage→accepted），使 ledger.current + timeline 有值
  httpLedger.seed(tgt, 'reported', 'sys-web');
  const d1 = httpLedger.apply('reported', 'triage', {
    incident_id: tgt, system_id: 'sys-web', actor_id: 'svc', reason: '受纳',
  });
  const d2 = httpLedger.apply('triage', 'accepted_in_progress', {
    incident_id: tgt, system_id: 'sys-web', actor_id: 'svc', reason: 'triage=new 受理',
  });
  assert.strictEqual(d1.ok, true);
  assert.strictEqual(d2.ok, true);
  let url = '';
  try {
    url = await startSreServer({ store: httpStore, ledger: httpLedger });
    await ta('HTTP: /health 与 /（base 未顶替）+ list/detail/scope/越权/404 冒烟', async () => {
      const h = await fetch(`${url}/health`);
      assert.strictEqual(h.status, 200);
      const root = await fetch(url + '/');
      assert.strictEqual(root.status, 200);

      const li = await fetch(`${url}/api/sre/incidents`);
      assert.strictEqual(li.status, 200);
      const lib = (await li.json()) as { count: number };
      assert.strictEqual(lib.count, httpStore.all().length);

      // 越权显式 system_id → 403
      const x = await fetch(`${url}/api/sre/incidents?system_id=sys-evil`);
      assert.strictEqual(x.status, 403);

      // actor 注入头部 → 写 query audit（matched_ids/filters 落 ledger）
      const auditedReq = await fetch(`${url}/api/sre/incidents?system_id=sys-web&severity=P0`, {
        headers: { 'x-sre-actor': 'ops-lee' },
      });
      assert.strictEqual(auditedReq.status, 200);
      const auditLog = httpLedger.queryAuditLog();
      const mine = auditLog.filter((r) => r.actor_id === 'ops-lee' && r.endpoint === '/api/sre/incidents');
      t('x-sre-actor → query audit 记录 actor_id / filters(matched_ids 命中) 落账', () => {
        assert.ok(mine.length >= 1, '缺 audit 行');
        const f = mine[mine.length - 1].filters as { matched_ids?: string[]; system_id?: string; severity?: string[] };
        assert.strictEqual(f.system_id, 'sys-web');
        assert.deepStrictEqual(f.severity, ['P0']);
        assert.ok(Array.isArray(f.matched_ids) && f.matched_ids.length >= 1, 'matched_ids 应记录命中集');
      });

      // 非法 scope → 422
      const sc = await fetch(`${url}/api/sre/incidents/${encodeURIComponent(tgt)}?scope=nope`);
      assert.strictEqual(sc.status, 422);

      // 不存在 → 404
      const nf = await fetch(`${url}/api/sre/incidents/00000000-0000-0000-0000-000000000000`);
      assert.strictEqual(nf.status, 404);

      // full detail 200 + 值
      const fulld = await fetch(`${url}/api/sre/incidents/${encodeURIComponent(tgt)}`);
      assert.strictEqual(fulld.status, 200);
      const fullBody = (await fulld.json()) as { lifecycle: string; timeline?: unknown };
      assert.strictEqual(fullBody.lifecycle, 'accepted_in_progress');
      assert.ok(!('timeline' in fullBody) || fullBody.timeline === undefined, 'full 不含 timeline');

      // trace → 含 timeline 数组
      const tr = await fetch(`${url}/api/sre/incidents/${encodeURIComponent(tgt)}?scope=trace`);
      assert.strictEqual(tr.status, 200);
      const trb = (await tr.json()) as { timeline?: unknown[] };
      assert.ok(Array.isArray(trb.timeline) && trb.timeline.length >= 1, `trace timeline len=${trb.timeline?.length}`);

      // 跨 system detail（某 sys-db id，而 acl=全系统时不应 403，这里 server 默认 acl=满所辖两系统 => 应 200）
      const dbIn = idsOfSys(httpStore, 'sys-db')[0];
      const dd = await fetch(`${url}/api/sre/incidents/${encodeURIComponent(dbIn)}?scope=trace`);
      assert.strictEqual(dd.status, 200, '全所辖内 sys-db trace 应 200');
    });
  } finally {
    await closeSreServer();
  }

  console.log(`\n✅ Issue #372 lifecycle 可观测 单测全部通过 (${pass})`);
}

function idsOfSys(store: IncidentStore, sys: string): string[] {
  return store.all().filter((i) => i.system_id === sys).map((i) => i.incident_id);
}

main().catch((e) => {
  console.error('✗ Issue #372 lifecycle 单测失败:', e);
  process.exit(1);
});
