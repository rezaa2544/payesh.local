'use strict';
/* ردیف ۱۹۷-Q04 — کلاس دانش‌آموزی جدا از اتاق؛ پیوند دانش‌آموز ↔ پایه/رشته/کلاس.
 *
 * دادهٔ واقعی هنرستان کاربر (۱۱۲ دانش‌آموز دهم در ۸ رشته) نشان داد:
 *   • در متوسطهٔ دوم (رشته‌محور) ورود اکسل پایه و رشته را روی خود دانش‌آموز می‌نویسد
 *     (`grade` + `field`) ولی هیچ کلاسی نمی‌سازد؛ صفحهٔ کلاس‌ها هم در رشته‌محور فهرست کلاس
 *     ندارد. پس «دهم نقشه کشی» هرگز ساخته نمی‌شد و هر ۱۱۲ نفر class_id خالی داشتند ⇒ حضور و
 *     غیاب هیچ کلاسی فهرست نداشت، دبیر هم (دامنه بر پایهٔ class_id) هیچ دانش‌آموزی نمی‌دید.
 *   • اتاق‌ها و کارگاه‌ها (`kind: 'room'`) در همان مجموعهٔ classes هستند و به‌جای کلاس دیده
 *     می‌شدند.
 *   • پایهٔ «دهم» دو بار تعریف شده بود (یکی از بذر سرور، یکی از گوشی) ⇒ منوی پایه می‌شکست.
 *
 * این‌جا (هنگام بالا آمدن سرور و چند ثانیه پس از هر تغییر کاربران/کلاس‌ها):
 *   ۱. تعریف تکراری (همان نوع + همان نام با یکسان‌سازی) حذف می‌شود؛ قدیمی‌ترین می‌ماند.
 *   ۲. فقط در مدرسهٔ رشته‌محور: برای هر «پایه + رشته» که دانش‌آموز بی‌کلاس دارد، کلاس
 *      دانش‌آموزی رشته‌محور (همان نام «دهم نقشه کشی») پیدا یا ساخته می‌شود و دانش‌آموزان به
 *      آن وصل می‌شوند. کلاس دستیِ هم‌نام یا هم‌پایه‌وهم‌رشته همیشه مقدم است؛ اتاق هرگز.
 *   کلاس‌محور (ابتدایی/متوسطه اول) دست نمی‌خورد: آن‌جا کلاس را مدیر می‌سازد (۰.۸.۳۰).
 *   هیچ دانش‌آموز، نمره یا حضوری حذف نمی‌شود؛ فقط class_id خالی پر می‌شود. */

const GRADE_WORDS = [['دوازدهم', 12], ['یازدهم', 11], ['دهم', 10], ['نهم', 9], ['هشتم', 8],
  ['هفتم', 7], ['ششم', 6], ['پنجم', 5], ['چهارم', 4], ['سوم', 3], ['دوم', 2], ['اول', 1]];

/** کلید یکسان: حروف عربی/فارسی، نیم‌فاصله، فاصله و نشانه‌ها نامی را جدا نمی‌کنند */
function key(v) {
  return String(v == null ? '' : v)
    .replace(/[ىي]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[\u200c\s_\-.:،؛/\\()[\]{}]+/g, '')
    .toLowerCase();
}

/** شمارهٔ پایه ۱..۱۲ (واژهٔ بلندتر اول: «یازدهم» ۱۱ است نه ۱۰) */
function gradeLevel(v) {
  const t = key(v).replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (!t) return 0;
  for (const [w, n] of GRADE_WORDS) if (t.indexOf(w) > -1) return n;
  const m = t.match(/^(\d{1,2})$/);
  return m && Number(m[1]) >= 1 && Number(m[1]) <= 12 ? Number(m[1]) : 0;
}

function branchOf(u) {
  const f = String((u && u.field) || '').trim();
  return f || String((u && u.branch) || '').trim();
}

/** مدرسهٔ رشته‌محور؟ مقطع اعلام‌شده مقدم است؛ بی‌مقطع: از خود داده */
function fieldBased(store) {
  const school = store.get('schools', 1) || {};
  const level = String(school.level || '').trim();
  if (level) return level === 'متوسطه دوم';
  for (const c of store.all('classes')) {
    if (c.kind === 'room') continue;
    if (c.mode === 'field' || String(c.branch || '').trim()) return true;
  }
  for (const u of store.all('users')) {
    if (u.role === 'student' && gradeLevel(u.grade) >= 10 && branchOf(u)) return true;
  }
  return false;
}

function repair(store) {
  const out = { lookups: 0, classes: 0, linked: 0 };
  /* ۱. تعریف‌های تکراری */
  const seen = new Set();
  const lookups = store.all('lookups').slice().sort((a, b) => Number(a.id) - Number(b.id));
  for (const l of lookups) {
    const k = String(l.kind || '') + '|' + key(l.name);
    if (!key(l.name)) continue;
    if (seen.has(k)) { store.remove('lookups', l.id); out.lookups++; } else seen.add(k);
  }
  if (!fieldBased(store)) return out;

  /* ۲. گروه‌های «پایه + رشته» دانش‌آموزان بی‌کلاس */
  const groups = new Map();
  for (const u of store.all('users')) {
    if (u.role !== 'student' || u.active === false || u.deleted === true) continue;
    if (Number(u.class_id)) continue;
    if (String(u.followup_reason || '').trim()) continue; /* «نیازمند پیگیری»: کار مدیر است */
    const g = String(u.grade || '').trim();
    const b = branchOf(u);
    if (!g || !b || gradeLevel(g) < 10) continue;
    const k = key(g) + '|' + key(b);
    if (!groups.has(k)) groups.set(k, { grade: g, branch: b, users: [] });
    groups.get(k).users.push(u);
  }
  if (!groups.size) return out;
  /* نام گروه با املای تعریف‌ها («نقشه کشی» در «رشته‌ها»)، وگرنه پرتکرارترین املا */
  const canon = new Map();
  for (const l of store.all('lookups')) {
    const k = String(l.kind || '') + '|' + key(l.name);
    if (!canon.has(k)) canon.set(k, String(l.name || '').trim());
  }
  const common = (users, pick) => {
    const n = new Map();
    for (const u of users) { const v = pick(u); n.set(v, (n.get(v) || 0) + 1); }
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  for (const grp of groups.values()) {
    grp.grade = canon.get('grade|' + key(grp.grade)) || common(grp.users, u => String(u.grade).trim());
    grp.branch = canon.get('branch|' + key(grp.branch)) || common(grp.users, branchOf);
  }
  const classes = store.all('classes').filter(c => c.kind !== 'room');
  const find = (grp) => {
    const name = key(grp.grade + ' ' + grp.branch);
    return classes.find(c => key(c.name) === name) ||
      classes.find(c => key(c.grade) === key(grp.grade) && key(c.branch) === key(grp.branch)) || null;
  };
  for (const grp of groups.values()) {
    let cls = find(grp);
    if (!cls) {
      cls = store.insert('classes', {
        name: grp.grade + ' ' + grp.branch, grade: grp.grade, branch: grp.branch, mode: 'field',
        grade_level: gradeLevel(grp.grade), kind: 'class',
        capacity: Math.max(30, grp.users.length), school_id: 1, auto_group: true,
      });
      classes.push(cls);
      out.classes++;
    }
    for (const u of grp.users) {
      store.update('users', u.id, { class_id: Number(cls.id) });
      out.linked++;
    }
  }
  return out;
}

/** هنگام بالا آمدن یک بار، سپس چند ثانیه پس از هر تغییر کاربران/کلاس‌ها/مشخصات مدرسه */
function install(store, opts = {}) {
  const delay = opts.delayMs == null ? 3000 : opts.delayMs;
  const log = opts.log || (() => {});
  let busy = false;
  let timer = null;
  const run = () => {
    if (busy) return null;
    busy = true;
    try {
      const r = repair(store);
      if (r.lookups || r.classes || r.linked) log(r);
      return r;
    } catch (e) {
      return null; /* تعمیر نباید سرور را بشکند */
    } finally {
      busy = false;
    }
  };
  run();
  const off = store.onWrite((collection) => {
    if (busy || timer) return;
    if (['users', 'classes', 'schools', 'lookups'].indexOf(collection) < 0) return;
    timer = setTimeout(() => { timer = null; run(); }, delay);
    if (timer.unref) timer.unref();
  });
  return { run, stop: () => { if (timer) clearTimeout(timer); timer = null; if (typeof off === 'function') off(); } };
}

module.exports = { repair, install, key, gradeLevel, fieldBased };
