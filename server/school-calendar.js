'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۱۹۷ (Q10 / F36) — روز تعطیل یا غیرحضوری (آلودگی هوا، کمبود انرژی، بیماری؛ معمولاً
   شب قبل اعلام می‌شود). همتای Dart: apps/payesh/packages/payesh_sync/lib/src/school_calendar.dart.

     calendar { date: YYYY-MM-DD, kind: closed | remote, reason, exams_to?: YYYY-MM-DD }
       closed = تعطیل (مدرسه بسته)، remote = غیرحضوری (آموزش مجازی)

   اثر واقعی:
     • آن روز «غیبت نمی‌خورد»: سرور هر ردیف حضور با وضعیت غیبت/تأخیر برای آن تاریخ را
       رد می‌کند (day_off) — حتی از مدیر؛ «حاضر/موجه» (حضور در کلاس مجازی) پذیرفته است.
     • اعلان به اولیا: کلاینت هم‌زمان یک اطلاعیهٔ «مهم» می‌نویسد (همه می‌بینند).
     • امتحان جابه‌جا: امتحان‌های داخلی آن روز به exams_to می‌روند؛ امتحان نهایی (national)
       دست مدرسه نیست و فقط هشدار داده می‌شود.
   ═══════════════════════════════════════════════════════════════════ */

const DAY_KINDS = Object.freeze(['closed', 'remote']);
const DAY_KIND_FA = Object.freeze({ closed: 'تعطیل', remote: 'غیرحضوری' });
const ABSENCE = new Set(['absent', 'late']);

function isoDay(v) {
  const s = String(v == null ? '' : v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? s : null;
}

/* شکل ردیف calendar؛ null = درست */
function dayOffIssue(row) {
  if (!row) return null;
  if (!isoDay(row.date)) return 'bad_date';
  if (!DAY_KINDS.includes(String(row.kind))) return 'bad_kind';
  const reason = String(row.reason == null ? '' : row.reason).trim();
  if (!reason) return 'reason_required';
  if (reason.length > 300) return 'reason_too_long';
  if (row.exams_to != null && row.exams_to !== '') {
    const to = isoDay(row.exams_to);
    if (!to) return 'bad_date';
    if (to <= String(row.date)) return 'bad_range';
  }
  return null;
}

/* ردیف calendar آن تاریخ (اگر تعطیل/غیرحضوری اعلام شده باشد) */
function dayOffOf(store, date) {
  const d = isoDay(date);
  if (!d || !store || typeof store.all !== 'function') return null;
  return store.all('calendar').find(r => String(r.date) === d && DAY_KINDS.includes(String(r.kind))) || null;
}

/* حضور در روز تعطیل/غیرحضوری: غیبت/تأخیر رد می‌شود */
function attendanceDayIssue(store, row) {
  if (!row || !ABSENCE.has(String(row.status))) return null;
  return dayOffOf(store, row.date) ? 'day_off' : null;
}

module.exports = { DAY_KINDS, DAY_KIND_FA, isoDay, dayOffIssue, dayOffOf, attendanceDayIssue };
