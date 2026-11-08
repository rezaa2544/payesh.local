'use strict';
/* ═══════════════════════════════════════════════════════════════════
   برنامهٔ هفتگی — همان بخشِ «برنامه» در نسخهٔ p2، مو‌به‌مو:

     • جدولِ شش‌روزه (شنبه تا پنج‌شنبه) با خانه‌های قابلِ کلیک
     • کنترلِ تداخلِ دبیر و کلاس + پیشنهادِ جایِ آزاد و جابه‌جایی
     • جابه‌جای موقت (دبیر جایگزین برای یک تاریخِ مشخص)
     • تولید خودکارِ برنامه با پیش‌نمایش و ثبتِ تأییدشده
     • تنظیمِ زنگ‌ها (زمانِ شروع/پایان، درس یا تفریح)
     • نمای دبیر («تدریس من»)، دبیر پایه («سرپرستی») و دانش‌آموز

   داده در همان کالکشن‌های سامانه می‌نشیند تا با بقیهٔ صفحه‌ها یکی باشد:
     schedule       → { class_id, subject_id, teacher_id, weekday, bell_order }
     bell_schedules → { order, start, end, type, label }
     substitutions  → { schedule_id, sub_teacher_id, date }
   ═══════════════════════════════════════════════════════════════════ */

const SCHED_DAY_FA = ['شنبه', 'یک‌شنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه'];

/* ── زنگ‌ها ──────────────────────────────────────────────────────── */
function schedLessons() {
  const sorted = list('bell_schedules')
    .filter(b => String(b.type || 'lesson') === 'lesson')
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  const seen = new Set();
  const bells = sorted.filter(b => {
    const order = Number(b.order || 0);
    if (seen.has(order)) return false;
    seen.add(order); return true;
  });
  if (bells.length) return bells;
  /* اگر مدرسه هنوز زنگی تعریف نکرده، شش زنگِ پیش‌فرض نشان داده می‌شود
     تا برنامه‌ریزی از همان روز اول ممکن باشد (با «تنظیم زنگ‌ها» قابل تغییر). */
  return [1, 2, 3, 4, 5, 6].map(n => ({ order: n, start: '', end: '', type: 'lesson', label: 'زنگ ' + n }));
}
function schedPeriods() { return schedLessons().map(b => Number(b.order)); }
function schedBellOf(period) {
  return schedLessons().find(b => Number(b.order) === Number(period)) || null;
}
function schedBellLabel(period) {
  const b = schedBellOf(period);
  const label = b && String(b.label || '').trim();
  return label || ('زنگ ' + fa(period));
}

/* ── تداخل‌ها ────────────────────────────────────────────────────── */
/* تداخلِ دبیر سراسری است (یک دبیر می‌تواند در چند مدرسه باشد)؛
   تداخلِ کلاس طبیعتاً درونِ همان کلاس است. */
function schedTeacherBusyAt(teacherId, day, period, exceptId) {
  if (!Number(teacherId)) return null;
  return list('schedule').find(x => Number(x.teacher_id) === Number(teacherId)
    && Number(x.weekday) === Number(day)
    && Number(x.bell_order) === Number(period)
    && Number(x.id) !== Number(exceptId || 0)) || null;
}
function schedClassBusyAt(classId, day, period, exceptId) {
  return list('schedule').find(x => Number(x.class_id) === Number(classId)
    && Number(x.weekday) === Number(day)
    && Number(x.bell_order) === Number(period)
    && Number(x.id) !== Number(exceptId || 0)) || null;
}
function schedConflicts() {
  const rows = list('schedule');
  const out = [];
  const seenT = {}, seenC = {};
  rows.forEach(r => {
    if (r.teacher_id) {
      const k = 't|' + r.teacher_id + '|' + r.weekday + '|' + r.bell_order;
      if (!seenT[k]) {
        seenT[k] = 1;
        const all = rows.filter(x => Number(x.teacher_id) === Number(r.teacher_id)
          && Number(x.weekday) === Number(r.weekday) && Number(x.bell_order) === Number(r.bell_order));
        if (all.length > 1) out.push({ kind: 'teacher', key: k, teacher_id: Number(r.teacher_id), day: Number(r.weekday), period: Number(r.bell_order), rows: all.slice().sort((a, b) => a.id - b.id) });
      }
    }
    const kc = 'c|' + r.class_id + '|' + r.weekday + '|' + r.bell_order;
    if (!seenC[kc]) {
      seenC[kc] = 1;
      const allc = rows.filter(x => Number(x.class_id) === Number(r.class_id)
        && Number(x.weekday) === Number(r.weekday) && Number(x.bell_order) === Number(r.bell_order));
      if (allc.length > 1) out.push({ kind: 'class', key: kc, class_id: Number(r.class_id), day: Number(r.weekday), period: Number(r.bell_order), rows: allc.slice().sort((a, b) => a.id - b.id) });
    }
  });
  out.sort((a, b) => (a.day - b.day) || (a.period - b.period) || (a.kind === b.kind ? 0 : (a.kind === 'class' ? -1 : 1)));
  return out;
}
/* جای‌های آزادِ پیشنهادی برای یک زنگ (کلاس و دبیر هر دو آزاد) — حداکثر ۳ */
function schedSuggestSlots(rowId) {
  const row = byId('schedule', Number(rowId));
  if (!row) return [];
  const out = [];
  const activeDays = schedWorkDays();
  const days = activeDays.length ? activeDays : SCHED_DAY_FA.map((_, i) => i);
  for (const di of days) {
    if (out.length >= 3) break;
    for (const p of schedPeriods()) {
      if (out.length >= 3) break;
      if (Number(row.weekday) === di && Number(row.bell_order) === Number(p)) continue;
      if (schedClassBusyAt(row.class_id, di, p, row.id)) continue;
      if (schedTeacherBusyAt(row.teacher_id, di, p, row.id)) continue;
      out.push({ day: di, period: Number(p) });
    }
  }
  return out;
}

/* ── کمکی‌های کارت و نام ────────────────────────────────────────── */
function schedName(kind, id) {
  const r = byId(kind, Number(id));
  return r ? (r.name || r.full_name || '') : '';
}
function schedTeacherName(id) { return schedName('users', id) || 'بدون دبیر'; }
function schedSubjectName(id) { return schedName('subjects', id) || '—'; }
function schedSubs(scheduleId) {
  return list('substitutions').filter(x => Number(x.schedule_id) === Number(scheduleId));
}
function schedSubsToday() {
  const map = Object.create(null);
  const today = todayISO();
  list('substitutions').forEach(x => { if (String(x.date) === today) map[Number(x.schedule_id)] = x; });
  return map;
}

/* ══════════════ نمای صفحه ══════════════ */
function schedWorkDays() {
  const school = byId('schools', 1) || {};
  const raw = Array.isArray(school.workdays) ? school.workdays : [0, 1, 2, 3, 4, 5];
  return [...new Set(raw.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d < SCHED_DAY_FA.length))].sort((a, b) => a - b);
}
function schedRooms() {
  return sortBy(list('classes').filter(c => c.kind === 'room' || (!c.kind && !c.grade && !c.branch)), 'name');
}
function schedGroupFor(grade, branch, create) {
  const g = String(grade || '').trim(), b = String(branch || '').trim();
  if (!g) return null;
  let found = list('classes').find(c => c.kind !== 'room' && String(c.grade || '').trim() === g && String(c.branch || '').trim() === b);
  if (found || !create) return found || null;
  const level = typeof impGradeLevel === 'function' ? impGradeLevel(g) : 0;
  const name = (g + (b ? ' ' + b : '')).trim();
  found = list('classes').find(c => c.kind !== 'room' && String(c.name || '').trim() === name);
  if (found) return found;
  return putLocal('classes', { name, grade: g, branch: b, mode: b ? 'field' : 'class', grade_level: level, kind: 'class', capacity: 30, school_id: 1 });
}
function schedCohortOf(user) {
  const u = user || {};
  const cls = byId('classes', u.class_id) || {};
  return { grade: String(u.grade || cls.grade || '').trim(), branch: String(u.branch || cls.branch || '').trim() };
}
function schedSameCohort(row, cohort) {
  return String(row.grade || '').trim() === String(cohort.grade || '').trim()
    && String(row.branch || '').trim() === String(cohort.branch || '').trim();
}
function schedPage() {
  const role = S.role || (S.user && S.user.role) || '';
  const isMgr = role === 'manager';
  const isTeacher = role === 'teacher';
  const myId = Number((S.user && S.user.id) || 0);
  const classes = sortBy(list('classes').filter(c => c.kind !== 'room'), 'name');
  const grades = typeof lookupList === 'function' ? lookupList('grade') : [];
  const branches = typeof lookupList === 'function' ? lookupList('branch') : [];
  const gradeNames = alphaSort([...new Set(grades.map(x => String(x.name)).concat(classes.map(c => String(c.grade || ''))).filter(Boolean))]);
  const branchNames = alphaSort([...new Set(branches.map(x => String(x.name)).concat(classes.map(c => String(c.branch || '')).filter(Boolean)))]);
  const selectedGrade = isMgr ? String(S.schedGrade || gradeNames[0] || '') : '';
  let matchingGroups = classes.filter(c => String(c.grade || '') === selectedGrade);
  const availableBranches = alphaSort([...new Set(matchingGroups.map(c => String(c.branch || '')).concat(branchNames))]);
  const selectedBranch = isMgr ? String(S.schedBranch != null ? S.schedBranch : ((matchingGroups[0] && matchingGroups[0].branch) || '')) : '';
  const cohort = { grade: selectedGrade, branch: selectedBranch };
  const group = isMgr ? schedGroupFor(selectedGrade, selectedBranch, false) : null;
  const cid = group ? Number(group.id) : 0;

  /* دبیر پایه: این انتخاب برای «سرپرستی» باقی می‌ماند، نه برای ساخت برنامه. */
  const homeCls = isTeacher ? sortBy(classes.filter(c => Number(c.teacher_id) === myId), 'name') : [];
  const homePick = Number(S.homepick || 0);
  const inHome = !!(homePick && homeCls.some(c => Number(c.id) === homePick));
  let readOnly = false;
  let viewerCohort = null;
  let viewerClass = 0;
  if (role === 'student') {
    const user = byId('users', myId) || S.user || {};
    viewerClass = Number(user.class_id || 0); viewerCohort = schedCohortOf(user); readOnly = true;
  } else if (role === 'parent') {
    const linked = list('parent_links').filter(l => Number(l.parent_id) === myId).map(l => Number(l.student_id));
    const kids = linked.map(sid => byId('users', sid)).filter(Boolean);
    const kid = kids.find(k => Number(k.class_id) === Number(S.schedClass)) || kids[0];
    viewerClass = Number((kid || {}).class_id || 0); viewerCohort = schedCohortOf(kid); readOnly = true;
  } else if (!isMgr && !isTeacher) {
    viewerClass = Number(S.schedClass || (classes[0] && classes[0].id) || 0); readOnly = true;
  }
  const rows = isMgr
    ? list('schedule').filter(s => schedSameCohort(s, cohort) || (!s.grade && cid && Number(s.class_id) === cid))
    : (isTeacher && !inHome)
      ? list('schedule').filter(s => Number(s.teacher_id) === myId)
      : isTeacher
        ? list('schedule').filter(s => Number(s.class_id) === homePick)
        : list('schedule').filter(s => (viewerClass && Number(s.class_id) === viewerClass) || (viewerCohort && viewerCohort.grade && schedSameCohort(s, viewerCohort)));
  const canEdit = isMgr && !!selectedGrade && !readOnly;
  const cObj = inHome ? byId('classes', homePick) : (isMgr ? { grade: cohort.grade, branch: cohort.branch } : byId('classes', viewerClass));
  const showTeacher = !isTeacher || inHome;
  const title = inHome
    ? 'برنامهٔ کلاسی ' + (cObj ? cObj.name : '')
    : (isTeacher ? 'برنامهٔ هفتگی تدریس من' : 'برنامهٔ هفتگی');
  const subsToday = schedSubsToday();
  const activeDays = schedWorkDays();
  const displayedDays = activeDays.length ? activeDays : [0, 1, 2, 3, 4, 5];

  const confs = schedConflicts();
  let confBlock = '';
  if (isMgr) {
    if (confs.length) {
      confBlock = card(`<b style="color:var(--red)">⚠️ ${fa(confs.length)} تداخل در برنامهٔ هفتگی</b>
        <div style="line-height:2;margin-top:6px">${confs.map(c => {
          const who = c.kind === 'teacher' ? schedTeacherName(c.teacher_id) : schedName('classes', c.class_id);
          const other = c.rows.map(r => esc(c.kind === 'teacher' ? (r.grade ? r.grade + (r.branch ? ' ' + r.branch : '') : schedName('classes', r.class_id)) : schedSubjectName(r.subject_id))).join(' و ');
          return `<div class="small" style="margin-top:8px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card)">
            <div><b>${c.kind === 'teacher' ? 'دبیر' : 'پایه و رشته'}: ${esc(who)}</b> — ${SCHED_DAY_FA[c.day]} زنگ ${fa(c.period)}: ${other}</div>
            <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:6px">${c.rows.map(r => {
              const sugs = schedSuggestSlots(r.id);
              const label = c.kind === 'teacher' ? 'زنگ «' + (r.grade ? r.grade + (r.branch ? ' ' + r.branch : '') : schedName('classes', r.class_id)) + '»' : 'درس «' + schedSubjectName(r.subject_id) + '»';
              const boxId = 'sug-' + String(c.key).replace(/[^a-z0-9]/gi, '') + '-' + fa(r.id);
              return `<div class="row" style="gap:6px;flex-wrap:wrap"><span class="muted">${esc(label)}:</span>
                <button class="btn ghost sm" data-act="sched-conf-sug" data-box="${esc(boxId)}">🔎 پیشنهاد جایِ آزاد</button>
                <div id="${esc(boxId)}" style="display:none;gap:6px;flex-wrap:wrap">${sugs.length ? sugs.map(g => `<button class="btn sm" data-act="sched-conf-move" data-id="${r.id}" data-day="${g.day}" data-period="${g.period}">جابه‌جایی به ${SCHED_DAY_FA[g.day]} زنگ ${fa(g.period)}</button>`).join('') : '<span class="small" style="color:var(--red)">جایِ آزاد پیدا نشد — یک زنگ را دستی خالی کنید.</span>'}</div></div>`;
            }).join('')}</div></div>`;
        }).join('')}</div>`);
    } else confBlock = card('<span class="badge green">✅ بدون تداخل — همهٔ زنگ‌ها آزاد است</span>');
  } else if (isTeacher) {
    const mine = confs.filter(c => c.kind === 'teacher' && Number(c.teacher_id) === myId);
    if (mine.length) confBlock = card(`<b style="color:var(--amber)">⚠️ ${fa(mine.length)} تداخل ساعتی شما در برنامه</b>
      <div class="small muted" style="margin-top:4px">${mine.map(c => SCHED_DAY_FA[c.day] + ' زنگ ' + fa(c.period)).join(' · ')}</div>
      <div class="small muted" style="margin-top:4px">جابه‌جایی را مدیر انجام می‌دهد.</div>`);
  }

  const cellOf = (d, p) => rows.find(r => Number(r.weekday) === d && Number(r.bell_order) === Number(p));
  const periods = schedPeriods();
  const head = pageHead(title, cObj ? [cObj.grade, cObj.branch].filter(Boolean).join(' · ') : (isTeacher ? 'همهٔ برنامه‌های شما' : ''),
    `${isMgr ? `<button class="btn sm ghost" data-act="workdays-edit">📅 روزهای فعال</button><button class="btn sm ghost" data-act="bell-edit">⏱️ تنظیم زنگ‌ها</button>` : ''}
     ${canEdit ? `<button class="btn sm" data-act="schedgen-open">⚙️ تولید خودکار</button>` : ''}`);

  const cohortPicker = isMgr ? `<div class="card tight"><div class="row" style="gap:10px;flex-wrap:wrap;align-items:end">
    <label class="field grow" style="min-width:150px;margin:0"><span>پایه</span><select class="input" data-set="schedGrade">${gradeNames.map(g => `<option value="${esc(g)}" ${g === selectedGrade ? 'selected' : ''}>${esc(g)}</option>`).join('')}${!gradeNames.length ? '<option value="">پایه تعریف نشده</option>' : ''}</select></label>
    <label class="field grow" style="min-width:150px;margin:0"><span>رشته</span><select class="input" data-set="schedBranch"><option value="" ${selectedBranch ? '' : 'selected'}>— بدون رشته —</option>${[...new Set(availableBranches)].filter(Boolean).map(b => `<option value="${esc(b)}" ${b === selectedBranch ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></label>
  </div><div class="small muted" style="margin-top:7px">برنامه برای این پایه و رشته چیده می‌شود؛ محل برگزاری را برای هر زنگ جداگانه انتخاب کنید.</div></div>` : '';
  const homePicker = isTeacher && homeCls.length ? `<div class="card tight"><div class="row between"><b class="small">نمای من</b>
      <select class="input" style="max-width:260px" data-set="homepick"><option value="">تدریس من</option>${homeCls.map(c => `<option value="${esc(c.id)}" ${Number(c.id) === homePick ? 'selected' : ''}>سرپرستی: ${esc(c.name)}</option>`).join('')}</select></div></div>` : '';
  if (isMgr && !selectedGrade) return head + cohortPicker + card(`<div class="muted small">برای چیدن برنامه، ابتدا پایه و رشته را در بخش «کلاس‌ها» تعریف کنید.</div><a class="btn primary" href="#/classes" style="margin-top:8px">تعریف پایه و رشته</a>`);

  const grid = `<div class="card"><div class="table-wrap"><div class="timetable" style="grid-template-columns:74px repeat(${displayedDays.length},minmax(112px,1fr))">
    <div class="tt-head"></div>${displayedDays.map(d => `<div class="tt-head"><b>${SCHED_DAY_FA[d]}</b></div>`).join('')}
    ${periods.map(p => `<div class="tt-head tt-period"><span class="badge purple">زنگ ${fa(p)}</span>${(schedBellOf(p) && schedBellOf(p).start) ? `<span class="small muted ltr">${esc(schedTime(schedBellOf(p).start) || schedBellOf(p).start)}${schedBellOf(p).end ? ' – ' + esc(schedTime(schedBellOf(p).end) || schedBellOf(p).end) : ''}</span>` : ''}</div>
      ${displayedDays.map(d => { const r = cellOf(d, p); if (r) {
        const sub = subsToday[Number(r.id)]; const room = r.room || schedName('classes', r.room_id);
        return `<div class="tt-cell" ${canEdit ? `role="button" tabindex="0" data-act="sched-slot" data-day="${d}" data-period="${p}" data-id="${r.id}"` : ''}>
          <b>${esc(schedSubjectName(r.subject_id))}</b><span class="small muted">${esc(showTeacher ? schedTeacherName(r.teacher_id) : (r.grade ? r.grade + (r.branch ? ' ' + r.branch : '') : ''))}</span>
          ${room ? `<span class="small" style="color:#6b7280">🏫 ${esc(room)}</span>` : ''}${sub ? `<span class="badge amber" style="margin-top:3px">🔁 ${esc(schedTeacherName(sub.sub_teacher_id))}</span>` : ''}</div>`;
      }
      return `<div class="tt-cell tt-empty" ${canEdit ? `role="button" tabindex="0" data-act="sched-slot" data-grade="${esc(cohort.grade)}" data-branch="${esc(cohort.branch)}" data-class-id="${cid}" data-day="${d}" data-period="${p}"` : ''}><span class="small muted">${canEdit ? '+ افزودن' : '—'}</span></div>`;
      }).join('')}`).join('')}
  </div></div>${canEdit ? '<div class="small muted" style="margin-top:10px;line-height:2">💡 روی خانه بزنید تا درس، دبیر و محل برگزاری را مشخص کنید. روزهای غیرفعال از جدول حذف شده‌اند.</div>' : ''}${canEdit ? schedSubsList(rows) : ''}</div>`;
  return head + cohortPicker + homePicker + confBlock + grid + (rows.length || canEdit ? '' : card(emptyNote));
}

/* فهرستِ جابه‌جای‌های موقتِ همین کلاس */
function schedSubsList(rows) {
  const ids = new Set(rows.map(r => Number(r.id)));
  const subs = list('substitutions').filter(x => ids.has(Number(x.schedule_id)))
    .sort((a, b) => String(a.date) < String(b.date) ? -1 : 1);
  if (!subs.length) return '';
  return `<div style="margin-top:10px;padding-top:8px;border-top:1px dashed var(--line)">
    <b class="small">🔁 جابه‌جای‌های موقت این کلاس</b>
    <div class="small" style="line-height:2.3;margin-top:4px">${subs.map(x => {
      const r = rows.find(rr => Number(rr.id) === Number(x.schedule_id)) || {};
      return `<div style="margin-bottom:4px">${esc(jdate(x.date))} — ${SCHED_DAY_FA[Number(r.weekday) || 0] || ''} زنگ ${fa(r.bell_order || 0)}، ${esc(schedSubjectName(r.subject_id))} — <b>${esc(schedTeacherName(x.sub_teacher_id))}</b>
        <a data-act="sub-del-route" data-id="${esc(x.id)}" style="color:var(--red);cursor:pointer;font-weight:600">حذف</a></div>`;
    }).join('')}</div></div>`;
}

/* ══════════════ پنجرهٔ زنگ (تعریف/ویرایش) ══════════════ */
function schedTeachers() {
  return sortBy(list('users').filter(u => u.role === 'teacher' && u.active !== false), 'name');
}
function schedSubjects() {
  return sortBy(list('subjects'), 'name');
}
function schedSlotModal(s) {
  s = s || {};
  const editing = !!Number(s.id);
  const day = Number(s.weekday || s.day || 0);
  const period = Number(s.bell_order || s.period || schedPeriods()[0] || 1);
  const grade = String(s.grade || S.schedGrade || '');
  const branch = String(s.branch != null ? s.branch : (S.schedBranch || ''));
  const group = schedGroupFor(grade, branch, false);
  const classId = Number(s.class_id || (group && group.id) || 0);
  const subs = schedSubjects();
  const teachers = schedTeachers().map(t => {
    const busy = schedTeacherBusyAt(t.id, day, period, s.id || 0);
    return { id: t.id, name: (busy ? '🔴 ' : '🟢 ') + (t.name || '') + (busy ? ' — در این ساعت مشغول' : '') };
  });
  const rooms = schedRooms();
  const legacyRoomOption = s.room && !Number(s.room_id) ? [[ '', 'مکان قبلی: ' + s.room ]] : [];
  const sel = (name, opts, val) => `<select class="input" name="${name}"${name === 'subject' ? ' required aria-required="true"' : ''}>${opts.map(o => `<option value="${esc(o[0])}" ${String(o[0]) === String(val == null ? '' : val) ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
  let subBlock = '';
  if (editing) {
    const exSub = schedSubs(s.id)[0];
    subBlock = `<div style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--line)"><b class="small">🔁 جابه‌جای موقت</b>
      <div class="small muted" style="margin:4px 0 8px">اگر دبیر در روز خاصی غایب است، برای همان تاریخ دبیر جایگزین تعیین کنید.</div>
      ${exSub ? `<div class="small" style="margin-bottom:8px">جابه‌جای فعلی: <b>${esc(schedTeacherName(exSub.sub_teacher_id))}</b> در ${esc(jdate(exSub.date))}</div>` : ''}
      <div class="row"><label class="field grow"><span>تاریخ شمسی</span>${jalaliDateControl('sub_date', exSub ? String(exSub.date || '').slice(0, 10) : '', { className: 'grow' })}</label>
        <label class="field grow"><span>دبیر جایگزین</span>${sel('sub_teacher', [['', '— انتخاب دبیر —']].concat(schedTeachers().map(t => [t.id, t.name])), exSub ? exSub.sub_teacher_id : '')}</label></div>
      <div class="row" style="gap:8px;margin-top:8px"><button type="button" class="btn sm" data-act="sub-save" data-id="${esc(s.id)}">ثبت جابه‌جای</button>
        ${exSub ? `<button type="button" class="btn ghost sm" data-act="sub-del" data-id="${esc(s.id)}">حذف جابه‌جای</button>` : ''}</div></div>`;
  }
  const days = schedWorkDays();
  const shownDays = days.length ? days : [0, 1, 2, 3, 4, 5];
  S.modalTitle = editing ? 'ویرایش زنگ' : ('افزودن درس — ' + SCHED_DAY_FA[day] + ' زنگ ' + fa(period));
  modal(`<form data-form="slot">
    <input type="hidden" name="id" value="${esc(s.id || '')}"><input type="hidden" name="class_id" value="${esc(classId)}">
    <input type="hidden" name="grade" value="${esc(grade)}"><input type="hidden" name="branch" value="${esc(branch)}"><input type="hidden" name="legacy_room" value="${esc(s.room || '')}">
    <div class="small muted" style="margin-bottom:7px">پایه و رشته: <b>${esc(grade + (branch ? ' · ' + branch : ''))}</b></div>
    <div class="row"><label class="field grow"><span>روز فعال مدرسه</span>${sel('day', shownDays.map(d => [d, SCHED_DAY_FA[d]]), day)}</label>
      <label class="field grow"><span>زنگ</span>${sel('period', schedPeriods().map(p => [p, schedBellLabel(p)]), period)}</label></div>
    <label class="field"><span>درس</span><div class="row" style="gap:6px">${sel('subject', [['', '— انتخاب درس —']].concat(subs.map(x => [x.id, x.name])), s.subject_id)}
      <button type="button" class="btn sm" data-act="sched-subject-add" title="تعریف درس تازه">+ درس</button></div></label>
    <label class="field"><span>دبیر</span><div class="row" style="gap:6px">${sel('teacher', [['', '— بدون دبیر —']].concat(teachers.map(t => [t.id, t.name])), s.teacher_id)}
      <button type="button" class="btn sm" data-act="sched-teacher-add" title="ثبت دبیر تازه">+ دبیر</button></div></label>
    <label class="field"><span>محل برگزاری</span><div class="row" style="gap:6px">${sel('room_id', [['', legacyRoomOption.length ? legacyRoomOption[0][1] : '— انتخاب محل —']].concat(rooms.map(r => [r.id, r.name])), s.room_id)}
      <button type="button" class="btn sm" data-act="sched-room-add" title="افزودن محل تازه">+ محل</button></div>
      <span class="small muted">از محل‌های تعریف‌شده در بخش کلاس‌ها انتخاب کنید، یا همین‌جا محل تازه بسازید.</span></label>
    <div class="small muted" style="margin-top:8px;line-height:2">🟢 دبیر آزاد · 🔴 دبیر مشغول در همان ساعت — ثبت زنگِ دارای تداخل ممکن نیست.</div>
    <button class="btn primary block" style="margin-top:10px">ذخیرهٔ زنگ</button>
    ${editing ? '<button type="button" class="btn danger block" style="margin-top:8px" data-act="slot-del" data-id="' + esc(s.id) + '">حذف این زنگ</button>' : ''}${subBlock}
  </form>`);
}

/* وضعیتِ فعلیِ فرم (برای اینکه با تغییر روز/زنگ، فهرست دبیران تازه شود) */
function schedSlotState(form) {
  const f = form.elements;
  return {
    id: Number(f.id.value) || 0,
    class_id: Number(f.class_id.value) || 0,
    grade: String(f.grade.value || ''), branch: String(f.branch.value || ''),
    room_id: Number(f.room_id.value) || 0,
    weekday: Number(f.day.value),
    bell_order: Number(f.period.value),
    subject_id: Number(f.subject.value) || null,
    teacher_id: Number(f.teacher.value) || null,
  };
}

/* ══════════════ تولید خودکار (همان الگوریتم p2) ══════════════ */
function schedGenerate(plan) {
  plan = plan || {};
  const classes = plan.classes || [];
  const subjects = plan.subjects || [];
  const teachers = plan.teachers || [];
  const existing = plan.existing || [];
  const days = (plan.days && plan.days.length) ? plan.days.slice() : [0, 1, 2, 3, 4, 5];
  const PPD = plan.periodsPerDay || 6;

  const subjMatch = (sub, cls) => {
    if (sub.grade && cls.grade && sub.grade !== cls.grade) return false;
    if (sub.branch && cls.branch && sub.branch !== cls.branch) return false;
    return true;
  };
  const specOf = {};
  subjects.forEach(s => {
    specOf[s.id] = teachers.filter(t => Number(t.subject_id) === Number(s.id))
      .map(t => t.id).sort((a, b) => a - b);
  });
  const load = {};
  teachers.forEach(t => { load[t.id] = 0; });
  existing.forEach(r => { if (r.teacher_id != null) load[r.teacher_id] = (load[r.teacher_id] || 0) + 1; });

  const classBusy = {};
  const teacherBusy = {};
  existing.forEach(r => {
    classBusy[r.class_id + '|' + r.day + '|' + r.period] = 1;
    if (r.teacher_id != null) teacherBusy[r.teacher_id + '|' + r.day + '|' + r.period] = 1;
  });

  const covered = {};
  existing.forEach(r => {
    if (r.subject_id == null) return;
    const k = r.class_id + '|' + r.subject_id;
    covered[k] = (covered[k] || 0) + 1;
  });

  const demands = [];
  classes.forEach(cls => {
    subjects.forEach(sub => {
      if (!subjMatch(sub, cls)) return;
      let h = Math.max(0, Math.floor(Number(sub.weekly_hours) || 0));
      h = Math.max(0, h - (covered[cls.id + '|' + sub.id] || 0));
      for (let i = 0; i < h; i++) demands.push({ class_id: cls.id, subject_id: sub.id });
    });
  });
  demands.sort((a, b) => {
    const sa = (specOf[a.subject_id] || []).length ? 0 : 1;
    const sb = (specOf[b.subject_id] || []).length ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const hoursOf = id => { const s = subjects.find(x => Number(x.id) === Number(id)); return Number(s && s.weekly_hours) || 0; };
    const ha = hoursOf(a.subject_id), hb = hoursOf(b.subject_id);
    if (ha !== hb) return hb - ha;
    if (a.class_id !== b.class_id) return a.class_id - b.class_id;
    return a.subject_id - b.subject_id;
  });

  const pickTeacher = subId => {
    const cands = (specOf[subId] || []).slice().sort((a, b) => ((load[a] || 0) - (load[b] || 0)) || (a - b));
    return cands.length ? cands[0] : null;
  };
  const classSubjDays = {};
  existing.forEach(r => {
    if (r.subject_id == null) return;
    const k = r.class_id + '|' + r.subject_id;
    (classSubjDays[k] = classSubjDays[k] || {})[r.day] = 1;
  });
  const slotFree = (classId, teacherId, d, p) => {
    if (classBusy[classId + '|' + d + '|' + p]) return false;
    if (teacherId != null && teacherBusy[teacherId + '|' + d + '|' + p]) return false;
    return true;
  };
  const findSlot = (classId, teacherId, subId) => {
    const used = classSubjDays[classId + '|' + subId] || {};
    for (let pass = 0; pass < 2; pass++) {
      for (let di = 0; di < days.length; di++) {
        const d = days[di];
        if (pass === 0 && used[d]) continue;
        for (let p = 1; p <= PPD; p++) if (slotFree(classId, teacherId, d, p)) return { day: d, period: p };
      }
    }
    return null;
  };

  const placements = [];
  const unplaced = [];
  let noSpecialist = 0;

  const commit = pl => {
    placements.push(pl);
    classBusy[pl.class_id + '|' + pl.day + '|' + pl.period] = 1;
    if (pl.teacher_id != null) {
      teacherBusy[pl.teacher_id + '|' + pl.day + '|' + pl.period] = 1;
      load[pl.teacher_id] = (load[pl.teacher_id] || 0) + 1;
    }
    const k = pl.class_id + '|' + pl.subject_id;
    (classSubjDays[k] = classSubjDays[k] || {})[pl.day] = 1;
  };
  const uncommit = pl => {
    const i = placements.indexOf(pl);
    if (i >= 0) placements.splice(i, 1);
    delete classBusy[pl.class_id + '|' + pl.day + '|' + pl.period];
    if (pl.teacher_id != null) {
      delete teacherBusy[pl.teacher_id + '|' + pl.day + '|' + pl.period];
      load[pl.teacher_id] = Math.max(0, (load[pl.teacher_id] || 1) - 1);
    }
  };
  const displace = (classId, teacherId, subId) => {
    for (const victim of placements.slice()) {
      if (victim.class_id !== classId) continue;
      uncommit(victim);
      const alt = findSlot(victim.class_id, victim.teacher_id, victim.subject_id);
      if (alt && (alt.day !== victim.day || alt.period !== victim.period)) {
        const mine = findSlot(classId, teacherId, subId);
        if (mine) {
          victim.day = alt.day; victim.period = alt.period;
          commit(victim);
          return mine;
        }
      }
      commit(victim);
    }
    return null;
  };

  demands.forEach(dm => {
    const tid = pickTeacher(dm.subject_id);
    if (tid == null) noSpecialist++;
    let slot = findSlot(dm.class_id, tid, dm.subject_id);
    if (!slot) slot = displace(dm.class_id, tid, dm.subject_id);
    if (slot) commit({ class_id: dm.class_id, subject_id: dm.subject_id, teacher_id: tid, day: slot.day, period: slot.period });
    else unplaced.push({ class_id: dm.class_id, subject_id: dm.subject_id, teacher_id: tid, reason: tid == null ? 'جایِ خالی برای کلاس نیست' : 'جایِ خالیِ مشترک برای کلاس و دبیر نیست' });
  });

  return { placements, unplaced, stats: { demands: demands.length, placed: placements.length, unplaced: unplaced.length, noSpecialist } };
}

/* پوششِ داده‌های همین مدرسه + پیش‌نمایش */
function schedgenPlan() {
  const periods = schedPeriods();
  const subjectName = id => (byId('subjects', id) || {}).name || '';
  const cohortMap = new Map();
  list('classes').filter(c => c.kind !== 'room' && c.grade).forEach(c => {
    const key = String(c.grade).trim() + '|' + String(c.branch || '').trim();
    if (!cohortMap.has(key)) cohortMap.set(key, { id: c.id, grade: String(c.grade).trim(), branch: String(c.branch || '').trim() });
  });
  const cohortId = (grade, branch, fallback) => {
    const match = [...cohortMap.values()].find(c => String(c.grade) === String(grade || '').trim() && String(c.branch) === String(branch || '').trim());
    return match ? Number(match.id) : Number(fallback);
  };
  return {
    classes: [...cohortMap.values()],
    subjects: list('subjects').map(s => ({ id: s.id, grade: s.grade || '', branch: s.branch || '', weekly_hours: s.weekly_hours })),
    teachers: list('users')
      .filter(u => u.role === 'teacher' && u.active !== false)
      .map(t => {
        /* تخصص دبیر با نام درسش شناخته می‌شود */
        const subj = list('subjects').find(s => String(s.name || '') === String(t.subject || ''));
        return { id: t.id, subject_id: subj ? subj.id : null, subject_name: subjectName(subj ? subj.id : null) };
      }),
    existing: list('schedule').map(r => ({ class_id: cohortId(r.grade, r.branch, r.class_id), teacher_id: r.teacher_id, subject_id: r.subject_id, day: Number(r.weekday), period: Number(r.bell_order) })),
    days: schedWorkDays().length ? schedWorkDays() : SCHED_DAY_FA.map((_, i) => i),
    periodsPerDay: periods.length || 6,
  };
}
function schedgenPreview() {
  const plan = schedgenPlan();
  const res = schedGenerate(plan);
  S.schedgen = { res };
  const byClass = {};
  res.placements.forEach(p => { (byClass[p.class_id] = byClass[p.class_id] || { n: 0, un: [] }).n++; });
  res.unplaced.forEach(p => { (byClass[p.class_id] = byClass[p.class_id] || { n: 0, un: [] }).un.push(p); });
  const ids = Object.keys(byClass).map(Number).sort((a, b) => a - b);
  const body = `<div class="small muted" style="margin-bottom:10px">
      تقاضا: ${fa(res.stats.demands)} زنگ · قابلِ ثبت: ${fa(res.stats.placed)} · تعیین‌نشده: ${fa(res.stats.unplaced)}
      ${res.stats.noSpecialist ? ' · بدونِ دبیرِ متخصص: ' + fa(res.stats.noSpecialist) + ' (با «بدون دبیر» ثبت می‌شود)' : ''}
      <br>ثبت فقط در خانه‌های خالی انجام می‌شود؛ برنامهٔ فعلی دست‌نخورده می‌ماند.</div>
    ${ids.length ? `<div style="display:grid;gap:8px;max-height:50vh;overflow:auto">${ids.map(cid => {
      const b = byClass[cid];
      const c = byId('classes', cid) || {};
      return `<div style="border:1px solid var(--line);border-radius:8px;padding:8px 10px">
        <div class="row" style="gap:8px"><b>${esc(c.name || ('کلاس ' + cid))}</b>
          <span class="badge green">${fa(b.n)} زنگ</span>
          ${b.un.length ? `<span class="badge red">${fa(b.un.length)} تعیین‌نشده</span>` : ''}</div>
        ${b.un.length ? `<div class="small" style="margin-top:6px;line-height:2">${b.un.map(u => '<div>⚠️ ' + esc(schedSubjectName(u.subject_id)) + ' — ' + esc(u.reason) + '</div>').join('')}</div>` : ''}
      </div>`;
    }).join('')}</div>` : '<div class="small muted">تقاضایی نیست (درسِ هم‌خوانی با کلاس‌ها پیدا نشد — برای هر درس «ساعت در هفته» را در بخش درس‌ها تعیین کنید).</div>'}
    <button class="btn primary block" style="margin-top:12px" data-act="schedgen-apply">همین برنامه ثبت شود</button>`;
  S.modalTitle = '⚙️ پیش‌نمایش تولید خودکار';
  modal(body);
}
function schedgenApply() {
  const g = S.schedgen;
  if (!g || !g.res) return toast('پیش‌نمایشی نیست', 'err');
  let n = 0, skip = 0;
  for (const p of g.res.placements) {
    if (schedClassBusyAt(p.class_id, p.day, p.period, 0)) { skip++; continue; }
    if (p.teacher_id != null && schedTeacherBusyAt(p.teacher_id, p.day, p.period, 0)) { skip++; continue; }
    const cohort = byId('classes', p.class_id) || {};
    putLocal('schedule', {
      class_id: p.class_id, grade: String(cohort.grade || ''), branch: String(cohort.branch || ''),
      subject_id: p.subject_id, teacher_id: p.teacher_id, room_id: null, room: '',
      weekday: p.day, bell_order: p.period, school_id: 1,
    });
    n++;
  }
  S.schedgen = null;
  closeModal(); saveCache(); render();
  flushQueue().catch(() => {});
  toast(fa(n) + ' زنگ ثبت شد' + (skip ? ' (' + fa(skip) + ' خانه پرشده بود و رد شد)' : '')
    + (g.res.unplaced.length ? '؛ ' + fa(g.res.unplaced.length) + ' زنگ تعیین‌نشده ماند' : ''), 'ok');
}

/* ══════════════ تنظیم زنگ‌ها ══════════════ */
function schedBellModal() {
  const bells = list('bell_schedules').sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  const draft = bells.length ? bells.map(b => ({ id: b.id, order: Number(b.order || 0), start: b.start || '', end: b.end || '', type: b.type || 'lesson', label: b.label || '' }))
    : [1, 2, 3, 4, 5, 6].map(n => ({ id: 0, order: n, start: '', end: '', type: 'lesson', label: 'زنگ ' + n }));
  S.bellDraft = draft;
  schedBellModalHtml();
}
function schedBellCaptureDraft(form) {
  const d = S.bellDraft || [];
  if (!form || !form.elements) return d;
  d.forEach((b, i) => {
    const start = form.elements['s_' + i];
    const end = form.elements['e_' + i];
    const type = form.elements['t_' + i];
    if (start) b.start = String(start.value || '').trim();
    if (end) b.end = String(end.value || '').trim();
    if (type) b.type = type.value === 'break' ? 'break' : 'lesson';
  });
  return d;
}
function schedBellModalHtml() {
  const d = S.bellDraft || [];
  S.modalTitle = '⏱️ تنظیم زنگ‌ها';
  modal(`<form data-form="bells">
    <div class="small muted" style="margin-bottom:10px;line-height:1.9">برای هر ردیف زمان شروع و پایان را وارد کنید. نوع «درس» به‌صورت زنگ در جدول می‌آید؛ «تفریح» فاصلهٔ بین زنگ‌هاست و خانهٔ درسی ایجاد نمی‌کند. ترتیب ردیف‌ها از بالا به پایین است.</div>
    ${d.map((b, i) => `<div class="card tight" style="margin-bottom:8px;padding:8px 10px">
      <div class="row between" style="margin-bottom:6px"><b class="small">${b.type === 'break' ? 'تفریح' : 'زنگ درسی'} ${fa(i + 1)}</b>
        <button type="button" class="btn ghost sm" data-act="bell-del" data-i="${i}" title="حذف این ردیف" style="color:var(--red)">حذف</button></div>
      <div class="row" style="gap:8px;align-items:end;flex-wrap:wrap">
        <label class="field grow" style="min-width:110px"><span>شروع</span><input class="input ltr clock-24h" type="text" data-clock-24h name="s_${i}" inputmode="numeric" maxlength="5" placeholder="۰۷:۴۵" autocomplete="off" value="${esc(schedTime(b.start))}" required></label>
        <label class="field grow" style="min-width:110px"><span>پایان</span><input class="input ltr clock-24h" type="text" data-clock-24h name="e_${i}" inputmode="numeric" maxlength="5" placeholder="۰۸:۳۰" autocomplete="off" value="${esc(schedTime(b.end))}" required></label>
        <label class="field grow" style="min-width:110px"><span>این ردیف</span><select class="input" name="t_${i}">
          <option value="lesson" ${b.type !== 'break' ? 'selected' : ''}>زنگ درس</option>
          <option value="break" ${b.type === 'break' ? 'selected' : ''}>زنگ تفریح</option></select></label>
      </div></div>`).join('')}
    <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">
      <button type="button" class="btn sm ghost" data-act="bell-add" data-type="lesson">+ زنگ درس</button>
      <button type="button" class="btn sm ghost" data-act="bell-add" data-type="break">+ زنگ تفریح</button>
      <button class="btn sm primary" style="flex:1;min-width:150px">ذخیرهٔ ساعت‌ها</button>
    </div>
  </form>`);
}
/* ساعت‌ها ممکن است با ارقام فارسی ذخیره شده باشند؛ input time فقط لاتین می‌پذیرد */
function schedTime(v) {
  const s = norm(String(v || '')).replace(/\s/g, '');
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  const h = Number(m[1]), min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return '';
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}
function schedSaveBells(f) {
  const d = S.bellDraft || [];
  if (!d.length) return toast('دست‌کم یک زنگ تعریف کنید', 'err');
  let previousEnd = -1;
  for (let i = 0; i < d.length; i++) {
    const start = schedTime(f['s_' + i] && f['s_' + i].value);
    const end = schedTime(f['e_' + i] && f['e_' + i].value);
    if (!start || !end) return toast('زمان شروع و پایان ردیف ' + fa(i + 1) + ' را وارد کنید', 'err');
    const mins = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    if (mins(start) >= mins(end)) return toast('پایان هر زنگ باید بعد از شروع آن باشد', 'err');
    if (mins(start) < previousEnd) return toast('ساعت ردیف‌ها باید به‌ترتیب باشند و با هم هم‌پوشانی نداشته باشند', 'err');
    previousEnd = mins(end);
  }
  if (!d.some((_, i) => f['t_' + i].value !== 'break')) return toast('دست‌کم یک زنگ درسی لازم است', 'err');
  let lessonOrder = 0;
  d.forEach((b, i) => {
    const start = schedTime(f['s_' + i].value);
    const end = schedTime(f['e_' + i].value);
    const type = f['t_' + i].value === 'break' ? 'break' : 'lesson';
    if (type === 'lesson') lessonOrder += 1;
    const row = {
      order: type === 'lesson' ? lessonOrder : (lessonOrder + 0.5),
      start, end, type,
      label: type === 'break' ? 'زنگ تفریح' : ('زنگ ' + lessonOrder),
      school_id: 1,
    };
    const id = Number(b.id) || 0;
    if (id) putLocal('bell_schedules', Object.assign({}, byId('bell_schedules', id) || {}, row, { id }));
    else b.id = putLocal('bell_schedules', row).id;
  });
  /* زنگ‌هایی که در فرم حذف شده‌اند؛ شناسه‌های آفلاینِ منفی هم حفظ/حذف شوند. */
  const keep = new Set(d.map(x => Number(x.id)).filter(Boolean));
  list('bell_schedules').filter(b => !keep.has(Number(b.id))).forEach(b => removeLocal('bell_schedules', b.id));
  S.bellDraft = null;
  closeModal(); saveCache(); render();
  flushQueue().catch(() => {});
  toast('زنگ‌ها ذخیره شد', 'ok');
}

/* ══════════════ کنش‌ها ══════════════ */
function schedSlotSave(f) {
  const id = Number(f.id.value) || 0;
  const grade = String(f.grade.value || '').trim(), branch = String(f.branch.value || '').trim();
  const classId = Number((schedGroupFor(grade, branch, true) || {}).id) || Number(f.class_id.value) || 0;
  const day = Number(f.day.value), period = Number(f.period.value);
  const subjectId = Number(f.subject.value) || null, teacherId = Number(f.teacher.value) || null;
  const roomId = Number(f.room_id.value) || null;
  if (!grade) return toast('پایه را انتخاب کنید', 'err');
  if (!subjectId) return toast('درس را انتخاب کنید', 'err');
  if (!schedWorkDays().includes(day)) return toast('این روز در روزهای فعال مدرسه نیست', 'err');
  const dup = list('schedule').find(x => schedSameCohort(x, { grade, branch })
    && Number(x.weekday) === day && Number(x.bell_order) === period && Number(x.id) !== id);
  const oldDup = !dup && list('schedule').find(x => !x.grade && Number(x.class_id) === classId
    && Number(x.weekday) === day && Number(x.bell_order) === period && Number(x.id) !== id);
  if (dup || oldDup) return toast('این پایه و رشته در آن روز و زنگ برنامه دارد', 'err');
  if (teacherId) {
    const busy = schedTeacherBusyAt(teacherId, day, period, id);
    if (busy) return toast('تداخل ساعت: این دبیر ' + SCHED_DAY_FA[day] + ' زنگ ' + fa(period) + ' برنامهٔ دیگری دارد', 'err');
  }
  if (roomId) {
    const roomBusy = list('schedule').find(x => Number(x.room_id) === roomId && Number(x.weekday) === day
      && Number(x.bell_order) === period && Number(x.id) !== id);
    if (roomBusy) return toast('این محل در آن روز و زنگ رزرو شده است', 'err');
  }
  const roomName = (byId('classes', roomId) || {}).name || String((f.legacy_room && f.legacy_room.value) || '');
  const row = { class_id: classId, grade, branch, subject_id: subjectId, teacher_id: teacherId,
    room_id: roomId, room: roomName, weekday: day, bell_order: period, school_id: 1 };
  if (id) putLocal('schedule', Object.assign({}, byId('schedule', id) || {}, row, { id })); else putLocal('schedule', row);
  closeModal(); saveCache(); render(); flushQueue().catch(() => {}); toast('برنامه ذخیره شد', 'ok');
}
function schedPendingState(el) {
  const form = el && el.closest('form[data-form="slot"]');
  if (!form) return null;
  const state = schedSlotState(form);
  state.grade = String(form.elements.grade.value || ''); state.branch = String(form.elements.branch.value || '');
  state.room_id = Number(form.elements.room_id.value) || 0;
  return state;
}
function schedResumePending(field, value) {
  const state = S.schedPendingSlot;
  if (!state) return;
  S.schedPendingSlot = null;
  state[field] = value;
  schedSlotModal(state);
}
function schedInlineTeacherForm() {
  S.modalTitle = 'دبیر جدید';
  modal(`<form data-form="sched-teacher"><div class="small muted" style="margin-bottom:8px">حساب دبیر با نقش «دبیر» ساخته می‌شود؛ شمارهٔ همراه، کد ملی و اطلاعات دیگر را بعداً در بخش کاربران تکمیل کنید.</div>
    <label class="field"><span>نام و نام خانوادگی</span><input class="input" name="name" required placeholder="نام دبیر"></label><button class="btn primary block">ثبت دبیر</button></form>`);
}
function schedInlineRoomForm() {
  S.modalTitle = 'محل برگزاری جدید';
  modal(`<form data-form="sched-room"><div class="small muted" style="margin-bottom:8px">این محل در فهرست کلاس‌ها/محل‌ها نیز ذخیره می‌شود.</div>
    <label class="field"><span>نام محل</span><input class="input" name="name" required placeholder="مثلاً کلاس ۱۰۱ یا کارگاه الکترونیک"></label><button class="btn primary block">ثبت محل</button></form>`);
}
function schedWorkdaysModal() {
  const active = new Set(schedWorkDays());
  S.modalTitle = '📅 روزهای فعال مدرسه';
  modal(`<form data-form="workdays"><div class="small muted" style="margin-bottom:10px;line-height:1.8">روزهایی را که مدرسه در آن‌ها برنامه دارد علامت بزنید. فقط همین روزها در جدول و پیشنهادهای چیدمان نمایش داده می‌شوند.</div>
    <div class="row" style="gap:8px;flex-wrap:wrap">${SCHED_DAY_FA.map((d, i) => `<label class="btn" style="display:flex;gap:7px;align-items:center;cursor:pointer"><input type="checkbox" name="day_${i}" value="${i}" ${active.has(i) ? 'checked' : ''}>${d}</label>`).join('')}</div>
    <button class="btn primary block" style="margin-top:12px">ذخیرهٔ روزهای فعال</button></form>`);
}
function schedSaveWorkdays(f) {
  const days = SCHED_DAY_FA.map((_, i) => i).filter(i => !!(f['day_' + i] && f['day_' + i].checked));
  if (!days.length) return toast('دست‌کم یک روز فعال انتخاب کنید', 'err');
  const old = byId('schools', 1) || { id: 1, school_id: 1 };
  putLocal('schools', Object.assign({}, old, { id: 1, workdays: days }));
  closeModal(); saveCache(); render(); flushQueue().catch(() => {}); toast('روزهای فعال مدرسه ذخیره شد', 'ok');
}

const SCHED_ACTIONS = {
  /* باز کردن پنجرهٔ یک خانه */
  'sched-slot': (el) => {
    const id = Number(el.getAttribute('data-id')) || 0;
    const row = id ? byId('schedule', id) : null;
    schedSlotModal(row || {
      class_id: Number(el.getAttribute('data-class-id')) || 0,
      grade: String(el.getAttribute('data-grade') || S.schedGrade || ''),
      branch: el.getAttribute('data-branch') == null ? String(S.schedBranch || '') : String(el.getAttribute('data-branch')),
      weekday: Number(el.getAttribute('data-day')),
      bell_order: Number(el.getAttribute('data-period')),
    });
  },
  'slot-del': (el) => {
    const id = Number(el.getAttribute('data-id'));
    const r = byId('schedule', id);
    if (!r) return toast('این زنگ پیدا نشد', 'err');
    if (!confirm('درس «' + schedSubjectName(r.subject_id) + '» در ' + SCHED_DAY_FA[Number(r.weekday)] + ' زنگ ' + fa(r.bell_order) + ' حذف شود؟')) return;
    schedSubs(id).forEach(x => removeLocal('substitutions', x.id));
    removeLocal('schedule', id);
    closeModal(); saveCache(); render();
    flushQueue().catch(() => {});
    toast('زنگ حذف شد', 'ok');
  },
  'sched-conf-sug': (el) => {
    const id = el.getAttribute('data-box');
    const box = document.getElementById(id);
    if (!box) return;
    box.style.display = box.style.display === 'none' ? 'flex' : 'none';
  },
  'sched-conf-move': (el) => {
    const id = Number(el.getAttribute('data-id'));
    const day = Number(el.getAttribute('data-day'));
    const period = Number(el.getAttribute('data-period'));
    const r = byId('schedule', id);
    if (!r) { render(); return; }
    if (!schedWorkDays().includes(day)) return toast('روز انتخاب‌شده در روزهای فعال مدرسه نیست', 'err');
    if (schedClassBusyAt(r.class_id, day, period, id)) return toast('این جای کلاس دیگر پر شده است', 'err');
    if (r.teacher_id && schedTeacherBusyAt(r.teacher_id, day, period, id)) return toast('این دبیر در آن ساعت مشغول است', 'err');
    putLocal('schedule', Object.assign({}, r, { weekday: day, bell_order: period }));
    saveCache(); render();
    flushQueue().catch(() => {});
    toast('زنگ جابه‌جا شد: ' + SCHED_DAY_FA[day] + ' زنگ ' + fa(period), 'ok');
  },
  'sub-save': (el) => {
    const id = Number(el.getAttribute('data-id'));
    const slot = byId('schedule', id);
    if (!slot) return toast('اول زنگ را ذخیره کنید', 'err');
    const form = el.closest('form');
    const dateInput = form.querySelector('[data-jalali-date="sub_date"]');
    const date = String((form.elements.sub_date.value || '')).slice(0, 10);
    const tid = Number(form.elements.sub_teacher.value) || 0;
    if (!date || !dateInput || !parseJalaliIso(dateInput.value)) {
      if (dateInput && typeof markControlInvalid === 'function') markControlInvalid(dateInput);
      return toast('تاریخ شمسی معتبر را وارد کنید', 'err');
    }
    if (!tid) {
      if (typeof markControlInvalid === 'function') markControlInvalid(form.elements.sub_teacher);
      return toast('دبیر جایگزین را انتخاب کنید', 'err');
    }
    if (Number(tid) === Number(slot.teacher_id)) return toast('دبیر جایگزین نمی‌تواند همان دبیرِ این زنگ باشد', 'err');
    const dow = (new Date(date + 'T12:00:00').getDay() + 1) % 7;
    if (dow !== Number(slot.weekday)) return toast('تاریخ باید روز «' + SCHED_DAY_FA[Number(slot.weekday)] + '» باشد', 'err');
    if (schedTeacherBusyAt(tid, slot.weekday, slot.bell_order, slot.id)) return toast('این دبیر در آن ساعت کلاس دارد', 'err');
    const ex = schedSubs(id)[0];
    const row = { schedule_id: Number(id), class_id: Number(slot.class_id) || null, sub_teacher_id: tid, date, school_id: 1 };
    if (ex) putLocal('substitutions', Object.assign({}, ex, row, { id: ex.id }));
    else putLocal('substitutions', row);
    closeModal(); saveCache(); render();
    flushQueue().catch(() => {});
    toast('جابه‌جای ثبت شد', 'ok');
  },
  'sub-del': (el) => {
    const id = Number(el.getAttribute('data-id'));
    schedSubs(id).forEach(x => removeLocal('substitutions', x.id));
    closeModal(); saveCache(); render();
    flushQueue().catch(() => {});
    toast('جابه‌جای حذف شد', 'ok');
  },
  'sub-del-route': (el) => {
    const id = Number(el.getAttribute('data-id'));
    const r = byId('substitutions', id);
    if (!r) return;
    const slot = byId('schedule', r.schedule_id) || {};
    if (!confirm('جابه‌جای ' + SCHED_DAY_FA[Number(slot.weekday) || 0] + ' زنگ ' + fa(slot.bell_order || 0) + ' (تاریخ ' + jdate(r.date) + ') حذف شود؟')) return;
    removeLocal('substitutions', id);
    saveCache(); render();
    flushQueue().catch(() => {});
    toast('جابه‌جای حذف شد', 'ok');
  },
  'schedgen-open': () => schedgenPreview(),
  'schedgen-apply': () => schedgenApply(),
  'bell-edit': () => schedBellModal(),
  'workdays-edit': () => schedWorkdaysModal(),
  'sched-subject-add': (el) => {
    S.schedPendingSlot = schedPendingState(el);
    S.modalTitle = 'درس جدید';
    modal(subjectFormHtml(null));
  },
  'sched-teacher-add': (el) => { S.schedPendingSlot = schedPendingState(el); schedInlineTeacherForm(); },
  'sched-room-add': (el) => { S.schedPendingSlot = schedPendingState(el); schedInlineRoomForm(); },
  'bell-add': (el) => {
    if (!Array.isArray(S.bellDraft)) return;
    schedBellCaptureDraft(el && el.closest('form[data-form="bells"]'));
    const last = S.bellDraft[S.bellDraft.length - 1] || {};
    const type = el && el.getAttribute('data-type') === 'break' ? 'break' : 'lesson';
    S.bellDraft.push({ id: 0, order: S.bellDraft.length + 1, start: last.end || '', end: '', type, label: type === 'break' ? 'زنگ تفریح' : '' });
    schedBellModalHtml();
  },
  'bell-del': (el) => {
    if (!Array.isArray(S.bellDraft)) return;
    schedBellCaptureDraft(el && el.closest('form[data-form="bells"]'));
    const i = Number(el.getAttribute('data-i'));
    if (!Number.isFinite(i) || i < 0 || i >= S.bellDraft.length) return;
    if (S.bellDraft.length <= 1) return toast('دست‌کم یک زنگ لازم است', 'err');
    S.bellDraft.splice(i, 1);
    schedBellModalHtml();
  },
};

const SCHED_FORMS = {
  slot: (f) => schedSlotSave(f),
  bells: (f) => schedSaveBells(f),
  workdays: (f) => schedSaveWorkdays(f),
  'sched-teacher': (f) => {
    const name = String(f.name.value || '').trim();
    if (!name) return toast('نام دبیر را وارد کنید', 'err');
    const user = putLocal('users', { name, role: 'teacher', active: true, profile_incomplete: true, school_id: 1 });
    closeModal(); saveCache(); render(); flushQueue().catch(() => {});
    toast('دبیر با نقش دبیر ساخته شد؛ اطلاعات تکمیلی را در بخش کاربران وارد کنید', 'ok');
    schedResumePending('teacher_id', user.id);
  },
  'sched-room': (f) => {
    const name = String(f.name.value || '').trim();
    if (!name) return toast('نام محل را وارد کنید', 'err');
    if (list('classes').some(c => String(c.name || '').trim().toLocaleLowerCase() === name.toLocaleLowerCase() && c.kind === 'room')) return toast('این محل قبلاً ثبت شده است', 'err');
    const room = putLocal('classes', { name, kind: 'room', school_id: 1 });
    closeModal(); saveCache(); render(); flushQueue().catch(() => {}); toast('محل به فهرست کلاس‌ها/محل‌ها اضافه شد', 'ok');
    schedResumePending('room_id', room.id);
  },
};

/* با تغییر روز یا زنگ در پنجره، فهرست دبیران (🟢/🔴) تازه می‌شود */
document.addEventListener('change', (e) => {
  const form = e.target.closest && e.target.closest('form[data-form="slot"]');
  if (!form) return;
  if (!e.target.matches('[name="day"],[name="period"]')) return;
  schedSlotModal(schedSlotState(form));
});

window.SCHED_ACTIONS = SCHED_ACTIONS;
window.SCHED_FORMS = SCHED_FORMS;
window.schedPage = schedPage;
window.schedSlotModal = schedSlotModal;
window.schedGenerate = schedGenerate;
window.schedConflicts = schedConflicts;
window.schedTeacherBusyAt = schedTeacherBusyAt;
window.schedSuggestSlots = schedSuggestSlots;
