'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۱۹۷ (Q08 / F34، Q09 / F35) — سه شیوهٔ ارزشیابی؛ همتای Dart:
   apps/payesh/packages/payesh_sync/lib/src/grade_scheme.dart (`gradeRowIssue`).

   • عددی — ۰ تا ۲۰ با «نوبت اول / نوبت دوم / پایانی».
   • پودمانی (kind: module) — دروس شایستگی هنرستان فنی‌وحرفه‌ای و کاردانش: ۵ پودمان مستقل
     (term = «پودمان ۱» … «پودمان ۵»)؛ competency ∈ {1,2,3}، continuous ∈ [0,5] با گام ۰٫۵ و
     score = competency × 5 + continuous. قبولی هر پودمان ۱۲؛ درس با قبولی هر ۵ پودمان قبول است
     (نمره = میانگین پودمان‌ها) وگرنه «ناتمام».
   • توصیفی (kind: descriptive) — دورهٔ ابتدایی: level ∈ «خیلی خوب، خوب، قابل قبول، نیاز به
     تلاش بیشتر» و بی‌نمرهٔ عددی (score تهی).
   ═══════════════════════════════════════════════════════════════════ */

const DESCRIPTIVE_LEVELS = Object.freeze(['خیلی خوب', 'خوب', 'قابل قبول', 'نیاز به تلاش بیشتر']);
const MODULE_PASS = 12;
const MODULE_COUNT = 5;

function latin(v) {
  return String(v == null ? '' : v).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0)).trim();
}

/* شمارهٔ پودمانِ یک term یا null */
function moduleOfTerm(term) {
  const m = /^پودمان\s*([1-5])$/.exec(latin(term));
  return m ? Number(m[1]) : null;
}

function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const t = latin(v);
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/* null = درست؛ وگرنه کد خطا (bad_score / bad_module / bad_level) */
function gradeIssue(row) {
  if (!row || typeof row !== 'object') return null;
  const kind = row.kind == null ? '' : String(row.kind);
  const empty = row.score == null || String(row.score).trim() === '';
  if (kind === 'descriptive') {
    if (!DESCRIPTIVE_LEVELS.includes(String(row.level == null ? '' : row.level))) return 'bad_level';
    if (!empty) return 'bad_level';
    return null;
  }
  if (kind === 'module') {
    if (moduleOfTerm(row.term) == null) return 'bad_module';
    const c = num(row.competency);
    const m = num(row.continuous);
    if (![1, 2, 3].includes(c)) return 'bad_module';
    if (m == null || m < 0 || m > 5 || !Number.isInteger(m * 2)) return 'bad_module';
    if (num(row.score) !== c * 5 + m) return 'bad_module';
    return null;
  }
  if (!empty) {
    const s = num(row.score);
    if (s == null || s < 0 || s > 20) return 'bad_score';
  }
  return null;
}

/* نتیجهٔ یک درس پودمانی از نمرهٔ ۵ پودمان (null = هنوز داده نشده) */
function moduleResult(scores) {
  const list = Array.from({ length: MODULE_COUNT }, (_, i) => (scores && scores[i] != null ? Number(scores[i]) : null));
  const failed = [];
  const missing = [];
  list.forEach((s, i) => {
    if (s == null) missing.push(i + 1);
    else if (s < MODULE_PASS) failed.push(i + 1);
  });
  const passed = !failed.length && !missing.length;
  const average = passed ? Math.round(list.reduce((a, b) => a + b, 0) / list.length * 100) / 100 : null;
  return { scores: list, failed, missing, passed, average };
}

module.exports = { DESCRIPTIVE_LEVELS, MODULE_PASS, MODULE_COUNT, moduleOfTerm, gradeIssue, moduleResult };
