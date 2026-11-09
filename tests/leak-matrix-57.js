'use strict';

const assert = require('node:assert/strict');
const policy = require('../server/policy');

const roles = ['manager', 'teacher', 'parent', 'student', 'counselor', 'guard'];
const collections = [
  'schools', 'school_years', 'users', 'classes', 'subjects', 'lookups', 'schedule',
  'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves',
  'parent_links', 'internships', 'staff_attendance', 'staff_posts', 'counselor_refs',
  'counselor_notes', 'discipline', 'homework', 'exams', 'calendar', 'app_settings',
  'import_issues', 'conflicts',
];
const readByRole = {
  manager: collections.filter((c) => c !== 'counselor_notes'),
  teacher: collections.filter((c) => !['parent_links', 'staff_attendance', 'counselor_refs', 'counselor_notes', 'app_settings', 'import_issues', 'conflicts'].includes(c)),
  parent: collections.filter((c) => !['staff_attendance', 'staff_posts', 'counselor_refs', 'counselor_notes', 'app_settings', 'import_issues', 'conflicts'].includes(c)),
  student: collections.filter((c) => !['parent_links', 'staff_attendance', 'staff_posts', 'counselor_refs', 'counselor_notes', 'discipline', 'app_settings', 'import_issues', 'conflicts'].includes(c)),
  counselor: collections.filter((c) => !['parent_links', 'staff_attendance', 'staff_posts', 'app_settings', 'import_issues', 'conflicts'].includes(c)),
  guard: collections.filter((c) => ['schools', 'school_years', 'users', 'classes', 'subjects', 'lookups', 'schedule', 'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves', 'internships', 'homework', 'exams', 'calendar'].includes(c)),
};
const scopes = {
  manager: { role: 'manager', selfId: 1, all: true, classIds: new Set(), studentIds: new Set(), cohorts: new Set() },
  teacher: { role: 'teacher', selfId: 2, all: false, classIds: new Set([10]), studentIds: new Set([3]), cohorts: new Set() },
  parent: { role: 'parent', selfId: 4, all: false, classIds: new Set([10]), studentIds: new Set([3]), cohorts: new Set() },
  student: { role: 'student', selfId: 3, all: false, classIds: new Set([10]), studentIds: new Set([3]), cohorts: new Set() },
  counselor: { role: 'counselor', selfId: 5, all: false, classIds: new Set(), studentIds: new Set(), cohorts: new Set() },
  guard: { role: 'guard', selfId: 6, all: false, classIds: new Set(), studentIds: new Set(), cohorts: new Set() },
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
  import_issues: { id: 1 }, conflicts: { id: 1 },
};
const readScopeByRole = {
  manager: collections,
  teacher: ['schools', 'school_years', 'users', 'classes', 'subjects', 'schedule', 'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves', 'internships', 'discipline', 'homework', 'exams', 'calendar'],
  parent: ['schools', 'school_years', 'users', 'classes', 'subjects', 'schedule', 'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves', 'parent_links', 'internships', 'discipline', 'homework', 'exams', 'calendar'],
  student: ['schools', 'school_years', 'users', 'classes', 'subjects', 'schedule', 'bell_schedules', 'substitutions', 'attendance', 'grades', 'announcements', 'leaves', 'internships', 'discipline', 'homework', 'exams', 'calendar'],
  counselor: ['schools', 'school_years', 'subjects', 'bell_schedules', 'announcements', 'counselor_refs', 'counselor_notes', 'homework', 'exams', 'calendar'],
  guard: ['schools', 'school_years', 'subjects', 'bell_schedules', 'announcements', 'homework', 'exams', 'calendar'],
};
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
  checkUserFields();
  checkNegativeControls();
  console.log(`LEAK-MATRIX-57-OK roles=${roles.length} collections=${collections.length} role_collection_checks=${matrixChecks} field_checks=${fieldChecks} fail=0`);
} catch (error) {
  console.error(`LEAK-MATRIX-57-FAIL ${error.stack || error.message}`);
  process.exitCode = 1;
}
