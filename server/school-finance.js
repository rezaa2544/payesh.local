'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۱۹۷ (Q07 / F31, F32, F33) — نوع مدرسه با اثر واقعی، هیئت امنا و کمک داوطلبانه.

   • شهریهٔ اجباری فقط در مدرسهٔ غیردولتی (غیرانتفاعی) معنا دارد. طبق بخشنامهٔ ۱۴۰۵ دریافت شهریه
     در مدارس دولتی (از جمله نمونه دولتی، شاهد، هنرستان و شبانه‌روزی دولتی) ممنوع است؛ آنچه
     مردم می‌دهند «کمک داوطلبانه» است (آیین‌نامهٔ مشارکت‌های مردمی) — نه شرط ثبت‌نام، نه مبلغ ثابت.
   • «هیئت امنا» شیوهٔ مدیریت است نه نوع مدرسه: از ۱۴۰۵ همهٔ مدارس دولتی هیئت امنا دارند ⇒
     صفحهٔ «هیئت امنا» (اعضا + جلسه/مصوبه) برای هر مدرسهٔ دولتی.
   • «اثر واقعی»: schoolFeatures(مدرسه) فهرست صفحه‌هایی است که این مدرسه دارد؛ برنامه (Dart:
     payesh_ui/lib/src/school_profile.dart `schoolFeatures`) منو را با همین روشن/خاموش می‌کند و
     سرور ردیفی که به صفحهٔ خاموش تعلق دارد نمی‌پذیرد (شهریه در مدرسهٔ دولتی ⇒ tuition_public).

   دو کالکشن تازه (فقط مدیر):
     contributions  { kind: voluntary|tuition, payer, amount (ریال), date, purpose?, student_id?,
                      receipt_no?, note? }
     trustees       { kind: member  → name, post, phone?
                      kind: meeting → date, title, decisions }
   ═══════════════════════════════════════════════════════════════════ */

/* نوع‌هایی که «شهریه» در آن‌ها مجاز است (همان TUITION_TYPES در school-profile) */
const TUITION_TYPES = ['non_profit'];
const CONTRIBUTION_KINDS = ['voluntary', 'tuition'];
const TRUSTEE_KINDS = ['member', 'meeting'];
const TRUSTEE_POSTS = ['رئیس', 'نایب‌رئیس', 'دبیر', 'خزانه‌دار', 'عضو'];
const MAX_AMOUNT = 1e13; /* ریال — سقف معقول یک ردیف */
const LIMITS = { payer: 120, purpose: 200, receipt: 40, note: 500, name: 120, phone: 20, title: 200, decisions: 4000 };

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const str = (v) => (v == null ? '' : String(v)).trim();

function capsOf(school) {
  const c = (school && school.capabilities) || {};
  return (k) => c[k] === 1 || c[k] === true;
}

/* مدرسهٔ دولتی؟ (هر نوعی جز غیرانتفاعی) */
function isPublicSchool(school) {
  const t = school && school.school_type ? String(school.school_type) : 'governmental';
  return !TUITION_TYPES.includes(t);
}

/* شهریه روشن است؟ — فقط غیردولتی و فقط با قابلیت has_tuition */
function tuitionOn(school) {
  return !isPublicSchool(school) && capsOf(school)('has_tuition');
}

/* صفحه‌هایی که این مدرسه دارد (منوها) — رونوشت Dart: schoolFeatures */
function schoolFeatures(school) {
  const has = capsOf(school);
  const out = ['contributions'];
  if (isPublicSchool(school)) out.push('trustees');
  if (tuitionOn(school)) out.push('tuition');
  for (const [cap, f] of [['has_iep', 'iep'], ['has_dorm', 'dorm'], ['has_workshop', 'workshop'], ['has_multigrade', 'multigrade'], ['has_evening', 'evening']]) {
    if (has(cap)) out.push(f);
  }
  return out;
}

/* شکل ردیف کمک/شهریه ⇒ کد خطا یا null. school = ردیف schools/1 (برای قاعدهٔ شهریه؛ در آینهٔ ابری
   بدون مدرسه فقط شکل سنجیده می‌شود). */
function contributionIssue(row, school) {
  if (!row || typeof row !== 'object') return 'bad_row';
  const kind = str(row.kind) || 'voluntary';
  if (!CONTRIBUTION_KINDS.includes(kind)) return 'bad_kind';
  if (kind === 'tuition' && school !== undefined && !tuitionOn(school)) return 'tuition_public';
  const payer = str(row.payer);
  if (!payer || payer.length > LIMITS.payer) return 'payer';
  const amount = Number(row.amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) return 'amount';
  if (!isDate(row.date)) return 'bad_date';
  if (str(row.purpose).length > LIMITS.purpose || str(row.receipt_no).length > LIMITS.receipt ||
    str(row.note).length > LIMITS.note) return 'too_long';
  if (row.student_id != null && row.student_id !== '' && !Number.isInteger(Number(row.student_id))) return 'bad_student';
  /* کمک داوطلبانه هرگز «اجباری/شرط ثبت‌نام» علامت نمی‌خورد */
  if (kind === 'voluntary' && (row.required === true || row.mandatory === true)) return 'voluntary_required';
  return null;
}

/* شکل ردیف هیئت امنا ⇒ کد خطا یا null */
function trusteeIssue(row) {
  if (!row || typeof row !== 'object') return 'bad_row';
  const kind = str(row.kind);
  if (!TRUSTEE_KINDS.includes(kind)) return 'bad_kind';
  if (kind === 'member') {
    const name = str(row.name);
    if (!name || name.length > LIMITS.name) return 'member_name';
    if (!TRUSTEE_POSTS.includes(str(row.post))) return 'member_post';
    if (str(row.phone).replace(/\D/g, '').length > LIMITS.phone) return 'too_long';
    return null;
  }
  if (!isDate(row.date)) return 'bad_date';
  const title = str(row.title);
  if (!title || title.length > LIMITS.title) return 'meeting_title';
  if (str(row.decisions).length > LIMITS.decisions) return 'too_long';
  return null;
}

module.exports = {
  TUITION_TYPES, CONTRIBUTION_KINDS, TRUSTEE_KINDS, TRUSTEE_POSTS, MAX_AMOUNT, LIMITS,
  isPublicSchool, tuitionOn, schoolFeatures, contributionIssue, trusteeIssue,
};
