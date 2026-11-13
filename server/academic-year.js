'use strict';
/* ═══════════════════════════════════════════════════════════════════
   سال تحصیلی و پایان اشتراک‌ها — ردیف ۱۴۹ (درخواست مالک ۱۴۰۵/۰۸/۲۲)
   ───────────────────────────────────────────────────────────────────
   قاعده‌های مالک:
     • همهٔ اشتراک‌ها در پایان سال تحصیلی (۳۱ شهریور، ساعت ۲۴ به وقت تهران) تمام می‌شوند؛
       برای سال جدید همه دوباره می‌خرند.
     • ماهانه: ۳۱ روز از زمان پرداخت (یا از پایان اشتراک فعالِ فعلی)، ولی هرگز از پایان
       همان سال تحصیلی جلوتر نمی‌رود (۳۱ شهریور صفر می‌شود).
     • سالانه: همیشه مبلغ کامل؛ تا پایان سال تحصیلی جاری اعتبار دارد، حتی اگر دیر (مثلاً
       بهمن) خریده شود.
     • از ۱ تیر «پنجرهٔ تمدید» باز است و به مدیران مدرسه هشدار تمدید داده می‌شود. سالانه‌ای
       که در این پنجره خریده شود سال تحصیلی بعد را پوشش می‌دهد (وگرنه تمدیدِ پیش از ۳۱
       شهریور بی‌معنا می‌شد)؛ ماهانه از پایان اشتراک فعلی ادامه پیدا می‌کند.
     • دورهٔ آزمایشی و «هدیه» هم از پایان سال تحصیلی جلوتر نمی‌روند.
   تقویم: تبدیل جلالی ⇄ میلادی همان الگوریتم client/import.js و payesh_ui JalaliDate.
   منطقهٔ زمانی: تهران UTC+03:30 (ساعت تابستانی از ۱۴۰۱ برداشته شده است).
   بردار مشترک Node ⇄ Dart: docs/cloud/contracts/academic-year-vectors.json
   ═══════════════════════════════════════════════════════════════════ */

const DAY_MS = 24 * 3600_000;
const TEHRAN_OFFSET_MS = 210 * 60_000;
const MONTHLY_DAYS = 31;
const RENEW_MONTH = 4; // تیر
const div = (a, b) => Math.floor(a / b);

function toJalali(gy, gm, gd) {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 365 * gy + div(gy2 + 3, 4) - div(gy2 + 99, 100) + div(gy2 + 399, 400) - 80 + gd + gdm[gm - 1];
  jy += 33 * div(days, 12053); days %= 12053;
  jy += 4 * div(days, 1461); days %= 1461;
  if (days > 365) { jy += div(days - 1, 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + div(days, 31) : 7 + div(days - 186, 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

function toGregorian(jy, jm, jd) {
  let gy = jy <= 979 ? 621 : 1600;
  jy -= jy <= 979 ? 0 : 979;
  let days = 365 * jy + div(jy, 33) * 8 + div((jy % 33) + 3, 4) + 78 + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  gy += 400 * div(days, 146097); days %= 146097;
  if (days > 36524) { gy += 100 * div(--days, 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * div(days, 1461); days %= 1461;
  if (days > 365) { gy += div(days - 1, 365); days = (days - 1) % 365; }
  let gd = days + 1;
  const sal = [0, 31, ((gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 1;
  for (; gm <= 12 && gd > sal[gm]; gm++) gd -= sal[gm];
  return [gy, gm, gd];
}

/** تاریخ جلالیِ لحظهٔ ms به وقت تهران. */
function tehranJalali(ms) {
  const d = new Date(ms + TEHRAN_OFFSET_MS);
  return toJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** لحظهٔ ساعت ۰۰:۰۰ تهرانِ یک روز جلالی (میلی‌ثانیهٔ UTC). */
function tehranMidnight(jy, jm, jd) {
  const [gy, gm, gd] = toGregorian(jy, jm, jd);
  return Date.UTC(gy, gm - 1, gd) - TEHRAN_OFFSET_MS;
}

/** سال تحصیلی‌ای که لحظهٔ ms در آن است؛ با سال پایانی‌اش نام‌گذاری می‌شود (۱۴۰۴-۱۴۰۵ ⇒ 1405). */
function academicYearOf(ms) {
  const [jy, jm] = tehranJalali(ms);
  return jm >= 7 ? jy + 1 : jy;
}

/** پایان سال تحصیلی (۳۱ شهریور ساعت ۲۴ = ۱ مهر ساعت ۰۰:۰۰ تهران)؛ همیشه بزرگ‌تر از ms. */
function yearEndMs(ms) {
  return tehranMidnight(academicYearOf(ms), 7, 1);
}

/** شروع پنجرهٔ تمدید (۱ تیر) در سال تحصیلیِ لحظهٔ ms. */
function renewOpenMs(ms) {
  return tehranMidnight(academicYearOf(ms), RENEW_MONTH, 1);
}

const inRenewWindow = (ms) => ms >= renewOpenMs(ms);

/** پایان اشتراک ماهانه: ۳۱ روز از max(اکنون، پایان فعلی)، با سقف پایان همان سال تحصیلی. */
function monthlyEnd(nowMs, curEndMs = 0) {
  const from = curEndMs > nowMs ? curEndMs : nowMs;
  return Math.min(from + MONTHLY_DAYS * DAY_MS, yearEndMs(from));
}

/** پایان اشتراک سالانه: پایان سال جاری؛ در پنجرهٔ تمدید (از ۱ تیر) پایان سال بعد. */
function yearlyEnd(nowMs, curEndMs = 0) {
  let end = yearEndMs(nowMs);
  if (inRenewWindow(nowMs)) end = yearEndMs(end);
  if (curEndMs >= end) end = yearEndMs(curEndMs);
  return end;
}

/** پایان روزشمار (آزمایشی، هدیه): از max(اکنون، پایان فعلی) + روزها، با سقف پایان همان سال. */
function daysEnd(nowMs, days, curEndMs = 0) {
  const from = curEndMs > nowMs ? curEndMs : nowMs;
  return Math.min(from + days * DAY_MS, yearEndMs(from));
}

/** پایان اشتراک برای یک پلن. */
function planEnd(planKey, nowMs, curEndMs = 0) {
  return planKey === 'yearly' ? yearlyEnd(nowMs, curEndMs) : monthlyEnd(nowMs, curEndMs);
}

/** هشدار تمدید: از ۱ تیر، وقتی اشتراک سال بعد هنوز خریده نشده است. */
function renewWarning(nowMs, endMs) {
  if (!inRenewWindow(nowMs)) return false;
  return !(endMs > yearEndMs(nowMs));
}

const iso = (ms) => new Date(ms).toISOString();

module.exports = {
  DAY_MS, MONTHLY_DAYS, TEHRAN_OFFSET_MS, toJalali, toGregorian, tehranJalali, tehranMidnight,
  academicYearOf, yearEndMs, renewOpenMs, inRenewWindow, monthlyEnd, yearlyEnd, daysEnd, planEnd,
  renewWarning, iso,
};
