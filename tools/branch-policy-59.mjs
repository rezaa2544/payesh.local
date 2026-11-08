#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   سیاست شاخهٔ قفل‌شده (D-38) — ردیف ۵۹         (BRANCH-POLICY-59)

   قاعده‌ها (همان چیزی که در سند ۵۹ ثبت شده):
     B1  کار روی شاخهٔ مجری انجام می‌شود، نه main.
     B2  وضعیت مرجع = origin/main؛ شاخه نباید از origin/main عقب باشد.
     B3  force-push ممنوع: نوکِ شاخه روی origin باید جدِ HEAD باشد
         (تاریخ بازنویسی‌شده = قرمز).
     B4  main فقط از راه merge (یا کامیت خودکار مانیفست انتشار) جلو می‌رود؛
         کامیت ویژگیِ مستقیم روی main = قرمز.
     B5  یک PR برای هر ردیف: هر شمارهٔ ردیف در فهرست PRهای ادغام‌شده باید
         دقیقاً یک PR داشته باشد (اختیاری، با --pr-audit و gh).

   اجرا:
     node tools/branch-policy-59.mjs                 # B1..B4 روی همین مخزن
     node tools/branch-policy-59.mjs --pr-audit      # + B5
     node tools/branch-policy-59.mjs --json
     node tools/branch-policy-59.mjs --repo <path>   # برای کنترل منفی
   کد خروج: ۰ سالم · ۱ نقض
   ═══════════════════════════════════════════════════════════════════ */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
export const REPO = path.resolve(arg('repo', path.resolve(HERE, '..')));
const MAIN = 'main';

/* تاریخ لازم‌الاجرا شدن سیاست (D-38/ردیف ۵۹). PRهای قدیمی‌تر «تاریخی» گزارش
   می‌شوند اما دروازه را قرمز نمی‌کنند؛ از این تاریخ به بعد یک ردیف = یک PR. */
export const POLICY_SINCE = '2026-11-08T02:00:00Z';

/* پیام کامیت‌هایی که به‌طور خودکار روی main ساخته می‌شوند (انتشار) */
const BOT_ON_MAIN = /^chore\(release\)/i;

export function git(args, cwd = REPO) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitOk(args, cwd = REPO) {
  try { git(args, cwd); return true; } catch (e) { return false; }
}

export function currentBranch(cwd = REPO) {
  try { return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd); } catch (e) { return null; }
}

export function remoteRef(ref, cwd = REPO) {
  try { return git(['rev-parse', '--verify', '--quiet', ref], cwd) || null; } catch (e) { return null; }
}

/* B4: هر کامیت روی main باید یکی از این‌ها باشد:
      • merge (دو والد یا بیشتر)  • کامیت خودکار انتشار  • کامیت ریشه
      • کامیتی که از طریق یک merge به main آمده (اجداد والد دوم)
   کامیت ویژگیِ مستقیم روی main هیچ‌کدام نیست ⇒ قرمز. */
export function mainIntegrity(commits, cwd = REPO) {
  const accepted = new Set();
  for (const sha of commits) {
    const info = git(['rev-list', '--parents', '-n', '1', sha], cwd).split(' ');
    const parents = info.slice(1);
    const subject = git(['log', '-1', '--pretty=%s', sha], cwd);
    if (parents.length >= 2) {
      accepted.add(sha);
      /* هرچه از والدهای غیراول آمده، از راه merge رسیده */
      for (const p of parents.slice(1)) {
        try {
          for (const c of git(['rev-list', p], cwd).split('\n').filter(Boolean)) accepted.add(c);
        } catch (e) { /* والد ناشناخته */ }
      }
      continue;
    }
    if (BOT_ON_MAIN.test(subject) || parents.length === 0) accepted.add(sha);
  }
  const bad = commits.filter(sha => !accepted.has(sha)).map(sha => ({
    sha: sha.slice(0, 8),
    subject: git(['log', '-1', '--pretty=%s', sha], cwd),
  }));
  return { ok: bad.length === 0, bad };
}

/* B3: نوکِ شاخهٔ روی origin باید جدِ HEAD باشد (نه بازنویسی‌شده) */
export function noForcePush(branch, cwd = REPO) {
  const head = remoteRef('HEAD', cwd);
  const originTip = branch ? remoteRef('refs/remotes/origin/' + branch, cwd) : null;
  if (!originTip) return { ok: true, skipped: true, why: 'شاخهٔ متناظر روی origin نیست' };
  const ok = gitOk(['merge-base', '--is-ancestor', originTip, head], cwd);
  return { ok, skipped: false, origin_tip: originTip.slice(0, 8), head: head && head.slice(0, 8) };
}

/* B2: عقب نبودن از origin/main */
export function baseFreshness(branch, cwd = REPO) {
  const originMain = remoteRef('refs/remotes/origin/' + MAIN, cwd);
  if (!originMain) return { ok: true, skipped: true, why: 'origin/main در دسترس نیست' };
  const head = remoteRef('HEAD', cwd);
  if (!head) return { ok: false, why: 'HEAD نیست' };
  const contains = gitOk(['merge-base', '--is-ancestor', originMain, head], cwd);
  let behind = 0;
  if (!contains) {
    try { behind = Number(git(['rev-list', '--count', head + '..' + originMain], cwd)) || 0; } catch (e) { behind = 0; }
  }
  return { ok: contains, behind, origin_main: originMain.slice(0, 8) };
}

/* ارقام فارسی/عربی ⇒ ASCII تا «ردیف ۵۲» و «ردیف 52» یکی دیده شوند */
export function normalizeDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660));
}

/* B5: هر ردیف دقیقاً یک PR ادغام‌شده */
export function auditPrsPerRow(prList, rows, since = POLICY_SINCE) {
  const problems = [], historical = [];
  for (const raw of rows) {
    const row = normalizeDigits(raw);
    const reRow = new RegExp('ردیف\\s*' + row + '([^0-9]|$)');
    const reBare = new RegExp('(^|[^0-9])' + row + '([^0-9]|$)');
    const titles = prList.map(p => ({ p, t: normalizeDigits(p.title || '') }));
    /* «ردیف ۶۰» صریح است؛ عددِ لخت می‌تواند چیز دیگری باشد («تست ۶۰ روزه»).
       پس اگر عنوان صریحی هست، فقط همان شمرده می‌شود. */
    const explicit = titles.filter(x => reRow.test(x.t));
    const hits = (explicit.length ? explicit : titles.filter(x => reBare.test(x.t))).map(x => x.p);
    const fresh = hits.filter(p => !p.mergedAt || p.mergedAt >= since);
    const old = hits.filter(p => p.mergedAt && p.mergedAt < since);
    if (old.length) historical.push({ row, prs: old.map(h => h.number) });
    if (fresh.length > 1) {
      problems.push({ row, prs: fresh.map(h => h.number), why: 'بیش از یک PR' });
    } else if (fresh.length === 0 && hits.length === 0) {
      problems.push({ row, prs: [], why: 'بدون PR' });
    }
  }
  return { ok: problems.length === 0, problems, historical };
}

export function evaluate({ cwd = REPO, prAudit = false, rows = [] } = {}) {
  const branch = currentBranch(cwd);
  const problems = [];
  if (!branch) return { ok: false, problems: [{ rule: 'B0', why: 'مخزن git نیست' }] };

  if (branch === MAIN) {
    problems.push({ rule: 'B1', why: 'روی main کار می‌شود؛ باید شاخهٔ مجزا + PR باشد' });
  }

  const fresh = baseFreshness(branch, cwd);
  if (!fresh.ok) problems.push({ rule: 'B2', why: `شاخه از origin/main عقب است (${fresh.behind || 0} کامیت)` });

  const force = noForcePush(branch, cwd);
  if (!force.ok) problems.push({ rule: 'B3', why: `تاریخ شاخه بازنویسی شده (origin=${force.origin_tip} جدِ HEAD نیست)` });

  /* B4: کامیت‌های تازهٔ origin/main که merge یا bot نیستند */
  const originMain = remoteRef('refs/remotes/origin/' + MAIN, cwd);
  let mainCheck = { ok: true, skipped: true };
  if (originMain) {
    let commits = [];
    try { commits = git(['rev-list', '-n', '40', 'refs/remotes/origin/' + MAIN], cwd).split('\n').filter(Boolean); } catch (e) { commits = []; }
    mainCheck = mainIntegrity(commits, cwd);
    if (!mainCheck.ok) {
      for (const b of mainCheck.bad) problems.push({ rule: 'B4', why: `کامیت غیر merge روی main: ${b.sha} «${b.subject}»` });
    }
  }

  let prCheck = { ok: true, skipped: true, historical: [] };
  if (prAudit && rows.length) {
    let list = [];
    try {
      /* --state all: PR باز هم «یک PR برای این ردیف» است؛ وگرنه B5 تا لحظهٔ merge
         همیشه قرمز می‌ماند و شاهدِ پیش از merge هرگز سبز نمی‌شود. */
      list = JSON.parse(execFileSync('gh', ['pr', 'list', '--state', 'all', '--limit', '300', '--json', 'number,title,mergedAt,state'], { encoding: 'utf8', cwd }));
    } catch (e) { list = null; }
    if (list) {
      prCheck = auditPrsPerRow(list, rows);
      if (!prCheck.ok) for (const p of prCheck.problems) problems.push({ rule: 'B5', why: `ردیف ${p.row}: ${p.why}` });
    } else prCheck = { ok: true, skipped: true, why: 'gh در دسترس نیست' };
  }

  return {
    ok: problems.length === 0, branch, problems,
    checks: { B1: branch !== MAIN, B2: fresh, B3: force, B4: mainCheck, B5: prCheck },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = (arg('rows', '') || '').split(',').map(s => s.trim()).filter(Boolean);
  const r = evaluate({ prAudit: argv.includes('--pr-audit'), rows });
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`# شاخه: ${r.branch}`);
    console.log(`# B2 origin/main: ${r.checks.B2.skipped ? 'نامعلوم' : (r.checks.B2.ok ? 'شامل شده' : 'عقب ' + r.checks.B2.behind)}`);
    console.log(`# B3 force-push: ${r.checks.B3.skipped ? 'معاف (شاخه روی origin نیست)' : (r.checks.B3.ok ? 'سالم' : 'بازنویسی‌شده')}`);
    console.log(`# B4 سلامت main: ${r.checks.B4.ok ? 'همه merge/انتشار' : 'کامیت مستقیم دارد'}`);
    if (r.checks.B5 && r.checks.B5.historical && r.checks.B5.historical.length) {
      for (const h of r.checks.B5.historical) console.log(`# تاریخی (قبل از سیاست، فقط ثبت): ردیف ${h.row} → PR ${h.prs.join(',')}`);
    }
    for (const p of r.problems) console.log(`PROBLEM ${p.rule} — ${p.why}`);
    console.log(r.ok ? 'BRANCH-POLICY-59-OK' : 'BRANCH-POLICY-59-FAILED');
  }
  process.exit(r.ok ? 0 : 1);
}
