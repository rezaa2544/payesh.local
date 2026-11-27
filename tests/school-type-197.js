#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 197 — Q07 (F31, F32, F33, F37): the school type has a REAL effect, a board of
   trustees («هیئت امنا») and voluntary contributions («کمک داوطلبانه»), and the
   tuition of نمونه دولتی / شاهد is fixed.

     T01  tuition only in غیرانتفاعی: profile save of a public type with has_tuition ⇒
          tuition_public; نمونه دولتی/شاهد/شبانه‌روزی/هنرستان no longer turn tuition on
     T02  stale data: a stored public school with has_tuition reads as tuition 0, and its
          features have no «tuition» but do have «trustees»
     T03  features follow the caps (the app's menus): iep/dorm/workshop/multigrade/evening
     T04  the manager records a voluntary contribution; shape errors are refused; a
          «tuition» row in a public school ⇒ tuition_public; in a غیرانتفاعی it is accepted
     T05  board of trustees: members (post from the list) and meetings with resolutions;
          refused in a غیرانتفاعی (feature_off); bad shapes refused
     T06  only the manager: teacher/parent/staff/office/guard cannot write or pull them
     T07  cloud scope mirrors the shape checks and keeps them manager-only
     T08  owner registry: a public school_type from the owner panel drops has_tuition
     T09  negative control: switching the school to غیرانتفاعی turns trustees off and
          tuition on (the same row flips its verdict)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
const pending = [];
function check(id, desc, fn) {
  pending.push(async () => {
    try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
    catch (e) { failed++; console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); }
  });
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const J = (x) => JSON.stringify(x);

const policy = require(path.join(ROOT, 'server/policy'));
const scope = require(path.join(ROOT, 'server/scope'));
const sync = require(path.join(ROOT, 'server/sync'));
const sp = require(path.join(ROOT, 'server/school-profile'));
const fin = require(path.join(ROOT, 'server/school-finance'));
const sr = require(path.join(ROOT, 'server/school-registry'));
const { openStore } = require(path.join(ROOT, 'server/db'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stype197-'));
const st = openStore(path.join(TMP, 'a.sqlite'));
st.insert('schools', { name: 'نمونه', level: 'متوسطه اول', gender: 'پسرانه', school_type: 'exemplary',
  capabilities: { has_tuition: 1, has_second_term_exam: 1 } }, { id: 1 });
const mgr = st.insert('users', { name: 'مدیر', role: 'manager', active: true });
st.insert('classes', { name: 'هفتم' }, { id: 10 });
const s1 = st.insert('users', { name: 'سارا', role: 'student', class_id: 10, active: true });
const par = st.insert('users', { name: 'ولی', role: 'parent', active: true });
st.insert('parent_links', { parent_id: par.id, student_id: s1.id });
const teacher = st.insert('users', { name: 'دبیر', role: 'teacher', active: true });
const staff = st.insert('users', { name: 'کارمند', role: 'staff', active: true, access: [] });
const office = st.insert('users', { name: 'اجرایی', role: 'office', active: true, access: [] });
const guard = st.insert('users', { name: 'نگهبان', role: 'guard', active: true, access: [] });

const today = new Date().toISOString().slice(0, 10);
let seq = 0;
const op = (collection, data, extra) => Object.assign({ uid: `t197-${++seq}`, collection, type: 'put', data }, extra || {});
const actor = (id) => { const u = st.get('users', id); return { user: u, role: policy.permRole(u.role), device: null }; };
const push = (id, ops) => sync.push(st, actor(id), { ops });
const gift = (extra) => Object.assign({ kind: 'voluntary', payer: 'ولی سارا', amount: 5000000, date: today,
  purpose: 'خرید پروژکتور', student_id: s1.id, receipt_no: 'R-12' }, extra || {});
const member = (extra) => Object.assign({ kind: 'member', name: 'آقای احمدی', post: 'رئیس', phone: '09120000000' }, extra || {});
const meeting = (extra) => Object.assign({ kind: 'meeting', date: today, title: 'جلسهٔ اول هیئت امنا',
  decisions: '۱) تعمیر سرویس بهداشتی از محل کمک‌های داوطلبانه' }, extra || {});
const profileBody = (school_type, caps) => ({ level: 'متوسطه اول', gender: 'پسرانه', school_type, shift: 'صبح',
  work_days: [0, 1, 2, 3, 4], excuse_window_minutes: 15, capabilities: caps });

check('T01', 'tuition only in غیرانتفاعی; نمونه دولتی/شاهد no longer turn it on', () => {
  for (const t of ['governmental', 'exemplary', 'shahed', 'boarding', 'vocational', 'kardanesh', 'adult']) {
    const r = sp.validateProfile(profileBody(t, { has_tuition: 1 }));
    assert(r.error === 'tuition_public', t + ' ' + J(r));
    assert(!sp.TYPE_CAPS[t].includes('has_tuition'), t + ' type turns tuition on');
  }
  const ok = sp.validateProfile(profileBody('non_profit', { has_tuition: 1 }));
  assert(ok.patch && ok.patch.capabilities.has_tuition === 1, 'non_profit ' + J(ok));
  assert(sp.SCHOOL_TYPES.length === 13 && ['kardanesh', 'adult', 'quranic', 'minority'].every(t => sp.SCHOOL_TYPES.includes(t)), 'types');
  return '7 public types tuition_public, non_profit ok, 13 types';
});

check('T02', 'stale public school with has_tuition reads tuition 0; trustees on, tuition off', () => {
  const p = sp.profileOf(st.get('schools', 1));
  assert(p.capabilities.has_tuition === 0 && p.public_school === true, J(p.capabilities));
  assert(J(p.features) === J(['contributions', 'trustees']), J(p.features));
  return J(p.features);
});

check('T03', 'features follow the caps (menus on/off)', () => {
  const f = (t, c) => J(fin.schoolFeatures({ school_type: t, capabilities: c }));
  assert(f('exceptional', { has_iep: 1 }) === J(['contributions', 'trustees', 'iep']), 'iep');
  assert(f('exceptional', {}) === J(['contributions', 'trustees']), 'iep off ⇒ no menu');
  assert(f('non_profit', { has_tuition: 1, has_dorm: 1, has_workshop: 1, has_multigrade: 1, has_evening: 1 }) ===
    J(['contributions', 'tuition', 'dorm', 'workshop', 'multigrade', 'evening']), 'all');
  return 'iep on/off, all five';
});

check('T04', 'manager records voluntary contributions; tuition rows refused in a public school', () => {
  const r = push(mgr.id, [op('contributions', gift()), op('contributions', gift({ payer: 'خیّر محله', student_id: null, amount: 120000000 }))]);
  assert(r.applied.length === 2, J(r));
  const bad = push(mgr.id, [
    op('contributions', gift({ amount: 0 })),
    op('contributions', gift({ amount: 12.5 })),
    op('contributions', gift({ payer: ' ' })),
    op('contributions', gift({ date: '1405/09/01' })),
    op('contributions', gift({ kind: 'fee' })),
    op('contributions', gift({ required: true })),
    op('contributions', gift({ kind: 'tuition' })),
  ]);
  assert(bad.rejected.map(x => x.error).join() === 'amount,amount,payer,bad_date,bad_kind,voluntary_required,tuition_public', J(bad.rejected));
  return '2 applied; amount,amount,payer,bad_date,bad_kind,voluntary_required,tuition_public';
});

check('T05', 'board of trustees: members and meetings; bad shapes refused', () => {
  const r = push(mgr.id, [op('trustees', member()), op('trustees', member({ name: 'خانم کریمی', post: 'دبیر' })), op('trustees', meeting())]);
  assert(r.applied.length === 3, J(r));
  const bad = push(mgr.id, [
    op('trustees', member({ name: '' })),
    op('trustees', member({ post: 'سلطان' })),
    op('trustees', meeting({ title: '' })),
    op('trustees', meeting({ date: 'x' })),
    op('trustees', { kind: 'party' }),
  ]);
  assert(bad.rejected.map(x => x.error).join() === 'member_name,member_post,meeting_title,bad_date,bad_kind', J(bad.rejected));
  return '3 applied; 5 refused';
});

check('T06', 'only the manager writes or pulls contributions and trustees', () => {
  for (const u of [teacher, par, staff, office, guard, s1]) {
    const r = push(u.id, [op('contributions', gift()), op('trustees', member())]);
    assert(r.applied.length === 0 && r.rejected.every(x => x.error === 'role_denied'), u.role + ' ' + J(r));
    const p = sync.pull(st, actor(u.id), {});
    assert(!(p.collections.contributions || []).length && !(p.collections.trustees || []).length, u.role + ' pulled');
  }
  const m = sync.pull(st, actor(mgr.id), {});
  assert((m.collections.contributions || []).length === 2 && (m.collections.trustees || []).length === 3, 'manager pull');
  return '6 roles denied; manager pulls 2 + 3';
});

check('T07', 'cloud scope: shape checks and manager-only', async () => {
  const cs = await scope.build({ query: async () => ({ rows: [] }) }, { role: 'office', uid: 9 });
  assert(!scope.canWriteCollection(cs, 'contributions') && !scope.canWriteCollection(cs, 'trustees'), 'office cloud');
  assert(!scope.rowInScope(cs, 'contributions', gift()) && !scope.rowInScope(cs, 'trustees', member()), 'rowInScope');
  const all = { all: true, role: 'manager' };
  assert(scope.canWriteRow(all, 'contributions', gift()).ok && scope.canWriteRow(all, 'contributions', gift({ amount: -1 })).error === 'amount', 'cloud gift');
  assert(scope.canWriteRow(all, 'trustees', member({ post: 'x' })).error === 'member_post', 'cloud trustee');
  assert(policy.collectionAllowed('contributions') && policy.collectionAllowed('trustees'), 'allowed');
  return 'office denied, shapes checked';
});

check('T08', 'owner registry: public school_type drops has_tuition', () => {
  const s = openStore(path.join(TMP, 'b.sqlite'));
  s.insert('schools', { name: 'قدیم', code: '1', level: 'متوسطه اول', county: 'نیشابور', school_type: 'non_profit', capabilities: { has_tuition: 1 }, gender: 'دخترانه' }, { id: 1 });
  s.setMeta('schools:bound', { school_id: 's-0197', manager_rev: 5, username: 'm.x', owner_profile: { school_type: 'non_profit' } });
  sr.applySchool(s, { id: 's-0197', name: 'قدیم', code: '1', county: 'نیشابور', school_type: 'shahed', manager: { rev: 5 } });
  const s1 = s.get('schools', 1);
  s.close();
  assert(s1.school_type === 'shahed' && !s1.capabilities.has_tuition, J(s1));
  return 'shahed, has_tuition ' + s1.capabilities.has_tuition;
});

check('T09', 'negative control: غیرانتفاعی flips the verdicts', () => {
  st.update('schools', 1, { school_type: 'non_profit', capabilities: { has_tuition: 1 } });
  const r = push(mgr.id, [op('contributions', gift({ kind: 'tuition' })), op('trustees', meeting())]);
  assert(r.applied.length === 1 && r.rejected[0].error === 'feature_off', J(r));
  assert(J(sp.profileOf(st.get('schools', 1)).features) === J(['contributions', 'tuition']), 'features');
  st.update('schools', 1, { school_type: 'exemplary', capabilities: { has_tuition: 0 } });
  return 'tuition accepted, trustees feature_off';
});

(async () => {
  for (const p of pending) await p();
  try { st.db.close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (!failed) console.log('SCHOOL-TYPE-197-OK');
  process.exit(failed ? 1 : 0);
})();
