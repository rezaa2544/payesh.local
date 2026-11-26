#!/usr/bin/env node
'use strict';
/* ردیف ۱۹۲ — بخش «اشتراک» بی‌عیب: کاربر همهٔ پرداخت‌هایش (با نتیجه و دلیل رد/لغو) و همهٔ
   اشتراک‌های خریداری‌شده‌اش را می‌بیند؛ مالک همان دفتر را در گزارش مدرسه (ack) می‌گیرد.
   اجرا: node --experimental-sqlite tests/sub-192.js */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const sr = require(path.join(ROOT, 'server', 'school-registry.js'));
const { openStore } = require(path.join(ROOT, 'server', 'db.js'));

const DAY = 24 * 3600_000;
let passed = 0; let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub192-'));
let n = 0;
function school(settings = {}) {
  const st = openStore(path.join(dir, `db-${++n}.sqlite`));
  st.setMeta('schools:registry', { rev: 1, plain: { v: 1, schools: [{ id: 's-192', name: 'دبستان آزادی', active: true }], settings: Object.assign({ roles: { manager: 'required', teacher: 'free' } }, settings), grants: [], decisions: {} } });
  st.setMeta('schools:bound', { school_id: 's-192' });
  const mgr = st.insert('users', { name: 'مدیر', role: 'manager', active: true });
  const other = st.insert('users', { name: 'مدیر دیگر', role: 'manager', active: true });
  const teacher = st.insert('users', { name: 'دبیر', role: 'teacher', active: true });
  return { st, mgr, other, teacher };
}
function decide(st, decisions = {}, grants = []) {
  const reg = st.getMeta('schools:registry');
  reg.plain.decisions = Object.assign({}, reg.plain.decisions, decisions);
  reg.plain.grants = (reg.plain.grants || []).concat(grants);
  st.setMeta('schools:registry', reg);
  return sr.applyOwner(st, reg.plain);
}

(async () => {
  await check('SUB192-01 بدون اشتراک ⇒ گزارش خالی ولی صفحه کار می‌کند (status none، plans)', async () => {
    const { st, mgr } = school();
    const h = sr.history(st, mgr);
    assert.strictEqual(h.ok, true);
    assert.strictEqual(h.sub.status, 'none');
    assert.strictEqual(h.sub.plans.length, 2);
    assert.deepStrictEqual(h.payments, []);
    assert.deepStrictEqual(h.periods, []);
  });

  await check('SUB192-02 رسید ⇒ در انتظار تأیید مالک؛ تأیید ⇒ پرداخت «paid» با بازهٔ اشتراک و یک اشتراک «جاری»', async () => {
    const { st, mgr } = school();
    const r = await sr.submitReceipt(st, mgr, 'monthly', 'REF-1001');
    assert.strictEqual(r.ok, true);
    let h = sr.history(st, mgr);
    assert.strictEqual(h.payments.length, 1);
    assert.strictEqual(h.payments[0].status, 'pending');
    assert.strictEqual(h.payments[0].awaiting_owner, true);
    assert.strictEqual(h.payments[0].ref, 'REF-1001');
    decide(st, { [r.payment.id]: { status: 'approved' } });
    h = sr.history(st, mgr);
    assert.strictEqual(h.sub.access, true);
    const p = h.payments[0];
    assert.strictEqual(p.status, 'paid');
    assert.ok(p.paid_at && p.period_start && p.period_end, 'paid_at + period');
    assert.strictEqual(p.period_end, h.sub.end);
    assert.strictEqual(h.periods.length, 1);
    assert.strictEqual(h.periods[0].kind, 'paid');
    assert.strictEqual(h.periods[0].state, 'current');
    assert.strictEqual(h.periods[0].payment, p.id);
    assert.strictEqual(h.periods[0].amount, p.amount);
    /* هیچ دادهٔ داخلی بیرون نمی‌رود */
    for (const k of ['uid', 'gateway_params', 'unreported', 'approved_by', 'flag']) assert.ok(!(k in p), k);
  });

  await check('SUB192-03 رد ⇒ کاربر «رد شد» و دلیل را می‌بیند (پیش‌تر بی‌صدا از فهرست حذف می‌شد)', async () => {
    const { st, mgr } = school();
    const r = await sr.submitReceipt(st, mgr, 'yearly', 'REF-2002');
    decide(st, { [r.payment.id]: { status: 'rejected', reason: 'مبلغ واریز کم است' } });
    const h = sr.history(st, mgr);
    assert.strictEqual(h.sub.pending.length, 0);
    assert.strictEqual(h.payments[0].status, 'rejected');
    assert.strictEqual(h.payments[0].reason, 'مبلغ واریز کم است');
    assert.strictEqual(h.payments[0].awaiting_owner, false);
    assert.deepStrictEqual(h.periods, []);
  });

  await check('SUB192-04 آزمایشی + خرید + تمدید پیش از پایان + هدیه ⇒ همهٔ اشتراک‌ها، تازه‌ترین بالا؛ تمدید از پایان قبلی', async () => {
    const { st, mgr } = school();
    /* آزمایشی بی‌صندوقچه ممکن نیست ⇒ همان رکوردی که startTrial می‌سازد */
    const now = Date.now();
    const state = sr.subsState(st);
    state.users[String(mgr.id)] = { status: 'trial', plan: 'trial', start: new Date(now - 3 * DAY).toISOString(), end: new Date(now + 4 * DAY).toISOString(), trial_used: true, role: 'manager', rule: 'ay-v1',
      log: [{ at: new Date(now - 3 * DAY).toISOString(), kind: 'trial', plan: 'trial', start: new Date(now - 3 * DAY).toISOString(), end: new Date(now + 4 * DAY).toISOString(), days: 7 }] };
    st.setMeta('sub:state', state);
    const a = await sr.submitReceipt(st, mgr, 'monthly', 'REF-3003');
    decide(st, { [a.payment.id]: { status: 'approved' } });
    const b = await sr.submitReceipt(st, mgr, 'monthly', 'REF-3004');
    decide(st, { [b.payment.id]: { status: 'approved' } });
    decide(st, {}, [{ id: 'g-1', school_id: 's-192', user_id: mgr.id, kind: 'gift', days: 10 }]);
    const h = sr.history(st, mgr);
    assert.deepStrictEqual(h.periods.map(x => x.kind).sort(), ['gift', 'paid', 'paid', 'trial']);
    const paid = h.payments.filter(p => p.status === 'paid');
    assert.strictEqual(paid.length, 2);
    /* خرید دوم از پایان خرید اول شروع می‌شود (تمدید، نه هم‌پوشانی) */
    const first = paid.find(p => p.id === a.payment.id); const second = paid.find(p => p.id === b.payment.id);
    assert.ok(Date.parse(second.period_start) >= Date.parse(first.period_start), 'renewal starts later');
    assert.strictEqual(second.period_start, first.period_end);
    for (let i = 1; i < h.periods.length; i++) assert.ok(String(h.periods[i - 1].start) >= String(h.periods[i].start), 'newest first');
    assert.strictEqual(h.payments[0].id, b.payment.id, 'payments newest first');
  });

  await check('SUB192-05 لغو پرداخت تأییدشده ⇒ پرداخت «لغو» با دلیل، اشتراکش «لغو شده»، دسترسی بسته', async () => {
    const { st, mgr } = school();
    const a = await sr.submitReceipt(st, mgr, 'yearly', 'REF-4004');
    decide(st, { [a.payment.id]: { status: 'approved' } });
    decide(st, { [a.payment.id]: { status: 'cancelled', reason: 'بازگشت وجه' } });
    const h = sr.history(st, mgr);
    assert.strictEqual(h.sub.access, false);
    assert.strictEqual(h.payments[0].status, 'cancelled');
    assert.strictEqual(h.payments[0].reason, 'بازگشت وجه');
    assert.strictEqual(h.periods.length, 1);
    assert.strictEqual(h.periods[0].state, 'cancelled');
  });

  await check('SUB192-06 بازنشانی مالک ⇒ اشتراک پاک، ولی تاریخچه می‌ماند و trial_used هم', async () => {
    const { st, mgr } = school();
    const a = await sr.submitReceipt(st, mgr, 'monthly', 'REF-5005');
    decide(st, { [a.payment.id]: { status: 'approved' } });
    decide(st, {}, [{ id: 'r-1', school_id: 's-192', user_id: mgr.id, kind: 'reset' }]);
    const h = sr.history(st, mgr);
    assert.strictEqual(h.sub.status, 'none');
    assert.strictEqual(h.sub.access, false);
    assert.strictEqual(h.periods.length, 1, 'the bought month is still listed');
    assert.strictEqual(h.payments.length, 1);
    assert.strictEqual(sr.gate(st, mgr).trial_available, true, 'no trial was used');
    const rec = sr.subsState(st).users[String(mgr.id)];
    assert.strictEqual(rec.log[rec.log.length - 1].kind, 'reset');
  });

  await check('SUB192-07 فقط دادهٔ خودِ کاربر — پرداخت مدیر دیگر دیده نمی‌شود', async () => {
    const { st, mgr, other } = school();
    await sr.submitReceipt(st, other, 'monthly', 'REF-6006');
    assert.strictEqual(sr.history(st, mgr).payments.length, 0);
    assert.strictEqual(sr.history(st, other).payments.length, 1);
  });

  await check('SUB192-08 نقش رایگان ⇒ status free ولی تاریخچهٔ پیشین در دسترس', async () => {
    const { st, mgr } = school();
    const a = await sr.submitReceipt(st, mgr, 'monthly', 'REF-7007');
    decide(st, { [a.payment.id]: { status: 'approved' } });
    const reg = st.getMeta('schools:registry'); reg.plain.settings.paywall_enabled = false; st.setMeta('schools:registry', reg);
    const h = sr.history(st, mgr);
    assert.strictEqual(h.sub.status, 'free');
    assert.strictEqual(h.payments.length, 1);
    assert.strictEqual(h.periods.length, 1);
  });

  await check('SUB192-09 دادهٔ پیش از ۱۹۲ (بی‌دفتر): پرداخت تأییدشده و آزمایشی هم در «همهٔ اشتراک‌ها»', async () => {
    const { st, mgr } = school();
    const now = Date.now();
    const state = sr.subsState(st);
    state.payments.push({ id: 'SUB-OLD00001', uid: mgr.id, role: 'manager', plan: 'yearly', months: 12, amount: 2200000, method: 'receipt', status: 'paid', ref: 'OLD-1', created_at: new Date(now - 40 * DAY).toISOString(), paid_at: new Date(now - 39 * DAY).toISOString() });
    state.users[String(mgr.id)] = { status: 'active', plan: 'yearly', start: new Date(now - 39 * DAY).toISOString(), end: new Date(now + 100 * DAY).toISOString(), trial_used: true, rule: 'ay-v1' };
    st.setMeta('sub:state', state);
    const h = sr.history(st, mgr);
    assert.strictEqual(h.periods.length, 1);
    assert.strictEqual(h.periods[0].payment, 'SUB-OLD00001');
    assert.strictEqual(h.periods[0].start, state.payments[0].paid_at);
  });

  await check('SUB192-10 گزارش مدرسه به مالک (ack) دفتر اشتراک هر کاربر را دارد', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'school-registry.js'), 'utf8');
    assert.match(src, /subs\.push\(\{[^\n]*log \}\)/);
  });

  await check('SUB192-11 /api/sub/history پیش از دیوار ۴۰۲ است (کاربر منقضی هم گزارشش را می‌بیند)', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    const h = src.indexOf("p === '/api/sub/history'");
    const wall = src.indexOf("'subscription_required'");
    assert.ok(h > 0 && wall > 0 && h < wall);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`SUB-192 passed=${passed}/${passed + failed}`);
  process.exit(failed ? 1 : 0);
})();
