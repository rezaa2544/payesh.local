'use strict';
/* Row 73 — Jalali / Persian-digit conformance vectors, produced by and checked against the WEB
   client's own functions (client/app.js toJalali/jdate/fa/norm, client/import.js
   impJalaliToIso/impIsoToJalali). The same file (docs/cloud/contracts/conformance/jalali-v1.json)
   runs against the native Dart port in apps/payesh/packages/payesh_ui (test/jalali_conformance_test.dart).
   Run: node tests/conformance-jalali-73.js          (verify)
        node tests/conformance-jalali-73.js --write  (regenerate after an intentional web change) */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'docs', 'cloud', 'contracts', 'conformance', 'jalali-v1.json');
const slice = (src, from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `marker not found: ${from} … ${to}`);
  return src.slice(a, b);
};
const app = fs.readFileSync(path.join(ROOT, 'client', 'app.js'), 'utf8');
const imp = fs.readFileSync(path.join(ROOT, 'client', 'import.js'), 'utf8');
const code = [
  slice(app, 'const fa = n =>', 'const alphaKey'),
  slice(app, 'function toJalali(', 'function toMin('),
  slice(imp, 'function impLatin(', '\n}\n') + '\n}\n',
  slice(imp, 'const _impDiv', '/* کد ملی'),
  'module.exports = { fa, norm, toJalali, jdate, J_MONTHS, J_DAYS, weekdayIndex, impJalaliToIso, impIsoToJalali, impToGregorian };',
].join('\n');
const sandbox = { module: { exports: {} }, Date, String, Number, Math, isNaN, now: () => new Date() };
vm.runInNewContext(code, sandbox, { filename: 'web-jalali.js' });
const W = sandbox.module.exports;
const plain = o => JSON.parse(JSON.stringify(o)); // vm realm → plain objects

// deterministic sample: Nowruz windows + month edges for 1925..2125, plus a seeded spread
function isoDates() {
  const out = new Set();
  const pad = n => String(n).padStart(2, '0');
  const add = (y, m, d) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    out.add(`${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`);
  };
  for (let y = 1925; y <= 2125; y++) {
    for (let d = 18; d <= 23; d++) add(y, 3, d);           // Nowruz / Esfand end
    for (const [m, d] of [[1, 1], [2, 28], [2, 29], [3, 1], [6, 21], [6, 22], [9, 22], [9, 23], [12, 21], [12, 22], [12, 31]]) add(y, m, d);
  }
  let s = 73;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 400; i++) add(1900 + Math.floor(rnd() * 250), 1 + Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28));
  return [...out].sort();
}

function build() {
  const dates = isoDates().map(iso => {
    const [y, m, d] = iso.split('-').map(Number);
    const j = W.toJalali(y, m, d);
    return { iso, jalali: j, jdate: W.jdate(iso), slash: W.impIsoToJalali(iso), weekday: W.weekdayIndex(new Date(iso + 'T00:00:00')) };
  });
  const toIso = [];
  for (let jy = 1300; jy <= 1500; jy += 1) {
    for (const [jm, jd] of [[1, 1], [6, 31], [7, 1], [12, 29], [12, 30]]) {
      toIso.push({ input: `${jy}/${jm}/${jd}`, iso: W.impJalaliToIso(`${jy}/${jm}/${jd}`) });
    }
  }
  for (const input of ['۱۴۰۵/۰۸/۱۹', '1405-8-19', '١٤٠٥/٠٨/١٩', '1199/01/01', '1405/13/01', '1405/00/10', '1405/01/32', 'abc', '', '1700/01/01']) {
    toIso.push({ input, iso: W.impJalaliToIso(input) });
  }
  const digits = ['0123456789', 'کلاس 10 الف', '1405/08/19', '', '12:05', 'v0.1.0'].map(s => ({ latin: s, fa: W.fa(s), back: W.norm(W.fa(s)) }));
  return {
    schema: 'jalali-v1',
    source: 'client/app.js toJalali/jdate/fa/norm/weekdayIndex + client/import.js impJalaliToIso/impIsoToJalali',
    months: W.J_MONTHS,
    weekdays: W.J_DAYS,
    dates,
    jalali_to_iso: toIso,
    digits,
    invalid_jdate: ['', 'not-a-date'].map(s => ({ input: s, jdate: W.jdate(s) })),
  };
}

const doc = plain(build());
if (process.argv.includes('--write')) {
  // one vector per line: small, reviewable diffs
  const body = Object.entries(doc).map(([k, v]) => Array.isArray(v) && typeof v[0] === 'object'
    ? ` ${JSON.stringify(k)}: [\n${v.map(x => '  ' + JSON.stringify(x)).join(',\n')}\n ]`
    : ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  fs.writeFileSync(FILE, '{\n' + body + '\n}\n');
  console.log(`wrote ${path.relative(ROOT, FILE)}: ${doc.dates.length} dates, ${doc.jalali_to_iso.length} jalali→iso, ${doc.digits.length} digit cases`);
} else {
  const committed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.deepStrictEqual(committed, doc, 'jalali-v1.json is not what the web client produces');
  // independent check: web Gregorian→Jalali→Gregorian is exact for EVERY day 1900‥2150
  // (regression for the Nowruz off-by-one-year bug fixed in row 73, e.g. 2024-03-20 → 1403/1/1)
  let days = 0;
  for (let t = Date.UTC(1900, 0, 1); t <= Date.UTC(2150, 0, 1); t += 864e5, days++) {
    const d = new Date(t);
    const g = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    assert.deepStrictEqual(plain(W.impToGregorian(...W.toJalali(...g))), g, g.join('-'));
  }
  assert.deepStrictEqual(plain(W.toJalali(2024, 3, 20)), [1403, 1, 1]);
  assert.deepStrictEqual(plain(W.toJalali(2028, 3, 20)), [1407, 1, 1]);
  assert.deepStrictEqual(plain(W.toJalali(2026, 11, 10)), [1405, 8, 19]);
  assert.ok(doc.dates.length > 2000);
  console.log(`JALALI-WEB-CONFORMANCE-OK roundtrip_days=${days} dates=${doc.dates.length} jalali_to_iso=${doc.jalali_to_iso.length} digits=${doc.digits.length}`);
}
