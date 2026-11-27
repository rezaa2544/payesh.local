#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 197 — Q06 (F41, F42, F44, F38): staff posts get their REAL default work,
   «دسترسی ندارید» is an explicit choice, and the guard keeps the gate.

     R01  no ticks ⇒ the post default: کارمند attendance/leaves/notices, اجرایی also
          grades/classes/reports, نگهبان only the gate (visitors) — the server enforces it
     R02  stored value: [] = default, ['none'] = nothing, unknown-only = nothing (fail-closed)
     R03  the guard records a visitor (in, then out); bad rows are refused; other roles cannot
     R04  pull: the guard gets visitors and TODAY'S leaves without reason / certificate;
          اجرایی (leaves area) still gets the whole leave; parents never get visitors
     R05  an explicit tick replaces the default (guard + «مرخصی‌ها» ⇒ full leaves)
     R06  cloud scope mirrors it: default grant, visitor shape check, leave reduced in the feed
     R07  negative control: with the default switched off (['none']) every gate write fails
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

const policy = require(path.join(ROOT, 'server/policy'));
const scope = require(path.join(ROOT, 'server/scope'));
const sync = require(path.join(ROOT, 'server/sync'));
const tenancy = require(path.join(ROOT, 'server/tenancy'));
const { openStore } = require(path.join(ROOT, 'server/db'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roles197-'));
const st = openStore(path.join(TMP, 'a.sqlite'));
const mgr = st.insert('users', { name: 'مدیر', role: 'manager', active: true });
st.insert('classes', { name: 'دهم' }, { id: 10 });
const s1 = st.insert('users', { name: 'سارا', role: 'student', class_id: 10, active: true });
const par = st.insert('users', { name: 'ولی', role: 'parent', active: true });
st.insert('parent_links', { parent_id: par.id, student_id: s1.id });
const today = new Date().toISOString().slice(0, 10);
const cert = 'data:image/png;base64,iVBORw0KGgo=';
const leave = st.insert('leaves', { student_id: s1.id, date: today, kind: 'hours', time_from: '10:00', time_to: '12:00',
  type: 'sick', reason: 'دکتر', attachment: cert, status: 'approved' });

let seq = 0;
const op = (collection, data, extra) => Object.assign({ uid: `r197-${++seq}`, collection, type: 'put', data }, extra || {});
const actor = (id) => { const u = st.get('users', id); return { user: u, role: policy.permRole(u.role), device: null }; };
const managerSaves = (data, id) => sync.push(st, actor(mgr.id), {
  ops: [op('users', data, id != null ? { id, base_version: st.get('users', id)._version } : {})],
});
const make = (name, role, phone, access) => managerSaves(Object.assign({ name, role, active: true, phone }, access === undefined ? {} : { access })).applied[0].id;
const staff = make('کارمند', 'staff', '09120001971', []);
const office = make('اجرایی', 'office', '09120001972');
const guard = make('نگهبان', 'guard', '09120001973');
const visitor = (extra) => Object.assign({ name: 'آقای رضایی', phone: '0912', reason: 'پیگیری پرونده', host: 'معاون',
  date: today, in_at: new Date().toISOString() }, extra || {});

check('R01', 'no ticks ⇒ the real default of each post, enforced by the server', () => {
  assert(JSON.stringify(st.get('users', staff).access) === '[]', 'stored ' + JSON.stringify(st.get('users', staff).access));
  const a = sync.push(st, actor(staff), { ops: [
    op('attendance', { student_id: s1.id, class_id: 10, date: today, status: 'absent' }),
    op('announcements', { title: 'جلسه', body: 'ساعت ۱۰' }),
    op('grades', { student_id: s1.id, class_id: 10, score: 18 }),
    op('visitors', visitor()),
  ] });
  assert(a.applied.length === 2, 'staff applied ' + JSON.stringify(a));
  assert(a.rejected.map(x => x.error).join() === 'role_denied,role_denied', 'staff rejected ' + JSON.stringify(a.rejected));
  const o = sync.push(st, actor(office), { ops: [
    op('grades', { student_id: s1.id, class_id: 10, score: 17, kind: 'monthly' }),
    op('subjects', { name: 'ریاضی' }),
    op('visitors', visitor()),
  ] });
  assert(o.applied.length === 2 && o.rejected[0].error === 'role_denied', 'office ' + JSON.stringify(o));
  const g = sync.push(st, actor(guard), { ops: [
    op('attendance', { student_id: s1.id, class_id: 10, date: today, status: 'late' }),
    op('announcements', { title: 'x', body: 'y' }),
  ] });
  assert(g.applied.length === 0, 'guard wrote outside the gate ' + JSON.stringify(g));
  assert(JSON.stringify(policy.staffAccessOf('guard', null)) === '["gate"]', 'guard default');
  assert(policy.staffAccessOf('counselor', []).length === 0 && policy.staffAccessOf('vice', []).length === 0, 'counselor/vice');
  return 'staff 2/4, office 2/3, guard 0/2 outside the gate';
});

check('R02', 'stored access: [] default · [none] nothing · unknown-only nothing', () => {
  const t = (a) => JSON.stringify(policy.accessToStore('staff', a));
  assert(t([]) === '[]' && t(undefined) === '[]' && t('') === '[]', 'empty');
  assert(t(['none']) === '["none"]' && t(['none', 'grades']) === '["none"]', 'none');
  assert(t(['root', 'users']) === '["none"]', 'unknown-only ' + t(['root', 'users']));
  assert(t(['grades', 'hack', 'attendance']) === '["attendance","grades"]', 'known');
  assert(JSON.stringify(policy.accessToStore('teacher', ['gate'])) === '[]', 'teacher');
  assert(policy.staffAccessOf('staff', ['none']).length === 0, 'none ⇒ nothing');
  return 'four shapes';
});

let visitorId = null;
check('R03', 'the guard records a visitor in and out; bad rows and other roles are refused', () => {
  const r = sync.push(st, actor(guard), { ops: [op('visitors', visitor())] });
  assert(r.applied.length === 1, 'in ' + JSON.stringify(r));
  visitorId = r.applied[0].id;
  const v = st.get('visitors', visitorId);
  const out = sync.push(st, actor(guard), { ops: [op('visitors', Object.assign({}, v, { out_at: new Date(Date.now() + 60000).toISOString() }),
    { id: visitorId, base_version: v._version })] });
  assert(out.applied.length === 1 && st.get('visitors', visitorId).out_at, 'out ' + JSON.stringify(out));
  const bad = sync.push(st, actor(guard), { ops: [
    op('visitors', visitor({ name: '  ' })),
    op('visitors', visitor({ in_at: '2026-11-27T10:00:00Z', out_at: '2026-11-27T09:00:00Z' })),
    op('visitors', visitor({ date: '27/11' })),
  ] });
  assert(bad.rejected.map(x => x.error).join() === 'visitor_name,bad_time,bad_date', 'bad ' + JSON.stringify(bad.rejected));
  const p = sync.push(st, actor(par.id), { ops: [op('visitors', visitor())] });
  assert(p.applied.length === 0 && p.rejected[0].error === 'role_denied', 'parent');
  return 'in/out applied; visitor_name,bad_time,bad_date; parent role_denied';
});

check('R04', 'pull: guard gets visitors + leaves without reason/certificate; office the whole leave; parent no visitors', () => {
  const g = sync.pull(st, actor(guard), {});
  const gl = (g.collections.leaves || []).find(x => x.id === leave.id);
  assert((g.collections.visitors || []).some(x => x.id === visitorId), 'guard visitors');
  assert(gl && gl.status === 'approved' && gl.time_from === '10:00' && gl.student_id === s1.id, 'guard leave ' + JSON.stringify(gl));
  assert(gl.reason === undefined && gl.attachment === undefined, 'guard leave leaked ' + Object.keys(gl));
  assert((g.collections.users || []).some(x => x.id === s1.id && x.name === 'سارا'), 'guard sees the student name');
  const o = sync.pull(st, actor(office), {});
  const ol = (o.collections.leaves || []).find(x => x.id === leave.id);
  assert(ol && ol.attachment === cert && ol.reason === 'دکتر', 'office leave');
  assert(!(o.collections.visitors || []).length, 'office has no gate');
  const p = sync.pull(st, actor(par.id), {});
  assert(!(p.collections.visitors || []).length, 'parent got visitors');
  return 'guard leave keys ' + Object.keys(gl).filter(k => k !== '_version').join(',');
});

check('R05', 'an explicit tick replaces the default', () => {
  managerSaves(Object.assign({}, st.get('users', guard), { access: ['gate', 'leaves'] }), guard);
  const g = sync.pull(st, actor(guard), {});
  const gl = (g.collections.leaves || []).find(x => x.id === leave.id);
  assert(gl && gl.attachment === cert, 'guard with «مرخصی‌ها» gets the whole leave');
  managerSaves(Object.assign({}, st.get('users', staff), { access: ['grades'] }), staff);
  const s = sync.push(st, actor(staff), { ops: [op('attendance', { student_id: s1.id, class_id: 10, date: today, status: 'present' })] });
  assert(s.rejected[0] && s.rejected[0].error === 'role_denied', 'staff default still open after a tick');
  managerSaves(Object.assign({}, st.get('users', guard), { access: [] }), guard);
  return 'tick wins over default';
});

check('R06', 'cloud scope: default grant, visitor shape, leave reduced in the feed', async () => {
  const cs = await scope.build({ query: async () => ({ rows: [] }) }, { role: 'guard', uid: 9 });
  assert(cs.grantWrite.join() === 'visitors' && cs.gateLeaves === true, JSON.stringify(cs));
  assert(scope.canWriteCollection(cs, 'visitors') && !scope.canWriteCollection(cs, 'attendance'), 'collections');
  assert(!scope.canWriteRow(cs, 'visitors', visitor({ name: '' })).ok && scope.canWriteRow(cs, 'visitors', visitor()).ok, 'shape');
  const row = { collection: 'leaves', record_id: 5, data: { student_id: 3, date: today, status: 'approved', reason: 'x', attachment: cert } };
  const out = tenancy.scrubUsersRow(cs, row);
  assert(out.data.reason === undefined && out.data.attachment === undefined && out.data.status === 'approved', JSON.stringify(out));
  const mg = tenancy.scrubUsersRow({ role: 'manager', all: true }, row);
  assert(mg.data.attachment === cert, 'manager keeps it');
  const { sql } = scope.sqlPredicate(cs, 1);
  assert(/'visitors'/.test(sql) && /'leaves'/.test(sql), sql.slice(0, 160));
  return 'grant visitors, gateLeaves, feed reduced';
});

check('R07', 'negative control: «هیچ» closes the gate', () => {
  managerSaves(Object.assign({}, st.get('users', guard), { access: ['none'] }), guard);
  const r = sync.push(st, actor(guard), { ops: [op('visitors', visitor())] });
  assert(r.applied.length === 0 && r.rejected[0].error === 'role_denied', JSON.stringify(r));
  const g = sync.pull(st, actor(guard), {});
  assert(!(g.collections.visitors || []).length, 'still pulls visitors');
  return 'role_denied, nothing pulled';
});

check('R08', 'web edit form: same areas and post defaults as server/policy.js; «هیچ» saved as [none]', () => {
  const src = fs.readFileSync(path.join(ROOT, 'client/pages.js'), 'utf8');
  const areas = src.match(/const EDIT_STAFF_ACCESS = \[([\s\S]*?)\];/)[1];
  const keys = [...areas.matchAll(/\['([a-z]+)',/g)].map(m => m[1]);
  assert(keys.join() === Object.keys(policy.STAFF_ACCESS).join(), 'areas ' + keys.join() + ' ≠ ' + Object.keys(policy.STAFF_ACCESS).join());
  const defs = src.match(/const EDIT_ROLE_DEFAULT_ACCESS = (\{[\s\S]*?\});/)[1];
  const web = Function('return ' + defs)();
  for (const r of ['staff', 'office', 'guard', 'counselor']) {
    assert(JSON.stringify(web[r]) === JSON.stringify(policy.ROLE_DEFAULT_ACCESS[r] || []), 'default ' + r);
  }
  const app = fs.readFileSync(path.join(ROOT, 'client/app.js'), 'utf8');
  assert(/ticked\.length \? ticked : \['none'\]/.test(app), 'app.js saves [] for nothing ticked');
  return keys.length + ' areas, 4 defaults';
});

(async () => {
  for (const p of pending) await p();
  try { st.db.close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (!failed) console.log('STAFF-ROLES-197-OK');
  process.exit(failed ? 1 : 0);
})();
