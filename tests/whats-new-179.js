'use strict';
/* ردیف ۱۷۹ — «چه چیزهایی تازه است؟» در همهٔ پنل‌ها از یک منبع (RELEASE_NOTES.json).
 *   WN-01 نسخهٔ package.json یادداشت دارد (هر انتشار باید بگوید چه چیزی عوض شد)
 *   WN-02 خروجی‌های ساخته‌شده (Dart + بلوک client/app.js) با منبع هم‌ترازند
 *   WN-03 قالب خط‌ها: رشته یا {t, for:[owner|school|web]} — بدون پنل ناشناخته و متن خالی
 *   WN-04 مانیفست سرور مدرسه (build-release) فقط متن خط‌های وب/مدرسه را می‌گیرد، نه خط‌های فقط-مالک
 *   WN-05 منطق وب: نسخه‌های جاافتاده، نخستین اجرا = فقط آخرین نسخه، به‌روز = هیچ
 *   WN-06 پنجره در پنل وب یک‌بار برای هر نسخه (نشانهٔ payesh.whatsnew.seen) و دکمهٔ تاریخچه در «سیستم»
 *   WN-07 جهش: یادداشت تازه بدون اجرای مولد ⇒ بررسی هم‌ترازی شکست می‌خورد
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let ok = 0, bad = 0;
function check(name, fn) {
  try { fn(); ok++; console.log('ok   ' + name); }
  catch (e) { bad++; console.log('FAIL ' + name + ' — ' + String(e && e.message || e).slice(0, 400)); }
}

const notes = JSON.parse(fs.readFileSync(path.join(ROOT, 'RELEASE_NOTES.json'), 'utf8'));
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const gen = path.join(ROOT, 'tools/gen-whats-new-179.mjs');

check('WN-01 package.json version ' + version + ' has release notes', () => {
  assert.ok(Array.isArray(notes[version]) && notes[version].length > 0, 'RELEASE_NOTES.json["' + version + '"] missing');
});

check('WN-02 generated Dart + web block in sync', () => {
  const r = spawnSync(process.execPath, [gen, '--check'], { encoding: 'utf8', cwd: ROOT });
  assert.strictEqual(r.status, 0, (r.stderr || '') + (r.stdout || ''));
});

check('WN-03 line format', () => {
  for (const [v, list] of Object.entries(notes)) {
    assert.ok(Array.isArray(list), v);
    for (const n of list) {
      if (typeof n === 'string') { assert.ok(n.trim(), v + ': empty'); continue; }
      assert.ok(n && typeof n.t === 'string' && n.t.trim(), v + ': object without t');
      if (n.for !== undefined) {
        assert.ok(Array.isArray(n.for) && n.for.length, v + ': for must be a non-empty list');
        for (const a of n.for) assert.ok(['owner', 'school', 'web'].includes(a), v + ': unknown audience ' + a);
      }
    }
  }
});

check('WN-04 build-release notes: text only, no owner-only lines', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/build-release.mjs'), 'utf8');
  const m = src.match(/NOTES = \(all\[VERSION\] \|\| \[\]\)([\s\S]*?);\n/);
  assert.ok(m, 'NOTES filter not found in build-release.mjs');
  const fn = new Function('all', 'VERSION', 'return (all[VERSION] || [])' + m[1] + ';');
  const sample = { '9.9.9': ['همه', { t: 'فقط مالک', for: ['owner'] }, { t: 'مدرسه', for: ['school'] }, { t: 'وب', for: ['web', 'owner'] }, { t: 'بی‌پنل' }] };
  assert.deepStrictEqual(fn(sample, '9.9.9'), ['همه', 'مدرسه', 'وب', 'بی‌پنل']);
  for (const n of fn(notes, version)) assert.strictEqual(typeof n, 'string');
});

/* client/app.js بلوک WHATS_NEW و توابع را در یک realm جدا اجرا می‌کنیم (بدون DOM). */
function webApi() {
  const src = fs.readFileSync(path.join(ROOT, 'client/app.js'), 'utf8');
  const a = src.indexOf('/* WHATS_NEW:BEGIN');
  const b = src.indexOf('function whatsNewHtml');
  assert.ok(a > 0 && b > a, 'WHATS_NEW block / functions not found');
  const ctx = {};
  vm.runInNewContext(src.slice(a, b) + '\nthis.api = { WHATS_NEW, whatsNewPending, wnCmp, WN_SEEN };', ctx);
  return ctx.api;
}

check('WN-05 web pending logic', () => {
  const { whatsNewPending, WHATS_NEW } = webApi();
  const list = [{ v: '0.9.35', n: ['a'] }, { v: '0.9.34', n: ['b'] }, { v: '0.9.33', n: ['c'] }, { v: '0.9.10', n: ['d'] }];
  const vs = r => JSON.parse(JSON.stringify(r.map(x => x.v)));
  assert.deepStrictEqual(vs(whatsNewPending('0.9.35', '0.9.33', list)), ['0.9.35', '0.9.34']);
  assert.deepStrictEqual(vs(whatsNewPending('0.9.35', null, list)), ['0.9.35']);
  assert.deepStrictEqual(vs(whatsNewPending('0.9.35', '0.9.35', list)), []);
  assert.deepStrictEqual(vs(whatsNewPending('0.9.34', '0.9.10', list)), ['0.9.34', '0.9.33'], 'never shows a release newer than the running client');
  assert.ok(WHATS_NEW.length > 0 && WHATS_NEW[0].v === version, 'embedded web notes start at ' + version);
  for (const r of WHATS_NEW) for (const t of r.n) assert.strictEqual(typeof t, 'string');
});

check('WN-06 web: once per version + history button', () => {
  const app = fs.readFileSync(path.join(ROOT, 'client/app.js'), 'utf8');
  const pages = fs.readFileSync(path.join(ROOT, 'client/pages.js'), 'utf8');
  assert.ok(/localStorage\.setItem\(WN_SEEN, current\)/.test(app), 'seen version stored');
  assert.ok(/case 'whats-new-all': showReleaseHistory\(\)/.test(app), 'history action');
  assert.ok(/data-act="whats-new-all"/.test(pages), 'system page button');
  assert.ok(/maybeShowReleaseNotes\(\);/.test(app), 'called on start');
});

check('WN-07 mutant: new note without regenerating ⇒ check fails', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wn179-'));
  try {
    for (const f of ['RELEASE_NOTES.json', 'client/app.js', 'apps/payesh/packages/payesh_update/lib/src/whats_new_data.dart', 'tools/gen-whats-new-179.mjs']) {
      fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    }
    const r0 = spawnSync(process.execPath, [path.join(tmp, 'tools/gen-whats-new-179.mjs'), '--check'], { encoding: 'utf8' });
    assert.strictEqual(r0.status, 0, 'copy in sync: ' + r0.stderr);
    const n = JSON.parse(fs.readFileSync(path.join(tmp, 'RELEASE_NOTES.json'), 'utf8'));
    n['99.0.0'] = ['جهش'];
    fs.writeFileSync(path.join(tmp, 'RELEASE_NOTES.json'), JSON.stringify(n));
    const r1 = spawnSync(process.execPath, [path.join(tmp, 'tools/gen-whats-new-179.mjs'), '--check'], { encoding: 'utf8' });
    assert.strictEqual(r1.status, 1, 'mutant must be caught');
    assert.ok(/stale/.test(r1.stderr));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

console.log(`WHATS-NEW-179: ${ok}/${ok + bad} ${bad ? 'FAIL' : 'OK'}`);
process.exit(bad ? 1 : 0);
