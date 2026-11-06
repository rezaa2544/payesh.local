'use strict';
/* ═══════════════════════════════════════════════════════════════════
   «سلامت داده» — همان ایدهٔ دیاگ نسخهٔ p2 (src/js/42-self-diagnostics.js)

   تفاوت مهم با نسخهٔ قبلی برنامه: تا امروز هیچ‌جا کاربران تکراری
   تشخیص داده نمی‌شد. اینجا دقیقاً مثل دیاگ p2:
     ۱) هر آزمون «چه چیزی خراب است» و «چطور درست می‌شود» را جدا می‌داند
     ۲) تعمیر خودکار فقط وقتی که داده‌ای از بین نرود (safe)
     ۳) حذف کاربر هرگز خودکار نیست؛ فقط راهنما و ادغام دستی
     ۴) هر آزمون در try است تا خودِ عیب‌یاب برنامه را نشکند

   دو خانواده: داده (data) و موتور/پیکربندی (engine).
   ═══════════════════════════════════════════════════════════════════ */

const DIAG_SEVERITY = {
  critical: { fa: 'بحرانی', icon: '🔴', rank: 3 },
  warning: { fa: 'هشدار', icon: '🟡', rank: 2 },
  info: { fa: 'اطلاع', icon: '🔵', rank: 1 },
};

/* ── ابزارهای مشترک ─────────────────────────────────────────────── */
function diagFa(x) { return typeof fa === 'function' ? fa(x) : String(x); }
function diagEsc(x) { return typeof esc === 'function' ? esc(x) : String(x == null ? '' : x); }

function diagDigits(v) {
  const s = String(v == null ? '' : v)
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  return s.replace(/\D/g, '');
}

/** همان الگوریتم رقم کنترل کد ملی که در سرور هم هست */
function diagValidNid(v) {
  const n = diagDigits(v);
  if (n.length !== 10) return false;
  if (/^(\d)\1{9}$/.test(n)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += Number(n[i]) * (10 - i);
  const r = s % 11;
  const c = Number(n[9]);
  return r < 2 ? c === r : c === 11 - r;
}

function diagNormName(v) {
  return String(v == null ? '' : v)
    .replace(/[ىي]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/\u200c/g, ' ')
    .replace(/[.,،؛:_\-]/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

/** کلید ورود هر کاربر — همان قاعدهٔ ورود: شمارهٔ همراه، وگرنه کد ملی */
function diagLoginKey(u) {
  const p = diagDigits(u && u.phone);
  if (p.length >= 10) return p;
  const n = diagDigits(u && u.national_id);
  return n.length === 10 ? n : '';
}

function diagUsers() { return list('users'); }
function diagName(u) { return String((u && (u.name || u.full_name)) || '؟'); }

/* ── آزمون‌ها ─────────────────────────────────────────────────────
   هر آزمون: { id, cat, title, desc, severity, safe, check(), fix(), guide }
   check() → { ok:true } یا { ok:false, count, items, msg }
   ───────────────────────────────────────────────────────────────── */
const DIAG_CHECKS = [

  /* ── کاربران تکراری: مهم‌ترین بخش ─────────────────────────────── */
  {
    id: 'dup-nid', cat: 'data', severity: 'critical', safe: false,
    title: 'کد ملی تکراری',
    desc: 'یک کد ملی برای دو نفر یا بیشتر — ورود و کارنامه قاطی می‌شود',
    guide: 'در هر گروه یکی را نگه دارید و بقیه را با «ادغام» در آن یکی جمع کنید، یا کد ملی اشتباه را ویرایش کنید.',
    check() {
      const by = Object.create(null);
      for (const u of diagUsers()) {
        const n = diagDigits(u.national_id);
        if (n.length !== 10) continue;
        (by[n] = by[n] || []).push(u);
      }
      const items = Object.keys(by).filter(k => by[k].length > 1)
        .map(k => ({ key: k, count: by[k].length, users: by[k].map(u => ({ id: u.id, name: diagName(u), role: u.role, phone: u.phone || '' })) }));
      return items.length
        ? { ok: false, count: items.length, items, msg: items.length + ' کد ملی بین چند کاربر مشترک است' }
        : { ok: true };
    },
  },

  {
    id: 'dup-login', cat: 'data', severity: 'critical', safe: false,
    title: 'نام کاربری (ورود) تکراری',
    desc: 'دو کاربر با یک شماره/کد ملی وارد می‌شوند — یکی از آن‌ها نمی‌تواند وارد شود',
    guide: 'برای نفر دوم یک شمارهٔ همراه درست ثبت کنید یا اگر همان شخص است، حساب‌ها را ادغام کنید.',
    check() {
      const by = Object.create(null);
      for (const u of diagUsers()) {
        const k = diagLoginKey(u);
        if (!k) continue;
        (by[k] = by[k] || []).push(u);
      }
      const items = Object.keys(by).filter(k => by[k].length > 1)
        .map(k => ({ key: k, count: by[k].length, users: by[k].map(u => ({ id: u.id, name: diagName(u), role: u.role, phone: u.phone || '', nid: u.national_id || '' })) }));
      return items.length
        ? { ok: false, count: items.length, items, msg: items.length + ' نام کاربری تکراری — این افراد نمی‌توانند وارد شوند' }
        : { ok: true };
    },
    fix() {
      /* نام کاربری از شمارهٔ همراه ساخته می‌شود. اگر دو نفر یک شماره
         دارند، شماره از دومی برداشته می‌شود تا با کد ملی وارد شود
         (قابل بازگشت است و هیچ داده‌ای پاک نمی‌شود). */
      const by = Object.create(null);
      for (const u of diagUsers()) {
        const k = diagLoginKey(u);
        if (!k) continue;
        (by[k] = by[k] || []).push(u);
      }
      let n = 0, stuck = 0;
      for (const k of Object.keys(by)) {
        const grp = by[k];
        if (grp.length < 2) continue;
        grp.sort((a, b) => Number(a.id) - Number(b.id));
        for (const u of grp.slice(1)) {
          const nid = diagDigits(u.national_id);
          if (nid.length !== 10) { stuck += 1; continue; }
          const stillDup = diagUsers().some(x => Number(x.id) !== Number(u.id)
            && diagLoginKey(x) === nid);
          if (stillDup) { stuck += 1; continue; }
          typeof putLocal === 'function'
            ? putLocal('users', Object.assign({}, u, { phone: '', followup_reason: 'شمارهٔ همراه تکراری بود — با کد ملی وارد می‌شود' }))
            : null;
          n += 1;
        }
      }
      return n + ' نام کاربری تکراری اصلاح شد'
        + (stuck ? ' · ' + stuck + ' مورد کد ملی هم‌پوشان دارد و باید دستی ادغام شود' : '');
    },
  },

  {
    id: 'dup-person', cat: 'data', severity: 'critical', safe: false,
    title: 'کاربر تکراری (یک نفر، دو حساب)',
    desc: 'هم‌نام + هم‌شماره یا هم‌کدملی یا هم‌تاریخ تولد — احتمالاً یک نفر دو بار ثبت شده',
    guide: 'با «ادغام» حساب دوم را در اولی جمع کنید: نمرات، حضور، مرخصی و پیوند ولی منتقل می‌شوند و حساب تکراری حذف می‌شود.',
    check() {
      const by = Object.create(null);
      for (const u of diagUsers()) {
        const nm = diagNormName(u.name || u.full_name);
        if (!nm) continue;
        (by[nm] = by[nm] || []).push(u);
      }
      const items = [];
      for (const nm of Object.keys(by)) {
        const grp = by[nm];
        if (grp.length < 2) continue;
        /* فقط وقتی «همان شخص» است که یک نشانهٔ هویتی هم مشترک باشد */
        const same = grp.some((a, i) => grp.some((b, j) => {
          if (i >= j) return false;
          const an = diagDigits(a.national_id), bn = diagDigits(b.national_id);
          const ap = diagDigits(a.phone), bp = diagDigits(b.phone);
          return (an && an === bn) || (ap && ap === bp)
            || (a.birth_date && a.birth_date === b.birth_date)
            || (a.father_nid && a.father_nid === b.father_nid && a.mother_nid && a.mother_nid === b.mother_nid);
        }));
        if (!same) continue;
        items.push({
          key: nm, count: grp.length,
          users: grp.map(u => ({ id: u.id, name: diagName(u), role: u.role, phone: u.phone || '', nid: u.national_id || '' })),
        });
      }
      return items.length
        ? { ok: false, count: items.length, items, msg: items.length + ' نفر با دو حساب (تکراری) ثبت شده‌اند' }
        : { ok: true };
    },
  },

  {
    id: 'invalid-nid', cat: 'data', severity: 'warning', safe: false,
    title: 'کد ملی نامعتبر',
    desc: 'کد ملی‌ای که رقم کنترلش درست نیست (احتمالاً اشتباه تایپ شده)',
    guide: 'از «کاربران ← ویرایش» کد ملی درست را وارد کنید. با کد ملی نامعتبر، ورود با کد ملی کار نمی‌کند.',
    check() {
      const bad = diagUsers().filter(u => diagDigits(u.national_id).length && !diagValidNid(u.national_id));
      return bad.length
        ? {
          ok: false, count: bad.length, msg: bad.length + ' کاربر کد ملی نامعتبر دارند',
          items: bad.slice(0, 50).map(u => ({ id: u.id, name: diagName(u), nid: u.national_id, role: u.role })),
        }
        : { ok: true };
    },
  },

  {
    id: 'orphan-link', cat: 'data', severity: 'critical', safe: true,
    title: 'پیوند ولیِ بی‌صاحب',
    desc: 'پیوندی که پدر/مادر یا دانش‌آموزش پاک شده است',
    fix() {
      let n = 0;
      for (const l of list('parent_links')) {
        if (!byId('users', l.parent_id) || !byId('users', l.student_id)) {
          removeLocal('parent_links', l.id); n += 1;
        }
      }
      return n + ' پیوند بی‌صاحب پاک شد';
    },
    check() {
      const bad = list('parent_links').filter(l => !byId('users', l.parent_id) || !byId('users', l.student_id));
      return bad.length
        ? { ok: false, count: bad.length, items: bad.slice(0, 20), msg: bad.length + ' پیوند ولی به کاربرِ پاک‌شده اشاره می‌کند' }
        : { ok: true };
    },
  },

  {
    id: 'orphan-class-ref', cat: 'data', severity: 'critical', safe: true,
    title: 'دانش‌آموز در کلاسِ پاک‌شده',
    desc: 'کلاسی که حذف شده ولی دانش‌آموزش هنوز به همان کلاس اشاره می‌کند',
    fix() {
      let n = 0;
      for (const u of list('users')) {
        if (!u.class_id) continue;
        if (byId('classes', u.class_id)) continue;
        putLocal('users', Object.assign({}, u, {
          class_id: null,
          followup_reason: 'کلاسش پاک شده بود — کلاس تازه انتخاب کنید',
          followup_ack: false,
        }));
        n += 1;
      }
      return n + ' دانش‌آموز به «نیازمند پیگیری» منتقل شد';
    },
    check() {
      const bad = list('users').filter(u => u.class_id && !byId('classes', u.class_id));
      return bad.length
        ? { ok: false, count: bad.length, msg: bad.length + ' کاربر به کلاسِ پاک‌شده اشاره می‌کنند', items: bad.slice(0, 20).map(u => ({ id: u.id, name: diagName(u) })) }
        : { ok: true };
    },
  },

  {
    id: 'no-class', cat: 'data', severity: 'info', safe: false,
    title: 'دانش‌آموز بدون کلاس',
    desc: 'دانش‌آموزی که کلاسی ندارد یا کلاسش پایه/رشته ندارد',
    guide: 'در صفحهٔ «پیگیری» برای هر نفر کلاس درست را انتخاب کنید.',
    check() {
      const bad = typeof followupStudents === 'function' ? followupStudents() : [];
      return bad.length
        ? { ok: false, count: bad.length, msg: bad.length + ' دانش‌آموز کلاسِ درست ندارد', items: bad.slice(0, 20).map(x => ({ id: x.user.id, name: diagName(x.user), reason: x.reason })) }
        : { ok: true };
    },
  },

  {
    id: 'class-no-grade', cat: 'data', severity: 'warning', safe: false,
    title: 'کلاس بدون پایه',
    desc: 'کلاسی که پایه‌اش خالی یا تعریف‌نشده است (بیشتر از ورود دسته‌ای قدیمی)',
    guide: 'در صفحهٔ «کلاس‌ها» هر کلاسی را که پایه ندارد ویرایش یا حذف کنید؛ کلاس‌ها فقط دستی تعریف می‌شوند.',
    check() {
      const grades = list('lookups').filter(l => String(l.kind) === 'grade').map(l => String(l.name));
      const bad = list('classes').filter(c => {
        const g = String(c.grade || '').trim();
        return !g || (grades.length && grades.indexOf(g) < 0);
      });
      return bad.length
        ? { ok: false, count: bad.length, msg: bad.length + ' کلاس پایهٔ درست ندارد', items: bad.slice(0, 20).map(c => ({ id: c.id, name: c.name, grade: c.grade || '' })) }
        : { ok: true };
    },
  },

  {
    id: 'dup-class', cat: 'data', severity: 'warning', safe: false,
    title: 'کلاس تکراری',
    desc: 'دو کلاس با همان پایه و رشته',
    guide: 'از «کلاس‌ها ← ادغام» دانش‌آموزان و برنامهٔ یکی را در دیگری جمع کنید.',
    check() {
      const by = Object.create(null);
      for (const c of list('classes')) {
        const k = diagNormName((c.grade || '') + ' ' + (c.branch || '')) || diagNormName(c.name);
        (by[k] = by[k] || []).push(c);
      }
      const items = Object.keys(by).filter(k => k && by[k].length > 1)
        .map(k => ({ key: k, count: by[k].length, users: by[k].map(c => ({ id: c.id, name: c.name })) }));
      return items.length
        ? { ok: false, count: items.length, items, msg: items.length + ' کلاس هم‌نام/هم‌پایه وجود دارد' }
        : { ok: true };
    },
  },

  {
    id: 'dup-lookup', cat: 'data', severity: 'warning', safe: true,
    title: 'پایه/رشتهٔ تکراری در تعریف‌ها',
    desc: 'یک پایه یا رشته دو بار در فهرست تعریف شده است',
    fix() {
      let n = 0;
      const kinds = ['grade', 'branch'];
      for (const kind of kinds) {
        const by = Object.create(null);
        for (const l of list('lookups')) {
          if (String(l.kind) !== kind) continue;
          const k = diagNormName(l.name);
          (by[k] = by[k] || []).push(l);
        }
        for (const k of Object.keys(by)) {
          const grp = by[k].sort((a, b) => Number(a.id) - Number(b.id));
          if (grp.length < 2) continue;
          const keep = grp[0];
          for (const extra of grp.slice(1)) {
            /* کلاس‌هایی که به نام تکراری اشاره می‌کنند به نام نگه‌داشته‌شده برگردانده می‌شوند */
            for (const c of list('classes')) {
              const field = kind === 'grade' ? 'grade' : 'branch';
              if (String(c[field] || '') !== String(extra.name)) continue;
              putLocal('classes', Object.assign({}, c, { [field]: keep.name }));
            }
            removeLocal('lookups', extra.id);
            n += 1;
          }
        }
      }
      return n + ' تعریف تکراری پاک شد و کلاس‌ها به نام اصلی برگشتند';
    },
    check() {
      const by = Object.create(null);
      for (const l of list('lookups')) {
        const k = String(l.kind) + '|' + diagNormName(l.name);
        (by[k] = by[k] || []).push(l);
      }
      const items = Object.keys(by).filter(k => by[k].length > 1)
        .map(k => ({ key: k, count: by[k].length, users: by[k].map(l => ({ id: l.id, name: l.name })) }));
      return items.length
        ? { ok: false, count: items.length, items, msg: items.length + ' تعریف تکراری در پایه/رشته‌ها' }
        : { ok: true };
    },
  },

  {
    id: 'dup-attendance', cat: 'data', severity: 'warning', safe: true,
    title: 'حضور تکراری در یک روز',
    desc: 'برای یک دانش‌آموز در یک تاریخ دو ثبت حضور',
    fix() {
      const by = Object.create(null);
      for (const a of list('attendance')) {
        const k = Number(a.student_id) + '|' + String(a.date || '');
        (by[k] = by[k] || []).push(a);
      }
      let n = 0;
      for (const k of Object.keys(by)) {
        const grp = by[k].sort((a, b) => Number(a.id) - Number(b.id));
        for (const extra of grp.slice(1)) { removeLocal('attendance', extra.id); n += 1; }
      }
      return n + ' ثبت حضور تکراری حذف شد (اولی نگه داشته شد)';
    },
    check() {
      const by = Object.create(null);
      for (const a of list('attendance')) {
        const k = Number(a.student_id) + '|' + String(a.date || '');
        (by[k] = by[k] || []).push(a);
      }
      const dups = Object.keys(by).filter(k => by[k].length > 1);
      return dups.length
        ? { ok: false, count: dups.length, msg: dups.length + ' ثبت حضور تکراری', items: dups.slice(0, 20).map(k => ({ key: k })) }
        : { ok: true };
    },
  },

  {
    id: 'dup-grade', cat: 'data', severity: 'warning', safe: false,
    title: 'نمرهٔ تکراری',
    desc: 'برای یک دانش‌آموز، یک درس و یک نوبت دو نمرهٔ هم‌نوع',
    guide: 'در «نمره‌ها» نمرهٔ اضافی را حذف یا اصلاح کنید.',
    check() {
      const by = Object.create(null);
      for (const g of list('grades')) {
        const k = [g.student_id, g.subject_id, g.term || '', g.exam_type || ''].join('|');
        (by[k] = by[k] || []).push(g);
      }
      const dups = Object.keys(by).filter(k => by[k].length > 1);
      return dups.length
        ? {
          ok: false, count: dups.length, msg: dups.length + ' نمرهٔ تکراری',
          items: dups.slice(0, 20).map(k => {
            const g = by[k][0];
            return { id: g.id, name: (byId('users', g.student_id) || {}).name || '؟', score: g.score };
          }),
        }
        : { ok: true };
    },
  },

  {
    id: 'sched-conflict', cat: 'data', severity: 'warning', safe: false,
    title: 'تداخل برنامهٔ هفتگی',
    desc: 'یک دبیر یا یک کلاس در یک زنگ دو درس دارد',
    guide: 'در «برنامه» پیشنهاد جای آزاد را بزنید و زنگ را جابه‌جا کنید.',
    check() {
      const confs = typeof schedConflicts === 'function' ? schedConflicts() : [];
      return confs.length
        ? { ok: false, count: confs.length, msg: confs.length + ' تداخل در برنامهٔ هفتگی', items: confs.slice(0, 20).map(c => ({ key: c.key, kind: c.kind, day: c.day, period: c.period })) }
        : { ok: true };
    },
  },

  {
    id: 'stuck-queue', cat: 'engine', severity: 'warning', safe: false,
    title: 'تغییراتِ در انتظارِ ارسال',
    desc: 'تغییراتی که هنوز به حافظهٔ ابری/سرور نرسیده‌اند',
    guide: 'اگر این عدد زیاد ماند، اتصال اینترنت سیستم را بررسی کنید. برنامه خودش هر چند ثانیه دوباره تلاش می‌کند.',
    check() {
      const n = Array.isArray(window.S && S.queue) ? S.queue.length : 0;
      return n > 20
        ? { ok: false, count: n, msg: n + ' تغییر هنوز ارسال نشده است' }
        : { ok: true };
    },
  },
];

/* ── اجرا ───────────────────────────────────────────────────────── */
let DIAG_LAST = null;

function diagRun() {
  const out = [];
  for (const c of DIAG_CHECKS) {
    let res;
    try { res = c.check() || { ok: true }; }
    catch (err) { res = { ok: false, count: 1, msg: 'این آزمون اجرا نشد: ' + (err && err.message), items: [] }; }
    out.push({ check: c, res });
  }
  out.sort((a, b) => {
    if (a.res.ok !== b.res.ok) return a.res.ok ? 1 : -1;
    const ra = (DIAG_SEVERITY[a.check.severity] || {}).rank || 0;
    const rb = (DIAG_SEVERITY[b.check.severity] || {}).rank || 0;
    return rb - ra;
  });
  DIAG_LAST = { at: new Date().toISOString(), rows: out };
  return DIAG_LAST;
}

function diagSummary() {
  const run = DIAG_LAST && DIAG_LAST.at ? DIAG_LAST : diagRun();
  let bad = 0, critical = 0, warning = 0;
  for (const r of run.rows) {
    if (r.res.ok) continue;
    bad += 1;
    if (r.check.severity === 'critical') critical += 1;
    else if (r.check.severity === 'warning') warning += 1;
  }
  return { bad, critical, warning, run };
}

/* ── اجرای تعمیر ────────────────────────────────────────────────── */
async function diagFix(id) {
  const c = DIAG_CHECKS.find(x => x.id === id);
  if (!c) return;
  if (!c.fix) return toast('این مورد باید دستی اصلاح شود — راهنمایش را ببینید', 'ok');
  if (!c.safe) return toast('این مورد خودکار اصلاح نمی‌شود (احتمال از بین رفتن داده)', 'err');
  const res = c.check();
  if (res.ok) return toast('چیزی برای اصلاح نمانده', 'ok');
  if (!confirm('«' + c.title + '» — ' + fa(res.count) + ' مورد خودکار اصلاح شود؟ هیچ داده‌ای حذف نمی‌شود جز ردیف‌های تکراریِ اضافی.')) return;
  /* پیش از تعمیر، یک پشتیبان (اگر سرور در دسترس باشد) */
  try { if (typeof api === 'function' && !PHONE_MODE) await api('/api/admin/backup', { method: 'POST', body: {} }); } catch (e) { /* بی‌صدا */ }
  let msg = '';
  try { msg = c.fix(res) || 'انجام شد'; }
  catch (err) { return toast('تعمیر انجام نشد: ' + (err && err.message), 'err'); }
  if (typeof saveCache === 'function') saveCache();
  diagRun();
  if (typeof render === 'function') render();
  if (typeof flushQueue === 'function') { try { await flushQueue(); } catch (e) { /* بی‌صدا */ } }
  toast(msg, 'ok');
}

/* ── ادغام دو حسابِ تکراری ──────────────────────────────────────── */
/* همهٔ داده‌های حساب‌های اضافی به حسابِ نگه‌داشته‌شده منتقل می‌شود.
   هیچ چیزی حذف نمی‌شود مگر خودِ حساب تکراری. */
function diagMergeUsers(keepId, dropIds) {
  const keep = byId('users', Number(keepId));
  if (!keep) return { ok: false, error: 'حساب اصلی پیدا نشد' };
  const drops = dropIds.map(Number).filter(id => id !== Number(keepId) && byId('users', id));
  if (!drops.length) return { ok: false, error: 'حسابی برای ادغام انتخاب نشد' };

  /* ۱) فیلدهای خالیِ حساب اصلی از حساب‌های دیگر پر می‌شوند */
  const fill = {};
  const FIELDS = ['first_name', 'last_name', 'national_id', 'phone', 'birth_date', 'gender',
    'father_name', 'father_nid', 'father_phone', 'mother_name', 'mother_nid', 'mother_phone',
    'landline', 'residence', 'address', 'last_gpa', 'covered', 'talent', 'class_id'];
  for (const id of drops) {
    const u = byId('users', id);
    for (const f of FIELDS) {
      if ((keep[f] === undefined || keep[f] === null || keep[f] === '') && u[f] !== undefined && u[f] !== null && u[f] !== '') fill[f] = u[f];
    }
  }
  const patch = Object.assign({}, keep, fill);
  delete patch.followup_reason;
  putLocal('users', patch);

  /* ۲) داده‌های وابسته منتقل می‌شوند */
  let moved = 0;
  for (const id of drops) {
    for (const g of list('grades').filter(x => Number(x.student_id) === id)) { putLocal('grades', Object.assign({}, g, { student_id: Number(keepId) })); moved += 1; }
    for (const a of list('attendance').filter(x => Number(x.student_id) === id)) { putLocal('attendance', Object.assign({}, a, { student_id: Number(keepId) })); moved += 1; }
    for (const l of list('parent_links').filter(x => Number(x.student_id) === id)) {
      const dup = list('parent_links').some(x => Number(x.parent_id) === Number(l.parent_id) && Number(x.student_id) === Number(keepId));
      if (dup) removeLocal('parent_links', l.id);
      else { putLocal('parent_links', Object.assign({}, l, { student_id: Number(keepId) })); moved += 1; }
    }
    for (const d of list('discipline').filter(x => Number(x.student_id) === id)) { putLocal('discipline', Object.assign({}, d, { student_id: Number(keepId) })); moved += 1; }
    for (const lv of list('leaves').filter(x => Number(x.student_id) === id)) { putLocal('leaves', Object.assign({}, lv, { student_id: Number(keepId) })); moved += 1; }
    /* حساب تکراری حذف می‌شود (تنها حذفِ این عملیات) */
    removeLocal('users', id);
  }
  if (typeof saveCache === 'function') saveCache();
  return { ok: true, moved, dropped: drops.length };
}

/* ── اکشن‌ها ────────────────────────────────────────────────────── */
function diagAct(act, el, id) {
  if (act === 'diag-rerun') { diagRun(); render(); return; }
  if (act === 'diag-fix') return diagFix(id);
  if (act === 'diag-open') {
    const c = DIAG_CHECKS.find(x => x.id === id);
    if (!c) return;
    const res = c.check();
    S.modalTitle = c.title;
    if (res.ok) {
      return modal('<div class="center" style="padding:16px 0"><div style="font-size:32px">✅</div><b>چیزی پیدا نشد</b></div>' +
        '<button class="btn primary block" data-act="modal-close" style="margin-top:10px">باشه</button>');
    }
    const rows = (res.items || []).slice(0, 30).map((it, i) => {
      if (it.users) {
        return `<tr><td>${fa(i + 1)}</td><td colspan="2">
          ${it.users.map(u => `<div>${diagEsc(u.name)} <span class="small muted">· ${diagEsc(u.phone || u.nid || '')}</span></div>`).join('')}
        </td><td class="nowrap">
          <button class="btn sm" data-act="diag-merge-open" data-id="${diagEsc(it.key)}" data-check="${c.id}">ادغام</button>
        </td></tr>`;
      }
      const note = it.reason || it.nid || (it.score != null ? 'نمره ' + it.score : '') || it.key || '';
      return `<tr><td>${fa(i + 1)}</td><td>${diagEsc(it.name || it.key || '—')}</td>
        <td class="small muted">${diagEsc(note)}</td><td></td></tr>`;
    }).join('');
    const guide = c.guide ? `<div class="small muted" style="margin:8px 0;line-height:2">💡 ${diagEsc(c.guide)}</div>` : '';
    const fixBtn = c.fix && c.safe
      ? `<button id="diag-fix-btn" class="btn primary grow" data-act="diag-fix" data-id="${c.id}">اصلاح خودکار ${fa(res.count)} مورد</button>`
      : '';
    return modal(`<div class="small">${diagEsc(c.desc || '')}</div>
      <div class="small" style="margin:6px 0"><b>${fa(res.count)}</b> مورد</div>
      ${guide}
      <div class="table-wrap" style="max-height:50vh;overflow:auto"><table><thead><tr><th>#</th><th>مورد</th><th>توضیح</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="row" style="margin-top:10px;gap:8px">
        <button class="btn ghost" data-act="modal-close">بستن</button>${fixBtn}
      </div>`);
  }
  if (act === 'diag-merge-open') {
    const key = String(id || '');
    const grp = list('users').filter(u => {
      const nid = diagDigits(u.national_id), lg = diagLoginKey(u);
      return nid === key || lg === key || diagNormName(u.name || u.full_name) === key;
    });
    if (grp.length < 2) return toast('این گروه دیگر تکراری نیست', 'ok');
    S.modalTitle = 'ادغام کاربران تکراری';
    const opts = gid => grp.map(u => `<option value="${u.id}" ${Number(u.id) === Number(gid) ? 'selected' : ''}>${diagEsc(diagName(u))} — ${diagEsc(u.phone || u.national_id || '')}</option>`).join('');
    return modal(`<div class="small" style="line-height:2">
        این ${fa(grp.length)} حساب احتمالاً یک نفرند. یکی را «اصلی» انتخاب کنید؛ نمرات، حضور، مرخصی و پیوند والدین بقیه به آن منتقل و بقیه حذف می‌شوند.
      </div>
      <label class="field"><span>حساب اصلی (نگه داشته می‌شود)</span>
        <select class="input" id="diag-keep">${opts(grp[0].id)}</select></label>
      <div class="small muted" style="line-height:2">بقیهٔ حساب‌ها: ${grp.slice(1).map(u => diagEsc(diagName(u))).join('، ') || '—'}</div>
      <button class="btn primary block" data-act="diag-merge-do" data-key="${diagEsc(key)}" style="margin-top:10px">ادغام کن</button>
      <button class="btn ghost block" data-act="modal-close" style="margin-top:8px">انصراف</button>`);
  }
  if (act === 'diag-merge-do') {
    const key = String(el.getAttribute('data-key') || '');
    const keepEl = document.getElementById('diag-keep');
    const keepId = Number(keepEl && keepEl.value);
    const grp = list('users').filter(u => {
      const nid = diagDigits(u.national_id), lg = diagLoginKey(u);
      return nid === key || lg === key || diagNormName(u.name || u.full_name) === key;
    });
    const drops = grp.map(u => Number(u.id)).filter(x => x !== keepId);
    const res = diagMergeUsers(keepId, drops);
    closeModal();
    diagRun(); render();
    if (typeof flushQueue === 'function') { try { flushQueue(); } catch (e) { /* بی‌صدا */ } }
    return toast(res.ok ? ('ادغام شد · ' + fa(res.moved) + ' رکورد منتقل و ' + fa(res.dropped) + ' حساب تکراری حذف شد') : res.error, res.ok ? 'ok' : 'err');
  }
  return undefined;
}

/* ── صفحهٔ «سلامت» ──────────────────────────────────────────────── */
function diagPageHtml() {
  const run = DIAG_LAST && DIAG_LAST.at ? DIAG_LAST : diagRun();
  const bad = run.rows.filter(r => !r.res.ok);
  const good = run.rows.filter(r => r.res.ok);
  const crit = bad.filter(r => r.check.severity === 'critical').length;
  const warn = bad.filter(r => r.check.severity === 'warning').length;

  const rowHtml = r => {
    const sev = DIAG_SEVERITY[r.check.severity] || DIAG_SEVERITY.info;
    const ok = r.res.ok;
    return `<div class="item">
      <div class="grow">
        <div class="t">${ok ? '✅' : sev.icon} ${diagEsc(r.check.title)}</div>
        <div class="s">${ok ? 'درست است' : diagEsc(r.res.msg || '')}</div>
        ${!ok && r.check.guide ? `<div class="small muted" style="margin-top:4px">💡 ${diagEsc(r.check.guide)}</div>` : ''}
      </div>
      ${ok ? '<span class="badge green">سالم</span>' : `
        <span class="badge ${r.check.severity === 'critical' ? 'red' : r.check.severity === 'warning' ? 'amber' : ''}">${fa(r.res.count)}</span>
        <button class="btn sm ghost" data-act="diag-open" data-id="${diagEsc(r.check.id)}">دیدن موارد</button>
        ${r.check.fix && r.check.safe ? `<button class="btn sm" data-act="diag-fix" data-id="${diagEsc(r.check.id)}">اصلاح خودکار</button>` : ''}`}
    </div>`;
  };

  return `${pageHead('سلامت داده', bad.length ? (fa(bad.length) + ' مورد برای رسیدگی') : 'همه چیز سالم است',
    `<button class="btn sm" data-act="diag-rerun">🔄 بررسی دوباره</button>`)}

  <div class="card tight">
    <div class="row between" style="flex-wrap:wrap;gap:8px">
      <div><b>${bad.length ? '🔎' : '✅'} ${bad.length ? fa(bad.length) + ' آزمون ایراد پیدا کرد' : 'همهٔ آزمون‌ها سالم‌اند'}</b>
        <div class="small muted" style="margin-top:4px">
          ${crit ? fa(crit) + ' بحرانی' : 'بدون بحرانی'} · ${warn ? fa(warn) + ' هشدار' : 'بدون هشدار'}
          ${run.at ? ' · آخرین بررسی: ' + diagEsc(new Date(run.at).toLocaleTimeString('fa-IR')) : ''}
        </div></div>
      <span class="small muted">${fa(run.rows.length)} آزمون</span>
    </div>
  </div>

  ${bad.length ? `<div class="card"><b>ایرادها</b><div class="list" style="margin-top:6px">${bad.map(rowHtml).join('')}</div></div>` : ''}
  ${good.length ? `<div class="card"><b>سالم</b><div class="list" style="margin-top:6px">${good.map(rowHtml).join('')}</div></div>` : ''}

  <div class="small muted" style="line-height:2;margin-top:6px">
    «اصلاح خودکار» فقط برای موردهایی است که هیچ داده‌ای از بین نمی‌رود (مثل ردیف تکراریِ اضافی).
    برای کد ملی تکراری یا دو حساب از یک نفر، خودتان «ادغام» را بزنید تا نمرات و حضور و والدین منتقل شوند.
  </div>`;
}

if (window.PAGES) {
  window.PAGES.health = () => {
    if (S.role !== 'manager') return pageHead('سلامت داده') + empty('دسترسی ندارید.');
    return diagPageHtml();
  };
}

window.DIAG_ACTIONS = {
  'diag-rerun': (el) => diagAct('diag-rerun', el),
  'diag-fix': (el, id) => diagAct('diag-fix', el, id),
  'diag-open': (el, id) => diagAct('diag-open', el, id),
  'diag-merge-open': (el, id) => diagAct('diag-merge-open', el, id),
  'diag-merge-do': (el) => diagAct('diag-merge-do', el),
};

window.PayeshDiag = { run: diagRun, checks: DIAG_CHECKS, mergeUsers: diagMergeUsers, validNid: diagValidNid, loginKey: diagLoginKey, summary: diagSummary };
