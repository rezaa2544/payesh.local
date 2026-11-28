#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 205 — Docker simulation: does the owner's «سرور کمکی» (helper) take load
   off the school server and its database?

   Containers (node:22-bookworm-slim, the repository bind-mounted read-only):
     sim205-school   the REAL school data service (server/index.js, SQLite) + probe
     sim205-s3       the owner's bucket (tools/sim/s3-lite.js, real SigV4, 40 ms latency)
     sim205-helperN  owner-panel helpers (helper.js = helper_node.dart protocol)
     sim205-load     the apps: teachers syncing attendance + the manager (load.js)
   s3/helpers/load share the school's network namespace, so the bucket is on
   http://127.0.0.1:9000 exactly like a local bucket the server accepts over http.

   Phases (same server, same data; helpers ON/OFF; server normal / CPU-starved):
     A_off        16 devices, think 1.5 s, cpus 1.0, no helpers
     B_on         same + 2 helpers (owner default: idle polling 5→30 s)
     C_off_busy   32 devices, no think, cpus 0.35, no helpers
     D_on_busy    same + 2 helpers (owner default)
     E_on_urgent  same + 2 helpers polling every 3 s (owner route «helpers» active)
   usage: node orchestrate.js [SECS]     results → $SIM_DIR/out/*.json + summary.json
   ═══════════════════════════════════════════════════════════════════ */
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DIR = process.env.SIM_DIR || '/work/tmp/sim205';
const OUT = path.join(DIR, 'out');
const SECS = Number(process.argv[2] || 75);
const IMG = 'node:22-bookworm-slim';
const S3 = { S3_ACCESS_KEY: 'sim205-ak', S3_SECRET: 'sim205-secret-do-not-reuse', S3_BUCKET: 'payesh-sim205', S3_REGION: 'us-east-1' };
const S3ENV = { S3_ENDPOINT: 'http://127.0.0.1:9000', ...S3 };

const UID = `${process.getuid()}:${process.getgid()}`;
const docker = (args, { allow = false, quiet = false } = {}) => {
  const r = spawnSync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0 && !allow) throw new Error('docker ' + args.slice(0, 3).join(' ') + ': ' + r.stderr);
  if (!quiet && r.stdout.trim()) process.stdout.write(r.stdout.slice(-2000));
  return r;
};
const env = (o) => Object.entries(o).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rm = (...names) => docker(['rm', '-f', ...names], { allow: true, quiet: true });
const ALL = ['sim205-load', 'sim205-helper1', 'sim205-helper2', 'sim205-s3', 'sim205-school'];

function startSchool(cpus = 1.0) {
  docker(['run', '-d', '--name', 'sim205-school', '-u', UID, '-e', 'HOME=/tmp', '--cpus', String(cpus), '--memory', '320m',
    '-v', `${REPO}:/repo:ro`, '-v', `${OUT}:/out`, '-v', `${DIR}/data:/data`, '-w', '/repo',
    ...env({
      PORT: 8080, HOST: '127.0.0.1', PAYESH_HEADLESS: 1, PAYESH_DATA: '/data', PAYESH_LOG: 0,
      PAYESH_AUTO_BACKUP: 0, PAYESH_UPDATE_AUTO: 0, PAYESH_LIVE_MS: 0, PAYESH_OUTBOX_AUTO: 0,
      PAYESH_CLOUD_AUTO: 0, PAYESH_MIRROR: 0, PROBE_OUT: '/out/probe-school.json',
      PAYESH_S3_ENDPOINT: S3ENV.S3_ENDPOINT, PAYESH_S3_BUCKET: S3.S3_BUCKET, PAYESH_S3_REGION: S3.S3_REGION,
      PAYESH_S3_ACCESS_KEY: S3.S3_ACCESS_KEY, PAYESH_S3_SECRET: S3.S3_SECRET,
    }),
    IMG, 'node', '-r', '/repo/tools/sim/helper-205/preload.js', '--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js']);
  docker(['run', '-d', '--name', 'sim205-s3', '-u', UID, '-e', 'HOME=/tmp', '--network', 'container:sim205-school', '--cpus', '1.0', '--memory', '160m',
    '-v', `${REPO}/tools/sim:/sim:ro`, '-v', `${DIR}/s3:/s3`,
    ...env({ PORT: 9000, S3_DIR: '/s3', S3_LATENCY_MS: 40, ...S3 }), IMG, 'node', '/sim/s3-lite.js']);
}
function startHelpers(urgent) {
  for (const [i, id] of [[1, 'a205a205a205a201'], [2, 'b205b205b205b202']]) {
    docker(['run', '-d', '--name', 'sim205-helper' + i, '-u', UID, '-e', 'HOME=/tmp', '--network', 'container:sim205-school', '--cpus', '1.0', '--memory', '160m',
      '-v', `${REPO}:/repo:ro`, '-v', `${OUT}:/out`,
      ...env({ ...S3ENV, HELPER_ID: id, SLOTS: 1, URGENT: urgent ? 1 : 0, HELPER_OUT: `/out/helper${i}.json`, PROBE_OUT: `/out/probe-helper${i}.json`, REPO: '/repo' }),
      IMG, 'node', '-r', '/repo/tools/sim/helper-205/preload.js', '/repo/tools/sim/helper-205/helper.js']);
  }
}
function snapshot() {
  docker(['stop', '-t', '10', 'sim205-s3', 'sim205-school'], { allow: true, quiet: true });
  for (const d of ['data', 's3']) execFileSync('cp', ['-a', path.join(DIR, d), path.join(DIR, 'snap-' + d)]);
}
function restore() {
  for (const d of ['data', 's3']) {
    execFileSync('sudo', ['-n', 'rm', '-rf', path.join(DIR, d)]);
    execFileSync('cp', ['-a', path.join(DIR, 'snap-' + d), path.join(DIR, d)]);
  }
  try { fs.unlinkSync(path.join(OUT, 'probe-school.json')); } catch (e) { /* none */ }
}
/** helpers switched off: their presence files go too (otherwise the server waits for them up to 90 s) */
function dropPresence() {
  const d = path.join(DIR, 's3');
  execFileSync('sudo', ['-n', 'find', d, '-path', '*payesh/helpers/*', '-delete']);
  execFileSync('sudo', ['-n', 'find', d, '-path', '*payesh/jobs/*', '-delete']);
}
function load(args, name) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const c = spawn('sudo', ['-n', 'docker', ...loadArgs(args)]);
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('close', code => code === 0 ? resolve(out) : reject(new Error((name || args[0]) + ' failed: ' + err.slice(-3000))));
  });
}
function loadArgs(args) {
  return ['run', '--rm', '--name', 'sim205-load', '-u', UID, '-e', 'HOME=/tmp', '--network', 'container:sim205-school', '--memory', '200m',
    '-v', `${REPO}:/repo:ro`, '-v', `${OUT}:/out`, ...env({ ...S3ENV, REPO: '/repo', OUT_DIR: '/out' }),
    IMG, 'node', '/repo/tools/sim/helper-205/load.js', ...args];
}

/* docker stats every ~2 s while a phase runs */
function sampler() {
  const rows = [];
  let stop = false;
  const run = (async () => {
    while (!stop) {
      const r = await new Promise(res => require('child_process').execFile('sudo', ['-n', 'docker', 'stats', '--no-stream', '--format', '{{json .}}'], { encoding: 'utf8' }, (e, stdout) => res({ stdout: stdout || '' })));
      const at = Date.now();
      for (const line of r.stdout.split('\n').filter(Boolean)) {
        try {
          const j = JSON.parse(line);
          if (!/^sim205-/.test(j.Name)) continue;
          rows.push({ at, name: j.Name, cpu: parseFloat(j.CPUPerc), mem_mb: parseFloat(j.MemUsage) * (/GiB/.test(j.MemUsage) ? 1024 : /KiB/.test(j.MemUsage) ? 1 / 1024 : 1) });
        } catch (e) { /* skip */ }
      }
      await sleep(500);
    }
  })();
  return { async end() { stop = true; await run; const by = {}; for (const r of rows) (by[r.name] = by[r.name] || []).push(r); const out = {}; for (const [k, a] of Object.entries(by)) { const c = a.map(x => x.cpu); out[k] = { samples: a.length, cpu_avg: +(c.reduce((x, y) => x + y, 0) / c.length).toFixed(1), cpu_max: +Math.max(...c).toFixed(1), mem_max_mb: +Math.max(...a.map(x => x.mem_mb)).toFixed(0) }; } return out; } };
}

async function phase(name, { devices, think, cpus, helpers, urgent }) {
  console.log(`\n── ${name}: devices=${devices} think=${think}ms cpus=${cpus} helpers=${helpers ? (urgent ? '2 (urgent)' : '2') : 'off'}`);
  /* every phase starts from the same database and the same bucket (snapshot taken after seeding) */
  docker(['stop', '-t', '10', 'sim205-helper1', 'sim205-helper2', 'sim205-s3', 'sim205-school'], { allow: true, quiet: true });
  rm('sim205-helper1', 'sim205-helper2', 'sim205-s3', 'sim205-school');
  restore();
  startSchool(cpus);
  for (const f of ['helper1.json', 'helper2.json', 'probe-helper1.json', 'probe-helper2.json']) { try { fs.unlinkSync(path.join(OUT, f)); } catch (e) { /* none */ } }
  if (helpers) startHelpers(urgent);
  await sleep(9000);
  const st = sampler();
  const line = await load(['phase', name, String(SECS), String(devices), String(think), '15'], name);
  const stats = await st.end();
  const res = JSON.parse(fs.readFileSync(path.join(OUT, name + '.json'), 'utf8'));
  res.docker = stats;
  res.cpus_school = cpus;
  res.helpers = helpers ? [1, 2].map(i => { try { return { stats: JSON.parse(fs.readFileSync(path.join(OUT, `helper${i}.json`), 'utf8')), probe: JSON.parse(fs.readFileSync(path.join(OUT, `probe-helper${i}.json`), 'utf8')) }; } catch (e) { return null; } }) : [];
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(res, null, 1));
  console.log(line.trim().split('\n').pop());
  return res;
}

(async () => {
  rm(...ALL);
  execFileSync('sudo', ['-n', 'rm', '-rf', DIR]);
  for (const d of ['out', 'data', 's3']) fs.mkdirSync(path.join(DIR, d), { recursive: true });
  execFileSync('sudo', ['-n', 'chmod', '-R', '777', DIR]);
  const t0 = Date.now();
  try {
    startSchool();
    await sleep(4000);
    console.log((await load(['seed'])).trim());
    snapshot();
    const plan = [
      ['A_off', { devices: 16, think: 1500, cpus: 1.0, helpers: false }],
      ['B_on', { devices: 16, think: 1500, cpus: 1.0, helpers: true }],
      ['C_off_busy', { devices: 32, think: 0, cpus: 0.35, helpers: false }],
      ['D_on_busy', { devices: 32, think: 0, cpus: 0.35, helpers: true }],
      ['E_on_urgent', { devices: 32, think: 0, cpus: 0.35, helpers: true, urgent: true }],
    ];
    const only = (process.env.PHASES || '').split(',').filter(Boolean);
    const results = {};
    for (const [n, o] of plan) if (!only.length || only.includes(n)) results[n] = await phase(n, o);
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ secs_per_phase: SECS, total_s: Math.round((Date.now() - t0) / 1000), results }, null, 1));
    console.log('\nsummary → ' + path.join(OUT, 'summary.json'));
  } finally {
    const logs = docker(['logs', '--tail', '60', 'sim205-school'], { allow: true, quiet: true });
    fs.writeFileSync(path.join(OUT, 'school.log'), (logs.stdout || '') + (logs.stderr || ''));
    if (process.env.KEEP !== '1') rm(...ALL);
  }
})().catch(e => { console.error(e.stack || e); process.exit(1); });
