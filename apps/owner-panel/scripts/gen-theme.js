#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   تولید پوستهٔ «نبض» برای پنل مالک — PR-3 · ردیف ۹۸

   منبع حقیقت: `client/pulse.css`. هیچ مقدار رنگ/شعاعی در این فایل
   دستی نوشته نمی‌شود؛ توکن‌ها هر بار از خود pulse.css خوانده می‌شوند و
   `apps/owner-panel/web/theme.css` از روی آن ساخته می‌شود.

     node apps/owner-panel/scripts/gen-theme.js          ← بازتولید
     node apps/owner-panel/scripts/gen-theme.js --check  ← فقط بررسی drift

   آزمون `owner-spa.test.js` همین تابع را اجرا و خروجی را بایت‌به‌بایت با
   فایل ثبت‌شده مقایسه می‌کند؛ ویرایش دستی theme.css یا تغییر pulse.css بدون
   بازتولید، آزمون را قرمز می‌کند.
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PULSE = path.join(ROOT, 'client', 'pulse.css');
const OUT = path.join(ROOT, 'apps', 'owner-panel', 'web', 'theme.css');

/* توکن‌هایی که پنل مالک لازم دارد. اگر یکی از pulse.css حذف شود، تولید
   شکست می‌خورد (fail-closed) به‌جای اینکه بی‌صدا مقدار پیش‌فرض بگذارد. */
const REQUIRED_LIGHT = ['--primary', '--primary-2', '--bg', '--card', '--ink', '--muted', '--line',
  '--soft', '--radius', '--accent', '--green', '--green-bg', '--red', '--red-bg', '--amber',
  '--amber-bg', '--purple', '--purple-bg', '--shadow', '--ring'];
const REQUIRED_DARK = ['--bg', '--card', '--ink', '--muted', '--line', '--soft', '--primary',
  '--primary-2', '--green-bg', '--red-bg', '--amber-bg', '--purple-bg', '--shadow', '--ring'];

/* اختلاف ثبت‌شده بین مقادیر prompt سند ۶۱ (§3.1) و فایل فعلی pulse.css.
   تصمیم این PR: مقدار pulse.css به‌کار می‌رود و مقدار prompt به‌کار نمی‌رود؛
   تا تثبیت مالک، هیچ‌یک «تطابق دقیق با نبض» ادعا نمی‌شود. آزمون بررسی
   می‌کند هر ردیف هنوز همین وضع را دارد؛ اگر pulse.css عوض شود، آزمون این
   جدول را کهنه اعلام می‌کند تا بازبینی شود. */
const TOKEN_DISCREPANCIES = [
  { token: '--radius',    mode: 'light', pulse: '18px',    prompt: '16px' },
  { token: '--muted',     mode: 'dark',  pulse: '#91b1a8', prompt: '#7fa39a' },
  { token: '--line',      mode: 'dark',  pulse: '#203b35', prompt: '#16302b' },
  { token: '--primary-2', mode: 'dark',  pulse: '#2dd4bf', prompt: '#0d9488' },
];

function stripComments(css) { return String(css).replace(/\/\*[\s\S]*?\*\//g, ''); }

function parseDecls(body) {
  const out = {};
  const order = [];
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim().replace(/\s+/g, ' ');
    if (!name.startsWith('--') || !value) continue;
    if (!(name in out)) order.push(name);
    out[name] = value;
  }
  return { map: out, order };
}

/* بلوک با انتخابگر دقیق را پیدا می‌کند (سطح بالا، بدون @media). */
function topLevelBlock(css, selector) {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      if (depth === 0) {
        const sel = css.slice(start, i).trim().replace(/\s+/g, ' ');
        if (sel === selector) {
          const end = css.indexOf('}', i);
          return css.slice(i + 1, end);
        }
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) start = i + 1;
    } else if (depth === 0 && c === ';') {
      start = i + 1;
    }
  }
  return null;
}

function mediaDarkRootBlock(css) {
  const m = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/.exec(css);
  return m ? m[1] : null;
}

function parsePulse(cssText) {
  const css = stripComments(cssText);
  const lightBody = topLevelBlock(css, ':root');
  const darkBody = topLevelBlock(css, 'html.dark, body.dark, [data-theme="dark"]');
  const mediaBody = mediaDarkRootBlock(css);
  if (lightBody == null) throw new Error('pulse.css: :root block not found');
  if (darkBody == null) throw new Error('pulse.css: explicit dark block not found');
  if (mediaBody == null) throw new Error('pulse.css: prefers-color-scheme dark block not found');
  const light = parseDecls(lightBody);
  const dark = parseDecls(darkBody);
  const media = parseDecls(mediaBody);
  for (const k of REQUIRED_LIGHT) if (!(k in light.map)) throw new Error('pulse.css: missing light token ' + k);
  for (const k of REQUIRED_DARK) if (!(k in dark.map)) throw new Error('pulse.css: missing dark token ' + k);
  /* دو بیان تاریک در pulse.css باید یکسان باشند؛ وگرنه «تاریک» مبهم است. */
  const a = JSON.stringify(dark.map);
  const b = JSON.stringify(media.map);
  if (a !== b) throw new Error('pulse.css: explicit dark block and prefers-color-scheme block differ');
  return { light, dark };
}

function decls(p, indent) {
  return p.order.map(k => `${indent}${k}: ${p.map[k]};`).join('\n');
}

function buildTheme(cssText) {
  const { light, dark } = parsePulse(cssText);
  const sha = crypto.createHash('sha256').update(cssText).digest('hex');
  return [
    '/* GENERATED by apps/owner-panel/scripts/gen-theme.js — do not edit by hand.',
    `   source: client/pulse.css sha256=${sha}`,
    '   regenerate: node apps/owner-panel/scripts/gen-theme.js */',
    ':root {',
    decls(light, '  '),
    '  color-scheme: light;',
    '}',
    '',
    '/* سیستم‌عامل تاریک، مگر کاربر صریحاً روشن را انتخاب کرده باشد */',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) {',
    decls(dark, '    '),
    '    color-scheme: dark;',
    '  }',
    '}',
    '',
    '/* انتخاب صریح کاربر */',
    ':root[data-theme="dark"] {',
    decls(dark, '  '),
    '  color-scheme: dark;',
    '}',
    '',
  ].join('\n');
}

function discrepancyStatus(cssText) {
  const { light, dark } = parsePulse(cssText);
  return TOKEN_DISCREPANCIES.map(d => {
    const actual = (d.mode === 'light' ? light.map : dark.map)[d.token];
    return Object.assign({}, d, { actual, stillDiffers: actual === d.pulse && actual !== d.prompt });
  });
}

module.exports = { PULSE, OUT, TOKEN_DISCREPANCIES, REQUIRED_LIGHT, REQUIRED_DARK,
  parsePulse, buildTheme, discrepancyStatus };

if (require.main === module) {
  const want = buildTheme(fs.readFileSync(PULSE, 'utf8'));
  if (process.argv.includes('--check')) {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (have !== want) { console.error('THEME-DRIFT: web/theme.css is not generated from current client/pulse.css'); process.exit(1); }
    console.log('THEME-OK');
  } else {
    fs.writeFileSync(OUT, want);
    console.log('wrote ' + path.relative(ROOT, OUT));
  }
}
