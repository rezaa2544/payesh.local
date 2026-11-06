'use strict';
// سیاست نقش/دامنه — پیاده‌سازی نمونهٔ محدود از ماتریس ۰۱ §۳.۲ و D‑24
// اصل: Default Deny. هر چیزی که در جدول نیامده «ممنوع» است.

const SCOPES = ['S0', 'S1', 'S2', 'S3', 'S4'];

// نقش‌های D‑24 (نام مصوب). vice_principal در محصول امروز معادل ندارد ولی در طراحی هست.
const ROLES = [
  'platform_owner', 'platform_operator', 'platform_support',
  'manager', 'vice_principal', 'teacher', 'counselor', 'parent', 'student', 'guard',
];

// school data: خواندن/نوشتن/تأیید/حذف + دامنه. `null` = ممنوع
const SCHOOL_DATA = {
  users: {
    manager:        { r: 'S3', w: 'S3', d: 'S3' },
    vice_principal: { r: 'S3', w: 'S3' },
    teacher:        { r: 'S2' },
    counselor:      { r: 'S2' },
    parent:         { r: 'S1' },
    student:        { r: 'S0' },
    guard:          { r: 'S0' },
  },
  grades: {
    manager:        { r: 'S3', w: 'S3', a: 'S3', d: 'S3' },
    vice_principal: { r: 'S3' },              // بدون تأیید (۰۱ §۳.۲)
    teacher:        { r: 'S2', w: 'S2' },
    counselor:      { r: 'S2' },
    parent:         { r: 'S1' },
    student:        { r: 'S0' },
  },
  attendance: {
    manager:        { r: 'S3', w: 'S3', a: 'S3', d: 'S3' },
    vice_principal: { r: 'S3', w: 'S3', a: 'S3' },
    teacher:        { r: 'S2', w: 'S2', a: 'S2' },
    counselor:      { r: 'S2' },
    parent:         { r: 'S1' },
    student:        { r: 'S0' },
  },
  audit: {
    manager:        { r: 'S3' },
  },
  tenant_meta: {
    manager:        { r: 'S3' },
  },
};

// دادهٔ سطح پلتفرم — مسیر جدا (۰۱ §۳.۱). در این نمونه فقط فرادادهٔ سلامت.
const PLATFORM_DATA = {
  platform_health: {
    platform_owner:    { r: 'S4' },
    platform_operator: { r: 'S4' },
    platform_support:  { r: 'S4' },
  },
};

function isPlatformRole(role) {
  return role === 'platform_owner' || role === 'platform_operator' || role === 'platform_support';
}

// can(role, resource, action) ⇒ { allowed, scope, reason }
function can(role, resource, action) {
  if (!ROLES.includes(role)) return { allowed: false, scope: null, reason: 'unknown_role' };
  const table = resource === 'platform_health' ? PLATFORM_DATA : SCHOOL_DATA;
  const row = table[resource];
  if (!row) return { allowed: false, scope: null, reason: 'unknown_resource' };
  const perm = row[role];
  if (!perm) return { allowed: false, scope: null, reason: 'default_deny' };
  const scope = perm[action];
  if (!scope) return { allowed: false, scope: null, reason: 'no_permission' };
  return { allowed: true, scope, reason: 'granted' };
}

module.exports = { SCOPES, ROLES, SCHOOL_DATA, PLATFORM_DATA, isPlatformRole, can };
