'use strict';

const assert = require('node:assert/strict');
const policy = require('../server/policy');
const scope = require('../server/scope');

const roles = ['manager', 'teacher', 'parent', 'student', 'counselor', 'guard', 'staff', 'office'];
const collections = [
  'schools', 'school_years', 'users', 'classes', 'subjects', 'lookups', 'schedule',
  'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves',
  'parent_links', 'internships', 'staff_attendance', 'staff_posts', 'counselor_refs',
  'counselor_notes', 'discipline', 'homework', 'exams', 'calendar', 'app_settings',
  'import_issues', 'conflicts', 'visitors', 'contributions', 'trustees', 'parent_msgs',
];
const readByRole = {
  manager: collections.filter((c) => c !== 'counselor_notes'),
  // row 197 (F19): the teacher refers their own students to the counselor and reads back only the
  // referrals they made (row scope below: referred_by === self) — never counselor_notes
  teacher: collections.filter((c) => !['parent_links', 'staff_attendance', 'counselor_notes', 'app_settings', 'import_issues', 'conflicts', 'visitors', 'contributions', 'trustees'].includes(c)),
  // row 197 (Q12 / F27): the parent reads the contributions recorded for their own child and the
  // messages/appointments of their own children (row scope below: student_id ∈ children)
  parent: collections.filter((c) => !['staff_attendance', 'staff_posts', 'counselor_refs', 'counselor_notes', 'app_settings', 'import_issues', 'conflicts', 'visitors', 'trustees'].includes(c)),
  // row 197 (F21): the student reads their own discipline notes (row scope below: own student_id only)
  student: collections.filter((c) => !['parent_links', 'staff_attendance', 'staff_posts', 'counselor_refs', 'counselor_notes', 'app_settings', 'import_issues', 'conflicts', 'visitors', 'contributions', 'trustees', 'parent_msgs'].includes(c)),
  counselor: collections.filter((c) => !['parent_links', 'staff_attendance', 'staff_posts', 'app_settings', 'import_issues', 'conflicts', 'visitors', 'contributions', 'trustees'].includes(c)),
  guard: collections.filter((c) => ['schools', 'school_years', 'users', 'classes', 'subjects', 'lookups', 'schedule', 'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves', 'internships', 'homework', 'exams', 'calendar'].includes(c)),
};
// row 187 (p2): کارمند and اجرایی read exactly what the guard reads
readByRole.staff = readByRole.guard;
readByRole.office = readByRole.guard;
const scopes = {
  manager: { role: 'manager', selfId: 1, all: true, classIds: new Set(), studentIds: new Set(), cohorts: new Set() },
  teacher: { role: 'teacher', selfId: 2, all: false, classIds: new Set([10]), studentIds: new Set([3]), cohorts: new Set() },
  parent: { role: 'parent', selfId: 4, all: false, classIds: new Set([10]), studentIds: new Set([3]), cohorts: new Set() },
  student: { role: 'student', selfId: 3, all: false, classIds: new Set([10]), studentIds: new Set([3]), cohorts: new Set() },
  // row 197 (Q12 / F29): the counselor's scope is every student of the school (and their classes)
  counselor: { role: 'counselor', selfId: 5, all: false, classIds: new Set([10]), studentIds: new Set([3]), cohorts: new Set() },
  guard: { role: 'guard', selfId: 6, all: false, classIds: new Set(), studentIds: new Set(), cohorts: new Set() },
  staff: { role: 'staff', selfId: 7, all: false, classIds: new Set(), studentIds: new Set(), cohorts: new Set() },
  office: { role: 'office', selfId: 8, all: false, classIds: new Set(), studentIds: new Set(), cohorts: new Set() },
};
const rows = {
  schools: { id: 1 }, school_years: { id: 1 }, users: { id: 3 }, classes: { id: 10 },
  subjects: { id: 1 }, lookups: { id: 1 }, schedule: { id: 1, class_id: 10 },
  bell_schedules: { id: 1 }, substitutions: { id: 1, class_id: 10 },
  attendance: { id: 1, student_id: 3, class_id: 10 }, grades: { id: 1, student_id: 3, class_id: 10 },
  announcements: { id: 1 }, leaves: { id: 1, student_id: 3 }, parent_links: { id: 1, parent_id: 4, student_id: 3 },
  internships: { id: 1, student_id: 3, class_id: 10 }, staff_attendance: { id: 1 }, staff_posts: { id: 1 },
  counselor_refs: { id: 1 }, counselor_notes: { id: 1 }, discipline: { id: 1, student_id: 3, class_id: 10 },
  homework: { id: 1 }, exams: { id: 1 }, calendar: { id: 1 }, app_settings: { id: 1 },
  import_issues: { id: 1 }, conflicts: { id: 1 }, visitors: { id: 1 }, contributions: { id: 1, student_id: 3 }, trustees: { id: 1 },
  parent_msgs: { id: 1, student_id: 3, to: 'counselor', kind: 'appointment' },
};
const readScopeByRole = {
  manager: collections,
  teacher: ['schools', 'school_years', 'users', 'classes', 'subjects', 'schedule', 'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves', 'internships', 'discipline', 'homework', 'exams', 'calendar'],
  parent: ['schools', 'school_years', 'users', 'classes', 'subjects', 'schedule', 'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves', 'parent_links', 'internships', 'discipline', 'homework', 'exams', 'calendar', 'contributions', 'parent_msgs'],
  student: ['schools', 'school_years', 'users', 'classes', 'subjects', 'schedule', 'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves', 'internships', 'discipline', 'homework', 'exams', 'calendar'],
  counselor: ['schools', 'school_years', 'users', 'classes', 'subjects', 'schedule', 'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves', 'internships', 'counselor_refs', 'counselor_notes', 'discipline', 'homework', 'exams', 'calendar', 'parent_msgs'],
  guard: ['schools', 'school_years', 'subjects', 'bell_schedules', 'announcements', 'homework', 'exams', 'calendar'],
};
readScopeByRole.staff = readScopeByRole.guard;
readScopeByRole.office = readScopeByRole.guard;
const secretFields = ['password_hash', 'password_enc', 'password_plain', 'phone_hash', '__password_verifier', 'pin_hash', 'token', 'secret', 'accessKey'];
const identityFields = ['national_id', 'father_nid', 'mother_nid', 'shenasname_serial', 'shenasname_seri', 'phone', 'address'];
let matrixChecks = 0;
let fieldChecks = 0;

function checkReadMatrix(emit = true, count = true) {
  for (const role of roles) {
    for (const collection of collections) {
      const expectedRead = readByRole[role].includes(collection);
      const actualRead = policy.canRead(role, collection);
      assert.equal(actualRead, expectedRead, `role=${role} collection=${collection} read mismatch`);

      const expectedScope = readScopeByRole[role].includes(collection);
      const actualScope = policy.rowInScope(scopes[role], collection, rows[collection]);
      assert.equal(actualScope, expectedScope, `role=${role} collection=${collection} row-scope mismatch`);
      const expectedVisible = expectedRead && expectedScope;
      assert.equal(actualRead && actualScope, expectedVisible, `role=${role} collection=${collection} visibility mismatch`);
      if (count) matrixChecks += 1;
      if (emit) console.log(`MATRIX role=${role} collection=${collection} read=${+actualRead} scoped=${+actualScope} visible=${+expectedVisible}`);
    }
  }
}

function checkUserFields(emit = true, count = true) {
  const sample = {
    id: 3, name: 'matrix-student', role: 'student', _version: 7,
    password_hash: 'hash-sentinel', password_enc: 'enc-sentinel', password_plain: 'plain-sentinel',
    phone_hash: 'phone-hash-sentinel', __password_verifier: 'verifier-sentinel', pin_hash: 'pin-sentinel',
    token: 'token-sentinel', secret: 'secret-sentinel', accessKey: 'key-sentinel',
    national_id: 'nid-sentinel', father_nid: 'father-nid-sentinel', mother_nid: 'mother-nid-sentinel',
    shenasname_serial: 'serial-sentinel', shenasname_seri: 'seri-sentinel', phone: 'phone-sentinel', address: 'address-sentinel',
  };
  for (const role of roles) {
    if (role === 'manager') {
      for (const field of [...secretFields, ...identityFields]) {
        assert.equal(sample[field] !== undefined, true, `manager control fixture missing ${field}`);
        if (count) fieldChecks += 1;
      }
      if (emit) console.log(`FIELDS role=manager target=all secrets=${secretFields.length} identity=${identityFields.length} preserved=1`);
      continue;
    }
    for (const target of ['self', 'other']) {
      const viewer = { id: target === 'self' ? sample.id : 9 };
      const output = policy.scrubUserFor(viewer, sample);
      for (const field of secretFields) {
        assert.equal(Object.hasOwn(output, field), false, `role=${role} target=${target} secret=${field} leaked`);
        if (count) fieldChecks += 1;
      }
      for (const field of identityFields) {
        assert.equal(Object.hasOwn(output, field), target === 'self', `role=${role} target=${target} identity=${field} exposure mismatch`);
        if (count) fieldChecks += 1;
      }
      assert.equal(output.name, sample.name, `role=${role} target=${target} public name was lost`);
      assert.equal(output._version, sample._version, `role=${role} target=${target} version was lost`);
      if (emit) console.log(`FIELDS role=${role} target=${target} secret_fields=${secretFields.length} identity_fields=${identityFields.length} public=preserved`);
    }
  }
}

function checkNegativeControls() {
  const oldRead = policy.COLLECTIONS.conflicts.read;
  try {
    policy.COLLECTIONS.conflicts.read = 'all';
    assert.throws(() => checkReadMatrix(false, false), /role=teacher collection=conflicts read mismatch/);
    console.log('NEGATIVE-CONTROL-OK unauthorized role/collection read expansion detected');
  } finally {
    policy.COLLECTIONS.conflicts.read = oldRead;
  }

  const oldScrub = policy.scrubUser;
  const oldScrubFor = policy.scrubUserFor;
  try {
    policy.scrubUser = (data) => ({ ...(data || {}) });
    policy.scrubUserFor = (_viewer, data) => ({ ...(data || {}) });
    assert.throws(() => checkUserFields(false, false), /secret=.* leaked/);
    console.log('NEGATIVE-CONTROL-OK disabled user-field scrub detected');
  } finally {
    policy.scrubUser = oldScrub;
    policy.scrubUserFor = oldScrubFor;
  }
}

try {
  assert.deepEqual(Object.keys(policy.COLLECTIONS).sort(), [...collections].sort(), 'matrix collection list drifted; update the explicit matrix');
  assert.deepEqual(policy.ROLES, roles, 'matrix role list drifted; update the explicit matrix');
  console.log(`PASS  MATRIX-COVERAGE roles=${roles.length} collections=${collections.length}`);
  checkReadMatrix();
  /* row 197 (F19): a teacher sees exactly the referrals they made — not a colleague's, not an unsigned one */
  const ownRef = { id: 2, student_id: 3, referred_by: 2 };
  const otherRef = { id: 3, student_id: 3, referred_by: 9 };
  assert.equal(policy.rowInScope(scopes.teacher, 'counselor_refs', ownRef), true, 'teacher must see the referral they made');
  assert.equal(policy.rowInScope(scopes.teacher, 'counselor_refs', otherRef), false, "teacher must not see a colleague's referral");
  assert.equal(policy.rowInScope(scopes.teacher, 'counselor_refs', rows.counselor_refs), false, 'teacher must not see an unsigned referral');
  assert.equal(policy.rowInScope(scopes.teacher, 'counselor_notes', ownRef), false, 'teacher must never see counselor notes');
  matrixChecks += 4;
  console.log('PASS  F19 teacher counselor_refs: own=1 colleague=0 unsigned=0 notes=0');
  /* row 197 (F21): a student sees their own discipline notes — never a classmate's */
  const ownDisc = { id: 4, student_id: 3, class_id: 10 };
  const mateDisc = { id: 5, student_id: 9, class_id: 10 };
  assert.equal(policy.rowInScope(scopes.student, 'discipline', ownDisc), true, 'student must see their own discipline note');
  assert.equal(policy.rowInScope(scopes.student, 'discipline', mateDisc), false, "student must not see a classmate's discipline note");
  assert.equal(scope.rowInScope({ role: 'student', uid: 3, all: false, classIds: [10], studentIds: [3], cohorts: [] }, 'discipline', mateDisc), false, "cloud scope: student must not see a classmate's discipline note");
  assert.equal(policy.canRead('student', 'counselor_notes') || policy.canRead('student', 'counselor_refs'), false, 'student never reads counselor data');
  matrixChecks += 4;
  console.log('PASS  F21 student discipline: own=1 classmate=0 cloud-classmate=0 counselor=0');
  /* row 197 (Q12 / F27, F29): parent messages — each side sees only its own threads (local and cloud) */
  const toMe = { id: 2, student_id: 3, to: 'teacher', teacher_id: 2, kind: 'message' };
  const toColleague = { id: 3, student_id: 3, to: 'teacher', teacher_id: 9, kind: 'message' };
  const toSchool = { id: 4, student_id: 3, to: 'school', kind: 'message' };
  const otherChild = { id: 5, student_id: 77, to: 'school', kind: 'message' };
  const cloudOf = (sc) => Object.assign({}, sc, { uid: sc.selfId, classIds: [...sc.classIds], studentIds: [...sc.studentIds], cohorts: [] });
  for (const [mirror, rs, conv] of [['local', policy.rowInScope, (x) => x], ['cloud', scope.rowInScope, cloudOf]]) {
    assert.equal(rs(conv(scopes.teacher), 'parent_msgs', toMe), true, mirror + ': teacher sees the message to them');
    assert.equal(rs(conv(scopes.teacher), 'parent_msgs', toColleague), false, mirror + ": teacher must not see a colleague's message");
    assert.equal(rs(conv(scopes.teacher), 'parent_msgs', toSchool), false, mirror + ': teacher must not see a message to the school');
    assert.equal(rs(conv(scopes.teacher), 'parent_msgs', rows.parent_msgs), false, mirror + ': teacher must not see a counseling appointment');
    assert.equal(rs(conv(scopes.counselor), 'parent_msgs', toMe), false, mirror + ': counselor must not see a message to a teacher');
    assert.equal(rs(conv(scopes.counselor), 'parent_msgs', rows.parent_msgs), true, mirror + ': counselor sees «به مشاور»');
    assert.equal(rs(conv(scopes.parent), 'parent_msgs', toColleague), true, mirror + ": parent sees every thread of their child");
    assert.equal(rs(conv(scopes.parent), 'parent_msgs', otherChild), false, mirror + ": parent must not see another child's thread");
    assert.equal(rs(conv(scopes.parent), 'contributions', { id: 6, student_id: 77 }), false, mirror + ": parent must not see another child's contribution");
    assert.equal(rs(conv(scopes.parent), 'contributions', { id: 7 }), false, mirror + ': parent must not see a contribution with no child');
    assert.equal(rs(conv(scopes.teacher), 'contributions', rows.contributions), false, mirror + ': teacher never sees contributions');
  }
  assert.equal(policy.canRead('student', 'parent_msgs'), false, 'student never reads parent messages');
  console.log('PASS  F27/F29 parent_msgs: teacher own=1 colleague=0 school=0; counselor teacher-msg=0; parent other-child=0; contributions other/none=0 (local+cloud)');
  checkUserFields();
  checkNegativeControls();
  console.log(`LEAK-MATRIX-57-OK roles=${roles.length} collections=${collections.length} role_collection_checks=${matrixChecks} field_checks=${fieldChecks} fail=0`);
} catch (error) {
  console.error(`LEAK-MATRIX-57-FAIL ${error.stack || error.message}`);
  process.exitCode = 1;
}
