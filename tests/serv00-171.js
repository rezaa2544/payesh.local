#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 171 — the central server kit for serv00.com (deploy/serv00 + two workflows).

     SV-01  app.js: ~/.payesh.env is read (quotes, comments; never overrides the environment);
            central defaults (PAYESH_CENTRAL=1, HOST=127.0.0.1 ⇒ no tunnel, headless, no restart)
     SV-02  setup.sh, run for real with a scripted `devil` (serv00's panel tool) and the release
            files of this repository: it unpacks the release named in releases/manifest.json,
            links ~/payesh-app, writes the keys to ~/.payesh.env (mode 600, not echoed), creates
            the nodejs website, installs app.js, restarts it; the REAL server started from that
            app.js answers /api/health as central + set up, and serves the school-server list;
            a second run (update) does not add the website again
     SV-03  workflows: keep-alive every 10 min + weekly deploy (the 90-day login); every job
            skips when the serv00 secrets are missing; keys travel on stdin, not on a command
            line; the mirror goes ONLY to the `directory` branch, which no other workflow builds,
            at exactly the address the apps read (SchoolDirectoryClient.defaultMirrorUrl)
     SV-04  hosted school servers do not inherit PAYESH_CENTRAL (only the main server is central)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
const pending = [];
function check(id, desc, fn) {
  pending.push(async () => {
    try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
    catch (e) { failed++; console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); }
  });
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function freePort() {
  return new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function get(port, p) {
  return new Promise((res) => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (x) => {
      let b = ''; x.on('data', (d) => { b += d; }); x.on('end', () => res({ status: x.statusCode, body: b, headers: x.headers }));
    });
    r.on('error', () => res({ status: 0, body: '' }));
    r.on('timeout', () => { r.destroy(); res({ status: 0, body: '' }); });
  });
}

check('SV-01', 'app.js: env file + central defaults', async () => {
  process.env.PAYESH_SERV00_TEST = '1';
  const app = require(path.join(ROOT, 'deploy/serv00/app.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv01-'));
  const f = path.join(dir, '.payesh.env');
  fs.writeFileSync(f, '# keys\nPAYESH_S3_SECRET="s e c"\nexport PAYESH_PUBLIC_URL=https://x.serv00.net\nPAYESH_CENTRAL=0\nlower=no\n');
  const env = { PAYESH_CENTRAL: '1' };
  const n = app.loadEnv(f, env);
  assert(n === 2, 'loaded ' + n);
  assert(env.PAYESH_S3_SECRET === 's e c' && env.PAYESH_PUBLIC_URL === 'https://x.serv00.net', JSON.stringify(env));
  assert(env.PAYESH_CENTRAL === '1', 'the environment was overridden');
  assert(!('lower' in env), 'lowercase key taken');
  assert(app.loadEnv(path.join(dir, 'none'), {}) === 0, 'missing file');
  const d = app.defaults({ HOST: '' }, '/home/u');
  for (const [k, v] of Object.entries({ PAYESH_CENTRAL: '1', HOST: '127.0.0.1', PAYESH_HEADLESS: '1', PAYESH_NO_RESTART: '1', PAYESH_DATA: '/home/u/payesh-data', PAYESH_APP_ROOT: '/home/u/payesh-app' })) {
    assert(d[k] === v, k + '=' + d[k]);
  }
  assert(app.defaults({ PAYESH_DATA: '/d' }, '/h').PAYESH_DATA === '/d', 'set value replaced');
  return 'env 2 keys, defaults 6';
});

check('SV-02', 'setup.sh for real (scripted devil): release, keys, website, REAL central answers', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sv02-'));
  const bin = path.join(home, 'stub-bin');
  fs.mkdirSync(bin);
  const port = await freePort();
  const DOMAIN = 't171.serv00.net';
  const realCurl = spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim();
  assert(realCurl, 'no curl');
  /* serv00's `devil`: website list/add/restart (restart = Passenger starting app.js), vhost IP */
  fs.writeFileSync(path.join(bin, 'devil'), `#!/bin/bash
echo "$*" >> "$HOME/devil.log"
case "$1 $2" in
  "www list") echo "Domain Type"; [ -f "$HOME/www.list" ] && cat "$HOME/www.list" ;;
  "www add") echo "$3 $4" >> "$HOME/www.list" ;;
  "www restart")
    [ -f "$HOME/app.pid" ] && kill "$(cat "$HOME/app.pid")" 2>/dev/null && sleep 1
    PORT=${port} PAYESH_APP_ROOT="${ROOT}" PAYESH_DISCOVERY=0 PAYESH_CLOUD_AUTO=0 PAYESH_HOSTING=0 PAYESH_OUTBOX_AUTO=0 PAYESH_AUTO_BACKUP=0 \\
      nohup "${process.execPath}" "$HOME/domains/$3/public_nodejs/app.js" > "$HOME/app.log" 2>&1 &
    echo $! > "$HOME/app.pid" ;;
  "vhost list") echo "IP Hostname"; echo "203.0.113.7 web1.serv00.com" ;;
  "ssl www") exit 1 ;;
esac
`, { mode: 0o755 });
  /* https://<domain> of serv00 → the app on loopback; the storage check fails fast (no network) */
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
a=(); for x in "$@"; do case "$x" in https://${DOMAIN}*) x="http://127.0.0.1:${port}\${x#https://${DOMAIN}}";; https://s3.*) printf 000; exit 7;; esac; a+=("$x"); done
exec "${realCurl}" "\${a[@]}"
`, { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const env = Object.assign({}, process.env, {
    HOME: home, USER: 'T171', PATH: bin + ':' + process.env.PATH,
    PAYESH_RAW: 'file://' + ROOT, PAYESH_DOMAIN: DOMAIN,
    PAYESH_S3_ACCESS_KEY: 'AK-171-TEST', PAYESH_S3_SECRET: "se'cret-171",
  });
  delete env.PAYESH_SERV00_TEST;
  try {
    const r = spawnSync('sh', [path.join(ROOT, 'deploy/serv00/setup.sh')], { env, encoding: 'utf8', timeout: 120000 });
    const out = r.stdout + r.stderr;
    const ver = JSON.parse(read('releases/manifest.json')).version;
    assert(r.status === 0, 'exit ' + r.status + '\n' + out + '\n' + (fs.existsSync(path.join(home, 'app.log')) ? fs.readFileSync(path.join(home, 'app.log'), 'utf8').slice(-1500) : ''));
    assert(out.includes('PAYESH-SETUP-OK ' + ver + ' ' + DOMAIN), out);
    assert(!out.includes('AK-171-TEST') && !out.includes('cret-171'), 'a key was printed');
    assert(fs.existsSync(path.join(home, 'payesh-app/server/index.js')), 'release not unpacked');
    assert(fs.realpathSync(path.join(home, 'payesh-app')) === fs.realpathSync(path.join(home, 'payesh-apps', ver)), 'link');
    const envf = path.join(home, '.payesh.env');
    assert((fs.statSync(envf).mode & 0o777) === 0o600, 'env mode ' + (fs.statSync(envf).mode & 0o777).toString(8));
    const kv = fs.readFileSync(envf, 'utf8');
    assert(kv.includes('PAYESH_S3_ACCESS_KEY=AK-171-TEST') && kv.includes("PAYESH_S3_SECRET=se'cret-171") && kv.includes('PAYESH_PUBLIC_URL=https://' + DOMAIN), kv);
    assert(fs.readFileSync(path.join(home, 'domains', DOMAIN, 'public_nodejs/app.js'), 'utf8') === read('deploy/serv00/app.js'), 'app.js');
    const log = fs.readFileSync(path.join(home, 'devil.log'), 'utf8');
    assert(log.includes('www add ' + DOMAIN + ' nodejs ' + path.join(bin, 'node') + ' production'), log);
    assert(out.includes('DNS: point app.payeshschool.ir (A record) to 203.0.113.7'), 'dns hint');
    const h = await get(port, '/api/health');
    const hj = JSON.parse(h.body);
    assert(h.status === 200 && hj.central === true && hj.setup_done === true, h.body);
    const l = await get(port, '/payesh/pub/school-servers.json');
    const lj = JSON.parse(l.body);
    assert(l.status === 200 && lj.kind === 'payesh-school-servers' && Array.isArray(lj.servers), l.status + ' ' + l.body.slice(0, 200));
    /* update run: same version kept, website not added twice, keys kept */
    const r2 = spawnSync('sh', [path.join(ROOT, 'deploy/serv00/setup.sh')], { env: Object.assign({}, env, { PAYESH_S3_ACCESS_KEY: '', PAYESH_S3_SECRET: '' }), encoding: 'utf8', timeout: 120000 });
    assert(r2.status === 0, 'second run ' + r2.status + (r2.stdout + r2.stderr).slice(-800));
    const adds = fs.readFileSync(path.join(home, 'devil.log'), 'utf8').split('\n').filter((x) => x.startsWith('www add'));
    assert(adds.length === 1, 'website added ' + adds.length + ' times');
    assert(fs.readFileSync(envf, 'utf8').includes('PAYESH_S3_ACCESS_KEY=AK-171-TEST'), 'keys lost on update');
    return 'release ' + ver + ', env 600, health central+setup_done, list ' + lj.servers.length + ' rows, update idempotent';
  } finally {
    try { process.kill(Number(fs.readFileSync(path.join(home, 'app.pid'), 'utf8'))); } catch (e) { /* gone */ }
  }
});

check('SV-03', 'workflows: keep-alive, weekly login, secrets skip, stdin keys, mirror branch', async () => {
  const wf = read('.github/workflows/serv00-central.yml');
  assert(/cron: '\*\/10 \* \* \* \*'/.test(wf) && /cron: '17 3 \* \* 1'/.test(wf), 'schedules');
  assert(wf.includes('workflows: [build-and-release]') && wf.includes("github.event.workflow_run.conclusion == 'success'"), 'after release');
  assert((wf.match(/skipped/g) || []).length >= 2, 'no skip without secrets');
  assert(wf.includes("'sh -s' < /tmp/remote.sh") && !/ssh [^\n]*PAYESH_S3_SECRET/.test(wf), 'keys on a command line');
  assert(wf.includes('PAYESH-SETUP-OK') && wf.includes('permissions:\n  contents: read'), 'result / permissions');
  const mir = read('.github/workflows/directory-mirror.yml');
  assert(/git push -qf "[^"]+" directory$/m.test(mir), 'mirror target');
  const dart = read('apps/payesh/packages/payesh_sync/lib/src/school_finder.dart');
  const m = /defaultMirrorUrl = Uri\.parse\(\s*'([^']+)'/.exec(dart);
  assert(m && m[1] === 'https://raw.githubusercontent.com/rezaa2544/payesh.local/directory/school-servers.json', 'app mirror url ' + (m && m[1]));
  assert(mir.includes('school-servers.json') && mir.includes("kind !== 'payesh-school-servers'"), 'list checked');
  /* no other workflow runs on a push to `directory` */
  for (const f of fs.readdirSync(path.join(ROOT, '.github/workflows'))) {
    const t = read('.github/workflows/' + f);
    const push = /\n  push:\n((?:    .*\n)+)/.exec(t);
    if (!push) continue;
    const br = /branches: \[([^\]]*)\]/.exec(push[1]);
    assert(br || /tags:/.test(push[1]), f + ' runs on any branch push');
    if (br) assert(!/'\*\*'|\bdirectory\b|^\s*\*\s*$/.test(br[1]), f + ' builds the directory branch: ' + br[1]);
  }
  return 'serv00-central + directory-mirror';
});

check('SV-04', 'hosted school servers are not central', async () => {
  const t = read('server/hosting.js');
  assert(/delete childEnv\[k\]/.test(t) && /'PAYESH_CENTRAL'\]\) delete childEnv\[k\]/.test(t), 'PAYESH_CENTRAL inherited');
  return 'PAYESH_CENTRAL removed from the child env';
});

(async () => {
  for (const p of pending) await p();
  console.log(`\nSERV00-171 ${failed ? 'FAIL' : 'OK'} ${passed}/${passed + failed}`);
  process.exit(failed ? 1 : 0);
})();
