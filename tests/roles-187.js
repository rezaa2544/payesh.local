#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 187 — every role gets exactly its access (the p2 definitions).

     RL-01  permRole: vice/deputy ⇒ manager; every other role is itself
     RL-02  معاون (vice) reads and writes every collection exactly like مدیر
     RL-03  vice scope = whole school (local buildScope and cloud scope.build)
     RL-04  every server guard reads the PERMISSION role (actorFrom, outbox, cloud token)
     RL-05  cloud token of a vice: role=manager, title_role=vice (display kept)
     RL-06  staff/office are known roles: common pages only (announcements…), no writes
     RL-07  counselor (p2): only the referred students — attendance/discipline, never grades;
            writes counselor_refs/notes only, never discipline
     RL-08  guard: common pages only, no writes
     RL-09  every assignable role is accepted by user edit, backup and the outbox
     RL-10  owner price policy «deputy» applies to the vice user
     RL-11  web client: S.role is the permission role, labels keep «معاون»
     RL-12  web authz: vice = manager for every route and action; counselor only its queue
     RL-13  counselor queue page on the web and the phone (nav, page, refer/handle)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const policy = require(path.join(ROOT, 'server/policy'));
const scope = require(path.join(ROOT, 'server/scope'));
const tenancy = require(path.join(ROOT, 'server/tenancy'));

/* ── a tiny store ── */
function store(rows) {
  return {
    all: (c) => (rows[c] || []).slice(),
    get: (c, id) => (rows[c] || []).find(r => Number(r.id) === Number(id)) || null,
    byRef: (c, k, v) => (rows[c] || []).filter(r => Number(r.teacher_id) === Number(v)),
  };
}
const ROWS = {
  users: [
    { id: 1, role: 'manager', name: 'مدیر' }, { id: 2, role: 'vice', name: '1' },
    { id: 3, role: 'student', name: 'الف', class_id: 10 }, { id: 4, role: 'student', name: 'ب', class_id: 11 },
    { id: 5, role: 'counselor', name: 'مشاور' }, { id: 6, role: 'staff' }, { id: 7, role: 'office' }, { id: 8, role: 'guard' },
  ],
  counselor_refs: [{ id: 90, student_id: 3, status: 'open', reason: 'تأخیر' }],
  parent_links: [], schedule: [],
};
const S0 = store(ROWS);
const COLS = Object.keys(policy.COLLECTIONS);

check('RL-01', 'permRole maps only the deputy names to manager', () => {
  assert(policy.permRole('vice') === 'manager' && policy.permRole('deputy') === 'manager', 'vice/deputy');
  for (const r of ['manager', 'teacher', 'parent', 'student', 'counselor', 'guard', 'staff', 'office']) {
    assert(policy.permRole(r) === r, r);
  }
  assert(policy.permRole('') === '' && policy.permRole(undefined) === '', 'empty');
  return 'vice, deputy → manager';
});

check('RL-02', 'vice reads and writes every collection exactly like the manager', () => {
  for (const c of COLS) {
    assert(policy.canRead('vice', c) === policy.canRead('manager', c), 'read ' + c);
    assert(policy.canWrite('vice', c) === policy.canWrite('manager', c), 'write ' + c);
  }
  assert(policy.canWrite('vice', 'users') && policy.canWrite('vice', 'app_settings'), 'manager-only collections');
  const r = policy.canWriteRow(S0, ROWS.users[1], 'vice', 'grades', { student_id: 3, class_id: 10, status: 'approved' }, null);
  assert(r.ok, 'row write ' + JSON.stringify(r));
  return COLS.length + ' collections equal';
});

check('RL-03', 'vice scope is the whole school (local and cloud)', async () => {
  const s = policy.buildScope(S0, ROWS.users[1]);
  assert(s.all === true && s.role === 'manager', 'local ' + JSON.stringify(s));
  for (const c of COLS) assert(policy.rowInScope(s, c, { id: 4, student_id: 4, class_id: 11 }), 'row ' + c);
  const cs = await scope.build({ query: async () => { throw new Error('no query for a manager'); } }, { role: 'vice', uid: 2 });
  assert(cs.all === true, 'cloud ' + JSON.stringify(cs));
  return 'all=true';
});

check('RL-04', 'server guards read the permission role', () => {
  const idx = read('server/index.js');
  assert(/role: policy\.permRole\(s\.user\.role\)/.test(idx), 'actorFrom');
  assert(/role: policy\.permRole\(user\.role\)/.test(read('server/outbox.js')), 'outbox actor');
  assert(/policy\.permRole\(claims\.role\)/.test(read('server/tenancy.js')), 'verifyToken');
  assert(/policy\.permRole\(String\(\(claims && claims\.role\)/.test(read('server/scope.js')), 'scope.build');
  return 'actorFrom, outbox, verifyToken, scope.build';
});

check('RL-05', 'cloud token of a vice: role manager, title_role vice', () => {
  const secret = 'x'.repeat(40);
  const tok = tenancy.signToken({ tid: '11111111-2222-4333-8444-555555555555', role: 'vice', uid: 2, exp: Date.now() + 60000 }, secret);
  const c = tenancy.verifyToken(tok, secret);
  assert(c.role === 'manager' && c.title_role === 'vice', JSON.stringify(c));
  const t2 = tenancy.signToken({ tid: '11111111-2222-4333-8444-555555555555', role: 'teacher', uid: 3, exp: Date.now() + 60000 }, secret);
  const c2 = tenancy.verifyToken(t2, secret);
  assert(c2.role === 'teacher' && c2.title_role === undefined, 'teacher untouched');
  return 'manager/vice';
});

check('RL-06', 'staff and office: known roles, common pages only, no writes', () => {
  for (const r of ['staff', 'office']) {
    assert(policy.ROLES.includes(r), r + ' in ROLES');
    assert(policy.canRead(r, 'announcements'), r + ' reads announcements');
    for (const c of COLS) assert(!policy.canWrite(r, c), r + ' writes ' + c);
    const s = policy.buildScope(S0, ROWS.users.find(u => u.role === r));
    assert(!s.all && s.studentIds.size === 0, r + ' scope');
    assert(!policy.rowInScope(s, 'users', { id: 3 }), r + ' sees a student');
    assert(policy.rowInScope(s, 'users', { id: s.selfId }), r + ' sees self');
  }
  return 'staff, office';
});

check('RL-07', 'counselor: referred students only, no grades, writes only its queue', () => {
  const s = policy.buildScope(S0, ROWS.users[4]);
  assert(s.studentIds.has(3) && !s.studentIds.has(4), 'referred only ' + [...s.studentIds]);
  assert(policy.rowInScope(s, 'users', { id: 3 }) && !policy.rowInScope(s, 'users', { id: 4 }), 'users');
  assert(policy.rowInScope(s, 'attendance', { student_id: 3 }), 'attendance pattern');
  assert(policy.rowInScope(s, 'discipline', { student_id: 3 }), 'discipline');
  assert(!policy.rowInScope(s, 'grades', { student_id: 3 }), 'grades hidden');
  assert(!policy.rowInScope(s, 'internships', { student_id: 3 }), 'internships hidden');
  assert(!policy.canWrite('counselor', 'discipline'), 'no discipline write');
  assert(policy.canWrite('counselor', 'counselor_refs') && policy.canWrite('counselor', 'counselor_notes'), 'queue writes');
  const cs = { role: 'counselor', uid: 5, all: false, classIds: [], studentIds: [3], cohorts: [] };
  assert(!scope.rowInScope(cs, 'grades', { student_id: 3 }) && scope.rowInScope(cs, 'attendance', { student_id: 3 }), 'cloud rows');
  const sql = scope.sqlPredicate(cs).sql;
  assert(!/'grades'/.test(sql) && /'attendance'/.test(sql), 'cloud SQL ' + sql.slice(0, 120));
  return 'students [3]';
});

check('RL-08', 'guard: common pages only, no writes', () => {
  for (const c of COLS) assert(!policy.canWrite('guard', c), 'guard writes ' + c);
  assert(policy.canRead('guard', 'announcements'), 'announcements');
  return 'read-only';
});

check('RL-09', 'every assignable role is accepted by user edit, backup and the outbox', () => {
  const all = ['manager', 'vice', 'teacher', 'parent', 'student', 'counselor', 'guard', 'staff', 'office'];
  for (const r of all) assert(policy.USER_ROLES.includes(r), r);
  assert(/policy\.USER_ROLES\.includes\(body\.role\)/.test(read('server/index.js')), 'user edit');
  assert(/USER_ROLES/.test(read('server/mirror.js')), 'backup');
  assert(/policy\.USER_ROLES\.includes\(u\.role\)/.test(read('server/outbox.js')), 'outbox person files');
  assert(require(path.join(ROOT, 'server/mirror')), 'mirror loads');
  return all.length + ' roles';
});

check('RL-10', 'owner price policy «deputy» applies to the vice user', () => {
  const src = read('server/school-registry.js');
  assert(/=== 'vice' \? 'deputy'/.test(src), 'vice → deputy key');
  return 'gate()';
});

/* the web client functions, run for real */
function webCtx() {
  const app = read('client/app.js');
  const fn = app.match(/function permRole\(role\) \{[\s\S]*?\n\}/)[0];
  const ctx = { window: {}, S: { user: null } };
  vm.createContext(ctx);
  vm.runInContext(fn, ctx);
  const pages = read('client/pages.js');
  vm.runInContext('function isPhoneMode(){return false}\n' + pages.match(/function navConfig\(role\) \{[\s\S]*?\n\}/)[0], ctx);
  vm.runInContext(read('client/authz.js').replace(/^'use strict';/, ''), ctx);
  return ctx;
}

check('RL-11', 'web S.role is the permission role, labels keep the saved role', () => {
  const app = read('client/app.js');
  assert(/get role\(\) \{ return permRole\(this\._role\); \}/.test(app), 'S.role getter');
  assert(/function roleTitle\(\)/.test(app), 'roleTitle');
  const pages = read('client/pages.js');
  assert(/ROLE_FA\[roleTitle\(\)\]/.test(pages), 'labels use roleTitle');
  const ctx = webCtx();
  assert(vm.runInContext("permRole('vice')", ctx) === 'manager', 'permRole web');
  return 'S.role / roleTitle';
});

check('RL-12', 'web authz: vice = manager everywhere; counselor only its queue', () => {
  const ctx = webCtx();
  const can = (route, role) => vm.runInContext(`authzCanRoute(${JSON.stringify(route)}, ${JSON.stringify(role)})`, ctx);
  const act = (a, role) => vm.runInContext(`authzCanAct(${JSON.stringify(a)}, ${JSON.stringify(role)})`, ctx);
  const routes = vm.runInContext("navConfig('manager').map(x => x[0])", ctx);
  for (const r of routes.concat(['followup', 'health', 'reports', 'network', 'cloud', 'cqueue'])) assert(can(r, 'vice'), 'vice route ' + r);
  for (const a of ['user-add', 'class-add', 'backup-now', 'mirror-restore', 'update-apply', 'ann-add', 'cref-add']) assert(act(a, 'vice'), 'vice act ' + a);
  assert(can('cqueue', 'counselor') && !can('students', 'counselor') && !can('record', 'counselor'), 'counselor routes');
  assert(act('cref-done', 'counselor') && !act('cref-add', 'counselor'), 'counselor acts');
  for (const r of ['staff', 'office', 'guard']) {
    assert(can('home', r) && can('announcements', r) && !can('users', r) && !can('leaves', r), r + ' routes');
    assert(!act('mirror-refresh', r) && !act('user-add', r), r + ' acts');
  }
  return routes.length + ' manager routes for vice';
});

check('RL-13', 'counselor queue on the web and the phone', () => {
  const pages = read('client/pages.js');
  assert(/role === 'counselor'[\s\S]{0,200}\['cqueue', '📨', 'صف ارجاع'\]/.test(pages), 'web nav');
  assert(/PAGES\.cqueue = /.test(pages) && /data-form="cref"/.test(pages), 'web page + form');
  const app = read('client/app.js');
  assert(/case 'cref-done'/.test(app) && /kind === 'cref'/.test(app), 'web actions');
  const dart = read('apps/payesh/app/lib/src/app.dart');
  assert(/'counselor' => const \[\s*\('cqueue', 'mail', 'صف ارجاع', 'cqueue'\)/.test(dart), 'phone nav');
  assert(/switch \(role == null \? null : permRole\(role\)\)/.test(dart), 'phone nav uses permRole');
  assert(fs.existsSync(path.join(ROOT, 'apps/payesh/app/lib/src/counselor/cqueue_screen.dart')), 'phone page');
  const rec = read('apps/payesh/packages/payesh_sync/lib/src/records.dart');
  assert(/role = permRole\(role\)/.test(rec), 'SchoolRecords permission role');
  return 'web + phone';
});

(async () => {
  for (const p of pending) await p();
  console.log(`\nROLES-187: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
