#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 194 — «سطح دسترسی» of the executive staff: the manager ticks what a
   staff member may do; the SERVER enforces it (local sync and cloud scope).

     AC-01  an explicit «هیچ» (['none']) ⇒ the staff/guard user writes nothing (row 197 Q06:
            no ticks at all now means the role's default areas — tests/staff-roles-197.js)
     AC-02  tick «حضور و غیاب» ⇒ the staff user writes attendance of ANY class, nothing else
     AC-03  the ticked collections are pulled for the whole school; others stay closed
     AC-04  unknown keys / non-grantable roles are dropped when the manager saves access
     AC-05  no tick can write users, parent_links or app_settings (no self-escalation)
     AC-06  a ticked staff user may delete in its area only
     AC-07  cloud scope mirrors the local guard (read, write, SQL predicate)
     AC-08  the Dart copy (staff_access.dart) has the same keys, writes and reads
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
const { openStore } = require(path.join(ROOT, 'server/db'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acc194-'));
const st = openStore(path.join(TMP, 'a.sqlite'));
const mgr = st.insert('users', { name: 'مدیر', role: 'manager', active: true });
const s1 = st.insert('users', { name: 'دانش‌آموز ۱', role: 'student', class_id: 10, active: true });
const s2 = st.insert('users', { name: 'دانش‌آموز ۲', role: 'student', class_id: 11, active: true });
st.insert('classes', { name: '۱۰۱' }, { id: 10 });
st.insert('classes', { name: '۱۰۲' }, { id: 11 });
st.insert('grades', { student_id: s1.id, class_id: 10, score: 18 });

let seq = 0;
const op = (collection, data, extra) => Object.assign({ uid: `acc-${++seq}`, collection, type: 'put', data }, extra || {});
const actor = (u) => ({ user: st.get('users', u.id), role: policy.permRole(u.role), device: null });
const managerSaves = (data, id) => sync.push(st, actor(mgr), {
  ops: [op('users', data, id != null ? { id, base_version: st.get('users', id)._version } : {})],
});

/* the manager creates a staff member and a guard with «هیچ» (row 197 Q06: explicit none) */
const r0 = managerSaves({ name: 'کارمند', role: 'staff', active: true, phone: '09120000194', access: ['none'] });
const staffId = r0.applied[0].id;
const guardId = managerSaves({ name: 'نگهبان', role: 'guard', active: true, phone: '09120000195', access: ['none'] }).applied[0].id;

check('AC-01', '«هیچ» ⇒ the staff user writes nothing', () => {
  assert(JSON.stringify(st.get('users', staffId).access) === '["none"]', 'stored ' + JSON.stringify(st.get('users', staffId).access));
  const r = sync.push(st, actor(st.get('users', staffId)), { ops: [op('attendance', { student_id: s1.id, class_id: 10, date: '2026-11-26', status: 'absent' })] });
  assert(r.applied.length === 0 && r.rejected[0].error === 'role_denied', JSON.stringify(r.rejected));
  const g = sync.push(st, actor(st.get('users', guardId)), { ops: [op('announcements', { title: 'x', body: 'y' })] });
  assert(g.applied.length === 0, 'guard wrote');
  return 'role_denied';
});

check('AC-02', 'tick «attendance» ⇒ attendance of any class, nothing else', () => {
  managerSaves(Object.assign({}, st.get('users', staffId), { access: ['attendance'] }), staffId);
  const u = st.get('users', staffId);
  assert(JSON.stringify(u.access) === '["attendance"]', 'stored ' + JSON.stringify(u.access));
  const r = sync.push(st, actor(u), { ops: [
    op('attendance', { student_id: s1.id, class_id: 10, date: '2026-11-26', status: 'absent' }),
    op('attendance', { student_id: s2.id, class_id: 11, date: '2026-11-26', status: 'late' }),
    op('attendance', { student_id: s2.id, class_id: 11, date: '2026-11-26', status: 'bogus' }),
    op('grades', { student_id: s1.id, class_id: 10, score: 20 }),
    op('announcements', { title: 'x', body: 'y' }),
  ] });
  assert(r.applied.length === 2, 'applied ' + JSON.stringify(r.applied));
  const errs = r.rejected.map(x => x.error).join(',');
  assert(errs === 'bad_status,role_denied,role_denied', errs);
  return `2 applied, rejected ${errs}`;
});

check('AC-03', 'ticked collections are pulled for the whole school', () => {
  const u = st.get('users', staffId);
  const out = sync.pull(st, actor(u), { collections: 'attendance,users,classes,grades,announcements' });
  const got = out.collections || {};
  assert((got.attendance || []).length === 2, 'attendance ' + (got.attendance || []).length);
  assert((got.users || []).some(x => x.id === s2.id), 'students');
  assert(!(got.users || []).some(x => x.national_id || x.phone && x.id !== staffId), 'identity scrubbed');
  assert((got.classes || []).length === 2, 'classes');
  assert(!(got.grades || []).length, 'grades must stay closed');
  return `attendance ${got.attendance.length}, users ${got.users.length}, grades 0`;
});

check('AC-04', 'unknown keys and non-grantable roles are dropped on save', () => {
  managerSaves(Object.assign({}, st.get('users', staffId), { access: ['attendance', 'root', 'users', 'notices'] }), staffId);
  assert(JSON.stringify(st.get('users', staffId).access) === '["attendance","notices"]', JSON.stringify(st.get('users', staffId).access));
  const t = managerSaves({ name: 'دبیر', role: 'teacher', active: true, phone: '09120000196', access: ['classes'] });
  assert(JSON.stringify(st.get('users', t.applied[0].id).access) === '[]', 'teacher access');
  assert(policy.staffAccessOf('vice', ['classes']).length === 0, 'vice is the manager');
  assert(policy.staffAccessOf('office', 'leaves, grades').join() === 'leaves,grades', 'comma list');
  return 'filtered';
});

check('AC-05', 'no tick writes users, parent_links or app_settings', () => {
  const all = Object.keys(policy.STAFF_ACCESS);
  const u = { role: 'staff', access: all };
  for (const c of ['users', 'parent_links', 'app_settings', 'import_issues', 'conflicts', 'staff_attendance']) {
    assert(!policy.grantWrites(u).has(c), 'writes ' + c);
    assert(!policy.canWriteFor(u, c), 'canWriteFor ' + c);
  }
  managerSaves(Object.assign({}, st.get('users', staffId), { access: all }), staffId);
  const me = st.get('users', staffId);
  const r = sync.push(st, actor(me), { ops: [op('users', Object.assign({}, me, { role: 'manager' }), { id: staffId, base_version: me._version })] });
  assert(r.applied.length === 0 && st.get('users', staffId).role === 'staff', 'escalated ' + JSON.stringify(r));
  return 'no escalation';
});

check('AC-06', 'delete only inside the ticked area', () => {
  managerSaves(Object.assign({}, st.get('users', staffId), { access: ['attendance'] }), staffId);
  const me = st.get('users', staffId);
  const att = st.all('attendance')[0];
  const ok = sync.push(st, actor(me), { ops: [{ uid: `acc-${++seq}`, collection: 'attendance', type: 'del', id: att.id, base_version: att._version }] });
  assert(ok.applied.length === 1, 'attendance delete ' + JSON.stringify(ok));
  const cls = st.get('classes', 10);
  const no = sync.push(st, actor(me), { ops: [{ uid: `acc-${++seq}`, collection: 'classes', type: 'del', id: 10, base_version: cls._version }] });
  assert(no.applied.length === 0 && no.rejected[0].error === 'role_denied', 'class delete');
  return 'attendance yes, classes no';
});

check('AC-07', 'cloud scope mirrors the local guard', async () => {
  const fake = { query: async (sql, params) => /data->'access'/.test(sql) && params[0] === 6 ? { rows: [{ access: ['attendance'] }] } : { rows: [] } };
  const cs = await scope.build(fake, { role: 'staff', uid: 6 });
  assert(cs.grantWrite.includes('attendance') && cs.grantRead.includes('users'), JSON.stringify(cs));
  assert(scope.canWriteCollection(cs, 'attendance') && !scope.canWriteCollection(cs, 'grades'), 'collections');
  assert(scope.rowInScope(cs, 'attendance', { student_id: 999 }) && !scope.rowInScope(cs, 'grades', { student_id: 999 }), 'rows');
  assert(scope.canWriteRow(cs, 'attendance', { status: 'present' }).ok && !scope.canWriteRow(cs, 'attendance', { status: 'x' }).ok, 'row write');
  assert(!scope.canWriteRow(cs, 'users', { id: 6, role: 'manager' }).ok, 'cloud escalation');
  const { sql } = scope.sqlPredicate(cs, 1);
  const open = (sql.match(/^\(r\.collection in \(([^)]*)\)/) || [])[1] || '';
  assert(/'attendance'/.test(open) && /'users'/.test(open) && !/'grades'/.test(open), sql.slice(0, 200));
  const none = await scope.build({ query: async (sql) => /data->'access'/.test(sql) ? { rows: [{ access: ['none'] }] } : { rows: [] } }, { role: 'guard', uid: 8 });
  assert(none.grantWrite.length === 0 && !scope.canWriteCollection(none, 'attendance'), 'guard with «هیچ»');
  /* row 197 (Q06): a guard nobody ticked gets its role default — the gate, nothing else */
  const dflt = await scope.build({ query: async () => ({ rows: [] }) }, { role: 'guard', uid: 8 });
  assert(JSON.stringify(dflt.grantWrite) === '["visitors"]' && !scope.canWriteCollection(dflt, 'attendance'), 'guard default ' + JSON.stringify(dflt.grantWrite));
  return 'read/write/sql';
});

check('AC-08', 'Dart copy has the same areas', () => {
  const dart = fs.readFileSync(path.join(ROOT, 'apps/payesh/packages/payesh_sync/lib/src/staff_access.dart'), 'utf8');
  const areas = [...dart.matchAll(/key: '([a-z_]+)',[\s\S]*?write: \{([^}]*)\},\s*read: \{([^}]*)\}/g)]
    .map(m => [m[1], m[2].match(/'([a-z_]+)'/g) || [], m[3].match(/'([a-z_]+)'/g) || []]
      .map(x => Array.isArray(x) ? x.map(y => y.replace(/'/g, '')) : x));
  const keys = areas.map(a => a[0]);
  assert(JSON.stringify(keys) === JSON.stringify(Object.keys(policy.STAFF_ACCESS)), 'keys ' + keys);
  for (const [k, w, r] of areas) {
    assert(JSON.stringify(w) === JSON.stringify(policy.STAFF_ACCESS[k].write), 'write ' + k);
    assert(JSON.stringify(r) === JSON.stringify(policy.STAFF_ACCESS[k].read), 'read ' + k);
  }
  const roles = (dart.match(/grantableRoles = \{([^}]*)\}/) || [])[1] || '';
  assert(JSON.stringify(roles.match(/'([a-z]+)'/g).map(x => x.replace(/'/g, ''))) === JSON.stringify(policy.GRANTABLE_ROLES), 'roles');
  /* row 197 (Q06): the post defaults are the same on both sides */
  const dm = (dart.match(/roleDefaultAccess = \{([\s\S]*?)\n\};/) || [])[1] || '';
  const dartDefaults = {};
  for (const m of dm.matchAll(/'([a-z]+)': \[([^\]]*)\]/g)) dartDefaults[m[1]] = (m[2].match(/'([a-z_]+)'/g) || []).map(x => x.replace(/'/g, ''));
  assert(JSON.stringify(dartDefaults) === JSON.stringify(policy.ROLE_DEFAULT_ACCESS), 'defaults ' + JSON.stringify(dartDefaults));
  assert((dart.match(/accessNone = '([a-z]+)'/) || [])[1] === policy.ACCESS_NONE, 'none marker');
  return `${keys.length} areas and ${Object.keys(dartDefaults).length} post defaults equal`;
});

(async () => {
  for (const p of pending) await p();
  try { st.db.close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
