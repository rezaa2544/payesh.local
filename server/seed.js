'use strict';
/* دادهٔ نمونه برای آزمایش و آموزش — هرگز دادهٔ واقعی نیست.
   ex: node --experimental-sqlite server/seed.js            (روی data/payesh.sqlite)
       node --experimental-sqlite server/seed.js --fresh    (پاک‌سازی و ساخت تازه)
*/
const path = require('path');
const fs = require('fs');
const { openStore } = require('./db');
const { nowISO } = require('./util');

const DATA_DIR = process.env.PAYESH_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'payesh.sqlite');
const fresh = process.argv.includes('--fresh');
if (fresh) { for (const f of [FILE, FILE + '-wal', FILE + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* noop */ } } }

const store = openStore(FILE);
let SEED = 20261031;
const rnd = () => { SEED = (SEED * 1664525 + 1013904223) % 4294967296; return SEED / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const ri = n => Math.floor(rnd() * n);

const MALE = ['امیرعلی', 'محمدحسین', 'آرش', 'سینا', 'پارسا', 'کیان', 'رضا', 'مهدی', 'علی', 'حسین', 'امیرحسین', 'یاسین', 'ماهان', 'بردیا', 'سبحان', 'ایلیا', 'دانیال', 'آرمین', 'بهنام', 'نیما', 'پویا', 'کامران', 'مسعود', 'حامد', 'شایان'];
const FEMALE = ['زهرا', 'فاطمه', 'نازنین', 'هستی', 'ریحانه', 'مریم', 'سارا', 'یلدا', 'باران', 'ترنم', 'مبینا', 'دیانا', 'آیدا', 'نگار', 'الهام', 'شقایق', 'پرنیان', 'سوگند', 'ملیکا', 'رها', 'آناهیتا', 'کیمیا', 'هلیا', 'سمانه'];
const FAMILY = ['محمدی', 'حسینی', 'رضایی', 'کریمی', 'احمدی', 'جعفری', 'موسوی', 'صادقی', 'نوری', 'شریفی', 'قاسمی', 'کاظمی', 'بهرامی', 'امینی', 'طاهری', 'فرهادی', 'زمانی', 'جوادی'];

function iso(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }

/* ── مدرسه ── */
if (!store.get('schools', 1)) {
  store.insert('schools', {
    name: 'دبیرستان کاردانش نمونه', type: 'کاردانش', level: 'متوسطه دوم', city: 'تهران',
    capabilities: { has_workshop: true, has_internships: true, has_staff_attendance: true, has_counselor: true, has_tuition: false, has_library: false, has_bus: false, has_dorm: false },
    created_at: nowISO(),
  }, { id: 1 });
  store.insert('school_years', { title: '۱۴۰۵–۱۴۰۶', active: true, school_id: 1, created_at: nowISO() }, { id: 1 });
  const manager = store.insert('users', {
    name: 'رضا مدیر', role: 'manager', phone: '09120000000', national_id: '0012345678', active: true, school_id: 1, created_at: nowISO(),
  });
  console.log('مدیر ساخته شد. برای ورود: از صفحهٔ اول «راه‌اندازی» یا کارت پیوند استفاده کنید. id =', manager.id);
}

/* ── کلاس‌ها ── */
const CLASS_DEFS = [
  ['دهم شبکه و نرم‌افزار', 'دهم', 'شبکه و نرم‌افزار رایانه'],
  ['یازدهم شبکه و نرم‌افزار', 'یازدهم', 'شبکه و نرم‌افزار رایانه'],
  ['دوازدهم شبکه و نرم‌افزار', 'دوازدهم', 'شبکه و نرم‌افزار رایانه'],
  ['دهم الکترونیک', 'دهم', 'الکترونیک'],
  ['یازدهم الکترونیک', 'یازدهم', 'الکترونیک'],
  ['دوازدهم الکترونیک', 'دوازدهم', 'الکترونیک'],
];
let classes = store.all('classes');
if (!classes.length) {
  for (const [name, grade, branch] of CLASS_DEFS) {
    store.insert('classes', { name, grade, branch, capacity: 30, school_id: 1, created_at: nowISO() });
  }
  classes = store.all('classes');
}

/* ── دروس ── */
const SUBJECT_DEFS = [
  ['ریاضی', false], ['فارسی', false], ['عربی', false], ['دین و زندگی', false], ['زبان انگلیسی', false],
  ['دانش فنی پایه', true], ['نصب و راه‌اندازی شبکه', true], ['طراحی وب', true], ['برنامه‌نویسی', true],
  ['مدارهای الکترونیکی', true], ['کارگاه الکترونیک', true], ['کارآموزی', true],
];
let subjects = store.all('subjects');
if (!subjects.length) {
  for (const [name, workshop] of SUBJECT_DEFS) {
    store.insert('subjects', { name, workshop, school_id: 1, weekly_hours: workshop ? 4 : 2, created_at: nowISO() });
  }
  subjects = store.all('subjects');
}

/* ── زنگ‌ها ── */
if (!store.all('bell_schedules').length) {
  const bells = [
    ['۰۷:۴۵', '۰۸:۳۰', 'lesson'], ['۰۸:۳۰', '۰۹:۱۵', 'lesson'], ['۰۹:۱۵', '۰۹:۳۰', 'break'],
    ['۰۹:۳۰', '۱۰:۱۵', 'lesson'], ['۱۰:۱۵', '۱۱:۰۰', 'lesson'], ['۱۱:۰۰', '۱۱:۳۰', 'break'],
    ['۱۱:۳۰', '۱۲:۱۵', 'lesson'], ['۱۲:۱۵', '۱۳:۰۰', 'lesson'],
  ];
  bells.forEach(([start, end, type], i) => {
    store.insert('bell_schedules', {
      order: i + 1, start, end, type, label: type === 'break' ? 'زنگ تفریح' : 'زنگ ' + (i + 1), school_id: 1,
    });
  });
}

/* ── دبیران ── */
let teachers = store.all('users').filter(u => u.role === 'teacher');
if (teachers.length < 10) {
  const names = ['محمد دبیر', 'فاطمه دبیر', 'علی دبیر', 'زهرا دبیر', 'حسین دبیر', 'مریم دبیر', 'رضا دبیر', 'سارا دبیر', 'امیر دبیر', 'نگار دبیر'];
  names.forEach((n, i) => {
    teachers.push(store.insert('users', {
      name: n, role: 'teacher', phone: '091210000' + String(i).padStart(2, '0'),
      subject: SUBJECT_DEFS[i % SUBJECT_DEFS.length][0], active: true, school_id: 1, created_at: nowISO(),
    }));
  });
}

/* ── برنامهٔ هفتگی ── */
if (!store.all('schedule').length) {
  const lessons = subjects.filter(s => s.name !== 'کارآموزی');
  const bellOrders = store.all('bell_schedules').filter(b => b.type === 'lesson').map(b => b.order);
  for (const cls of classes) {
    for (let weekday = 0; weekday < 5; weekday++) {
      bellOrders.forEach((order, idx) => {
        const subject = lessons[(idx + classes.indexOf(cls) + weekday) % lessons.length];
        const teacherPool = teachers.filter(t => t.subject === subject.name);
        const teacher = teacherPool.length ? teacherPool[0] : teachers[(idx + weekday) % teachers.length];
        store.insert('schedule', {
          class_id: cls.id, weekday, bell_order: order,
          subject_id: subject.id, teacher_id: teacher.id, school_id: 1, created_at: nowISO(),
        });
      });
    }
  }
}

/* ── دانش‌آموزان و اولیا ── */
let students = store.all('users').filter(u => u.role === 'student');
if (!students.length) {
  const perClass = 6;
  for (const cls of classes) {
    for (let i = 0; i < perClass; i++) {
      const female = rnd() > 0.5;
      const first = female ? pick(FEMALE) : pick(MALE);
      const last = pick(FAMILY);
      const st = store.insert('users', {
        name: first + ' ' + last, role: 'student', class_id: cls.id,
        national_id: '00' + String(10000000 + ri(89999999)),
        phone: '', active: true, school_id: 1, created_at: nowISO(),
      });
      const parent = store.insert('users', {
        name: 'ولی ' + last, role: 'parent', phone: '0913' + String(1000000 + ri(8999999)),
        active: true, school_id: 1, created_at: nowISO(),
      });
      store.insert('parent_links', { parent_id: parent.id, student_id: st.id, relation: 'father', created_at: nowISO() });
      students.push(st);
    }
  }
}

/* ── حضور ۱۰ روز اخیر ── */
if (!store.all('attendance').length) {
  for (let d = 0; d < 10; d++) {
    const day = iso(daysAgo(d));
    const wd = (daysAgo(d).getDay() + 1) % 7;   /* JS: شنبه=6 → 0 */
    if (wd >= 5) continue;
    for (const cls of classes) {
      const roster = students.filter(s => s.class_id === cls.id);
      for (const st of roster) {
        const r = rnd();
        const status = r > 0.94 ? 'absent' : (r > 0.90 ? 'late' : 'present');
        store.insert('attendance', {
          student_id: st.id, class_id: cls.id, date: day, status,
          note: '', source: 'seed', school_id: 1, created_at: nowISO(),
        });
      }
    }
  }
}

/* ── نمرات ── */
if (!store.all('grades').length) {
  for (const cls of classes) {
    const roster = students.filter(s => s.class_id === cls.id);
    const clsSubjects = [...new Set(store.all('schedule').filter(s => s.class_id === cls.id).map(s => s.subject_id))];
    for (const st of roster) {
      for (const sid of clsSubjects) {
        const subj = subjects.find(s => s.id === sid);
        const score = Math.round((10 + rnd() * 10) * 4) / 4;
        if (subj && subj.workshop) {
          store.insert('grades', {
            student_id: st.id, class_id: cls.id, subject_id: sid, term: 'نوبت اول',
            kind: 'practical', theoretical_score: Math.round((8 + rnd() * 12) * 4) / 4,
            practical_score: Math.round((12 + rnd() * 8) * 4) / 4, score,
            status: 'approved', teacher_id: null, school_id: 1, created_at: nowISO(),
          });
        } else {
          store.insert('grades', {
            student_id: st.id, class_id: cls.id, subject_id: sid, term: 'نوبت اول',
            kind: 'midterm', score, status: rnd() > 0.3 ? 'approved' : 'pending',
            teacher_id: null, school_id: 1, created_at: nowISO(),
          });
        }
      }
    }
  }
}

/* ── اطلاعیه‌ها ── */
if (!store.all('announcements').length) {
  [
    ['آغاز سال تحصیلی', 'کلاس‌ها از شنبهٔ این هفته طبق برنامهٔ هفتگی برگزار می‌شوند.', 'normal'],
    ['برنامهٔ امتحانات نوبت اول', 'برنامهٔ امتحانات هفتهٔ آینده در بخش تقویم بارگذاری شد.', 'info'],
    ['جلسهٔ اولیا و مربیان', 'جلسهٔ اولیا و مربیان پنجشنبه ساعت ۱۰ در سالن اجتماعات برگزار می‌شود.', 'important'],
  ].forEach(([title, body, severity]) => {
    store.insert('announcements', {
      title, body, severity, audience: 'all', date: iso(daysAgo(ri(5))), author_id: 1,
      school_id: 1, created_at: nowISO(),
    });
  });
}

/* ── کارآموزی پایهٔ دوازدهم ── */
if (!store.all('internships').length) {
  const seniors = classes.filter(c => c.grade === 'دوازدهم');
  for (const cls of seniors) {
    for (const st of students.filter(s => s.class_id === cls.id)) {
      for (let k = 0; k < 2; k++) {
        store.insert('internships', {
          student_id: st.id, date: iso(daysAgo(10 + k * 7)), hours: 16,
          location: k ? 'کارگاه صنعتی شهر' : 'شرکت پشتیبانی شبکه',
          status: k ? 'pending' : 'approved', note: '',
          school_id: 1, created_at: nowISO(),
        });
      }
    }
  }
}

/* ── حضور کادر ── */
if (!store.all('staff_attendance').length) {
  for (let d = 0; d < 5; d++) {
    const day = iso(daysAgo(d));
    for (const t of teachers) {
      store.insert('staff_attendance', {
        user_id: t.id, date: day, status: rnd() > 0.1 ? 'present' : 'absent', school_id: 1, created_at: nowISO(),
      });
    }
  }
}

const stats = {
  users: store.count('users'), classes: store.count('classes'), subjects: store.count('subjects'),
  schedule: store.count('schedule'), attendance: store.count('attendance'), grades: store.count('grades'),
  internships: store.count('internships'), announcements: store.count('announcements'),
};
console.log('✅ دادهٔ نمونه:', stats);
console.log('   فایل:', FILE);
console.log('   مدیر: رضا مدیر (برای ورود، از «راه‌اندازی» یا کارت پیوند استفاده کنید)');

/* ── کد پیوند نمونه برای مدیر (تا اولین ورود راحت باشد) ── */
try {
  const auth = require('./auth');
  const mgr = store.all('users').find(u => u.role === 'manager');
  if (mgr) {
    const pc = auth.createPairCode(store, mgr.id, mgr.id);
    if (pc.ok) {
      console.log('');
      console.log('  ┌──────────────────────────────────────────────┐');
      console.log('  │  کد پیوند مدیر (یک‌بارمصرف، ۷ روز):            │');
      console.log('  │      ' + pc.display + '                        │');
      console.log('  │  در صفحهٔ ورود: «ورود با کارت پیوند»            │');
      console.log('  └──────────────────────────────────────────────┘');
    }
  }
} catch (e) { console.log('pair code skipped:', e.message); }

store.close();
