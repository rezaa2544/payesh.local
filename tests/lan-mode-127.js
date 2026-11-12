// Row 127 — LAN mode of the native school app + the API-only school data service.
//
//   LM-01  server/index.js with PAYESH_HEADLESS=1 (REAL process): /api/health says headless,
//          every non-API path (/, /index.html, /install, /join/…, /downloads/…, /app.js) is
//          404 no_web_ui JSON — never HTML; setup over loopback works; the default (non-headless)
//          server still serves the browser web client (iPhone/browser access; not an installable — row 129 changed only Release and the download page).
//   LM-02  NEG first setup from a non-loopback address is refused (403 setup_local_only) when a
//          non-loopback IPv4 exists on this machine (CI runners have one).
//   LM-03  Dart ⇄ server parity: every route LanAccessClient calls exists in server/index.js and
//          every server error the Dart side maps is really emitted by the server.
//   LM-04  Dart LanServerRules keep http to the four private ranges + loopback/link-local/ULA.
//   LM-05  Windows data-service installer: build-time refusals (web UI / WebView2), no web-UI
//          Source lines, headless launcher, no task time limit, firewall private/domain only.
//   LM-06  Linux install.sh / start.sh are headless and copy no web UI.
//   LM-07  Android: networkSecurityConfig referenced; system CAs only (never user CAs).
//   LM-08  CI wiring: LAN IT in sync-real-server with exact tally, data-service silent install +
//          IT against the INSTALLED service + expect-fail gate in the Windows job.
//   Mutants: each static rule is mutated in memory and must turn red.
// Last line: LAN-MODE-127-OK checks=N mutants=M  |  LAN-MODE-127-FAIL failures=N
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const F = {
  index: 'server/index.js',
  auth: 'server/auth.js',
  identity: 'server/identity.js',
  dart: 'apps/payesh/packages/payesh_sync/lib/src/lan_access.dart',
  iss: 'install/windows/data-service/payesh-data-service.iss',
  cmd: 'install/windows/data-service/payesh-service.cmd',
  linux: 'install/linux/install.sh',
  startsh: 'start.sh',
  manifest: 'apps/payesh/app/android/app/src/main/AndroidManifest.xml',
  nsc: 'apps/payesh/app/android/app/src/main/res/xml/network_security_config.xml',
  wf: '.github/workflows/native-client.yml',
};

let failures = 0;
let checks = 0;
const ok = (id, cond, msg) => { checks++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}  ${msg}`); if (!cond) failures++; };

// ---------------- static rules (pure: file map → list of violations) ----------------
function rules(src) {
  const v = [];
  const need = (cond, msg) => { if (!cond) v.push(msg); };
  // LM-03 parity
  const routes = ['/api/health', '/api/network', '/api/auth/login', '/api/auth/refresh', '/api/auth/logout', '/api/setup', '/api/v1/pull', '/api/sync'];
  for (const r of routes) {
    need(src.dart.includes(`'${r}'`) || r === '/api/v1/pull' || r === '/api/sync', `LM-03 dart does not call ${r}`);
    need(src.index.includes(`'${r}'`), `LM-03 server has no route ${r}`);
  }
  const serverText = src.index + src.auth + src.identity;
  for (const w of ['bad_credentials', 'no_password', 'device_limit', 'device_revoked', 'device_expired', 'setup_local_only', 'already_setup']) {
    need(src.dart.includes(`'${w}'`), `LM-03 dart does not map ${w}`);
    need(serverText.includes(`'${w}'`), `LM-03 server never emits ${w}`);
  }
  need(/const HEADLESS = process\.env\.PAYESH_HEADLESS === '1'/.test(src.index), 'LM-01 HEADLESS switch missing');
  need(/if \(HEADLESS\) \{\s*res\.writeHead\(404[\s\S]{0,200}no_web_ui/.test(src.index), 'LM-01 headless does not refuse non-API paths');
  need(/if \(HEADLESS\) \{\s*const remote[^\n]*\n\s*if \(!\(remote === '::1' \|\| remote\.startsWith\('127\.'\)\)\) return json\(\{ ok: false, error: 'setup_local_only' \}, 403\);/.test(src.index), 'LM-02 headless setup not loopback-only');
  // the headless refusal must come BEFORE downloads / static files / SPA fallback
  const hIdx = src.index.indexOf("error: 'no_web_ui'");
  need(hIdx > 0 && hIdx < src.index.indexOf("url.pathname.startsWith('/downloads/')") && hIdx < src.index.indexOf('/* SPA fallback */'), 'LM-01 headless refusal placed after static serving');
  // LM-04 private ranges
  for (const [re, what] of [[/b\[0\] == 10\b/, '10/8'], [/b\[0\] == 172 && b\[1\] >= 16 && b\[1\] <= 31/, '172.16/12'], [/b\[0\] == 192 && b\[1\] == 168/, '192.168/16'], [/b\[0\] == 169 && b\[1\] == 254/, '169.254/16'], [/0xfc/, 'fc00::/7']]) {
    need(re.test(src.dart), `LM-04 LanServerRules lost ${what}`);
  }
  need(!/b\[0\] == 172 && b\[1\] >= 16 && b\[1\] <= 3[2-9]/.test(src.dart), 'LM-04 172 range widened');
  need(/static bool allowed\(Uri u\)[\s\S]{0,300}return isLocalHost\(u\.host\)/.test(src.dart), 'LM-04 allowed() does not require a local host');
  need(/if \(!LanServerRules\.allowed\(uri\)\) \{\s*throw const LanAccessFailure\(LanAccessError\.badAddress\)/.test(src.dart), 'LM-04 client sends without checking the address');
  // LM-05 Windows data service installer
  for (const e of ['client\\index.html', 'client\\app.js', 'WebView2Loader.dll']) {
    need(src.iss.includes(`#if FileExists(AddBackslash(StageDir) + "${e}")`) && src.iss.includes(`#error ${e}`), `LM-05 iss does not refuse ${e}`);
  }
  need(!/^\s*Source:\s*"[^"]*(client\\\*|client\\index\.html|client\\app\.js|styles\.css|WebView2|desktop\\)/mi.test(src.iss), 'LM-05 iss ships web UI / WebView2');
  need(/^\s*Source:\s*"\{#StageDir\}\\client\\lib\\\*\.js"/m.test(src.iss), 'LM-05 iss must ship only client\\lib\\*.js from client');
  need(/PrivilegesRequired=admin/.test(src.iss) && /AppId=\{\{9B1F0C52-7D3A-4E59-A6C1-2F8E4D7B3A61\}/.test(src.iss), 'LM-05 iss AppId/admin');
  need(!/F022A94A-885F-4620-9730-3E5EF0086EBE/.test(src.iss), 'LM-05 iss reuses the native app AppId');
  need(/-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/.test(src.iss) && /-UserId 'SYSTEM'/.test(src.iss) && /-AtStartup/.test(src.iss), 'LM-05 task: SYSTEM, boot, no time limit');
  need(!/schtasks\.exe"; Parameters: "\/Create/.test(src.iss), 'LM-05 schtasks /Create (72 h limit) used');
  need(/localport=8080 profile=private,domain"/.test(src.iss) && !/profile=(any|public)/.test(src.iss), 'LM-05 firewall must be private/domain only');
  need(/uninsneveruninstall/.test(src.iss), 'LM-05 school data must survive uninstall');
  need(/set "PAYESH_HEADLESS=1"/.test(src.cmd) && /PAYESH_UPDATE_AUTO=0/.test(src.cmd) && /server\\start\.js/.test(src.cmd), 'LM-05 launcher not headless');
  // LM-06 Linux
  need(/Environment=PAYESH_HEADLESS=1/.test(src.linux), 'LM-06 systemd unit not headless');
  need(!/cp -r "\$DIR\/server" "\$DIR\/client"/.test(src.linux) && !/cp -r[^\n]*"\$DIR\/client"\s/.test(src.linux), 'LM-06 install.sh copies the web UI');
  need(/export PAYESH_HEADLESS="\$\{PAYESH_HEADLESS:-1\}"/.test(src.startsh), 'LM-06 start.sh not headless by default');
  // LM-07 Android
  need(/android:networkSecurityConfig="@xml\/network_security_config"/.test(src.manifest), 'LM-07 networkSecurityConfig not referenced');
  need(/<certificates src="system"\s*\/>/.test(src.nsc) && !/src="user"/.test(src.nsc), 'LM-07 user CAs trusted');
  need(!/<debug-overrides>/.test(src.nsc), 'LM-07 debug overrides in release config');
  // LM-08 CI
  need(src.wf.includes('dart test --reporter expanded test/lan_server_it_test.dart | tee "$GITHUB_WORKSPACE/lan-real-server.txt"'), 'LM-08 LAN IT not run in sync-real-server');
  need(src.wf.includes("'^NATIVE-LAN-IT passed=7 negative_controls=12$'") && src.wf.includes("'\\+7: All tests passed'"), 'LM-08 LAN IT tally not enforced');
  need(src.wf.includes("$env:PAYESH_LAN_IT_URL = 'http://127.0.0.1:8080'") && src.wf.includes("'NATIVE-LAN-IT passed=7 negative_controls=12'"), 'LM-08 IT against the INSTALLED service missing');
  need(src.wf.includes('node tools/native-independence-gate.mjs --windows "$dir" --expect-fail'), 'LM-08 data service not run through the gate as negative control');
  need(src.wf.includes('DATA-SERVICE-NO-WEBUI-CONTROL-OK') && src.wf.includes("throw 'ISCC accepted a data-service stage that ships client\\index.html'"), 'LM-08 ISCC web-UI negative control missing');
  for (const p of ["'server/index.js'", "'install/windows/data-service/**'"]) {
    need((src.wf.match(new RegExp(p.replace(/[.*/]/g, (c) => '\\' + c), 'g')) || []).length >= 2, `LM-08 path filter ${p} missing in push/pull_request`);
  }
  return v;
}

const real = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, read(p)]));

// ---------------- mutants ----------------
const MUTANTS = [
  ['M01', 'headless switch removed', 'index', (s) => s.replace("const HEADLESS = process.env.PAYESH_HEADLESS === '1';", 'const HEADLESS = false;')],
  ['M02', 'headless refusal moved after SPA fallback', 'index', (s) => s.replace("error: 'no_web_ui'", "error: 'x'").replace('/* SPA fallback */', "/* SPA fallback */ error: 'no_web_ui'")],
  ['M03', 'setup allowed from the network', 'index', (s) => s.replace("if (!(remote === '::1' || remote.startsWith('127.'))) return json({ ok: false, error: 'setup_local_only' }", "if (false) return json({ ok: false, error: 'setup_local_only' }")],
  ['M04', 'Dart forgets device_revoked', 'dart', (s) => s.replace(/'device_revoked' \|\|/g, '')],
  ['M05', '172.16/12 widened to 172.0/8', 'dart', (s) => s.replace('b[1] >= 16 && b[1] <= 31', 'b[1] >= 16 && b[1] <= 39')],
  ['M06', 'client skips the address check', 'dart', (s) => s.replace('if (!LanServerRules.allowed(uri)) {\n      throw const LanAccessFailure(LanAccessError.badAddress);', 'if (false) {\n      throw const LanAccessFailure(LanAccessError.badAddress);')],
  ['M07', 'installer ships the web UI', 'iss', (s) => s.replace('Source: "payesh-service.cmd"', 'Source: "{#StageDir}\\client\\index.html"; DestDir: "{app}\\client"\nSource: "payesh-service.cmd"')],
  ['M08', 'installer stops refusing WebView2', 'iss', (s) => s.replace('#error WebView2Loader.dll', '; WebView2Loader.dll')],
  ['M09', 'task back to schtasks (72 h limit)', 'iss', (s) => s.replace('-ExecutionTimeLimit ([TimeSpan]::Zero)', '')],
  ['M10', 'firewall opened for public networks', 'iss', (s) => s.replace('profile=private,domain"', 'profile=any"')],
  ['M11', 'launcher not headless', 'cmd', (s) => s.replace('set "PAYESH_HEADLESS=1"', 'rem')],
  ['M12', 'linux unit serves the web UI', 'linux', (s) => s.replace('Environment=PAYESH_HEADLESS=1\n', '')],
  ['M13', 'linux copies client/', 'linux', (s) => s.replace('$SUDO cp -r "$DIR/server" "$DIR/package.json" "$TARGET/"', '$SUDO cp -r "$DIR/server" "$DIR/client" "$TARGET/"')],
  ['M14', 'Android trusts user CAs', 'nsc', (s) => s.replace('<certificates src="system"/>', '<certificates src="system"/>\n            <certificates src="user"/>')],
  ['M15', 'Android config not referenced', 'manifest', (s) => s.replace('android:networkSecurityConfig="@xml/network_security_config"', '')],
  ['M16', 'CI LAN tally relaxed', 'wf', (s) => s.replace("'^NATIVE-LAN-IT passed=7 negative_controls=12$'", "'NATIVE-LAN-IT'")],
  ['M17', 'CI no longer tests the INSTALLED service', 'wf', (s) => s.replace("$env:PAYESH_LAN_IT_URL = 'http://127.0.0.1:8080'", '')],
  ['M18', 'native-client path filter drops server/index.js', 'wf', (s) => s.split("      - 'server/index.js'\n").join('')],
  ['M19', 'start.sh serves the web UI again', 'startsh', (s) => s.replace('export PAYESH_HEADLESS="${PAYESH_HEADLESS:-1}"', '')],
  ['M20', 'server stops emitting setup_local_only', 'index', (s) => s.split("'setup_local_only'").join("'forbidden'")],
];

// ---------------- REAL server checks ----------------
function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
function req(method, host, port, p, body) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, host, port, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (rs) => {
      let t = ''; rs.setEncoding('utf8'); rs.on('data', (c) => { t += c; }); rs.on('end', () => res({ status: rs.statusCode, type: String(rs.headers['content-type'] || ''), body: t }));
    });
    r.on('error', (e) => res({ status: 0, type: '', body: String(e.message) }));
    r.setTimeout(5000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
async function startServer(headless) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lan127-'));
  const env = Object.assign({}, process.env, {
    PORT: String(port), HOST: '0.0.0.0', PAYESH_DATA: dir, PAYESH_LOG: '0', PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
    PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0',
  });
  if (headless) env.PAYESH_HEADLESS = '1'; else delete env.PAYESH_HEADLESS;
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (c) => { log += c; }); child.stderr.on('data', (c) => { log += c; });
  for (let i = 0; i < 200; i++) {
    const r = await req('GET', '127.0.0.1', port, '/api/health');
    if (r.status === 200) return { port, dir, child, log: () => log };
    await new Promise((s) => setTimeout(s, 100));
  }
  child.kill('SIGKILL');
  throw new Error('server did not start\n' + log);
}
async function stopServer(s) { s.child.kill('SIGKILL'); await new Promise((r) => s.child.once('exit', r)); fs.rmSync(s.dir, { recursive: true, force: true }); }

(async () => {
  // static
  const v = rules(real);
  for (const x of v) console.log('  ' + x);
  ok('LM-STATIC', v.length === 0, `static rules LM-01..LM-08 hold on the real repository (${v.length} violations)`);
  let killed = 0;
  for (const [id, what, file, fn] of MUTANTS) {
    const m = Object.assign({}, real, { [file]: fn(real[file]) });
    const changed = m[file] !== real[file];
    const r = rules(m).filter((x) => !v.includes(x));
    ok(id, changed && r.length > 0, `${what} → ${changed ? (r[0] || 'NOT CAUGHT') : 'mutation did not apply'}`);
    if (changed && r.length) killed++;
  }

  // real server, headless
  const s = await startServer(true);
  try {
    const h = JSON.parse((await req('GET', '127.0.0.1', s.port, '/api/health')).body);
    ok('LM-01a', h.name === 'payesh-local' && h.headless === true && h.setup_done === false, `headless server: /api/health headless=${h.headless} setup_done=${h.setup_done}`);
    let html = 0;
    for (const p of ['/', '/index.html', '/install', '/join/ABCD-EFGH', '/downloads/payesh-local.apk', '/app.js', '/styles.css', '/manifest.webmanifest']) {
      const r = await req('GET', '127.0.0.1', s.port, p);
      const good = r.status === 404 && r.type.startsWith('application/json') && r.body.includes('no_web_ui') && !/<html/i.test(r.body);
      if (!good) { html++; console.log(`  ${p} → ${r.status} ${r.type} ${r.body.slice(0, 80)}`); }
    }
    ok('LM-01b', html === 0, 'headless server serves NO web page: 8 UI paths → 404 no_web_ui JSON');
    // NEG from a non-loopback address
    const other = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
    if (other) {
      const r = await req('POST', other.address, s.port, '/api/setup', { school_name: 'x', manager_name: 'مهاجم شبکه', phone: '09129999999', password: 'xxxx1234' });
      ok('LM-02', r.status === 403 && r.body.includes('setup_local_only'), `setup from ${other.address} (not loopback) → ${r.status} ${r.body.slice(0, 60)}`);
    } else {
      console.log('SKIP  LM-02  no non-loopback IPv4 on this machine (CI runners have one)');
    }
    const r = await req('POST', '127.0.0.1', s.port, '/api/setup', { school_name: 'هنرستان ۱۲۷', manager_name: 'مدیر آزمون', phone: '09120000127', password: 'modir-127' });
    const j = JSON.parse(r.body || '{}');
    ok('LM-01c', r.status === 200 && j.device_token && j.session && j.session.token, `setup from loopback → ${r.status}, device token issued`);
    const l = await req('POST', '127.0.0.1', s.port, '/api/auth/login', { phone: '09120000127', password: 'modir-127', name: 'it', platform: 'it' });
    ok('LM-01d', l.status === 200 && JSON.parse(l.body).device_token, `phone + password login on the headless server → ${l.status}`);
  } finally { await stopServer(s); }

  // real server, default (browser web client still served — row 129 scope is Release + download page only)
  const d = await startServer(false);
  try {
    const h = JSON.parse((await req('GET', '127.0.0.1', d.port, '/api/health')).body);
    const r = await req('GET', '127.0.0.1', d.port, '/');
    ok('LM-01e', h.headless === false && r.status === 200 && /text\/html/.test(r.type), `default server unchanged (browser client; row 129 = Release only): headless=${h.headless}, / → ${r.status} ${r.type.split(';')[0]}`);
  } finally { await stopServer(d); }

  console.log(failures ? `LAN-MODE-127-FAIL failures=${failures}` : `LAN-MODE-127-OK checks=${checks} mutants=${killed}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); console.log('LAN-MODE-127-FAIL failures=1'); process.exit(1); });
