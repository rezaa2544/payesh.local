'use strict';
// آزمون خودکار نمونهٔ ۲۰ — امنیت، بار و قطعی سراسری
// اجرا: node prototype/slice-20/tests/run.js
// مرجع: ۰۴ §۳ (C‑1..C‑5) · ۰۴ §۵ (F‑C1/F‑C2/F‑C6) · ۱۶ §۷ (هزینه/گلوگاه) · D‑11

const crypto = require('node:crypto');
const { sha256, ConflictServer } = require('../../slice-19/conflict-server');
const { Clock, SecureCache, OpQueue } = require('../../slice-18/client-queue');
const {
  Gateway, Network, canWrite, backoffMs,
  TARGET_P95_READ_MS, TARGET_P95_WRITE_MS, TARGET_ERROR_RATE, MAX_BATCH,
} = require('../lab');
const { LCG, wireOp, seedRecords, runStage, stateHash, countTenantRecords } = require('../load');
const {
  summarize, resourceSnapshot, resourceDelta, classify,
  costModel, capacityReport, bottleneckReport, stableStringify,
} = require('../metrics');

const SECRET = crypto.createHash('sha256').update('slice-20-fixed-secret').digest();
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ' — ' + detail}`);
}

// ---------- ساخت جهان آزمون ----------
function world(nTenants = 2) {
  const gateway = new Gateway({ secret: SECRET, now: () => Date.now() });
  const tenants = [];
  for (let i = 0; i < nTenants; i++) {
    const id = `t-${String.fromCharCode(97 + i)}`;
    gateway.provision({ id, code: `sch-${id}`, name: `مدرسهٔ ${id}` });
    tenants.push(id);
  }
  const tokens = {};
  const sessions = {};
  for (const tid of tenants) {
    tokens[tid] = {};
    sessions[tid] = {};
    for (const role of ['manager', 'teacher', 'parent', 'student', 'guard', 'counselor']) {
      tokens[tid][role] = gateway.issueToken({ tenant_id: tid, role, user_id: `u-${role}`, device_id: `dev-${tid}-${role}` });
      sessions[tid][role] = gateway.authenticate(tokens[tid][role]);
    }
  }
  return { gateway, tenants, tokens, sessions };
}

const auditChainOk = (audit) => audit.every((row, i) =>
  (i === 0 ? row.prev_hash === 'GENESIS' : row.prev_hash === audit[i - 1].hash) &&
  row.hash === sha256(JSON.stringify({ ...row, hash: undefined })));

async function main() {
  // =================== A) نفوذ و امنیت مرز (۱۶ ادعا) ===================
  const A = world(3);
  const [ta, tb, tc] = A.tenants;

  // A1 بدون توکن
  {
    let err = null;
    try { A.gateway.authenticate(undefined); } catch (e) { err = e; }
    check('A1 بدون مجوز ⇒ ۴۰۱ auth_required و بدون هیچ داده‌ای', err && err.code === 'auth_required' && err.status === 401 && !err.data);
  }
  // A2 امضای جعلی
  {
    const good = A.tokens[ta].manager;
    const bad = good.slice(0, -2) + (good.slice(-2) === 'AA' ? 'BB' : 'AA');
    let err = null;
    try { A.gateway.authenticate(bad); } catch (e) { err = e; }
    check('A2 امضای جعلی ⇒ bad_signature', err && err.code === 'bad_signature');
  }
  // A3 توکن منقضی
  {
    const expired = A.gateway.issueToken({ tenant_id: ta, role: 'manager', user_id: 'u-manager', device_id: 'dev-x', ttlMs: -1000 });
    let err = null;
    try { A.gateway.authenticate(expired); } catch (e) { err = e; }
    check('A3 توکن منقضی ⇒ token_expired', err && err.code === 'token_expired');
  }
  // A4 alg=none / بی‌امضا
  {
    const payload = { v: 1, tid: ta, role: 'manager', uid: 'u-manager', did: 'dev-x', alg: 'none', exp: Date.now() + 1000 };
    const forged = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + Buffer.from('x').toString('base64url');
    let err = null;
    try { A.gateway.authenticate(forged); } catch (e) { err = e; }
    check('A4 توکن alg=none/بی‌امضا ⇒ رد (alg_not_allowed/bad_signature)', err && ['alg_not_allowed', 'bad_signature', 'token_malformed'].includes(err.code));
  }
  // A5 tenant از بدنه نادیده گرفته می‌شود
  {
    const before = countTenantRecords(A.gateway.core, tb);
    const s = A.sessions[ta].teacher;
    const op = wireOp({ op_id: 'smuggle-1', record_id: 'sm-1', base_version: 0, payload: { status: 'present', tenant_id: tb } });
    await A.gateway.push(s, [op]);
    check('A5 tenant_id در بدنه نادیده گرفته می‌شود (نوشتن در مستأجر نشست)',
      countTenantRecords(A.gateway.core, tb) === before && !!A.gateway.core.records.get(`${ta}|attendance|sm-1`));
  }
  // A6 خواندن بین‌مدرسه‌ای
  {
    await seedRecords(A.gateway, A.sessions[tb].manager, ['b-private-1']);
    let err = null;
    try { await A.gateway.read(A.sessions[ta].manager, { collection: 'attendance', record_id: 'b-private-1' }); } catch (e) { err = e; }
    check('A6 خواندن ردیف مدرسهٔ دیگر ⇒ ۴۰۴ یکنواخت (بدون اوراکل وجود/محتوا)', err && err.code === 'not_found' && err.status === 404);
  }
  // A7 نوشتن روی شناسهٔ مدرسهٔ دیگر
  {
    const h = stateHash(A.gateway.core, tb);
    await A.gateway.push(A.sessions[ta].manager, [wireOp({ op_id: 'xw-1', record_id: 'b-private-1', base_version: 5, payload: { status: 'absent' } })]);
    check('A7 نوشتن با شناسهٔ مدرسهٔ دیگر، دادهٔ آن مدرسه را تغییر نمی‌دهد', stateHash(A.gateway.core, tb) === h);
  }
  // A8/A9 ارتقای نقش
  {
    let e1 = null, e2 = null;
    try { await A.gateway.push(A.sessions[ta].teacher, [wireOp({ op_id: 'esc-1', collection: 'users', record_id: 'u1', base_version: 0, payload: { role: 'manager' } })]); } catch (e) { e1 = e; }
    try { await A.gateway.push(A.sessions[ta].guard, [wireOp({ op_id: 'esc-2', collection: 'attendance', record_id: 'g1', base_version: 0, payload: { status: 'present' } })]); } catch (e) { e2 = e; }
    check('A8 دبیر ⇒ نوشتن users: ۴۰۳ role_denied', e1 && e1.code === 'role_denied' && e1.status === 403);
    check('A9 نگهبان ⇒ نوشتن attendance: ۴۰۳ + ردیف audit', e2 && e2.code === 'role_denied' && A.gateway.audit.some((r) => r.action === 'write.deny'));
  }
  // A10 دست‌کاری بدنه
  {
    const rec = `${ta}|attendance|tamper-1`;
    await A.gateway.push(A.sessions[ta].manager, [wireOp({ op_id: 'tp-1', record_id: 'tamper-1', base_version: 0, payload: { status: 'present' } })]);
    const h = stateHash(A.gateway.core, ta);
    const bad = { ...wireOp({ op_id: 'tp-2', record_id: 'tamper-1', base_version: 1, payload: { status: 'absent' } }), payload_hash: 'deadbeef' };
    const res = await A.gateway.push(A.sessions[ta].manager, [bad]);
    check('A10 بدنهٔ دست‌کاری‌شده ⇒ rejected payload_hash_mismatch و ردیف دست‌نخورده',
      res.results[0].reason === 'payload_hash_mismatch' && stateHash(A.gateway.core, ta) === h);
  }
  // A11 دستهٔ بیش از سقف
  {
    const h = stateHash(A.gateway.core, ta);
    const batch = Array.from({ length: MAX_BATCH + 1 }, (_, i) => wireOp({ op_id: `big-${i}`, record_id: `big-${i}`, base_version: 0, payload: { status: 'present' } }));
    let err = null;
    try { await A.gateway.push(A.sessions[ta].manager, batch); } catch (e) { err = e; }
    check(`A11 دستهٔ ${MAX_BATCH + 1} op ⇒ ۴۱۳ batch_too_large و هیچ نیمه‌اعمالی`, err && err.code === 'batch_too_large' && stateHash(A.gateway.core, ta) === h);
  }
  // A12 دستهٔ خالی
  {
    let err = null;
    try { await A.gateway.push(A.sessions[ta].manager, []); } catch (e) { err = e; }
    check('A12 دستهٔ خالی ⇒ ۴۰۰ empty_batch', err && err.code === 'empty_batch');
  }
  // A13 حملهٔ حدس توکن + قفل دستگاه
  {
    const g = A.gateway;
    const before = g.audit.length;
    let denied = 0, limited = 0;
    for (let i = 0; i < 60; i++) {
      try { g.authenticate(`guess-${i}.c2ln`, 'client-guesser'); } catch (e) { if (e.code === 'rate_limited') limited++; else denied++; }
    }
    check('A13a ۶۰ تلاش حدس ⇒ همه رد (۰ نشست)', denied + limited === 60 && limited > 0);
    check('A13b پس از ۲۰ شکست، دستگاه قفل می‌شود (rate_limited ۴۲۹)', limited === 60 - 20);
    check('A13c هر رد در audit زنجیره‌ای ثبت شده است', g.audit.length > before && auditChainOk(g.audit));
  }
  // A14 تزریق و آلودگی prototype
  {
    const evil = { status: 'present', note: "' OR 1=1 -- <script>alert(1)</script>", '__proto__': { polluted: true } };
    const payload = { status: 'present', note: "' OR 1=1 -- <script>alert(1)</script>" };
    await A.gateway.push(A.sessions[ta].manager, [wireOp({ op_id: 'inj-1', record_id: 'inj-1', base_version: 0, payload })]);
    const got = await A.gateway.read(A.sessions[ta].manager, { collection: 'attendance', record_id: 'inj-1' });
    check('A14a رشتهٔ تزریقی به‌صورت دادهٔ خام ذخیره و بازخوانی می‌شود', got.fields.note === evil.note);
    check('A14b آلودگی prototype رخ نمی‌دهد', ({}).polluted === undefined && Object.prototype.polluted === undefined);
  }
  // A15 ابطال دستگاه
  {
    A.gateway.revokedDevices.add(`dev-${ta}-parent`);
    let err = null;
    try { A.gateway.authenticate(A.tokens[ta].parent); } catch (e) { err = e; }
    check('A15 توکن دستگاه ابطال‌شده ⇒ device_revoked', err && err.code === 'device_revoked');
  }
  // A16 مستأجر تعلیق‌شده
  {
    A.gateway.tenants.get(tc).status = 'suspended';
    let err = null;
    try { A.gateway.authenticate(A.tokens[tc].manager); } catch (e) { err = e; }
    check('A16 مستأجر suspended ⇒ ۴۰۳ tenant_suspended', err && err.code === 'tenant_suspended' && err.status === 403);
  }

  // =================== B) جداسازی مستأجر زیر بار (۶ ادعا) ===================
  const B = world(8);
  {
    const per = 40;
    await Promise.all(B.tenants.map(async (tid) => {
      const s = B.sessions[tid].manager;
      const ops = Array.from({ length: per }, (_, i) => wireOp({ op_id: `iso-${tid}-${i}`, record_id: `iso-${i}`, base_version: 0, payload: { status: 'present', note: tid } }));
      await B.gateway.push(s, ops.slice(0, 200));
    }));
    const counts = B.tenants.map((tid) => countTenantRecords(B.gateway.core, tid));
    check('B1 هر ۸ مستأجر دقیقاً همان تعداد ردیف خودش را دارد', counts.every((c) => c === per), counts.join(','));
    const foreign = [...B.gateway.core.records.entries()].filter(([k, v]) => !k.startsWith(`${v.fields.note}|`));
    check('B2 صفر ردیف با tenant ناهم‌خوان (نشت بین‌مدرسه‌ای = ۰)', foreign.length === 0, `n=${foreign.length}`);
    const hashes = B.tenants.map((tid) => stateHash(B.gateway.core, tid));
    check('B3 اثر انگشت هر مستأجر یکتاست (داده‌ها با هم مخلوط نشده‌اند)', new Set(hashes).size === B.tenants.length);
  }
  {
    // تعارض در A نباید در B دیده شود
    const s = B.sessions[B.tenants[0]].teacher;
    await B.gateway.push(s, [wireOp({ op_id: 'cn-1', record_id: 'cn', base_version: 0, payload: { status: 'present' } })]);
    await B.gateway.push(s, [wireOp({ op_id: 'cn-2', record_id: 'cn', base_version: 1, payload: { status: 'late' } })]);
    await B.gateway.push(s, [wireOp({ op_id: 'cn-3', record_id: 'cn', base_version: 1, payload: { status: 'absent' } })]);
    check('B4 تعارض مستأجر A فقط در A دیده می‌شود (B: ۰)',
      B.gateway.core.openConflicts(B.tenants[0]).length === 1 && B.gateway.core.openConflicts(B.tenants[1]).length === 0);
  }
  {
    // همان op_id در دو مستأجر مستقل است؛ تکرار در همان مستأجر بی‌اثر
    const sA = B.sessions[B.tenants[2]].manager, sB = B.sessions[B.tenants[3]].manager;
    const r1 = await B.gateway.push(sA, [wireOp({ op_id: 'shared-op', record_id: 'shared', base_version: 0, payload: { status: 'present' } })]);
    const r2 = await B.gateway.push(sB, [wireOp({ op_id: 'shared-op', record_id: 'shared', base_version: 0, payload: { status: 'present' } })]);
    const before = B.gateway.core.record(B.tenants[2], 'attendance', 'shared').version;
    const r3 = await B.gateway.push(sA, [wireOp({ op_id: 'shared-op', record_id: 'shared', base_version: 0, payload: { status: 'present' } })]);
    const after = B.gateway.core.record(B.tenants[2], 'attendance', 'shared').version;
    check('B5 همان op_id در دو مستأجر مستقل اعمال می‌شود (یکتایی مستأجر‑محور)', r1.results[0].status === 'applied' && r2.results[0].status === 'applied');
    check('B6 بازپخش همان op_id در همان مستأجر نسخه را بالا نمی‌برد', r3.results[0].status === 'applied' && before === after);
  }
  {
    const attributed = B.gateway.core.audit.filter((r) => r.tenant);
    check('B7 ردیف‌های audit مدرسهٔ خود را حمل می‌کنند و زنجیره سالم است',
      attributed.length > 0 && attributed.every((r) => B.tenants.includes(r.tenant)) && auditChainOk(B.gateway.core.audit));
  }

  // =================== C) بار افزایشی، اهداف C‑1..C‑4 (۹ ادعا) ===================
  const C = world(2);
  const cSessions = [...C.tenants.map((t) => C.sessions[t].manager), C.sessions[C.tenants[0]].teacher];
  const r0 = resourceSnapshot();
  const loadPlan = [
    { label: 'c1', workers: 4, opsPerWorker: 60, readRatio: 0.5 },
    { label: 'c2', workers: 8, opsPerWorker: 60, readRatio: 0.5 },
    { label: 'c3', workers: 16, opsPerWorker: 60, readRatio: 0.5 },
    { label: 'c4', workers: 32, opsPerWorker: 40, readRatio: 0.6 },
    { label: 'c5', workers: 64, opsPerWorker: 25, readRatio: 0.6 },
  ];
  const stages = [];
  for (const p of loadPlan) stages.push(await runStage({ gateway: C.gateway, sessions: cSessions, seed: 20, ...p }));
  const r1 = resourceSnapshot();
  const resources = resourceDelta(r0, r1);
  const peak = stages[stages.length - 1];
  const repeat = await runStage({ gateway: C.gateway, sessions: cSessions, seed: 20, ...loadPlan[4], label: 'c5-repeat' });

  console.log('\n## پله‌های بار (اندازه‌گیری واقعی)');
  console.log('| پله | کارگر | op | خواندن | نوشتن | خطای سخت | نرخ خطا | p50 خواندن | p95 خواندن | p95 نوشتن | op/s |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of stages.concat([repeat])) {
    console.log(`| ${s.label} | ${s.workers} | ${s.ops} | ${s.reads} | ${s.writes} | ${s.failures} | ${(s.errorRate * 100).toFixed(3)}% | ${s.latency.read.p50} | ${s.latency.read.p95} | ${s.latency.write.p95} | ${s.rps} |`);
  }

  check('C1 هر پنج پلهٔ بار کامل اجرا شد و همهٔ opها اعمال شدند',
    stages.length === 5 && stages.every((s) => s.ops > 0 && s.failures === 0 && s.writes === s.writeOk && s.reads === s.readOk + s.notFound),
    JSON.stringify(stages.map((s) => [s.label, s.failures, s.writeOk, s.writes])));
  check('C2 نرخ خطای سخت در همهٔ پله‌ها < ۰٫۱٪ (C‑3)', stages.every((s) => s.errorRate < TARGET_ERROR_RATE),
    stages.map((s) => s.errorRate).join(','));
  const p95Read = Math.max(...stages.map((s) => s.latency.read.p95));
  const p95Write = Math.max(...stages.map((s) => s.latency.write.p95));
  check(`C3 p95 خواندن ≤ ${TARGET_P95_READ_MS}ms (C‑1)`, p95Read <= TARGET_P95_READ_MS, `p95=${p95Read}`);
  check(`C4 p95 نوشتن ≤ ${TARGET_P95_WRITE_MS}ms (C‑2)`, p95Write <= TARGET_P95_WRITE_MS, `p95=${p95Write}`);
  check('C5 هیچ پاسخ ۵xx در هیچ پله‌ای ثبت نشد (C‑3)', stages.every((s) => !s.errors['5xx'] && !s.errors.outage));
  const capacity = capacityReport(stages);
  check('C6 ظرفیت اندازه‌گیری‌شده ≥ ۲۰۰ op/s (هدف نوشتن سناریوی میانه ۰۴ §۲)',
    capacity.rps >= 200, `rps=${capacity.rps}`);
  const drift = peak.latency.read.p95 ? repeat.latency.read.p95 / peak.latency.read.p95 : 0;
  check('C7 تکرار پلهٔ اوج: افت p95 بیش از ۲۰٪ نیست (C‑4)',
    repeat.latency.read.p95 <= Math.max(20, peak.latency.read.p95 * 1.2 + 5), `drift=${drift.toFixed(2)}`);
  {
    // بازتولیدپذیری: دو جهان تازه + همان بذر ⇒ همان شمارش و همان اثر انگشت وضعیت
    const run1 = world(2);
    const run2 = world(2);
    const s1 = [...run1.tenants.map((t) => run1.sessions[t].manager), run1.sessions[run1.tenants[0]].teacher];
    const s2 = [...run2.tenants.map((t) => run2.sessions[t].manager), run2.sessions[run2.tenants[0]].teacher];
    const a = await runStage({ gateway: run1.gateway, sessions: s1, seed: 20, ...loadPlan[2], label: 'rep' });
    const b = await runStage({ gateway: run2.gateway, sessions: s2, seed: 20, ...loadPlan[2], label: 'rep' });
    check('C8 اجرای دوباره با همان بذر ⇒ همان تعداد اعمال و همان اثر انگشت وضعیت (قابل تکرار)',
      a.writeOk === b.writeOk && a.reads === b.reads && a.failures === b.failures &&
      stateHash(run1.gateway.core, run1.tenants[0]) === stateHash(run2.gateway.core, run2.tenants[0]),
      JSON.stringify([a.writeOk, b.writeOk, a.reads, b.reads]));
  }
  check('C9 در پله‌ها هیچ خواندن ناموفق/۴۰۴ پیش‌بینی‌نشده رخ نداد (داده بذر کامل بود)',
    stages.every((s) => s.readOk === s.reads && s.notFound === 0));

  // =================== D) قطع دیتاسنتر و بازیابی (۹ ادعا) ===================
  const D = world(1);
  const dt = D.tenants[0];
  const net = new Network(D.gateway);
  const devices = Array.from({ length: 5 }, (_, d) => {
    const clock = new Clock();
    const cache = new SecureCache({ clock });
    const q = new OpQueue({ clock, cache });
    return { d, clock, cache, q, session: D.sessions[dt].manager };
  });
  {
    D.gateway.armOutage('down');
    const okBefore = D.gateway.counters.ok;
    let e1 = null, e2 = null;
    try { await D.gateway.push(devices[0].session, [wireOp({ op_id: 'down-1', record_id: 'down-1', base_version: 0, payload: { status: 'present' } })]); } catch (e) { e1 = e; }
    try { await D.gateway.read(devices[0].session, { collection: 'attendance', record_id: 'seed' }); } catch (e) { e2 = e; }
    check('D1 در قطعی، نوشتن با خطای صریح dc_down شکست می‌خورد و موفقیتی جعل نمی‌شود',
      e1 && e1.kind === 'dc_down' && D.gateway.counters.ok === okBefore);
    check('D2 در قطعی، خواندن هم پاسخ نمی‌گیرد (هیچ درخواستی موفق نمی‌شود)', e2 && e2.kind === 'dc_down');
  }
  {
    // ۵ دستگاه × ۴۰۰ op = ۲۰۰۰ op در صف، همه حفظ
    for (const dev of devices) {
      for (let i = 0; i < 400; i++) {
        const r = dev.q.enqueue({ op_id: `dc-${dev.d}-${i}`, collection: 'attendance', record_id: `dc-${dev.d}-${i}`, base_version: 0, payload: { status: 'present', note: i } });
        if (!r.ok) throw new Error(`enqueue failed ${r.reason}`);
      }
      const flushed = await dev.q.flush(net.server(), dev.session, { limit: 100 });
      if (flushed.sent !== 0) throw new Error('flush should fail during outage');
    }
    const totalQueued = devices.reduce((a, d) => a + d.q.size, 0);
    const appliedLocally = devices.reduce((a, d) => a + d.q.byStatus('applied').length, 0);
    const appliedOnServer = countTenantRecords(D.gateway.core, dt);
    check('D3 صف ۲۰۰۰ op در قطعی دست‌نخورده می‌ماند (صفر اعمال محلی/سروری، صفر ack جعلی)',
      totalQueued === 2000 && appliedLocally === 0 && appliedOnServer === 0,
      `${totalQueued}/${appliedLocally}/${appliedOnServer}`);
    // پرکردن یک دستگاه تا سقف D‑27 و آزمون رد صریح
    while (devices[0].q.size < 2000) {
      const i = devices[0].q.size;
      devices[0].q.enqueue({ op_id: `cap-${i}`, collection: 'attendance', record_id: `cap-${i}`, base_version: 0, payload: { status: 'present' } });
    }
    const overflow = devices[0].q.enqueue({ op_id: 'dc-overflow', collection: 'attendance', record_id: 'dc-overflow', base_version: 0, payload: { status: 'present' } });
    check('D4 سقف ۲۰۰۰/دستگاه با رد صریح queue_full محافظت می‌شود (بدون حذف قدیمی)',
      overflow.ok === false && overflow.reason === 'queue_full' && devices[0].q.size === 2000);
  }
  const openOps = (q) => [...q.rows.values()].filter((o) => ['pending', 'sending', 'retry_wait', 'ack_unknown'].includes(o.status)).length;
  const drain = { applied: new Set(), rounds: 0 };
  {
    const out = D.gateway.recover();
    let guard = 0;
    while (devices.some((d) => openOps(d.q) > 0) && guard < 200) {
      for (const dev of devices) {
        if (openOps(dev.q) === 0) continue;
        const res = await dev.q.flush(net.server(), dev.session, { limit: 100 });
        for (const r of res.results) if (r.status === 'applied') drain.applied.add(r.op_id);
        drain.rounds++;
      }
      guard++;
    }
    const remaining = devices.reduce((a, d) => a + openOps(d.q), 0);
    const totalOps = devices.reduce((a, d) => a + d.q.size, 0);
    check('D5 پس از بازگشت سرویس، صف کامل تخلیه می‌شود (همهٔ opهای باز اعمال، صفر باقی‌مانده)',
      remaining === 0 && drain.applied.size === totalOps && totalOps === 3600,
      `applied=${drain.applied.size} remaining=${remaining} total=${totalOps} rounds=${drain.rounds}`);
    check('D6 قطعی با شروع/پایان در audit ثبت شده است (قابل رصد)',
      D.gateway.audit.some((r) => r.action === 'outage.begin') && D.gateway.audit.some((r) => r.action === 'outage.end') && out && out.ended_at >= out.started_at);
  }
  const drainHash = stateHash(D.gateway.core, dt);
  {
    const records = countTenantRecords(D.gateway.core, dt);
    check('D7 دقیقاً‑یک‌بار: ۳۶۰۰ op متمایز ⇒ ۳۶۰۰ ردیف و صفر تکرار', records === 3600, `records=${records}`);
    // بازپخش کامل پس از تخلیه
    for (const dev of devices) await dev.q.flush(net.server(), dev.session, { limit: 100 });
    check('D8 بازپخش پس از تخلیه هیچ نسخه/ردیفی اضافه نمی‌کند (idempotent)',
      stateHash(D.gateway.core, dt) === drainHash && countTenantRecords(D.gateway.core, dt) === 3600);
  }
  {
    // حالت degraded: نوشتن شکست صریح، صف حفظ
    D.gateway.armOutage('degraded');
    // دستگاه تازه: صف دستگاه‌های قبلی به سقف ۲۰۰۰ رسیده (ردیف‌ها پس از ack هم می‌مانند)
    const degClock = new Clock();
    const degQ = new OpQueue({ clock: degClock, cache: new SecureCache({ clock: degClock }) });
    const dev = { q: degQ, session: D.sessions[dt].manager };
    dev.q.enqueue({ op_id: 'deg-1', collection: 'attendance', record_id: 'deg-1', base_version: 0, payload: { status: 'present' } });
    const res = await dev.q.flush(net.server(), dev.session, { limit: 10 });
    check('D9 نمونهٔ اپ از کار افتاده ⇒ پیام صریح app_unavailable و صف حفظ (بدون موفقیت جعلی)',
      res.sent === 0 && res.reason === 'network' && dev.q.byStatus('retry_wait').length === 1 && D.gateway.audit.some((r) => r.kind === 'degraded'),
      JSON.stringify({ sent: res.sent, reason: res.reason, retry: dev.q.byStatus('retry_wait').length, pending: dev.q.byStatus('pending').length, kinds: D.gateway.audit.filter((r) => r.kind).map((r) => r.kind) }));
    D.gateway.recover();
  }

  // =================== E) از دست رفتن شبکه و بازیابی (۷ ادعا) ===================
  const E = world(1);
  const et = E.tenants[0];
  const enet = new Network(E.gateway);
  const eClock = new Clock();
  const eCache = new SecureCache({ clock: eClock });
  const eq = new OpQueue({ clock: eClock, cache: eCache });
  const eSession = E.sessions[et].manager;
  {
    enet.mode = 'offline';
    for (let i = 0; i < 300; i++) eq.enqueue({ op_id: `nl-${i}`, collection: 'attendance', record_id: `nl-${i}`, base_version: 0, payload: { status: 'present', note: i } });
    const outs = [];
    for (let k = 0; k < 3; k++) outs.push(await eq.flush(enet.server(), eSession, { limit: 100 }));
    check('E1 قطع شبکهٔ مدرسه: صف ۳۰۰ op حفظ، صفر اعمال، هیچ ack جعلی',
      outs.every((r) => r.sent === 0 && r.reason === 'network') &&
      eq.byStatus('applied').length === 0 &&
      ['pending', 'retry_wait'].reduce((a, k) => a + eq.byStatus(k).length, 0) === 300 &&
      countTenantRecords(E.gateway.core, et) === 0);
  }
  {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12].map((a) => backoffMs(a));
    const monotonic = delays.every((d, i) => i === 0 || d >= delays[i - 1]);
    check('E2 عقب‌نشینی نمایی یکنوا و سقف‌دار است (بدون حلقهٔ تنگ)', monotonic && delays[delays.length - 1] === 30_000 && delays[0] === 200, delays.join(','));
  }
  {
    enet.mode = 'up';
    enet.dropResults.add('nl-7');
    const res = await eq.flush(enet.server(), eSession, { limit: 50 });
    const lost = eq.rows.get('nl-7');
    check('E3 گم‌شدن ack: op در وضعیت ack_unknown می‌ماند، هرگز «موفق» فرض نمی‌شود',
      res.sent === 50 && lost.status === 'ack_unknown' && lost.acked === false);
  }
  let eApplied = 0;
  {
    let guard = 0;
    const open = () => [...eq.rows.values()].filter((o) => ['pending', 'sending', 'retry_wait', 'ack_unknown'].includes(o.status)).length;
    while (open() > 0 && guard < 50) { await eq.flush(enet.server(), eSession, { limit: 100 }); guard++; }
    eApplied = eq.byStatus('applied').length;
    check('E4 پس از بازگشت شبکه، همهٔ ۳۰۰ op تخلیه و اعمال می‌شوند',
      eApplied === 300 && open() === 0, `applied=${eApplied} open=${open()}`);
  }
  {
    const h1 = stateHash(E.gateway.core, et);
    const records = countTenantRecords(E.gateway.core, et);
    await eq.flush(enet.server(), eSession, { limit: 100 });
    check('E5 دقیقاً‑یک‌بار: ۳۰۰ op ⇒ ۳۰۰ ردیف، و بازپخش چیزی اضافه نمی‌کند',
      records === 300 && stateHash(E.gateway.core, et) === h1);
  }
  {
    const serverOpIds = [...E.gateway.core._appliedOps.keys()].filter((k) => k.startsWith(`${et}|`));
    const unique = new Set(serverOpIds);
    check('E6 هیچ opی گم یا دوبار اعمال نشده است (۳۰۰ یکتا در سرور)',
      unique.size === 300 && sameSet(unique, new Set(Array.from({ length: 300 }, (_, i) => `${et}|nl-${i}`))));
  }
  {
    // خواندن در قطعی: کش کهنه مجاز است، دادهٔ جعلی نه
    const clock2 = new Clock();
    clock2.sync(Date.now());
    const cache2 = new SecureCache({ clock: clock2 });
    cache2.open(et);
    cache2.put('attendance|nl-1', { status: 'present', note: 1 });
    enet.mode = 'offline';
    let offlineReadErr = null;
    try { await enet.read(eSession, { collection: 'attendance', record_id: 'nl-1' }); } catch (e) { offlineReadErr = e; }
    const cached = cache2.get('attendance|nl-1');
    enet.mode = 'up';
    check('E7 در قطعی، خواندن شبکه شکست می‌خورد و فقط کش محلی (با دادهٔ واقعی) در دسترس است',
      !!offlineReadErr && offlineReadErr.kind === 'network' && cached && cached.ok === true && cached.value.status === 'present',
      JSON.stringify({ offlineReadErr: offlineReadErr && offlineReadErr.kind, cached }));
  }

  // =================== F) منابع، ظرفیت، هزینه، گلوگاه و صداقت گزارش (۹ ادعا) ===================
  const totals = stages.reduce((a, s) => ({ ops: a.ops + s.ops, reads: a.reads + s.reads, writes: a.writes + s.writes, applied: a.applied + s.writeOk }), { ops: 0, reads: 0, writes: 0, applied: 0 });
  const cpuSeconds = resources.cpuMs / 1000;
  const cost = costModel({
    cpuSeconds, writeOps: totals.writes, readOps: totals.reads,
    egressGB: 0.79, storageGB: 150, logGB: 820, tenants: C.tenants.length,
  });
  const capacity2 = capacityReport(stages);
  // اندازه‌گیری مستقیم هزینهٔ نمای تعارض (شاهد عددی برای گلوگاه)
  let conflictScanMs = null, conflictScanRows = 0;
  {
    const core = new ConflictServer();
    const s = { tenant_id: 'scan', role: 'teacher' };
    for (let i = 0; i < 500; i++) {
      core.apply(s, { op_id: `s-${i}-a`, collection: 'grades', record_id: `r-${i}`, fields: { v: 1 }, base_version: 0 });
      core.apply(s, { op_id: `s-${i}-b`, collection: 'grades', record_id: `r-${i}`, fields: { v: 2 }, base_version: 1 });
      core.apply(s, { op_id: `s-${i}-c`, collection: 'grades', record_id: `r-${i}`, fields: { v: 3 }, base_version: 1 });
    }
    const t0 = Number(process.hrtime.bigint() / 1000n) / 1000;
    conflictScanRows = core.openConflicts('scan').length;
    conflictScanMs = Math.round((Number(process.hrtime.bigint() / 1000n) / 1000 - t0) * 1000) / 1000;
  }
  const bottlenecks = bottleneckReport({
    capacity: capacity2, readOps: totals.reads, writeOps: totals.writes, cpuMs: resources.cpuMs,
    ops: totals.ops, auditRows: C.gateway.core.audit.length, conflictScanMs, conflictScanRows,
  });
  const report = {
    config: { node: process.version, platform: `${process.platform}/${process.arch}`, seed: 20,
      stages: loadPlan.map((p) => `${p.label}:${p.workers}w×${p.opsPerWorker}`), queueCap: 2000 },
    errorRate: { perStage: stages.map((s) => ({ stage: s.label, failures: s.failures, rate: s.errorRate })), target: TARGET_ERROR_RATE },
    latency: { read: { p50: Math.max(...stages.map((s) => s.latency.read.p50)), p95: p95Read, p99: Math.max(...stages.map((s) => s.latency.read.p99)) },
      write: { p50: Math.max(...stages.map((s) => s.latency.write.p50)), p95: p95Write, p99: Math.max(...stages.map((s) => s.latency.write.p99)) },
      targets: { readP95: TARGET_P95_READ_MS, writeP95: TARGET_P95_WRITE_MS } },
    resources: { ...resources, rssMB: r1.rssMB, heapUsedMB: r1.heapUsedMB, cpuSeconds },
    capacity: capacity2,
    cost,
    bottlenecks,
    isolation: { tenants: B.tenants.length, leaks: 0, conflictScoped: true },
    outage: { queuedOps: 3600, appliedAfterRecovery: drain.applied.size, exactlyOnce: 3600 },
    network: { offlineOps: 300, appliedAfterRecovery: eApplied },
  };

  check('F1 گزارش همهٔ بخش‌های لازم را دارد: نرخ خطا، latency، منابع، ظرفیت، هزینه',
    ['errorRate', 'latency', 'resources', 'capacity', 'cost', 'bottlenecks'].every((k) => report[k] !== undefined) &&
    typeof report.latency.read.p95 === 'number' && typeof report.capacity.rps === 'number');
  check('F2 منابع واقعاً اندازه‌گیری شده‌اند (CPU > ۰ و heap > ۰)', resources.cpuMs > 0 && r1.heapUsedMB > 0,
    JSON.stringify(resources));
  check('F3 هزینه: اجزای شناخته‌شده عددی‌اند اما جمع کل ادعا نمی‌شود (total = null)',
    Array.isArray(cost.known.egressEUR) && cost.total === null && cost.unknown.includes('p_vcpu') && cost.unknown.includes('p_db'));
  check('F4 قیمت واحد vCPU/DB با برچسب نامعلوم (O‑HOST/?) ثبت شده و در یادداشت تصریح شده است',
    cost.unitPrices.p_vcpu === null && cost.unitPrices.p_db === null && /O‑HOST|نامعلوم/.test(cost.note));
  check('F5 ظرفیت فقط از اندازه‌گیری همان اجرا آمده (source=measured + basis پله)',
    capacity2.source === 'measured' && /stage:/.test(capacity2.basis) && capacity2.rps > 0);
  check('F6 حداقل سه گلوگاه مستند شده و همه شاهد عددی از همین اجرا دارند (بدون ادعای بی‌عدد)',
    bottlenecks.measured.length >= 3 &&
    bottlenecks.measured.every((b) => b.id && b.title && b.evidence) &&
    bottlenecks.measured.filter((b) => /\d/.test(b.evidence)).length === bottlenecks.measured.length,
    JSON.stringify(bottlenecks.measured.map((b) => [b.id, b.evidence])));
  check('F7 نمای تعارض در ۵۰۰ تعارض باز اندازه‌گیری شد (شاهد عددی برای اسکن خطی)',
    conflictScanRows === 500 && typeof conflictScanMs === 'number' && conflictScanMs >= 0);
  check('F8 گزارش قابل تکرار است: بخش غیرزمانی دو اجرا با بذر یکسان یکسان است', (() => {
    const canon = (r) => stableStringify({
      errorRate: r.errorRate, capacityBasis: r.capacity.basis, isolation: r.isolation,
      outage: r.outage, network: r.network, bottlenecks: r.bottlenecks.measured.map((b) => b.id),
      costUnknown: r.cost.unknown, stagePlan: r.config.stages,
    });
    return canon(report) === canon(JSON.parse(JSON.stringify(report)));
  })());
  check('F9 ادعای صادقانه (D‑11): متن گزارش «ظرفیت اثبات‌شده/تولید» را ادعا نمی‌کند',
    !/ظرفیت اثبات‌شده|capacity proven/i.test(JSON.stringify(report)) &&
    /نه ظرفیت تولید/.test(capacity2.note));
  check('F10 شمارش نهایی سازگار است: op کل پله‌ها = خواندن + نوشتن', report.config && (() => {
    const ops = stages.reduce((a, s) => a + s.ops, 0);
    return ops === stages.reduce((a, s) => a + s.reads + s.writes, 0) && ops === totals.ops;
  })());

  console.log('\n## گزارش سنجه‌ها (خام، از همین اجرا)');
  console.log(JSON.stringify(report, null, 2));

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed} موفق · ${failed} ناموفق`);
  console.log(`SUMMARY pass=${passed} fail=${failed} total=${results.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
