'use strict';
/* ═══════════════════════════════════════════════════════════════════
   «برنامه‌شدن» ویندوز پس از به‌روزرسانی درجا
   ───────────────────────────────────────────────────────────────────
   نصب‌کنندهٔ تازه میان‌بر «پایش.lnk» را با wscript + payesh-app.vbs
   می‌سازد (پنجرهٔ مستقل، بدون نوار آدرس). اما کسی که از نسخهٔ قدیمی
   به‌روزرسانی یک‌کلیکی می‌کند، میان‌بر قدیمی «پایش.url» را دارد که تب
   مرورگر باز می‌کند. این ماژول همان یک‌بار، بعد از بالا آمدن سرور:

     ۱) payesh-app.vbs و payesh.ico را از install/windows به ریشهٔ نصب کپی
     ۲) میان‌برهای دسکتاپ/منوی استارت را بازنویسی می‌کند (wscript + vbs + آیکون)
     ۳) «پایش.url» قدیمی را پاک می‌کند

   اگر ویندوز نبود یا فایلی نبود، بی‌صدا رد می‌شود؛ هیچ‌وقت اجرای برنامه
   را متوقف نمی‌کند.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP_VBS = 'payesh-app.vbs';
const APP_ICO = 'payesh.ico';

/** اسکریپت PowerShell بازسازی میان‌برها — جدا تا آزمون‌پذیر باشد */
function buildScript({ root, port = 8080 }) {
  const vbs = path.win32.join(root, APP_VBS);
  const ico = path.win32.join(root, APP_ICO);
  const q = s => "'" + String(s).replace(/'/g, "''") + "'";
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    'try {',
    '  $shell = New-Object -ComObject WScript.Shell',
    '  $desktop = [Environment]::GetFolderPath("Desktop")',
    '  $programs = [Environment]::GetFolderPath("Programs")',
    '  Remove-Item (Join-Path $desktop "پایش.url") -Force',
    '  $targets = @((Join-Path $desktop "پایش.lnk"))',
    '  $group = Join-Path $programs "پایش-لوکال"',
    '  New-Item -ItemType Directory -Force -Path $group | Out-Null',
    '  $targets += (Join-Path $group "پایش.lnk")',
    '  foreach ($t in $targets) {',
    '    $s = $shell.CreateShortcut($t)',
    '    $s.TargetPath = "C:\\Windows\\System32\\wscript.exe"',
    '    $s.Arguments = \'"\' + ' + q(vbs) + ' + \'"\'',
    '    $s.WorkingDirectory = ' + q(path.win32.dirname(vbs)),
    '    $s.IconLocation = ' + q(ico),
    '    $s.Description = "پایش-لوکال — سامانهٔ مدرسه"',
    '    $s.WindowStyle = 1',
    '    $s.Save()',
    '  }',
    '  Write-Output "ok"',
    '} catch { Write-Output ("err:" + $_.Exception.Message) }',
  ].join('\r\n');
}

function sameFile(a, b) {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch (e) { return false; }
}

/**
 * کپی فایل‌های اجرا به ریشهٔ نصب + بازسازی میان‌برها.
 * @returns {Promise<{ok:boolean, skipped?:boolean, copied?:string[], error?:string}>}
 */
async function ensure({ root, port = 8080, log = () => {}, run = true, timeout = 25_000 } = {}) {
  if (process.platform !== 'win32') return { ok: false, skipped: true, reason: 'not_windows' };

  const srcDir = path.join(root, 'install', 'windows');
  const copied = [];
  for (const name of [APP_VBS, APP_ICO]) {
    const src = path.join(srcDir, name);
    const dst = path.join(root, name);
    if (!fs.existsSync(src)) continue;
    try {
      if (!sameFile(src, dst)) {
        fs.copyFileSync(src, dst);
        copied.push(name);
      }
    } catch (e) { log('copy ' + name + ': ' + (e.message || e)); }
  }

  if (!fs.existsSync(path.join(root, APP_VBS))) {
    return { ok: false, skipped: true, reason: 'missing_app_vbs', copied };
  }
  if (!run) return { ok: true, planned: true, copied, script: buildScript({ root, port }) };

  const scriptFile = path.join(os.tmpdir(), 'payesh-shortcut-' + process.pid + '.ps1');
  try {
    fs.writeFileSync(scriptFile, '\ufeff' + buildScript({ root, port }), 'utf8');
  } catch (e) {
    return { ok: false, error: 'write_script_failed', detail: String(e.message || e) };
  }

  const out = await new Promise(resolve => {
    let text = '';
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ text: 'spawn_failed:' + (e.message || e), code: -1 }); }
    child.stdout.on('data', d => { text += String(d); });
    child.stderr.on('data', d => { text += String(d); });
    const kill = setTimeout(() => { try { child.kill(); } catch (e) { /* noop */ } }, timeout);
    child.on('exit', code => { clearTimeout(kill); resolve({ text: text.trim(), code }); });
    child.on('error', e => { clearTimeout(kill); resolve({ text: 'error:' + (e.message || e), code: -1 }); });
  });

  try { fs.unlinkSync(scriptFile); } catch (e) { /* noop */ }

  const ok = /(^|\n)ok\b/.test(out.text) || out.code === 0;
  if (!ok) log('shortcut: ' + out.text.slice(0, 300));
  return { ok, copied, code: out.code, output: out.text.slice(0, 300) };
}

/** نسخه‌ای که در پس‌زمینه اجرا می‌شود و خطاها فقط لاگ می‌شوند */
function ensureInBackground({ root, port, store, version, log }) {
  const tag = String(version || '');
  try {
    if (store && tag && store.getMeta('app_entry_version') === tag) {
      return { ok: true, skipped: true, reason: 'already_done' };
    }
  } catch (e) { /* noop */ }

  setTimeout(() => {
    ensure({ root, port, log }).then(r => {
      if (r && r.ok && !r.skipped && store && tag) {
        try { store.setMeta('app_entry_version', tag); } catch (e) { /* noop */ }
      }
    }).catch(() => {});
  }, 6_000).unref?.();

  return { ok: true, scheduled: true };
}

module.exports = { ensure, ensureInBackground, buildScript, APP_VBS, APP_ICO };
