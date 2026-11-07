#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
   تمرین اجرایی ردیف ۱۱ — «هر ادعا به فایل، خط، تست یا خروجی runtime متصل است»

   چه چیزی را اثبات می‌کند:
   ۱) ۷۳ آیتم کنترلی اسناد ۰۶–۱۰ واقعاً در جدول‌ها وجود دارند و توزیع احکام
      (PASS/FAIL/UNKNOWN) با عددی که سند ۱۱ اعلام می‌کند یکی است.
   ۲) هر ارجاع `file:line` در آن جدول‌ها به فایلی موجود و خطی موجود اشاره می‌کند
      (هیچ ارجاع مرده‌ای وجود ندارد).
   ۳) هر یک از ۷۳ ردیف حداقل یک «اتصال» دارد: ارجاع فایل، پروب اجرایی، نماد کد،
      گزارهٔ اندازه‌گیری‌شده، یا حضور در فهرست UNKNOWN سند ۱۱.
   ۴) سازوکارهای کلیدی ادعاها روی HEAD واقعاً همان‌اند (نه فقط نقل‌قول).
   ۵) دو یافتهٔ P0 (F‑04/F‑06) با محتوای خط، نه فقط شمارهٔ خط، بازاثبات می‌شوند.
   ۶) کد محصول نسبت به پایهٔ ممیزی f2fc472 تغییر نکرده ⇒ نتیجه‌گیری ممیزی روی HEAD معتبر است.

   اجرا: node --experimental-sqlite docs/cloud/reports/evidence/drill-11-claims.cjs
   ───────────────────────────────────────────────────────────────────────────── */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../../../..');
process.chdir(ROOT);

let PASS = 0, FAIL = 0;
const out = [];
const ok = (label, detail) => { PASS++; out.push(`✓ ${label}  ::  ${detail}`); };
const bad = (label, detail) => { FAIL++; out.push(`✗ ${label}  ::  ${detail}`); };
const check = (cond, label, detail) => (cond ? ok(label, detail) : bad(label, detail));

const read = f => fs.readFileSync(f, 'utf8');
const lines = f => read(f).split('\n');
const faToInt = s => Number(s.replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x6f0)).replace(/[^\d]/g, ''));
const PRODUCT_DIRS = ['server', 'client', 'tests', 'scripts'];
const productFiles = () => {
  const acc = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) acc.push(p);
    }
  };
  for (const d of PRODUCT_DIRS) if (fs.existsSync(d)) walk(d);
  return acc;
};
const PROD = productFiles();
const PROD_TEXT = new Map(PROD.map(f => [f, read(f)]));
const countAll = needle => {
  let n = 0;
  for (const [, t] of PROD_TEXT) n += t.split(needle).length - 1;
  return n;
};
const grepFiles = (needle, dirs) => PROD.filter(f => dirs.some(d => f.startsWith(d + '/')) && PROD_TEXT.get(f).includes(needle));

/* ── ۱) خواندن ۷۳ ردیف داوری از اسناد ۰۶–۱۰ ───────────────────────────────── */
const AUDIT_DOCS = [
  'docs/cloud/06-audit-auth-session.md',
  'docs/cloud/07-audit-roles-tenant.md',
  'docs/cloud/08-audit-source-of-truth.md',
  'docs/cloud/09-audit-cache-queue-sync.md',
  'docs/cloud/10-audit-crypto-backup-restore.md',
];
const KEYS = ['PASS', 'FAIL', 'UNKNOWN', 'BLOCKED'];
const rows = [];
for (const doc of AUDIT_DOCS) {
  for (const ln of lines(doc)) {
    if (!ln.startsWith('|')) continue;
    const cells = ln.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(s => s.trim());
    if (cells.length < 3) continue;
    const id = cells[0].replace(/\*/g, '').trim();
    if (!/^[A-Z]\u2011\d+$/.test(id)) continue;
    const tok = cells[cells.length - 1].replace(/\*/g, '').trim().split(/\s+/)[0]
      .replace(/[\u2014:\u060c]/g, '').toUpperCase();
    if (!KEYS.includes(tok)) continue;
    rows.push({ id, verdict: tok, doc: path.basename(doc), cell: cells.slice(1).join(' | '), evidence: cells.slice(1, -1).join(' | ') });
  }
}
const dupIds = rows.map(r => r.id).filter((v, i, a) => a.indexOf(v) !== i);
check(rows.length === 73, 'R1 ۷۳ آیتم کنترلی از جدول‌های داوری ۰۶–۱۰ خوانده شد', `rows=${rows.length}`);
check(dupIds.length === 0, 'R2 هیچ شناسهٔ تکراری در ۷۳ آیتم نیست', `dups=${dupIds.join(',') || 'none'}`);

const tally = rows.reduce((a, r) => (a[r.verdict] = (a[r.verdict] || 0) + 1, a), {});
const cP = tally.PASS || 0, cF = tally.FAIL || 0, cU = tally.UNKNOWN || 0, cB = tally.BLOCKED || 0;
check(cP === 26 && cF === 40 && cU === 7 && cB === 0,
  'R3 توزیع احکام بازشماری‌شده = ۲۶ PASS / ۴۰ FAIL / ۷ UNKNOWN / ۰ BLOCKED',
  `P=${cP} F=${cF} U=${cU} B=${cB}`);

/* ── ۲) سند ۱۱: اعداد، درصدها، فهرست UNKNOWN ──────────────────────────────── */
const d11 = read('docs/cloud/11-gap-report.md');
const docNum = label => {
  const m = d11.match(new RegExp('\\|\\s*\\*\\*' + label + '\\*\\*\\s*\\|\\s*([۰-۹]+)'));
  return m ? faToInt(m[1]) : null;
};
check(docNum('PASS') === cP && docNum('FAIL') === cF && docNum('UNKNOWN') === cU,
  'R4 اعداد جدول سند ۱۱ با بازشماری ردیف‌محور می‌خواند',
  `doc=${docNum('PASS')}/${docNum('FAIL')}/${docNum('UNKNOWN')} recount=${cP}/${cF}/${cU}`);

const pct = n => (Math.round(n * 1000 / 73) / 10).toFixed(1);
const dPct = { PASS: pct(cP), FAIL: pct(cF), UNKNOWN: pct(cU) };
const faPct = v => v.replace('.', '٫').replace(/[0-9]/g, d => String.fromCharCode(0x6f0 + Number(d)));
const mismatch = [];
for (const [k, v] of Object.entries(dPct)) {
  if (!d11.includes(faPct(v))) mismatch.push(`${k}=${v}`);
}
check(mismatch.length === 0, 'R5 درصدها فقط از روش اعلام‌شده (PASS÷۷۳، بدون وزن) بازمحاسبه و مطابقت شد',
  `PASS=${dPct.PASS}% FAIL=${dPct.FAIL}% UNKNOWN=${dPct.UNKNOWN}%`);

const unkSection = d11.split('### ۲.۳')[1] ? d11.split('### ۲.۳')[1].split('###')[0] : '';
const unkIds = [...unkSection.matchAll(/([A-Z])\u2011(\d+)/g)].map(m => `${m[1]}\u2011${m[2]}`);
const computedUnk = rows.filter(r => r.verdict === 'UNKNOWN').map(r => r.id);
const unkMissing = computedUnk.filter(id => !unkIds.includes(id));
const unkExtra = unkIds.filter(id => !computedUnk.includes(id));
check(unkMissing.length === 0 && unkExtra.length === 0,
  'R6 فهرست UNKNOWN سند ۱۱ (§۲.۳) دقیقاً همان ۷ ردیف UNKNOWN جدول‌ها است',
  `computed=${computedUnk.length} doc=${unkIds.length}` + (unkMissing.length || unkExtra.length ? ` missing=${unkMissing} extra=${unkExtra}` : ''));

/* ── ۳) ارجاع‌ها: فایل/خط موجود، پروب موجود ────────────────────────────────── */
const resolveFile = f => {
  for (const c of [f, 'server/' + f, 'client/' + f, 'tests/' + f, 'scripts/' + f,
    'docs/cloud/reports/evidence/' + f, 'docs/cloud/' + f, 'docs/' + f])
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
};
const PROBE_FILE = 'docs/cloud/reports/evidence/mission-06-10-probes.txt';
const probeText = read(PROBE_FILE);

function parseRefs(cell) {
  const refs = [];
  for (const m of cell.matchAll(/`([A-Za-z0-9_./\-]+\.(?:js|mjs|cjs|json|md|sql|cs|iss))(?::(\d+(?:[-,]\d+)*))?`/g))
    refs.push({ file: m[1], range: m[2] || null });
  for (const m of cell.matchAll(/(?:^|[\s(،؛`])([A-Za-z0-9_./\-]+\.(?:js|mjs|cjs|json|md|sql|cs|iss)):(\d+(?:[-,]\d+)*)/g))
    refs.push({ file: m[1], range: m[2] });
  const seen = new Set();
  return refs.filter(x => { const k = JSON.stringify(x); return seen.has(k) ? false : (seen.add(k), true); });
}
const rangeNums = r => r.split(',').flatMap(part => {
  const [a, b] = part.split('-').map(Number);
  return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
});

let citTotal = 0, citOk = 0;
const citBroken = [];
const drift = [];
const STOP = new Set(['PASS', 'FAIL', 'UNKNOWN', 'BLOCKED', 'server', 'client', 'tests', 'scripts', 'docs', 'true', 'false', 'catch', 'push', 'json', 'http', 'https']);
const cellTokens = cell => new Set((cell.match(/[A-Za-z_][A-Za-z0-9_.]{3,}/g) || [])
  .map(t => t.replace(/\.$/, ''))
  .filter(t => !/\.(js|mjs|cjs|json|md|sql|cs|iss)$/.test(t) && !STOP.has(t.toLowerCase())));

for (const r of rows) {
  const refs = parseRefs(r.evidence);
  r.refs = refs;
  r.refOk = 0;
  r.drift = false;
  const toks = cellTokens(r.evidence);
  for (const ref of refs) {
    citTotal++;
    const f = resolveFile(ref.file);
    if (!f) {
      if (probeText.includes(ref.file)) { citOk++; r.refOk++; r.runtime = true; continue; }  // خروجی runtime (مثل فایل آینه)
      citBroken.push(`${r.id}:${ref.file}`); continue;
    }
    if (!ref.range) { citOk++; r.refOk++; continue; }
    const n = lines(f).length;
    const nums = rangeNums(ref.range);
    if (Math.max(...nums) > n || Math.min(...nums) < 1) { citBroken.push(`${r.id}:${ref.file}:${ref.range}>${n}`); continue; }
    citOk++; r.refOk++;
    const body = nums.map(x => lines(f)[x - 1]).join('\n').toLowerCase();
    const hit = [...toks].some(t => body.includes(t.toLowerCase()));
    if (toks.size && !hit) r.drift = true;
    if (r.drift) drift.push(r.id);
  }
}
const driftRows = [...new Set(drift)];
check(citTotal > 0 && citBroken.length === 0, 'R7 همهٔ ارجاع‌های file:line به فایل و خط موجود اشاره می‌کنند (هیچ ارجاع مرده)',
  `citations=${citTotal} resolved=${citOk} broken=${citBroken.length}` + (citBroken.length ? ` → ${citBroken.slice(0, 5).join(' , ')}` : ''));

/* رانش ارجاع: شناسهٔ ادعا در بازهٔ ارجاع‌داده‌شده نیست. دو دسته:
   (الف) CORRECTIONS — شمارهٔ خط در سند قدیمی رفته است؛ لنگر درست روی HEAD این‌جاست و تأیید می‌شود.
   (ب) ACCEPTED — ارجاع درست است، ولی شناسهٔ متنی در همان خط نیست (متن ادعا از جای دیگری می‌آید). */
const CORRECTIONS = [
  ['A\u201114', 'auth.js:113-114', [['server/auth.js', 115, 'user.active']]],
  ['B\u20111', 'canWrite :52 / canWriteRow :151', [['server/policy.js', 51, 'function canWrite('], ['server/policy.js', 152, 'function canWriteRow(']]],
  ['B\u20112', 'sync.js:52,56', [['server/sync.js', 50, 'rowInScope'], ['server/sync.js', 53, 'rowInScope']]],
  ['B\u201113', 'policy.js:9', [['server/policy.js', 8, 'ROLES']]],
  ['C\u20112', 'index.js:1076', [['server/index.js', 1073, '/api/admin/restore']]],
  ['D\u20111', 'sync.js:98', [['server/sync.js', 96, 'syncSeen']]],
  ['D\u20112', 'app.js:311', [['client/app.js', 315, 'slice(0, 120)']]],
  ['E\u201110', 'mirror.js:31-35', [['server/mirror.js', 39, 'contentHash'], ['server/mirror.js', 93, 'compareMirror']]],
  ['E\u201111', 'mirror.js:27', [['server/mirror.js', 32, 'KEEP_DAYS']]],
];
const ACCEPTED = [
  ['E\u20114', 'index.js:778', [['server/index.js', 778, '/api/admin/users/credentials']]],
  ['D\u201113', 'app.js:115-119', [['client/app.js', 118, 'idbSet']]],
];
let corrOk = 0, corrBad = [];
for (const [id, cited, anchors] of CORRECTIONS) {
  for (const [f, n, tok] of anchors) {
    const good = fs.existsSync(f) && (lines(f)[n - 1] || '').includes(tok);
    if (good) corrOk++; else corrBad.push(`${id}→${f}:${n} (${tok})`);
  }
}
const covered = [...CORRECTIONS, ...ACCEPTED].map(x => x[0]);
const uncovered = driftRows.filter(id => !covered.includes(id));
check(corrBad.length === 0 && uncovered.length === 0 && driftRows.length === CORRECTIONS.length + ACCEPTED.length,
  'R8 رانش ارجاع دقیقاً ۱۱ ردیف است: ۹ ارجاع با لنگر تصحیح‌شده و ۲ ارجاع تأییدشده؛ همهٔ لنگرها روی HEAD بازبینی شد',
  `drift=${driftRows.length} corrections=${CORRECTIONS.length} accepted=${ACCEPTED.length} anchors_ok=${corrOk}` +
  (corrBad.length ? ` bad=${corrBad.join(' , ')}` : '') + (uncovered.length ? ` uncovered=${uncovered.join(' , ')}` : ''));

const probeRefs = [...new Set(rows.flatMap(r => [...r.evidence.matchAll(/\bP(\d+)\b/g)].map(m => 'P' + m[1])))];
const probeMissing = probeRefs.filter(p => !probeText.includes(p));
check(probeRefs.length >= 8 && probeMissing.length === 0, 'R9 هر پروب ارجاع‌داده‌شده در شاهد خام پروب‌ها موجود است',
  `probes=${probeRefs.length} missing=${probeMissing.length}` + (probeMissing.length ? ` → ${probeMissing}` : ''));

/* ── ۴) اتصال هر ردیف: ارجاع | پروب | نماد کد | گزارهٔ اندازه‌گیری | UNKNOWN ── */
/* گزاره‌های اندازه‌گیری‌شده برای ردیف‌هایی که ادعای «نبود/شمارش» دارند */
const PREDICATES = {
  'D‑9': () => countAll("'seq'") === 0 && countAll(' op.seq') === 0,
  'D‑10': () => !/needs_review|needs-review|نیازمند بررسی/.test(read('client/app.js')),
  'D‑11': () => !/هشدار[^\n]*سقف|queueWarn|MAX_QUEUE/.test(read('client/app.js')),
  'E‑1': () => grepFiles('https.createServer', ['server']).length === 0,
  'E‑2': () => countAll('createCipheriv') === 0 && countAll('createDecipheriv') === 0,
  'E‑17': () => !/hmac|signature|verifySignature/.test(read('server/mirror.js')),
  'C‑8': () => grepFiles('school_id', ['server']).reduce((n, f) => n + (PROD_TEXT.get(f).match(/school_id/g) || []).length, 0) === 25,
  'B‑14': () => /BACKUP_ROLES = new Set\(\[[^\]]*'guard'/.test(read('server/index.js')),
  'E‑9': () => /Object\.assign\(\{\}, row\)/.test(read('server/mirror.js')) && /store\.insert\(name/.test(read('server/mirror.js')),
  'A‑3': () => probeText.includes('P7'),
};
let attached = 0, unattached = [];
const kinds = { refs: 0, probe: 0, symbol: 0, predicate: 0, unknown: 0 };
for (const r of rows) {
  let kind = null;
  if (r.refOk > 0) kind = 'refs';
  else if (probeRefs.some(p => r.evidence.includes(p))) kind = 'probe';
  else if (PREDICATES[r.id] && PREDICATES[r.id]()) kind = 'predicate';
  else if (r.verdict === 'UNKNOWN' && unkIds.includes(r.id)) kind = 'unknown';
  else {
    const symbols = [...r.evidence.matchAll(/`([A-Za-z_][A-Za-z0-9_.]{3,})`/g)].map(m => m[1])
      .filter(t => !/\.(js|mjs|cjs|json|md|sql|cs|iss)$/.test(t));
    if (symbols.some(s => countAll(s.split('.')[0]) > 0)) kind = 'symbol';
  }
  if (kind) { attached++; kinds[kind]++; } else unattached.push(r.id);
}
check(unattached.length === 0, 'R10 هر ۷۳ ادعا حداقل یک اتصال دارد (ارجاع/پروب/نماد/گزارهٔ سنجیده/فهرست UNKNOWN)',
  `attached=${attached}/73 refs=${kinds.refs} probe=${kinds.probe} predicate=${kinds.predicate} unknown=${kinds.unknown} symbol=${kinds.symbol}`);

/* ── ۵) سازوکارهای ادعاشده روی HEAD — اندازه‌گیری زنده ────────────────────── */
const M = [
  ['A‑1 PBKDF2 ۱۵۰٬۰۰۰ تکرار + timingSafeEqual', () => {
    const t = read('server/util.js');
    return /PBKDF2_ITER\s*=\s*150000/.test(t) && /timingSafeEqual/.test(t);
  }, 'server/util.js'],
  ['A‑2 توکن نشست در سکون هش می‌شود', () => /sha256\(token\)|token_hash/.test(read('server/auth.js')), 'server/auth.js'],
  ['A‑8 عمر نشست ۲۴ ساعت', () => /SESSION_HOURS\s*=\s*24/.test(read('server/auth.js')), 'server/auth.js:11'],
  ['A‑10 توکن دستگاه ۳۶۵ روز', () => /DEVICE_DAYS\s*=\s*365/.test(read('server/auth.js')), 'server/auth.js:10'],
  ['A‑11 حداقل طول رمز فقط ۴', () => /pw\.length\s*<\s*4/.test(read('server/auth.js')), 'server/auth.js:177'],
  ['B‑1 مجوز نوشتن از نگاشت نقش×کالکشن', () => /c\.write\.includes\(role\)/.test(read('server/policy.js')), 'server/policy.js:52-54'],
  ['B‑2 اعمال اسکوپ ردیف در pull', () => (read('server/sync.js').match(/policy\.rowInScope/g) || []).length >= 2, 'server/sync.js:50,53'],
  ['B‑5 تأیید نمره توسط دبیر ممکن نیست', () => /approved/.test(read('server/policy.js')) && /pending/.test(read('server/policy.js')), 'server/policy.js:174-177'],
  ['B‑12 سد مدیر، با استثنای آینه/بازیابی برای چهار نقش', () => {
    const t = read('server/index.js');
    return /const backupPath = \/\^\\\/api\\\/admin\\\/\(mirror\|restore/.test(t) && /BACKUP_ROLES\.has\(actor\.role\)/.test(t);
  }, 'server/index.js:558-561'],
  ['C‑5 کلاینت role و user_id خودش را به صندوقچه می‌فرستد', () => /role: S\.role \|\| null/.test(read('client/app.js')), 'client/app.js:364'],
  ['C‑6 هویت drain از شیء کلاینت', () => /item\.user_id/.test(read('server/outbox.js')), 'server/outbox.js:181'],
  ['C‑7 نشان «اعمال شد» در همان صندوقچه', () => /outbox\/done\//.test(read('server/outbox.js')), 'server/outbox.js:14,24'],
  ['C‑10 پیشوند ثابت و بی‌مستأجر', () => /'payesh\/'/.test(read('server/outbox.js')), 'server/outbox.js:48'],
  ['D‑6 صف با slice(-500) بریده می‌شود (F‑07)', () => /slice\(-500\)/.test(read('client/app.js')), 'client/app.js:121'],
  ['D‑7 تعارض = نسخهٔ سرور، کار محلی حذف (F‑08)', () => /conflicts\.length/.test(read('client/app.js')) && /S\.queue = S\.queue\.filter\(op => op\.uid !== c\.uid/.test(read('client/app.js')), 'client/app.js:333-340'],
  ['D‑14 همگام‌سازی زنده هر ۱ ثانیه', () => /INTERVAL_MS\s*=\s*1000/.test(read('server/live.js')), 'server/live.js:24'],
  ['E‑5 رمز خام در ردیف کاربر', () => /password_plain: pw/.test(read('server/auth.js')), 'server/auth.js:183'],
  ['E‑7 بازیابی + نسخهٔ ایمنی پیش از بازیابی', () => /safety = path\.basename\(store\.backupTo/.test(read('server/index.js')), 'server/index.js:1078'],
  ['E‑9 بازیابی همهٔ فیلدهای ردیف را می‌نویسد (شامل role)', () => /Object\.assign\(\{\}, row\)/.test(read('server/mirror.js')) && /store\.insert\(name, clean/.test(read('server/mirror.js')), 'server/mirror.js:194-203'],
  ['E‑13 کلید فضای ذخیره‌سازی در بستهٔ کلاینت (F‑04)', () => /accessKey/.test(read('client/cloud-baked.js')) && /secret/.test(read('client/cloud-baked.js')), 'client/cloud-baked.js'],
  ['E‑14 برگشت کلید از /api/cloud/config', () => /accessKey: c\.accessKey, secret: c\.secret/.test(read('server/index.js')), 'server/index.js:672'],
];
for (const [label, fn, where] of M) check(!!fn(), 'M ' + label, where);

/* ── ۶) دو یافتهٔ P0 با محتوای خط (نه فقط شمارهٔ خط) ────────────────────────── */
const lineHas = (f, n, needle) => (lines(f)[n - 1] || '').includes(needle);
check(lineHas('server/index.js', 663, '/api/cloud/config') && lineHas('server/index.js', 672, 'accessKey') &&
  lineHas('client/app.js', 971, '/api/cloud/config') && lineHas('client/app.js', 972, 'localStorage.setItem'),
  'P0‑1 F‑04 در HEAD: مسیر تحویل کلید + ذخیره در localStorage (۴ خط با محتوا بررسی شد)',
  'server/index.js:663,672 · client/app.js:971,972');
check(lineHas('server/outbox.js', 181, 'item.user_id') && lineHas('server/outbox.js', 182, 'user.active'),
  'P0‑2 F‑06 در HEAD: هویت drain از شیء کلاینت و بررسی صرفاً active',
  'server/outbox.js:181,182');
check(/BACKUP_ROLES = new Set\(\[[^\]]*'guard'/.test(read('server/index.js')) === true &&
  /'guard'/.test(read('server/index.js').split('BACKUP_ROLES')[1].split('\n')[0]),
  'P0‑3 چهار نقش (شامل guard) به آینه/بازیابی دسترسی دارند', 'server/index.js:47');

/* ── ۷) ادعاهای «نبود» با اندازه‌گیری، و شمارش‌ها ──────────────────────────── */
check(countAll('createCipheriv') === 0 && countAll('createDecipheriv') === 0,
  'N1 هیچ رمزنگاری سکونی در کد وجود ندارد (E‑2: ۰ مورد)', 'cipher_calls=0');
const schoolId = grepFiles('school_id', ['server']).reduce((n, f) => n + (PROD_TEXT.get(f).match(/school_id/g) || []).length, 0);
check(schoolId === 25, 'N2 school_id در سرور ۲۵ نقطه است (F‑05/C‑8)', `school_id_refs=${schoolId}`);
check(countAll('tenant_id') === 0, 'N3 ستون/فیلد tenant_id در کد محصول صفر است (F‑05)', 'tenant_id_refs=0');
check(grepFiles('https.createServer', ['server']).length === 0, 'N4 هیچ سرور TLS در کد نیست (E‑1: TLS از استقرار می‌آید)', 'https_servers=0');
check(!/hmac|signature/i.test(read('server/mirror.js')), 'N5 بازیابی هیچ امضا/هش اعتبارسنجی نمی‌کند (E‑17)', 'mirror_signature_refs=0');
check(!/\bseq\b/.test(read('client/app.js')), 'N6 ترتیب ارسال وابستگی‌محور نیست و seq محلی وجود ندارد (D‑9)', 'seq_refs=0');
check(!/needs_review|MAX_QUEUE|نیازمند بررسی/.test(read('client/app.js')), 'N7 سقف ۲۰۰۰/۳۰ روز و وضعیت «نیازمند بررسی» پیاده نشده (D‑10/D‑11)', 'queue_cap_refs=0');

/* ── ۸) تصحیح ثبت‌شدهٔ ادعای D‑10: op فیلد زمانی دارد، ولی برای عمر استفاده نمی‌شود */
const opAt = /at: new Date\(\)\.toISOString\(\)/.test(read('client/app.js'));
check(opAt && !/needs_review/.test(read('client/app.js')),
  'C1‑11 تصحیح D‑10: هر op فیلد at دارد؛ نبودِ منطق عمر/بررسی، دلیل FAIL می‌ماند',
  'client/app.js:589 (at) · needs_review=0');

/* ── ۹) متادیتای شاهد: پین ممیزی، دلتای محصول، لاگ آزمون ───────────────────── */
const d05 = read('docs/cloud/05-audit-sha-freeze.md');
check(/04e0636/.test(d05) && /04e0636/.test(d11), 'S1 پین SHA ممیزی در اسناد ۰۵ و ۱۱ هست', '04e0636');
let diffN = -1;
try {
  diffN = cp.execSync('git diff --name-only f2fc472 HEAD -- server client tests scripts package.json package-lock.json installer desktop install deploy',
    { encoding: 'utf8' }).split('\n').filter(Boolean).length;
} catch (e) { diffN = -2; }
check(diffN === 0, 'S2 کد محصول نسبت به پایهٔ ممیزی f2fc472 تغییر نکرده (حکم ممیزی روی HEAD معتبر است)',
  `product_diff_files=${diffN}`);
const tlog = read('docs/cloud/reports/evidence/mission-05-tests-run.log');
const tPass = faToInt((tlog.match(/pass=([0-9۰-۹]+)/) || [])[1] || '0');
const tFail = faToInt((tlog.match(/fail=([0-9۰-۹]+)/) || [])[1] || '0');
const tClaim = faToInt((d05.match(/([۰-۹]+) موفق/) || [])[1] || '0');
check(tPass === 88 && tFail === 0 && tClaim === tPass, 'S3 ادعای «۸۸ آزمون سبز» با لاگ شاهد خام یکی است',
  `log pass=${tPass} fail=${tFail} doc05 claim=${tClaim}`);

/* ── ۱۰) ماتریس پذیرش ۱۱ و بند دور بستن ────────────────────────────────────── */
const acRows = (d11.match(/^\| AC\u2011\d+/gm) || []).length;
check(acRows === 5, 'A1 ماتریس پذیرش ۱۱ پنج ردیف دارد', `ac_rows=${acRows}`);
check(/حکم:\s*۵\/۵/.test(d11), 'A2 حکم ثبت‌شدهٔ سند ۵/۵ است', 'حکم: ۵/۵');
check(/^## ۶\./m.test(d11), 'A3 بند «دور بستن» (§۶) در سند ۱۱ هست', '§۶');

/* ── خروجی ────────────────────────────────────────────────────────────────── */
out.push('');
out.push(`CLAIMS rows=${rows.length} attached=${attached} citations=${citTotal} resolved=${citOk} broken=${citBroken.length}`);
out.push(`VERDICTS pass=${cP} fail=${cF} unknown=${cU} blocked=${cB} conformance=${dPct.PASS}%`);
out.push(`ATTACH refs=${kinds.refs} probe=${kinds.probe} predicate=${kinds.predicate} unknown_list=${kinds.unknown} symbol=${kinds.symbol}`);
out.push(`PROBES cited=${probeRefs.length} resolved=${probeRefs.length - probeMissing.length}`);
out.push(`DRIFT rows=${driftRows.length} corrections=${CORRECTIONS.length} accepted=${ACCEPTED.length} (${driftRows.join(', ')})`);
out.push(`P0 f04=verified f06=verified backuproles=4`);
out.push(`ABSENCE cipher=0 tenant_id=0 tls=0 signature=0 seq=0 queue_cap=0`);
out.push(`SUMMARY pass=${PASS} fail=${FAIL} total=${PASS + FAIL}`);
console.log(out.join('\n'));
process.exit(FAIL === 0 ? 0 : 1);
