#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   پروب دور بستن ردیف ۱۶ — «اعداد سند بازمحاسبه‌پذیرند، معیارها نام‌پذیرند»

   چرا وجود دارد: بازبینی ۱۶ (REVIEW-16) دو ناسازگاری عددی را دستی پیدا کرد
   (R‑16‑۲ نسخهٔ p95/RTO، R‑16‑۳ فرمول هزینه). هیچ آزمونی جلوی برگشت آن‌ها را
   نمی‌گرفت. این پروب همان آزمون است: مدل هزینه/ظرفیت را از ورودی‌های
   اندازه‌گیری‌شده بازحساب می‌کند و اعداد سند را با آن مقایسه می‌کند، هر ۱۴
   معیار را به نشانهٔ متنی لازم گره می‌زند، و هفت اصلاح R‑16‑۱..۷ را می‌سنجد.

   هیچ کد محصولی تغییر نمی‌کند؛ سرور با دیتابیس موقت (mktemp) بالا می‌آید.

   اجرا: node --experimental-sqlite --disable-warning=ExperimentalWarning \
           docs/cloud/reports/evidence/probe-16-model.cjs
   ═══════════════════════════════════════════════════════════════════ */
'use strict';
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..');
const DOC16 = 'docs/cloud/16-ha-observability-cost.md';
const DOC04 = 'docs/cloud/04-capacity-and-availability.md';
const DOC15 = 'docs/cloud/15-backup-recovery.md';
const RUNTIME_EVIDENCE = 'docs/cloud/reports/evidence/mission-16-observability-probe.txt';
const BASE_SHA = 'f2fc472';
const PRODUCT_PATHS = 'server client tests scripts package.json package-lock.json installer desktop install deploy';

const results = [];
function check(label, fn) {
  let pass = false, detail = '';
  try { const r = fn(); pass = r === true || (r && r.pass === true); detail = (r && r.detail) || ''; }
  catch (e) { pass = false; detail = 'EXC: ' + (e && e.message); }
  results.push({ label, pass, detail });
  return pass;
}

/* ── ابزار عدد فارسی ────────────────────────────────────────────────── */
const FA = '۰۱۲۳۴۵۶۷۸۹';
const fa = s => String(s).replace(/[۰-۹]/g, c => String(FA.indexOf(c)));
const norm = s => fa(s).replace(/[٬,]/g, '').replace(/٫/g, '.');
function num(s) {
  const m = norm(String(s).replace(/\*\*/g, '')).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function range(s) {
  const nums = [...norm(String(s).replace(/\*\*/g, '')).matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
  if (!nums.length) return null;
  return nums.length >= 2 ? [nums[0], nums[nums.length - 1]] : [nums[0], nums[0]];
}
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function rows(text) {
  // جدول‌های Markdown ⇒ [{first, cells, line}]
  return text.split('\n').filter(l => l.trim().startsWith('|')).map(line => {
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    return { first: cells[0].replace(/\*\*/g, '').replace(/`/g, '').trim(), cells, line };
  });
}
const rowByPrefix = (rs, prefix) => rs.find(r => r.first.startsWith(prefix));
function section(text, start, end) {
  const i = text.indexOf(start); if (i < 0) return '';
  const j = end ? text.indexOf(end, i + start.length) : -1;
  return j < 0 ? text.slice(i) : text.slice(i, j);
}

/* ── راه‌اندازی سرور واقعی برای اندازه‌گیری ورودی مدل ──────────────── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-m16model-'));
let child = null;

async function freePort() {
  const net = require('node:net');
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function req(BASE, p, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  const res = await fetch(BASE + p, {
    method: opts.method || 'GET', headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, bytes: Buffer.byteLength(text), text };
}

async function measurePayload() {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: TMP, PAYESH_LOG: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_LIVE_MS: '0',
      PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0', PAYESH_TRUST_PROXY: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 25000) {
    try { const r = await req(BASE, '/api/health'); if (r.status === 200) { up = true; break; } } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 150));
  }
  if (!up) throw new Error('server did not start');
  const setup = JSON.parse((await req(BASE, '/api/setup', { method: 'POST', body: {
    school_name: 'دبیرستان مدل ۱۶', manager_name: 'مدیر مدل', password: 'Model-16-Aa', phone: '09120000061',
  } })).text);
  if (!setup.ok) throw new Error('setup failed');
  const token = setup.session.token;
  const anon = await req(BASE, '/api/live/rev');
  const live = await req(BASE, '/api/live/rev', { token });
  return { anonStatus: anon.status, status: live.status, bytes: live.bytes, body: live.text };
}

function git(cmd) {
  try { return execSync(cmd, { cwd: ROOT }).toString().trim(); } catch (e) { return 'ERR:' + (e && e.message); }
}

(async () => {
  const d16 = read(DOC16), d04 = read(DOC04), d15 = read(DOC15);
  const r16 = rows(d16);

  let measured;
  try { measured = await measurePayload(); }
  catch (e) { measured = { error: String(e && e.message) }; }
  if (child) { try { child.kill('SIGKILL'); } catch {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  /* ── ورودی‌های مدل، از سند و از اندازه‌گیری ─────────────────────── */
  const rDev = rowByPrefix(r16, 'دستگاه هم‌زمان اوج');
  const rPoll = rowByPrefix(r16, 'حجم پاسخ هر poll');
  const rEgress = rowByPrefix(r16, 'پهنای باند خروجی/ماه');
  const rLog = rowByPrefix(r16, 'حجم لاگ/ماه');
  const devices = rDev ? [num(rDev.cells[1]), num(rDev.cells[2]), num(rDev.cells[3])] : [null, null, null];
  const formula = rEgress ? norm(rEgress.cells[4]) : '';
  const fm = formula.match(/\((\d+)\+(\d+)/);
  const docPayload = fm ? Number(fm[1]) : null;
  const headerBytes = fm ? Number(fm[2]) : null;
  const pollRowBytes = rPoll ? num(rPoll.cells[1]) : null;

  /* ── ۱) ورودی اندازه‌گیری‌شده ─────────────────────────────────────── */
  check('M1 اندازهٔ پاسخ poll اندازه‌گیری‌شده = عدد فرمول سند', () => ({
    pass: measured.status === 200 && measured.anonStatus === 401 &&
          measured.bytes === docPayload && pollRowBytes === docPayload,
    detail: `measured=${measured.bytes} doc_formula=${docPayload} doc_row=${pollRowBytes} anon=${measured.anonStatus}`,
  }));
  check('M2 سناریوهای دستگاه ۵۰۰/۴٬۰۰۰/۲۰٬۰۰۰', () => ({
    pass: devices[0] === 500 && devices[1] === 4000 && devices[2] === 20000,
    detail: 'devices=' + JSON.stringify(devices),
  }));

  /* ── ۲) بازمحاسبهٔ پهنای باند خروجی ───────────────────────────────── */
  const perReq = (docPayload || 0) + (headerBytes || 0);
  const egressTb = devices.map(d => (perReq * 86400 * 30 * d) / 1e12);
  const docEgress = rEgress ? [num(rEgress.cells[1]), num(rEgress.cells[2]), num(rEgress.cells[3])] : [null, null, null];
  const names = ['محافظه‌کارانه', 'میانه', 'رشد'];
  egressTb.forEach((tb, i) => {
    check(`M${3 + i} پهنای باند خروجی ${names[i]} = ${tb.toFixed(2)} TB`, () => {
      const rel = docEgress[i] ? Math.abs(tb - docEgress[i]) / tb : 1;
      return { pass: rel <= 0.01, detail: `model=${tb.toFixed(3)} doc=${docEgress[i]} rel=${(rel * 100).toFixed(2)}%` };
    });
  });

  /* ── ۳) بازمحاسبهٔ حجم لاگ ────────────────────────────────────────── */
  const logGb = devices.map(d => (80 * d * 86400 * 30) / 1e9);
  const docLog = rLog ? [num(rLog.cells[1]), num(rLog.cells[2]), num(rLog.cells[3])] : [null, null, null];
  logGb.forEach((gb, i) => {
    check(`M${6 + i} حجم لاگ ${names[i]} = ${gb.toFixed(1)} GB/ماه`, () => {
      const rel = docLog[i] ? Math.abs(gb - docLog[i]) / gb : 1;
      return { pass: rel <= 0.01, detail: `model=${gb.toFixed(2)} doc=${docLog[i]} rel=${(rel * 100).toFixed(2)}%` };
    });
  });

  /* ── ۴) هزینهٔ خروجی از بازهٔ واحد قیمت [E] ──────────────────────── */
  const euroRow = rowByPrefix(r16, 'خروجی');
  const docEuro = euroRow ? [range(euroRow.cells[1]), range(euroRow.cells[2]), range(euroRow.cells[3])] : [null, null, null];
  egressTb.forEach((tb, i) => {
    const gb = tb * 1000;
    const lo = gb * 0.008, hi = gb * 0.012;
    check(`M${9 + i} هزینهٔ خروجی ${names[i]} = €${lo.toFixed(0)}–${hi.toFixed(0)}`, () => {
      const d = docEuro[i];
      const tol = Math.max(0.5, 0.01 * Math.max(lo, hi));
      const okp = d && Math.abs(d[0] - lo) <= tol && Math.abs(d[1] - hi) <= tol;
      return { pass: !!okp, detail: `model=€${lo.toFixed(1)}–${hi.toFixed(1)} doc=€${d ? d.join('–') : '?'} tol=${tol.toFixed(2)}` };
    });
  });

  /* ── ۵) جمع شناخته‌شده = مجموع اقلام خودِ سند ────────────────────── */
  check('M12 جمع شناخته‌شده = مجموع سه قلم جدول سند (سه سناریو)', () => {
    const eur = rowByPrefix(r16, 'خروجی'), sto = rowByPrefix(r16, 'ذخیره/بکاپ'),
          lg = rowByPrefix(r16, 'لاگ'), tot = rowByPrefix(r16, 'جمع شناخته‌شده');
    if (!eur || !sto || !lg || !tot) return { pass: false, detail: 'ردیف‌های جدول هزینه پیدا نشد' };
    const bad = [];
    for (let i = 0; i < 3; i++) {
      const parts = [range(eur.cells[i + 1]), range(sto.cells[i + 1]), range(lg.cells[i + 1])];
      const t = range(tot.cells[i + 1]);
      const sum = [parts[0][0] + parts[1][0] + parts[2][0], parts[0][1] + parts[1][1] + parts[2][1]];
      if (Math.abs(sum[0] - t[0]) > Math.max(1, 0.01 * sum[0]) || Math.abs(sum[1] - t[1]) > Math.max(1, 0.01 * sum[1])) {
        bad.push(`${names[i]}: sum=${sum.join('–')} doc=${t.join('–')}`);
      }
    }
    return { pass: bad.length === 0, detail: bad.join(' | ') || 'ALL-SUMS-MATCH' };
  });

  /* ── ۶) نگهبان‌های «بدون تصمیم مالی/ادعای SLA خودسرانه» ──────────── */
  check('M13 قیمت vCPU/پایگاه «?» و عنوان §۷.۲ «نامعلوم» است', () => {
    const pv = rowByPrefix(r16, 'p_vcpu'), pd = rowByPrefix(r16, 'p_db');
    const head = /###\s*۷\.۲[^\n]*/.exec(d16);
    const okp = !!(pv && pd) && pv.cells[2].trim() === '?' && pd.cells[2].trim() === '?' &&
                !!head && head[0].includes('نامعلوم');
    return { pass: okp, detail: `p_vcpu=${pv && pv.cells[2]} p_db=${pd && pd.cells[2]} heading=${head ? head[0].trim() : 'missing'}` };
  });
  check('M14 هیچ ردیف جدولی «جمع» با عدد خودساختهٔ ۷۴ نیست', () => {
    const bad = r16.filter(r => r.first.includes('جمع') && norm(r.line).includes('74'));
    return { pass: bad.length === 0, detail: bad.length ? bad[0].line.trim() : 'no-self-made-total' };
  });
  check('M15 واژهٔ SLA فقط در بافت نفی/بازآمده به‌کار رفته (جدول SLO بدون SLA)', () => {
    const slo = section(d16, '## ۲.', '## ۳.');
    if (slo.includes('SLA')) return { pass: false, detail: 'SLA در جدول SLO آمده' };
    const bad = d16.split('\n').filter(l => l.includes('SLA') &&
      !['نیست', 'ندارد', 'بدون', 'نمی‌شود', 'نشود', 'باز', 'BC‑16‑۲'].some(t => l.includes(t)));
    return { pass: bad.length === 0, detail: bad.length ? bad[0].trim().slice(0, 90) : 'only-negated' };
  });

  /* ── ۷) پوشش ۱۴ معیار با نشانهٔ متنی لازم ────────────────────────── */
  const AC = [
    ['معیار ۱ HA و failover', ['LB', 'standby', 'promote', 'SP‑1']],
    ['معیار ۲ رصدپذیری با آستانه و اقدام', ['/readyz', 'آستانه', 'اقدام']],
    ['معیار ۳ RPO/RTO صریح و برچسب‌دار', ['RPO', 'RTO', '[A]', '[M]']],
    ['معیار ۴ هزینه سه‌سناریویی برچسب‌دار', ['محافظه‌کارانه', 'میانه', 'رشد', '[E]']],
    ['معیار ۵ رشد و شکست هزینه', ['۷.۴', 'push', 'SSE', 'نمونه‌برداری']],
    ['معیار ۶ بدون Cloudflare', ['بدون Cloudflare']],
    ['معیار ۷ بدون تصمیم مالی خودسرانه', ['قیمت واحد', '?', 'نامعلوم']],
    ['معیار ۸ جدول نه‌گانهٔ نقاط شکست', ['SP‑1', 'SP‑9']],
    ['معیار ۹ شرط فعال‌سازی و ضد split‑brain', ['fencing', 'epoch', 'split']],
    ['معیار ۱۰ هشدار با شدت/مسئول/escalation', ['P0', 'P3', 'escalation', 'مسئول']],
    ['معیار ۱۱ متریک/لاگ/trace/health با نگهداشت', ['/metrics', '/healthz', 'نگهداشت', 'PII', 'trace'], '## ۵.', '## ۶.'],
    ['معیار ۱۲ فرمول/واحد و برچسب [M]/[A]/[E]', ['فرمول', '[M]', '[A]', '[E]']],
    ['معیار ۱۳ هم‌ترازی با ۰۴ و ۱۵', ['۰۴ §۴', '۱۵ §۲', 'C‑2']],
    ['معیار ۱۴ سازگاری با ۱۵ و ۱۶‑ب', ['۱۵ §۵', '۱۶‑ب']],
  ];
  AC.forEach(([label, tokens, s1, s2], i) => {
    const body = s1 ? section(d16, s1, s2) : d16;
    check(`A${i + 1} ${label}`, () => {
      const miss = tokens.filter(t => !body.includes(t));
      return { pass: miss.length === 0, detail: miss.length ? 'غایب: ' + miss.join(',') : 'ok' };
    });
  });

  /* ── ۸) هفت اصلاح R‑16‑۱..۷ بازبینی، هنوز برجاست ────────────────── */
  const sloRows = () => rows(section(d16, '## ۲.', '## ۳.'));
  const CORR = [
    ['نشست در پایگاه است (ادعای «نشست در حافظه» برگشته نیست)', () =>
      d16.includes('نشست‌ها در پایگاه‌اند') && !d16.includes('نشست‌ها در حافظه') && d16.includes('cfgCache')],
    ['جدول SLO: p95 نوشتن ۸۰۰ms و RTO ۲ ساعت (بدون ۴۰۰ms/۴h)', () => {
      const slo = sloRows();
      const w = slo.find(r => r.first.includes('p95 نوشتن'));
      const rt = slo.find(r => r.first === 'RTO');
      return !!w && !!rt && w.cells[1].includes('۸۰۰') && !w.cells[1].includes('۴۰۰') &&
             rt.cells[1].includes('۲ ساعت');
    }],
    ['قیمت واحد نامعلوم + فرمول باز، بدون جمع €۷۴', () => d16.includes('نامعلوم تا انتخاب میزبان') && d16.includes('فرمول') && sections03No74(d16)],
    ['نه نقطهٔ شکست SP‑1..SP‑9', () => ['SP‑1', 'SP‑2', 'SP‑3', 'SP‑4', 'SP‑5', 'SP‑6', 'SP‑7', 'SP‑8', 'SP‑9'].every(t => d16.includes(t))],
    ['fencing + epoch + تمرین فصلی', () => ['fencing', 'epoch', 'تمرین فصلی'].every(t => d16.includes(t))],
    ['سه نقطهٔ سلامت + متریک + لاگ JSON + نگهداشت', () => ['/healthz', '/readyz', '/metrics', 'JSON', 'نگهداشت'].every(t => d16.includes(t))],
    ['هشدار P0–P3 با مسئول و escalation و runbook', () => ['P0', 'P1', 'P2', 'P3', 'escalation', 'runbook', 'هشدار بدون مالک'].every(t => d16.includes(t))],
  ];
  function sections03No74(txt) {
    // هیچ ردیف جدولی نباید جمع €۷۴ اعلام کند
    return rows(txt).filter(r => r.first.includes('جمع') && norm(r.line).includes('74')).length === 0;
  }
  CORR.forEach(([label, fn], i) => {
    check(`R${i + 1} ${label}`, () => {
      let okp = false; try { okp = fn() === true; } catch { okp = false; }
      return { pass: okp, detail: okp ? 'ok' : 'missing' };
    });
  });

  /* ── ۹) هم‌ترازی بین‌سندی (منبع واحد) ────────────────────────────── */
  check('X1 ۰۴: C‑1=۳۰۰ms و C‑2=۸۰۰ms موجود است', () => {
    const c1 = rows(d04).find(r => r.first === 'C‑1'), c2 = rows(d04).find(r => r.first === 'C‑2');
    const okp = !!(c1 && c2) && c1.line.includes('۳۰۰') && c2.line.includes('۸۰۰');
    return { pass: okp, detail: okp ? 'ok' : 'C‑1/C‑2 mismatch' };
  });
  check('X2 ۱۵: RTO سناریوی ۲ = ≤ ۲ ساعت', () => {
    const s2 = rows(d15).find(r => r.first === '۲' && r.line.includes('خرابی جدول'));
    const okp = !!s2 && s2.cells[s2.cells.length - 1].includes('۲ ساعت');
    return { pass: okp, detail: okp ? 'ok' : (s2 ? s2.line.trim().slice(0, 80) : 'row-2 missing') };
  });

  /* ── ۱۰) تازگی شاهد اجرایی و تمامیت پایهٔ ممیزی ─────────────────── */
  const head = git('git rev-parse HEAD');
  check('E1 شاهد اجرایی امروز تازه است (head=HEAD) و ALL-MET', () => {
    if (!fs.existsSync(path.join(ROOT, RUNTIME_EVIDENCE))) return { pass: false, detail: 'evidence missing' };
    const ev = read(RUNTIME_EVIDENCE);
    const m = ev.match(/^head:\s*(\w+)/m);
    const okp = !!m && m[1] === head && ev.includes('EXPECTATIONS=ALL-MET') && ev.includes('exit=0');
    return { pass: okp, detail: `evidence_head=${m ? m[1] : 'none'} head=${head}` };
  });
  check('E2 پایهٔ ممیزی f2fc472 موجود است و کد محصول ۰ فایل تغییر', () => {
    const exists = git(`git cat-file -e ${BASE_SHA}^{commit} && echo OK`);
    if (exists !== 'OK') return { pass: false, detail: 'BASE-MISSING:' + BASE_SHA };
    const n = git(`git diff --name-only ${BASE_SHA} HEAD -- ${PRODUCT_PATHS}`).split('\n').filter(Boolean).length;
    return { pass: n === 0, detail: `product_diff_files=${n}` };
  });

  /* ── خروجی ──────────────────────────────────────────────────────── */
  const pass = results.filter(r => r.pass).length;
  const fail = results.length - pass;
  console.log('PROBE-16-MODEL — بازمحاسبهٔ مدل هزینه/ظرفیت و پوشش معیارهای ۱۶');
  console.log('SHA=' + head);
  console.log('DOC=' + DOC16);
  console.log('MEASURED_PAYLOAD_BYTES=' + (measured.bytes ?? 'ERR'));
  for (const r of results) {
    console.log(`${r.pass ? '✓' : '✗'} ${r.label}${r.detail ? '  ::  ' + r.detail : ''}`);
  }
  console.log(`SUMMARY pass=${pass} fail=${fail} total=${results.length}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('PROBE FAILED: ' + (e && e.message));
  console.log('SUMMARY pass=0 fail=1 total=1');
  process.exit(1);
});
