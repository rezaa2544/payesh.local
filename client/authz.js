'use strict';
/* ═══════════════════════════════════════════════════════════════════
   لایهٔ مجوزدهی — همان ایدهٔ نسخهٔ p2 (src/js/30-authz.js)

   مسئله: پیش از این فقط خودِ صفحه‌ها «اگر مدیر نیستی دسترسی نداری»
   می‌نوشتند. یعنی با عوض کردن آدرس (#/users) هر نقشی می‌توانست بدنهٔ
   صفحهٔ مدیر را ببیند و — مهم‌تر — دکمه‌های همان صفحه هم کار می‌کردند.

   راه‌حل (همان p2):
     • فهرست مسیرهای مجاز از خودِ منو (تک‌منبع حقیقت) + مسیرهای کمکی
     • یک جدول کنش‌ها: کنش‌های مدیریتی فقط برای مدیر
     • سد نهایی همیشه سمت سرور است (server/policy.js)؛ این لایه جلوی
       «دیدن و کلیک کردن» را می‌گیرد، نه جای سرور را.
   ═══════════════════════════════════════════════════════════════════ */

/* مسیرهایی که در منو نیستند ولی برای همان نقش مجازند */
const AUTHZ_EXTRA_ROUTES = {
  manager: ['record', 'child', 'attendance-report', 'followup', 'health', 'reports', 'network', 'cloud', 'system'],
  teacher: ['record', 'students', 'attendance', 'grades', 'schedule', 'system'],
  parent: ['child', 'record', 'schedule', 'leaves', 'system'],
  student: ['record', 'schedule', 'system'],
  counselor: ['record', 'students', 'schedule', 'system'],
  guard: ['schedule', 'system'],
};

/* برای همهٔ نقش‌های واردشده باز است */
const AUTHZ_COMMON = ['home', 'announcements', 'system', 'scan'];

const _AUTHZ_CACHE = Object.create(null);

function authzNavRoutes(role) {
  try {
    if (typeof navConfig !== 'function') return [];
    return (navConfig(role) || []).map(x => x[0]);
  } catch (e) { return []; }
}

/** مجموعهٔ مسیرهای مجاز یک نقش (با کش) */
function authzRoutes(role) {
  const r = String(role || '');
  if (_AUTHZ_CACHE[r]) return _AUTHZ_CACHE[r];
  const set = Object.create(null);
  authzNavRoutes(r).forEach(x => { if (x) set[x] = true; });
  (AUTHZ_EXTRA_ROUTES[r] || []).forEach(x => { set[x] = true; });
  AUTHZ_COMMON.forEach(x => { set[x] = true; });
  _AUTHZ_CACHE[r] = set;
  return set;
}

function authzCanRoute(route, role) {
  const r = String(route || 'home');
  if (!role) return false;
  return !!authzRoutes(role)[r];
}

/* ── جدول کنش‌ها ──────────────────────────────────────────────────
   فقط کنش‌های «نوشتن/مدیریت» اینجا فهرست شده‌اند؛ هر چیز دیگری که
   در این جدول نباشد با قاعدهٔ هر نقش در صفحه اجرا می‌شود (پیش‌فرض باز
   برای کنش‌های نمایشی). کنش‌های مدیریتی هیچ‌وقت با نقش دیگری اجرا نمی‌شوند.
   ───────────────────────────────────────────────────────────────── */
const AUTHZ_MANAGER_ONLY = /^(user-add|user-edit|user-delete|user-password|user-auto-pw|users-bulk-delete|pick-clear|role-filter|class-add|class-edit|class-delete|class-merge|def-add|def-edit|def-delete|def-delete-only|def-delete-cascade|def-delete-students|subject-add|subject-edit|subject-delete|import-open|import-back|import-check|import-apply|issue-fix|issue-done|issues-open|issues-clear|followup-assign|followup-ack|diag-rerun|diag-fix|diag-open|diag-merge-open|diag-merge-do|backup-now|backup-list|mirror-refresh|mirror-restore|devices-list|revoke-device|audit-list|cloud-edit|cloud-save|cloud-test|cloud-test-browser|cloud-cors|cloud-reset|cloud-phone-check|net-refresh|network|tunnel-enable|tunnel-login|tunnel-off|tunnel-refresh|update-apply|update-auto|update-autoapply|update-check|update-fetch|update-recheck|update-rollback|upd-retry|update-later|pair-code|pair-refresh|transfer|settings-save|att-all|ann-add|ann-edit|ann-delete|sched-class|schedgen-open|schedgen-apply|bell-edit|bell-add|bell-del|sched-conf-move|sched-conf-sug|sched-slot|slot-del|sub-save|sub-del|sub-del-route)$/;

/* کنش‌هایی که دبیر هم دارد (ثبت حضور و نمره و مرخصی) */
const AUTHZ_TEACHER_OK = /^(att-save|att-set|grade-save|grade-reload|leave-add|leave-delete|leave-set)$/;
/* کنش‌هایی که ولی/دانش‌آموز هم دارد */
const AUTHZ_FAMILY_OK = /^(leave-add|leave-delete|leave-set)$/;
/* کنش‌های همیشه‌مجاز (نشست، نمایش، بستن پنجره، چاپ) */
const AUTHZ_ALWAYS = /^(modal-close|modal-bg|retry|login-mode|unlock-mode|lock|pin-change|print|copy-url|originbar-off|originbar|phone-diagnose|outbox-sync|goto|sync|update-later|diag-rerun-always)$/;

/* آینه/پشتیبان: مدیر و عوامل اجرایی (همان چیزی که سرور هم اجازه می‌دهد) */
const AUTHZ_BACKUP_OK = /^(mirror-refresh|mirror-restore)$/;

function authzCanAct(act, role) {
  const a = String(act || '');
  const r = String(role || '');
  if (!a) return true;
  if (AUTHZ_ALWAYS.test(a)) return true;
  if (r === 'manager') return true;
  if (AUTHZ_BACKUP_OK.test(a)) return ['manager', 'teacher', 'counselor', 'guard'].indexOf(r) >= 0;
  if (AUTHZ_MANAGER_ONLY.test(a)) return false;
  /* خانواده (مرخصی) پیش از دبیر بررسی می‌شود: کنش مشترک است */
  if (AUTHZ_FAMILY_OK.test(a)) return r === 'teacher' || r === 'parent' || r === 'student';
  if (AUTHZ_TEACHER_OK.test(a)) return r === 'teacher';
  return true;
}

/* ── صفحهٔ «دسترسی ندارید» ──────────────────────────────────────── */
function authzDeniedHtml(route) {
  const label = (typeof AUTHZ_ROUTE_FA !== 'undefined' && AUTHZ_ROUTE_FA[route]) || '';
  const home = S.user ? S.role : '';
  return `<div class="topbar"><div><h2>دسترسی ندارید</h2>
      <div class="small muted">این صفحه برای نقش شما باز نیست</div></div></div>
    <div class="card center" style="padding:26px">
      <div style="font-size:38px">🔒</div>
      <b style="display:block;margin:8px 0">${label ? '«' + label + '»' : 'این بخش'} برای نقش شما در دسترس نیست</b>
      <div class="small muted" style="line-height:2">
        با حساب «${home ? (typeof ROLE_FA !== 'undefined' ? (ROLE_FA[home] || home) : home) : 'شما'}» وارد شده‌اید.
        اگر فکر می‌کنید باید دسترسی داشته باشید، از مدیر مدرسه بخواهید نقش حسابتان را بررسی کند.
      </div>
      <a class="btn primary" href="#/home" style="margin-top:12px">بازگشت به خانه</a>
    </div>`;
}

const AUTHZ_ROUTE_FA = {
  home: 'خانه', users: 'کاربران', classes: 'کلاس‌ها', schedule: 'برنامه', reports: 'گزارش‌ها',
  attendance: 'حضور و غیاب', 'attendance-report': 'حضور و غیاب', grades: 'نمره', students: 'دانش‌آموزان',
  announcements: 'اطلاعیه‌ها', leaves: 'مرخصی', record: 'پرونده', network: 'شبکه',
  cloud: 'حافظهٔ ابری', system: 'سیستم', followup: 'نیازمند پیگیری', health: 'سلامت داده', child: 'فرزند',
};

window.authzCanRoute = authzCanRoute;
window.authzCanAct = authzCanAct;
window.authzDeniedHtml = authzDeniedHtml;
window.authzRoutes = authzRoutes;
window.PayeshAuthz = { routes: authzRoutes, canRoute: authzCanRoute, canAct: authzCanAct, extra: AUTHZ_EXTRA_ROUTES, common: AUTHZ_COMMON };
