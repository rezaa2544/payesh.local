'use strict';
/* ═══════════════════════════════════════════════════════════════════
   حل تعارض نسخهٔ ۱ — ردیف ۴۱
   field-level LWW با «زمان سرور» + قواعد دامنه برای نمره/حضور

   مبنای طراحی: docs/cloud/14-conflict-convergence.md (D‑28)
   قاعدهٔ کلی: **هیچ ادغام خودکاری برای دادهٔ حساس انجام نمی‌شود.**
   هر فیلد در هر کالکشن یکی از سه کلاس را دارد:

     auto   — ادغام خودکار مجاز است؛ اگر دو نوشتن روی همان فیلد برسند،
              «آخرین دریافت در سرور» برنده است (LWW با زمان سرور).
              ساعت دستگاه هیچ نقشی ندارد.
     manual — هر تغییر متعارض نیازمند تصمیم انسان مجاز است؛ مقدار
              بازنده در ردیف conflict نگه داشته می‌شود (هیچ‌گاه دور
              ریخته نمی‌شود).
     (هر فیلد نامعلوم/ذکرنشده) → manual  ← پیش‌فرضِ fail-closed

   چرا زمان سرور؟ در docs/cloud/14 §۴: «زمان کلاینت فقط اطلاعاتی است؛
   ملاک server_seq». این ماژول هم هیچ‌جا به `at` کلاینت تکیه نمی‌کند و
   برنده را از ترتیب دریافت در سرور می‌سازد (test CF‑05).
   ═══════════════════════════════════════════════════════════════════ */

/* فیلدهای ساختاری که هرگز بخشی از «تغییر داده» حساب نمی‌شوند */
const META_FIELDS = new Set([
  'id', '_version', 'version', 'at', 'uid', 'device_id', 'created_at', 'updated_at',
  'school_id', 'tenant_id', 'deleted_at', '__password_verifier',
]);

/* ── جدول قواعد دامنه (یک ردیف برای هر کالکشن محصول) ───────────────── */
const RULES = {
  /* حضور: «status» حساس است (اثر مستقیم روی کارنامه و شهریه) —
     یادداشت و ساعت ورود/خروج ادغام خودکار می‌شوند */
  attendance: {
    unit: 'row', merge: 'fields',
    auto: ['note', 'arrival_time', 'leave_time', 'excuse_note'],
    manual: ['status', 'student_id', 'class_id', 'date', 'session', 'period'],
  },
  /* نمره: خودِ score هرگز ادغام خودکار نمی‌شود؛ یادداشت/توضیح بله */
  grades: {
    unit: 'row', merge: 'fields',
    auto: ['note', 'teacher_note'],
    manual: ['score', 'kind', 'student_id', 'subject_id', 'term', 'class_id', 'exam_id'],
  },
  /* مرخصی: وضعیت تک‌مقداری است — هیچ ادغام فیلدی */
  leaves: {
    unit: 'row', merge: 'none', auto: [], manual: ['status', 'from_date', 'to_date', 'reason', 'student_id'],
  },
  /* کاربران: نام/تلفن/نشانی ادغام؛ نقش و شناسه و رمز هرگز */
  users: {
    unit: 'field', merge: 'fields',
    auto: ['name', 'phone', 'father_phone', 'mother_phone', 'guardian_phone', 'address', 'birth_date'],
    manual: ['role', 'national_id', 'class_id', 'active', 'password_hash', 'phone_hash', 'password_enc'],
  },
  homework: {
    unit: 'row', merge: 'fields', auto: ['note', 'due_date'], manual: ['title', 'description', 'class_id', 'subject_id'],
  },
  discipline: { unit: 'row', merge: 'none', auto: [], manual: [] },
  announcements: { unit: 'row', merge: 'none', auto: [], manual: [] },
  schedule: { unit: 'row', merge: 'none', auto: [], manual: [] },
  exams: { unit: 'row', merge: 'none', auto: [], manual: [] },
  calendar: { unit: 'row', merge: 'none', auto: [], manual: [] },
};

const DEFAULT_RULE = { unit: 'row', merge: 'none', auto: [], manual: [] };

function ruleOf(collection) {
  return RULES[collection] || DEFAULT_RULE;
}

/** کلاس فیلد: 'auto' | 'manual' */
function classOf(collection, field) {
  const r = ruleOf(collection);
  if (r.auto.includes(field)) return 'auto';
  return 'manual';                       /* پیش‌فرض fail-closed */
}

/**
 * فیلدهایی که مقدارشان واقعاً تغییر کرده است.
 * op همگام‌سازی یک **وصلهٔ جزئی** است: فیلدی که در بدنه نیامده «تغییر
 * نکرده» است، نه اینکه حذف شده باشد. حذف واقعی با null صریح بیان می‌شود.
 */
function changedFields(existing, incoming) {
  const out = [];
  const body = incoming || {};
  for (const k of Object.keys(body)) {
    if (META_FIELDS.has(k)) continue;
    const a = existing ? existing[k] : undefined;
    const b = body[k];
    if (JSON.stringify(a === undefined ? null : a) !== JSON.stringify(b === undefined ? null : b)) out.push(k);
  }
  return out.sort();                     /* ترتیب قطعی (docs/14 §۴) */
}

/**
 * تصمیم دربارهٔ یک op در برابر وضعیت سرور.
 * @returns {{action:'apply'|'merge'|'conflict'|'noop', fields:string[], auto:string[], manual:string[], rule:object, reason:string}}
 */
function decide({ collection, type, incoming, existing, base_version, now }) {
  const rule = ruleOf(collection);

  if (!existing) {
    /* ساخت ردیف تازه: تعارضی نیست (base_version=0 در قرارداد مجاز است) */
    return { action: 'apply', fields: [], auto: [], manual: [], rule, reason: 'new_row' };
  }

  /* حذف در برابر ویرایش: اگر کسی ردیف را بعد از نسخهٔ حذف‌کننده تغییر داده،
     حذف خودکار مجاز نیست — ردیف می‌ماند و تصمیم انسانی لازم است. */
  if (type === 'del') {
    const cur = Number(existing._version || 0);
    if (base_version != null && Number(base_version) !== cur) {
      return { action: 'conflict', fields: ['*'], auto: [], manual: ['*'], rule, reason: 'delete_vs_edit' };
    }
    return { action: 'apply', fields: [], auto: [], manual: [], rule, reason: 'delete_ok' };
  }

  const changed = changedFields(existing, incoming).filter(k => !META_FIELDS.has(k));
  if (!changed.length) return { action: 'noop', fields: [], auto: [], manual: [], rule, reason: 'no_change' };

  const auto = changed.filter(f => classOf(collection, f) === 'auto');
  const manual = changed.filter(f => classOf(collection, f) !== 'auto');

  /* تنها استثنای مستند (docs/14 §۲.۱): op «اثر انگشت رمز» بی‌نسخه */
  const keys = Object.keys(incoming || {});
  const verifierOnly = keys.length > 0 && keys.every(k => k === '__password_verifier' || META_FIELDS.has(k));
  if (verifierOnly) return { action: 'apply', fields: changed, auto, manual, rule, reason: 'password_verifier_exception' };

  if (manual.length) {
    return { action: 'conflict', fields: changed, auto, manual, rule, reason: 'sensitive_field_conflict' };
  }
  return { action: 'merge', fields: auto, auto, manual: [], rule, reason: 'auto_merge_fields' };
}

/** سند ادغام‌شده: فقط فیلدهای auto از op می‌آیند؛ بقیه از سرور */
function mergedDoc(existing, incoming, fields) {
  const out = Object.assign({}, existing);
  for (const f of fields) out[f] = incoming[f];
  return out;
}

/** شرح خوانا و قابل بازبینی برای ردیف conflict */
function describe(payload) {
  const { collection, kind, fields, rule } = payload;
  return {
    kind: kind || 'edit_vs_edit',
    collection,
    fields: Array.isArray(fields) ? fields : [],
    policy: {
      merge: rule ? rule.merge : 'none',
      auto: rule ? rule.auto : [],
      manual: rule ? rule.manual : [],
      clock: 'server_time_only',
    },
  };
}

/** کل جدول قواعد (برای سند/آزمون پوشش کامل کالکشن‌ها) */
function table() { return JSON.parse(JSON.stringify(RULES)); }

module.exports = { RULES, DEFAULT_RULE, META_FIELDS, ruleOf, classOf, changedFields, decide, mergedDoc, describe, table };
