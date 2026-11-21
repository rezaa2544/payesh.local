#!/usr/bin/env node
// Row 169 (D-50) — end-to-end check of the 32-bit Windows edition on a real Windows machine.
// Starts the INSTALLED (or assembled) program with Chromium's DevTools port, then inside the app
// page proves: window.payeshHost exists only there and works (files, handles, DPAPI, processes,
// DNS, error format), cross-origin fetch works (LAN http without CORS headers + https), the
// Flutter UI rendered (first frame, no uncaught errors) and — school app — the encrypted
// database was created at %LOCALAPPDATA%\Payesh\payesh.db and is not plaintext.
//
//   node tools/web32/e2e.mjs --exe <dir>\payesh_app.exe --app app --out <dir> [--port 9333]
//   node tools/web32/e2e.mjs --exe <dir>\payesh_owner.exe --app owner --out <dir>
// Last line: WEB32-E2E-OK app=<id> checks=N   |   WEB32-E2E-FAIL <why>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, '');
  const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : '1';
  args[k] = v;
}
const APP = args.app || 'app';
const OUT = path.resolve(args.out || 'web32-e2e');
const PORT = Number(args.port || 9333);
const ORIGIN = 'http://payesh.localhost';
fs.mkdirSync(OUT, { recursive: true });
const logLines = [];
const log = (s) => { logLines.push(s); console.log(s); };
let checks = 0;
const ok = (id, detail) => { checks++; log(`PASS ${id} ${detail ?? ''}`.trim()); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browserLog = []; /* CDP Log domain (CORS / network / security messages) */
function fail(why) {
  for (const l of browserLog.slice(-25)) log('  browser-log: ' + l);
  log('WEB32-E2E-FAIL ' + why);
  fs.writeFileSync(path.join(OUT, `e2e-${APP}.txt`), logLines.join('\n') + '\n');
  try { child?.kill(); } catch { /* gone */ }
  process.exit(1);
}

// Isolated profile: the app's data (LOCALAPPDATA\Payesh) goes to a fresh folder.
const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), 'w32local-'));
let child = null;
if (args.exe) {
  const env = { ...process.env, LOCALAPPDATA: LOCAL };
  child = spawn(args.exe, [`--remote-debugging-port=${PORT}`, '--remote-allow-origins=*'], { env, stdio: 'ignore' });
  child.on('exit', (c) => log(`program exited with ${c}`));
}

// A LAN-like plain http server WITHOUT any CORS header (the school server is like that for
// many endpoints) — the shell must still let the app read it.
const lan = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('payesh-lan-ok'); });
await new Promise((r) => lan.listen(0, '127.0.0.1', r));
const LAN = `http://127.0.0.1:${lan.address().port}/health`;

async function targets() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    return await r.json();
  } catch { return []; }
}

let page = null;
for (let i = 0; i < 120 && !page; i++) {
  page = (await targets()).find((t) => t.type === 'page' && String(t.url).startsWith(ORIGIN + '/'));
  if (!page) await sleep(500);
}
if (!page) fail('no app page on the DevTools port (did the program start?)');
ok('E2E-01', 'app page ' + page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); });
let seq = 0;
const pending = new Map();
const exceptions = [];
const consoleErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  if (m.method === 'Log.entryAdded') browserLog.push(`${m.params.entry.level} ${m.params.entry.source}: ${m.params.entry.text}`.slice(0, 400));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
}

// ── the host object ─────────────────────────────────────────────────────────
for (let i = 0; i < 60; i++) { if (await evalJs('typeof window.payeshHost')) break; await sleep(250); }
if ((await evalJs('typeof window.payeshHost')) !== 'object') fail('window.payeshHost missing in the app page');
const info = JSON.parse(await evalJs('payeshHost.info()'));
if (info.os !== 'windows' || !/\.exe$/i.test(info.exe) || !(info.pid > 0) || info.app !== APP) fail('info ' + JSON.stringify(info).slice(0, 300));
if (!info.env || info.env.LOCALAPPDATA !== LOCAL) fail('env.LOCALAPPDATA ' + (info.env && info.env.LOCALAPPDATA));
ok('E2E-02', `info os=${info.os} osVersion=${info.osVersion} app=${info.app} pid=${info.pid} shell=${info.shell}`);

const hostJs = `(() => {
  const H = payeshHost, T = ${JSON.stringify(path.join(LOCAL, 'hostcheck'))};
  const bytes = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('');
  const out = [];
  const must = (c, m) => { if (!c) throw new Error(m); };
  H.mkdir(T + '\\\\a\\\\b');
  must(JSON.parse(H.stat(T + '\\\\a\\\\b')).t === 'd', 'mkdir');
  H.write(T + '\\\\a\\\\f.bin', bytes, false);
  H.write(T + '\\\\a\\\\f.bin', 'XY', true);
  const back = H.read(T + '\\\\a\\\\f.bin', -1, -1);
  must(back.length === 258 && back.slice(0, 256) === bytes && back.slice(256) === 'XY', 'binary round trip');
  must(H.read(T + '\\\\a\\\\f.bin', 10, 14) === bytes.slice(10, 14), 'range read');
  const st = JSON.parse(H.stat(T + '\\\\a\\\\f.bin'));
  must(st.t === 'f' && st.s === 258 && st.m > 1.6e12, 'stat ' + JSON.stringify(st));
  must(JSON.parse(H.stat(T + '\\\\nope')).t === 'n', 'stat missing');
  const names = JSON.parse(H.list(T + '\\\\a')).map((e) => e.join(':')).sort().join(',');
  must(names === 'b:d,f.bin:f', 'list ' + names);
  const h = H.fopen(T + '\\\\a\\\\db', 'rw');
  H.fwrite(h, 8192, 'page');
  must(H.fsize(h) === 8196, 'fsize ' + H.fsize(h));
  must(H.fread(h, 8192, 10) === 'page', 'fread');
  must(H.fread(h, 0, 4) === '\\0\\0\\0\\0', 'hole reads zero');
  H.ftrunc(h, 4096); must(H.fsize(h) === 4096, 'ftrunc');
  H.fsync(h); H.fclose(h);
  const h2 = H.fopen(T + '\\\\a\\\\db', 'rw'); must(H.fsize(h2) === 4096, 'rw keeps content'); H.fclose(h2);
  H.setMtime(T + '\\\\a\\\\f.bin', 1700000000000);
  must(Math.abs(JSON.parse(H.stat(T + '\\\\a\\\\f.bin')).m - 1700000000000) < 2000, 'setMtime');
  H.copy(T + '\\\\a\\\\f.bin', T + '\\\\a\\\\g.bin');
  H.rename(T + '\\\\a\\\\g.bin', T + '\\\\a\\\\f.bin');
  must(JSON.parse(H.stat(T + '\\\\a\\\\g.bin')).t === 'n', 'rename replaces');
  let code = '';
  try { H.read(T + '\\\\missing.bin', -1, -1); } catch (e) { code = String(e.message || e).split('|')[0]; }
  must(code === '2', 'error format <code>|<message>: ' + code);
  try { H.remove(T + '\\\\a', false); code = 'none'; } catch (e) { code = String(e.message || e).split('|')[0]; }
  must(code === '145', 'non-recursive remove of a full folder: ' + code);
  H.remove(T, true);
  must(JSON.parse(H.stat(T)).t === 'n', 'recursive remove');
  const sealed = H.dpapi('secret-key-bytes', 'payesh', true);
  must(sealed.length > 40 && sealed !== 'secret-key-bytes', 'dpapi protect');
  must(H.dpapi(sealed, 'payesh', false) === 'secret-key-bytes', 'dpapi unprotect');
  let wrong = false; try { H.dpapi(sealed, 'other', false); } catch (e) { wrong = true; }
  must(wrong, 'dpapi entropy enforced');
  const r = JSON.parse(H.run('cmd.exe', JSON.stringify(['/d', '/c', 'echo', 'payesh', 'web32']), '', 20000));
  must(r.code === 0 && r.out.trim() === 'payesh web32', 'run ' + JSON.stringify(r));
  /* an argument with a space is quoted exactly like dart:io Process.run does on Windows */
  const q = JSON.parse(H.run('cmd.exe', JSON.stringify(['/d', '/c', 'echo', 'a b']), '', 20000));
  must(q.code === 0 && q.out.trim() === '"a b"', 'run quoting ' + JSON.stringify(q));
  const reg = JSON.parse(H.run('reg', JSON.stringify(['query', 'HKLM\\\\SOFTWARE\\\\Microsoft\\\\Cryptography', '/v', 'MachineGuid', '/reg:64']), '', 20000));
  must(/MachineGuid\\s+REG_SZ\\s+[0-9A-Fa-f-]{36}/.test(reg.out), 'reg MachineGuid ' + reg.out.slice(0, 200));
  const ips = JSON.parse(H.resolve('localhost'));
  must(ips.length > 0, 'resolve localhost');
  return 'files+handles+dpapi+run+resolve ' + ips.join(' ');
})()`;
try { ok('E2E-03', 'host contract: ' + (await evalJs(hostJs))); } catch (e) { fail('host contract: ' + e.message); }

// ── network: LAN http without CORS headers, and https ───────────────────────
try {
  const t = await evalJs(`fetch(${JSON.stringify(LAN)}).then(r => r.text())`);
  if (t !== 'payesh-lan-ok') fail('LAN fetch body ' + t);
  ok('E2E-04', 'cross-origin http (no CORS headers) ' + LAN);
} catch (e) { fail('LAN fetch: ' + e.message); }
if (!args.offline) {
  try {
    const s = await evalJs(`fetch('https://api.github.com/zen').then(r => r.status)`);
    if (s !== 200 && s !== 403) fail('https status ' + s);
    ok('E2E-05', 'cross-origin https (Chrome root store) status ' + s);
  } catch (e) { fail('https fetch: ' + e.message); }
}
// No second window: the shell refuses popups (links go to the system browser instead).
{
  const blocked = await evalJs(`window.open('about:blank') === null`);
  if (!blocked) fail('window.open was not refused');
  ok('E2E-06', 'window.open refused by the shell');
}

// ── Flutter rendered ─────────────────────────────────────────────────────────
let rendered = false;
for (let i = 0; i < 120 && !rendered; i++) {
  rendered = await evalJs(`!!document.querySelector('flutter-view, flt-glass-pane') && !document.getElementById('loading')`);
  if (!rendered) await sleep(500);
}
if (!rendered) fail('Flutter view never appeared');
await sleep(4000);
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) fs.writeFileSync(path.join(OUT, `web32-${APP}.png`), Buffer.from(shot.result.data, 'base64'));
const real = exceptions.filter((x) => x && !/ERR_CONNECTION_REFUSED|Failed to fetch/i.test(x));
if (real.length) fail('uncaught exceptions: ' + real.join(' | ').slice(0, 1500));
ok('E2E-07', `Flutter UI rendered (screenshot web32-${APP}.png), console errors: ${consoleErrors.length}`);

// ── school app: the encrypted local database ────────────────────────────────
if (APP === 'app') {
  const db = path.join(LOCAL, 'Payesh', 'payesh.db');
  for (let i = 0; i < 40 && !fs.existsSync(db); i++) await sleep(500);
  if (!fs.existsSync(db)) fail('no encrypted database at ' + db);
  await sleep(1500);
  const head = fs.readFileSync(db).subarray(0, 16).toString('latin1');
  if (head.startsWith('SQLite format 3')) fail('payesh.db is PLAINTEXT');
  if (!fs.existsSync(path.join(LOCAL, 'Payesh', 'secure'))) fail('no DPAPI secure store folder');
  ok('E2E-08', `encrypted database ${fs.statSync(db).size} B, header not plaintext, DPAPI store present`);
}

// ── exit through the host (same path the updater uses) ──────────────────────
await evalJs('payeshHost.exit(0), true').catch(() => true);
let exited = !child;
for (let i = 0; i < 40 && !exited; i++) { exited = child.exitCode !== null; if (!exited) await sleep(500); }
if (!exited) fail('payeshHost.exit(0) did not close the program');
ok('E2E-09', 'payeshHost.exit(0) closed the program, code ' + (child ? child.exitCode : '-'));
lan.close();
log(`WEB32-E2E-OK app=${APP} checks=${checks}`);
fs.writeFileSync(path.join(OUT, `e2e-${APP}.txt`), logLines.join('\n') + '\n');
process.exit(0);
