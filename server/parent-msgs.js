'use strict';
/* ═══════════════════════════════════════════════════════════
   ردیف ۱۹۷ (Q12 / F27، F29) — پیام ولی به مدرسه/دبیر/مشاور، نوبت مشاوره، و جلسه‌های مشاور.

   کالکشن تازه:
     parent_msgs { student_id, parent_id (مُهرِ سرور = نویسندهٔ ولی), to: school|teacher|counselor,
                   teacher_id (فقط وقتی to=teacher؛ از برنامهٔ کلاسِ فرزند — ولی نام دبیر را نمی‌بیند،
                   «دبیرِ <درس>» را می‌بیند), subject_id?, kind: message|appointment, text,
                   want_date? (روزِ دلخواهِ نوبت)، reply?, replied_by (مُهرِ سرور),
                   appt_date?, appt_time? (نوبتِ قطعی)، status: open|answered|scheduled|closed }
     خواندن: مدیر همه؛ ولی ردیف‌های فرزندان خودش (هر دو ولی)؛ دبیر فقط to=teacher و teacher_id=خودش؛
             مشاور فقط to=counselor.
     نوشتن: ولی فقط می‌سازد (open، بی‌پاسخ و بی‌نوبت) و تا وقتی باز است متن خودش را ویرایش می‌کند؛
            گیرنده (دبیرِ همان پیام، مشاور، مدیر) فقط پاسخ/وضعیت/نوبت را می‌گذارد — متن، فرزند و
            گیرنده عوض نمی‌شود؛ مشاور خودش هم برای ولیِ هر دانش‌آموز نوبت می‌گذارد
            (kind=appointment، status=scheduled).

   counselor_notes (موجود؛ فقط مشاور می‌خواند): kind = session (جلسهٔ خوداقدام/ارجاعی) | guidance
     (هدایت تحصیلی پایهٔ نهم/دهم با رشتهٔ پیشنهادی track)؛ date، text، ref_id?
   ═══════════════════════════════════════════════════════════ */

const MSG_TO = ['school', 'teacher', 'counselor'];
const MSG_KINDS = ['message', 'appointment'];
const MSG_STATUSES = ['open', 'answered', 'scheduled', 'closed'];
/* آنچه گیرنده می‌گذارد — ولی هرگز */
const REPLY_FIELDS = ['reply', 'replied_by', 'appt_date', 'appt_time'];
/* آنچه پس از ساخته‌شدن برای غیرمدیر ثابت است */
const FIXED_FIELDS = ['student_id', 'parent_id', 'to', 'teacher_id', 'kind', 'text'];
const NOTE_KINDS = ['session', 'guidance'];
/* رشته‌های هدایت تحصیلی پایهٔ نهم (نظری، فنی‌وحرفه‌ای، کاردانش) */
const GUIDANCE_TRACKS = ['ریاضی و فیزیک', 'علوم تجربی', 'علوم انسانی', 'علوم و معارف اسلامی', 'فنی‌وحرفه‌ای', 'کاردانش'];
const LIMITS = { text: 1000, reply: 1000, note: 2000 };

const str = (v) => (v == null ? '' : String(v)).trim();
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00Z'));
const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const empty = (v) => v == null || str(v) === '';
const posInt = (v) => v != null && /^\d{1,15}$/.test(String(v)) && Number(v) > 0;

/* شکل ردیف parent_msgs برای همهٔ نقش‌ها (مدیر هم) — '' یعنی درست */
function msgIssue(row) {
  if (!row) return '';
  if (!posInt(row.student_id)) return 'student_required';
  if (!MSG_TO.includes(str(row.to))) return 'bad_to';
  if (!MSG_KINDS.includes(str(row.kind || 'message'))) return 'bad_kind';
  if (str(row.to) === 'teacher' ? !posInt(row.teacher_id) : !empty(row.teacher_id)) return 'teacher_required';
  if (str(row.kind) === 'appointment' && str(row.to) === 'teacher') return 'bad_to';
  const t = str(row.text);
  if (!t) return 'text_required';
  if (t.length > LIMITS.text) return 'text_too_long';
  if (str(row.reply).length > LIMITS.reply) return 'text_too_long';
  if (!empty(row.want_date) && !isDate(row.want_date)) return 'bad_date';
  if (!empty(row.appt_date) && !isDate(row.appt_date)) return 'bad_date';
  if (!empty(row.appt_time) && !isTime(row.appt_time)) return 'bad_time';
  if (!empty(row.appt_time) && empty(row.appt_date)) return 'bad_date';
  const st = str(row.status || 'open');
  if (!MSG_STATUSES.includes(st)) return 'bad_status';
  if (st === 'scheduled' && (str(row.kind) !== 'appointment' || empty(row.appt_date))) return 'appt_required';
  return '';
}

/* ولی: فقط «باز»، بی‌پاسخ و بی‌نوبت — '' یعنی درست */
function parentMsgIssue(row, existing) {
  if (row && row !== existing) {
    if (!empty(row.status) && str(row.status) !== 'open') return 'approval_denied';
    for (const f of REPLY_FIELDS) if (!empty(row[f])) return 'approval_denied';
  }
  if (existing && str(existing.status || 'open') !== 'open') return 'msg_answered';
  return '';
}

/* غیرمدیرِ گیرنده (و ولیِ ویرایشگر): فیلدهای ثابت عوض نمی‌شوند. row ممکن است وصله باشد
   (store.update ادغام می‌کند) — فقط فیلدهایی که آمده‌اند سنجیده می‌شوند. skip: فیلدهایی که آزادند. */
function fixedChanged(row, existing, skip) {
  if (!row || !existing || row === existing) return '';
  const free = new Set(skip || []);
  for (const f of FIXED_FIELDS) {
    if (free.has(f) || row[f] === undefined) continue;
    if (str(row[f]) !== str(existing[f])) return 'msg_fixed';
  }
  return '';
}

/* گیرندهٔ این پیام کیست؟ (مدیر همه را می‌گیرد) */
function isRecipient(role, uid, row) {
  if (!row) return false;
  if (role === 'manager') return true;
  if (role === 'teacher') return str(row.to) === 'teacher' && Number(row.teacher_id) === Number(uid);
  if (role === 'counselor') return str(row.to) === 'counselor';
  return false;
}

/* شکل counselor_notes — '' یعنی درست (ردیف‌های قدیمیِ بی‌kind = جلسه) */
function noteIssue(row) {
  if (!row) return '';
  if (!posInt(row.student_id)) return 'student_required';
  const k = str(row.kind || 'session');
  if (!NOTE_KINDS.includes(k)) return 'bad_kind';
  if (!empty(row.date) && !isDate(row.date)) return 'bad_date';
  const t = str(row.text != null ? row.text : row.note);
  if (!t && k === 'session') return 'text_required';
  if (t.length > LIMITS.note) return 'text_too_long';
  if (k === 'guidance' && !GUIDANCE_TRACKS.includes(str(row.track))) return 'bad_track';
  return '';
}

module.exports = {
  MSG_TO, MSG_KINDS, MSG_STATUSES, REPLY_FIELDS, FIXED_FIELDS, NOTE_KINDS, GUIDANCE_TRACKS, LIMITS,
  msgIssue, parentMsgIssue, fixedChanged, isRecipient, noteIssue,
};
