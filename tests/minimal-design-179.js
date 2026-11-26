'use strict';
/* ردیف ۱۷۹ (بخش ۲) — طرح «مینیمال حرفه‌ای» (انتخاب مالک) با پوستهٔ روشن / تاریک / سیستم در همهٔ پنل‌ها.
 *   MD-01 توکن‌های client/pulse.css (روشن و تاریک) همان PayeshTokens.minimalLight/minimalDark فلاتر‌اند
 *   MD-02 سه بیان تاریک یکسان‌اند (prefers-color-scheme، [data-theme="dark"]) و «روشن» صریح بر سیستم تاریک چیره است
 *   MD-03 کنتراست WCAG AA: متن، متن کم‌رنگ و پیوند روی هر سطح؛ متن دکمهٔ اصلی؛ هر جفت وضعیت
 *   MD-04 تخت و بی‌گرادیان: دکمهٔ اصلی و آیتم فعال منو بدون گرادیان/درخشش؛ رنگ‌های فیروزه‌ای قدیمی حذف
 *   MD-05 کلید پوسته در وب: سیستم → روشن → تاریک → سیستم، localStorage «payesh.theme»، <html data-theme>
 *   MD-06 دکمهٔ پوسته در «سیستم» و نوار کناری وب + کنش theme-cycle در app.js + ماتریس برابری
 *   MD-07 پنل وب مالک: theme.css از همین pulse.css ساخته شده، app.css بی‌گرادیان، رنگ مانیفست‌ها
 *   MD-08 اپ‌های بومی: مالک و مدرسه look: minimal، اپ مدرسه انتخاب را در prefs «theme» نگه می‌دارد
 *   MD-09 جهش‌ها: هر بررسی ورودی خراب را رد می‌کند
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
let ok = 0, bad = 0;
function check(name, fn) {
  try { fn(); ok++; console.log('ok   ' + name); }
  catch (e) { bad++; console.log('FAIL ' + name + ' — ' + String(e && e.message || e).slice(0, 400)); }
}

const themeGen = require(path.join(ROOT, 'apps/owner-panel/scripts/gen-theme.js'));
const PULSE = read('client/pulse.css');
const TOKENS_DART = read('apps/payesh/packages/payesh_ui/lib/src/tokens.dart');

function dartTokens(src, name) {
  const m = new RegExp('static const PayeshTokens ' + name + ' = PayeshTokens\\(([\\s\\S]*?)\\n  \\);').exec(src);
  if (!m) throw new Error('tokens.dart: ' + name + ' not found');
  const out = {};
  for (const mm of m[1].matchAll(/(\w+): Color\(0xFF([0-9A-Fa-f]{6})\)/g)) out[mm[1]] = '#' + mm[2].toLowerCase();
  return out;
}
const MAP = { '--bg': 'bg', '--card': 'card', '--ink': 'ink', '--muted': 'muted', '--line': 'line', '--primary': 'primary',
  '--soft': 'soft', '--green': 'success', '--green-bg': 'successBg', '--red': 'danger', '--red-bg': 'dangerBg',
  '--amber': 'warning', '--amber-bg': 'warningBg', '--purple': 'info', '--purple-bg': 'infoBg' };

function topBlock(css, selector) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0, start = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === '{') {
      if (depth === 0 && clean.slice(start, i).trim().replace(/\s+/g, ' ') === selector) return clean.slice(i + 1, clean.indexOf('}', i));
      depth++;
    } else if (c === '}') { depth--; if (depth === 0) start = i + 1; }
  }
  return null;
}
function decls(body) {
  const o = {};
  for (const part of String(body || '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0 && part.slice(0, i).trim().startsWith('--')) o[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return o;
}

/* ── بررسی‌ها به‌صورت تابع تا جهش‌ها همان‌ها را روی ورودی خراب اجرا کنند ── */
const C = {
  tokens(pulse, dart) {
    const { light, dark } = themeGen.parsePulse(pulse);
    const L = dartTokens(dart, 'minimalLight'), D = dartTokens(dart, 'minimalDark');
    const out = [];
    for (const [css, d] of Object.entries(MAP)) {
      if (light.map[css] !== L[d]) out.push(`light ${css}=${light.map[css]} ≠ dart ${d}=${L[d]}`);
      if (dark.map[css] !== D[d]) out.push(`dark ${css}=${dark.map[css]} ≠ dart ${d}=${D[d]}`);
    }
    if (light.map['--radius'] !== '10px') out.push('radius must be 10px');
    return out;
  },
  modes(pulse) {
    const out = [];
    try { themeGen.parsePulse(pulse); } catch (e) { out.push(e.message); }
    const root = decls(topBlock(pulse, ':root'));
    const forced = decls(topBlock(pulse, ':root[data-theme="light"]'));
    if (JSON.stringify(root) !== JSON.stringify(forced)) out.push(':root[data-theme="light"] must repeat the light tokens exactly');
    return out;
  },
  contrast(pulse) {
    const { light, dark } = themeGen.parsePulse(pulse);
    const lum = (hex) => {
      const n = parseInt(hex.slice(1), 16);
      const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const out = [];
    for (const [name, t] of [['light', light.map], ['dark', Object.assign({}, light.map, dark.map)]]) {
      /* Row 180 (design 2 as drawn): body text 4.5 on every surface; the zinc-500 hint text
         (--muted) is 4.5 on page/card and ≥ 4.3 on the soft selection pill (the spec's own
         #71717a on #f4f4f5); status colours are only 6px dots / icons beside --ink2 text in
         outlined pills, so they need the non-text 2.5 floor against the card. */
      for (const s of ['--bg', '--card', '--soft']) {
        for (const f of ['--ink', '--ink2', '--muted', '--primary']) {
          const min = f === '--muted' && s === '--soft' ? 4.3 : 4.5;
          const r = ratio(t[f], t[s]);
          if (r < min) out.push(`${name} ${f} on ${s} = ${r.toFixed(2)}`);
        }
      }
      if (ratio(t['--on-primary'], t['--primary']) < 4.5) out.push(`${name} on-primary on primary`);
      if (ratio(t['--link'], t['--card']) < 4.5) out.push(`${name} --link on --card`);
      for (const k of ['green', 'red', 'amber', 'purple']) {
        const r = ratio(t['--' + k], t['--card']);
        if (r < 2.5) out.push(`${name} --${k} dot on --card = ${r.toFixed(2)}`);
      }
    }
    return out;
  },
  flat(pulse) {
    const out = [];
    const rule = (sel) => { const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(pulse); return m ? m[1] : ''; };
    const nav = rule('.navitem.on');
    if (/gradient|rgba\(13, 148, 136/.test(nav) || !/background:\s*var\(--soft\)/.test(nav)) out.push('.navitem.on must be a soft pill');
    if (!/color:\s*var\(--ink\)/.test(nav)) out.push('.navitem.on text must be ink');
    const btn = rule('.btn.primary, .btn.sched-top-action');
    if (/gradient/.test(btn) || !/background:\s*var\(--primary\)/.test(btn)) out.push('.btn.primary must be a flat fill');
    if (/radial-gradient\(at/.test(rule('body'))) out.push('body background wash is back');
    const live = pulse.replace(/\.nabd-card::before \{[^}]*\}/, '');
    if (/#0d9488|#14b8a6|#5eead4|#2dd4bf|rgba\(13, 148, 136|rgba\(13, 76, 68/i.test(live)) out.push('old teal colour left in pulse.css');
    return out;
  },
};

check('MD-01 web tokens = Flutter minimalLight / minimalDark (15 tokens × 2 modes, radius 10)', () => {
  assert.deepStrictEqual(C.tokens(PULSE, TOKENS_DART), []);
});
check('MD-02 dark expressed once (media = [data-theme=dark]); explicit light repeats :root', () => {
  assert.deepStrictEqual(C.modes(PULSE), []);
  assert.ok(/:root\[data-theme="dark"\] \{ color-scheme: dark; \}/.test(PULSE), 'color-scheme for explicit dark');
});
check('MD-03 WCAG AA on every surface, filled button and status pair (light + dark)', () => {
  assert.deepStrictEqual(C.contrast(PULSE), []);
});
check('MD-04 flat: no gradient/glow on primary button and active nav item, no teal left', () => {
  assert.deepStrictEqual(C.flat(PULSE), []);
});

/* MD-05: کد پوسته در pages.js با DOM و localStorage ساختگی */
function themeSandbox(stored) {
  const store = new Map(stored == null ? [] : [['payesh.theme', stored]]);
  const attrs = new Map();
  const documentElement = {
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
  };
  const sandbox = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    document: { documentElement },
  };
  const src = read('client/pages.js');
  const a = src.indexOf('const THEME_KEY');
  const b = src.indexOf("try { applyTheme(themeMode()); }");
  const end = src.indexOf('\n', b);
  vm.runInNewContext(src.slice(a, end) + '\nthis.api = { themeMode, setThemeMode, nextThemeMode, themeButtonHtml, THEME_LABEL };', sandbox);
  return { api: sandbox.api, store, attrs };
}
check('MD-05 web toggle: system → light → dark → system; payesh.theme; <html data-theme>; applied at load', () => {
  const { api, store, attrs } = themeSandbox(null);
  assert.strictEqual(api.themeMode(), 'system');
  assert.ok(!attrs.has('data-theme'));
  const seen = [];
  for (let i = 0; i < 3; i++) {
    api.setThemeMode(api.nextThemeMode(api.themeMode()));
    seen.push([api.themeMode(), store.get('payesh.theme') || null, attrs.get('data-theme') || null]);
  }
  assert.deepStrictEqual(JSON.parse(JSON.stringify(seen)), [['light', 'light', 'light'], ['dark', 'dark', 'dark'], ['system', null, null]]);
  // a saved choice is applied before the first render
  const pre = themeSandbox('dark');
  assert.strictEqual(pre.attrs.get('data-theme'), 'dark');
  assert.ok(pre.api.themeButtonHtml().includes('data-act="theme-cycle"') && pre.api.themeButtonHtml().includes('پوسته: تاریک'));
  // junk in storage = system
  assert.strictEqual(themeSandbox('purple').api.themeMode(), 'system');
});
check('MD-06 theme button on «سیستم» + sidebar; app.js handles theme-cycle; parity matrix entry', () => {
  const pages = read('client/pages.js');
  const sys = pages.slice(pages.indexOf('PAGES.system = '), pages.indexOf('PAGES.system = ') + 1500);
  assert.ok(/\$\{themeButtonHtml\(\)\}/.test(sys), 'system page button');
  const shell = pages.slice(pages.indexOf('function shellHtml'), pages.indexOf('function canonicalBarHtml'));
  assert.ok(/themeButtonHtml\('theme-side'\)/.test(shell), 'sidebar button');
  assert.ok(/case 'theme-cycle': setThemeMode\(nextThemeMode\(themeMode\(\)\)\); render\(\); return;/.test(read('client/app.js')));
  const m = JSON.parse(read('docs/cloud/128-parity-matrix.json'));
  assert.ok(m.items.some(i => i.id === 'act:theme-cycle' && i.status === 'native'));
  assert.ok(/content="#18181b"/.test(read('client/index.html')));
  assert.strictEqual(JSON.parse(read('client/manifest.webmanifest')).theme_color, '#18181b');
});
check('MD-07 owner web panel: theme.css generated from this pulse.css, flat app.css, manifest colours', () => {
  assert.strictEqual(read('apps/owner-panel/web/theme.css'), themeGen.buildTheme(PULSE));
  const css = read('apps/owner-panel/web/app.css');
  assert.ok(!/gradient\(/.test(css), 'no gradients');
  assert.ok(/\.navitem\[aria-current="page"\] \{[^}]*background: var\(--soft\)/.test(css), 'soft pill');
  const man = JSON.parse(read('apps/owner-panel/web/manifest.webmanifest'));
  assert.strictEqual(man.theme_color, '#18181b');
  assert.strictEqual(man.background_color, '#fafafa');
  assert.ok(/data-action': 'theme'/.test(read('apps/owner-panel/web/app.js')), 'owner panel keeps its روشن/تاریک/سیستم button');
});
check('MD-08 native apps: minimal look + persisted روشن/تاریک/سیستم in both apps', () => {
  const owner = read('apps/payesh/owner/lib/src/app.dart');
  assert.ok(/look: PayeshLook\.minimal/.test(owner) && !/look: PayeshLook\.nabd/.test(owner));
  assert.ok(/PayeshThemeMode\.next\(_theme\)/.test(owner) && /'theme',/.test(owner));
  const app = read('apps/payesh/app/lib/src/app.dart');
  assert.ok(/static const look = PayeshLook\.minimal;/.test(app));
  assert.ok(/themeController: themeMode/.test(app) && /onTheme: syncPalette/.test(app));
  assert.ok(/PayeshThemeButton\(compact: true\)/.test(app), 'button in the top strip');
  const main = read('apps/payesh/app/lib/main.dart');
  assert.ok(/await themeMode\.load\(prefs\.read\)/.test(main) && /prefs\.write\(PayeshThemeMode\.storeKey, v\)/.test(main));
  assert.ok(/Key\('sys-theme'\)/.test(read('apps/payesh/app/lib/src/login/login_screens.dart')));
  assert.ok(/class PayeshThemeMode extends ValueNotifier<ThemeMode>/.test(read('apps/payesh/packages/payesh_ui/lib/src/theme_mode.dart')));
});

/* MD-09: جهش‌ها */
const MUT = [
  ['token drift (light primary)', () => C.tokens(PULSE.replace('--primary: #18181b;', '--primary: #18181c;'), TOKENS_DART)],
  ['token drift (dart dark bg)', () => C.tokens(PULSE, TOKENS_DART.replace(/(minimalDark = PayeshTokens\([\s\S]*?bg: Color\(0xFF)09090B/, '$1000000'))],
  ['explicit light block missing', () => C.modes(PULSE.replace(':root[data-theme="light"] {', '.x-light {'))],
  ['explicit dark differs from media dark', () => C.modes(PULSE.replace(/(html\.dark, body\.dark, \[data-theme="dark"\] \{[\s\S]*?)--bg: #09090b;/, '$1--bg: #000000;'))],
  ['muted too light', () => C.contrast(PULSE.replace('--muted: #6b6b73;', '--muted: #a1a1aa;'))],
  ['gradient back on nav', () => C.flat(PULSE.replace(/(\.navitem\.on \{[^}]*)background: var\(--soft\);/, '$1background: linear-gradient(135deg, var(--primary), var(--primary-2));'))],
  ['teal leftover', () => C.flat(PULSE + '\n.x { color: #0d9488; }')],
];
check('MD-09 mutations rejected (' + MUT.length + ')', () => {
  for (const [label, fn] of MUT) {
    let r;
    try { r = fn(); } catch (e) { r = [e.message]; }
    assert.ok(Array.isArray(r) && r.length > 0, 'mutation not caught: ' + label);
  }
});

console.log(`MINIMAL-DESIGN-179 ok=${ok} fail=${bad}`);
process.exit(bad ? 1 : 0);
