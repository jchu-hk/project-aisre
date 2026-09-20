/**
 * test/intake.smoke.ts —— 冒烟自测（F-SRE-014 AC-014a/014b / UC-SRE-016）
 *
 * 运行：cd apps/ai-sre-service && npx ts-node test/intake.smoke.ts
 * 覆盖（对齐 AC/UC）：
 *  1. 归一化缺关键字段 → missing（异常流, UC-SRE-016「提示补全重试」）
 *  2. 合法报文归一化 → reporter_contact 脱敏、raw 落库/空、source/severity、source='intake'
 *  3. triage：重复(dup)→不新建；已知(known,同 open issue)→并入；无匹配=新建(new)
 *  4. Issue 关联（本地伪号 no-op gateway）
 *  5. 回执闭环 received→…→closed；首投失败会重试（ack_attempts≥2）
 *  6. NFR-S 保留：raw 超时清空；关单后 contact 清除
 *  7. 空 intake_channels = 待接入态（routes 空、不注册）；有通道则注册 POST 路由
 */

import * as assert from 'assert';
import { IntakeService } from '../src/intake/ingestion';
import { normalizeReport } from '../src/intake/normalize';
import { IncidentStore } from '../src/incidents/incident-store';
import { toMaskedContactRef } from '../src/incidents/reporter-contact';
import { RetentionSweeper, RetentionPolicy } from '../src/intake/retention';
import { LogAckBackend } from '../src/intake/acknowledger';
import { planIntakeRoutes } from '../src/intake/http-intake';

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

async function main() {
  console.log('== 1. normalize 关键字段校验 ==');
  const normMissing = normalizeReport(
    { system_id: '', symptom_desc: '' },
    { sourceChannel: 'test', receivedAt: new Date() },
  );
  t('缺字段 → ok=false，missing 含 4 个关键字段', () => {
    assert.strictEqual(normMissing.ok, false);
    for (const f of ['system_id', 'symptom_desc', 'reported_at', 'reporter_contact']) {
      assert.ok(normMissing.missing.includes(f), `missing ${f}`);
    }
  });

  const ok = normalizeReport(
    {
      system_id: 'school-admin-system',
      symptom_desc: '用户列表页打开后一直转圈不显示数据，刷新无效',
      reported_severity: '高/多用户',
      reported_at: 1693000000,
      reporter_contact: 'ops-runner@corp.example.com',
      keep_raw: true,
    },
    { sourceChannel: 'sas_ops', receivedAt: new Date('2026-09-05T00:00:00Z') },
  );
  t('合法报文归一化成功', () => assert.ok(ok.ok && !!ok.incident));
  t('reporter_contact 脱敏入库（非明文全量）', () => {
    const ref = ok.incident!.reporter_contact_ref;
    assert.ok(ref && !ref.includes('ops-runner@corp.example.com'), `ref=${ref}`);
    assert.ok(ref.includes('***'), `ref=${ref}`);
  });
  t('keep_raw=true 时 raw 落库并剔除全量回执值', () => {
    const rp = ok.incident!.raw_payload as Record<string, unknown> | null;
    assert.ok(rp);
    assert.strictEqual(rp!['reporter_contact'], undefined);
  });
  t('source=intake + source_channel 保留', () => {
    assert.strictEqual(ok.incident!.source, 'intake');
    assert.strictEqual(ok.incident!.source_channel, 'sas_ops');
  });

  console.log('== 2. triage 三分类 ==');
  const store = new IncidentStore();
  const backend = new LogAckBackend();
  const svc = new IntakeService(store, { ackBackend: backend });
  const iso = new Date().toISOString();
  const r1 = await svc.ingest(
    { system_id: 'sas', symptom_desc: '导出报表报错，按钮点不动', reported_at: iso, reporter_contact: 'a@x.com' },
    { sourceChannel: 'webform', receivedAt: new Date() },
  );
  t('new: 首个同象 → triage=new、回执受理(received)', () => {
    assert.strictEqual(r1.triage!.triage, 'new');
    assert.strictEqual(r1.acked, true);
    assert.strictEqual(r1.incident!.ack_status, 'received');
  });
  const r2 = await svc.ingest(
    { system_id: 'sas', symptom_desc: '导出报表报错，按钮点不动', reported_at: iso, reporter_contact: 'b@x.com' },
    { sourceChannel: 'im', receivedAt: new Date() },
  );
  t('dup: 同系统同象重复 → triage=dup，并入既有，不新建 Issue', () => {
    assert.strictEqual(r2.triage!.triage, 'dup');
    assert.ok(r2.triage!.duplicate_of_id);
    assert.strictEqual(r2.issueId, r1.issueId);
  });
  const r3 = await svc.ingest(
    { system_id: 'sas', symptom_desc: '完全不同现象 XZ99 报障', reported_at: iso, reporter_contact: 'c@x.com' },
    { sourceChannel: 'im', receivedAt: new Date() },
  );
  t('new(另一现象): 判定 new', () => {
    assert.strictEqual(r3.triage!.triage, 'new');
  });

  // known：模拟一张已存在 open Issue 关联的另一条 open 报障，再次同 issue 报文 → known（并入不新建）
  const storeK = new IncidentStore();
  const knownSvc = new IntakeService(storeK, { ackBackend: new LogAckBackend() });
  const kb = await knownSvc.ingest(
    { system_id: 'sas', symptom_desc: '登录页白屏', reported_at: iso, reporter_contact: 'd@x.com' },
    { sourceChannel: 'im', receivedAt: new Date() },
  );
  (storeK as { markIssue: Function }).markIssue(kb.incident!.incident_id, 555);
  // known：报障者在 Issue #555（已开）上补充同类但措辞不同信息 → 判定 known、并入不新建
  const rKnown = await knownSvc.ingest(
    { system_id: 'sas', symptom_desc: '多了一个更详细的根因线索：网关偶发超时导致白屏', issue_id: 555, reported_at: iso, reporter_contact: 'e@x.com' },
    { sourceChannel: 'ticket', receivedAt: new Date() },
  );
  await ta('known: 命中 open Issue #555 关联记录 → triage=known，并入不新建', async () => {
    assert.strictEqual(rKnown.triage!.triage, 'known');
    assert.strictEqual(rKnown.triage!.known_issue_id, 555);
    assert.strictEqual(rKnown.incident!.duplicate_of_id, null); // post-known 未并入 id
    assert.ok(rKnown.issueId === 555);
  });

  // ========================= 回归：QA 缺陷 B1/M1/B2 =========================
  console.log('== 2.5 回归：B1 known 落库 / M1 指纹去 severity / B2 电话掩码 ==');
  await ta('B1-回归: known 命中后 acked=true 且 incident 已入 store（可 getById 查回）', async () => {
    assert.strictEqual(rKnown.acked, true, `known.acked=${rKnown.acked} 应为 true`);
    const persisted = storeK.getById(rKnown.incident!.incident_id);
    assert.ok(persisted, 'known 命中 incident 应已 upsert 入 store（getById 应命中）');
    assert.strictEqual(persisted!.triage, 'known');
    assert.strictEqual(persisted!.issue_id, 555);
    // 回执收到后 store 副本 ack_status 亦推进为 received
    assert.strictEqual(persisted!.ack_status, 'received');
    assert.strictEqual(persisted!.ack_attempts >= 1, true);
  });
  // known 后对该 incident 可正常推进回执（此前因未入 store 无法 setAckStatus）
  await ta('B1-回归: 已补证 known incident 可继续推进回执状态（处理中）', async () => {
    const cont = await knownSvc.ack().acknowledge(rKnown.incident!.incident_id, 'processing');
    assert.strictEqual(cont, true);
    assert.strictEqual(storeK.getById(rKnown.incident!.incident_id)!.ack_status, 'processing');
  });

  await ta('M1-回归: 同 system+同现象、severity 表述不同或缺省 → 判 dup 归并到 A，不产生新', async () => {
    const mStore = new IncidentStore();
    const mSvc = new IntakeService(mStore, { ackBackend: new LogAckBackend() });
    const mA = await mSvc.ingest(
      { system_id: 'pay', symptom_desc: '对账流水缺失，出现款项对不上', reported_severity: '高/影响面大', reported_at: iso, reporter_contact: 'mA@x.com' },
      { sourceChannel: 'im', receivedAt: new Date() },
    );
    assert.strictEqual(mA.triage!.triage, 'new', 'A(首报) 应为 new');
    const mB = await mSvc.ingest(
      { system_id: 'pay', symptom_desc: '对账流水缺失，出现款项对不上', reported_severity: '紧急/严重', reported_at: iso, reporter_contact: 'mB@x.com' },
      { sourceChannel: 'webform', receivedAt: new Date() },
    );
    assert.strictEqual(mB.triage!.triage, 'dup', 'B(severity 表述不同) 应判 dup');
    assert.strictEqual(mB.triage!.duplicate_of_id, mA.incident!.incident_id, 'B 应归并到 A');
    const mC = await mSvc.ingest(
      { system_id: 'pay', symptom_desc: '对账流水缺失，出现款项对不上', reported_at: iso, reporter_contact: 'mC@x.com' },
      { sourceChannel: 'ticket', receivedAt: new Date() },
    );
    assert.strictEqual(mC.triage!.triage, 'dup', 'C(缺省 severity) 应判 dup');
    assert.strictEqual(mC.triage!.duplicate_of_id, mA.incident!.incident_id, 'C 应归并到 A');
    // 不产生额外新 incident：同一 dedup 指纹只该有一个现役首建
    const aCount = mStore.all().filter((i) => i.triage === 'new' && i.incident_id !== mA.incident!.incident_id).length;
    assert.strictEqual(aCount, 0, '不应产生额外 new incident');
  });
  t('M1-回归: 指纹不含 severity → 同 system+现象、severity 有无/表述不同，指纹一致', () => {
    const mkFp = (sev?: string) => normalizeReport(
      { system_id: 'pay', symptom_desc: '对账流水缺失，出现款项对不上', reported_severity: sev, reported_at: iso, reporter_contact: 'fp@x.com' },
      { sourceChannel: 'im', receivedAt: new Date() },
    ).incident!.dedup_fingerprint;
    const fpHigh = mkFp('高/影响面大');
    const fpUrgent = mkFp('紧急/严重');
    const fpNone = mkFp(undefined);
    assert.strictEqual(fpHigh, fpUrgent, '不同 severity 文案指纹应一致');
    assert.strictEqual(fpUrgent, fpNone, '缺省 severity 指纹应同前');
  });
  t('B2-回归: 电话掩码前缀全星仅留尾 4（+cc 保留为结构提示）', () => {
    // 明细：本地号码前部全星仅留尾 4
    const local = toMaskedContactRef('13855551234');
    assert.strictEqual(local.ref, '***1234', `local.ref=${local.ref}`);
    // 带国家码：保留 +cc 结构提示 + 星 + 尾 4，不再暴露国家码外其它位
    const intl = toMaskedContactRef('+86 138 5555 1234');
    assert.strictEqual(intl.ref, '+86 ***1234', `intl.ref=${intl.ref}`);
  });

  console.log('== 3. 回执闭环与重试 ==');
  const id3 = r1.incident!.incident_id;
  backend.failNextOnce = true;
  const okClosed = await svc.ack().acknowledge(id3, 'closed', '已修复并验证');
  t('回执失败→重试后成功，acked=true，attempts≥2，status=closed', () => {
    const inc = store.getById(id3)!;
    assert.strictEqual(okClosed, true);
    assert.ok(inc.ack_attempts >= 2, `attempts=${inc.ack_attempts}`);
    assert.strictEqual(inc.ack_status, 'closed');
  });

  console.log('== 4. NFR-S 保留清理 ==');
  const storeR = new IncidentStore();
  const old = new Date(Date.now() - 31 * 864e5);
  const ri = await new IntakeService(storeR).ingest(
    { system_id: 'sas', symptom_desc: 'trx-leak', reported_at: old.toISOString(), reporter_contact: 'old@x.com', keep_raw: true },
    { sourceChannel: 'webform', receivedAt: old },
  );
  const si = ri.incident!;
  si.ack_status = 'closed';
  si.resolved_at = new Date(Date.now() - 10 * 864e5).toISOString(); // 10 天前关单
  const policy: RetentionPolicy = { rawPayloadKeepDays: 30, contactKeepDaysAfterClose: 7 };
  const sweep = new RetentionSweeper(storeR, policy, () => new Date());
  const rep = sweep.runOnce();
  t('raw_payload 超 30 天自动清空', () => {
    assert.ok(rep.clearedRaw >= 1);
    assert.strictEqual(si.raw_payload, null);
  });
  t('关单后 >7 天 reporter_contact_ref 清除（保留审计字段）', () => {
    assert.ok(rep.clearedContact >= 1);
    assert.strictEqual(si.reporter_contact_ref, '');
  });

  console.log('== 5. 空配置 = 待接入态（AC 空态基线）==');
  const mk = (channels?: unknown[]) => ({ identity: { instance_id: 't', listen: '0.0.0.0:0' }, systems: [], intake_channels: channels } as any);
  const emptyRoutes = planIntakeRoutes(mk([]));
  t('intake_channels=[] → 无路由（不注册不报错）', () => assert.deepStrictEqual(emptyRoutes, []));
  const oneRoutes = planIntakeRoutes(mk([{ type: 'webhook', name: 'ops', verb: 'POST', enabled: true }]));
  t('启用 1 webhook → 注册 1 条 POST 收报路由', () => {
    assert.strictEqual(oneRoutes.length, 1);
    assert.strictEqual(oneRoutes[0].method, 'POST');
    assert.ok(oneRoutes[0].path.endsWith('/ops'));
  });

  console.log(`\n✅ F-SRE-014 intake 冒烟自测全部通过 (${pass})`);
}

main().catch((e) => {
  console.error('✗ F-SRE-014 intake 冒烟自测失败:', e);
  process.exit(1);
});
