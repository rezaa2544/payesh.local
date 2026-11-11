'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 83: randomized multi-device convergence test (property / fuzz)
   (FZ-01 .. FZ-08)

   Real product code on the server side: server/sync.js push/pull,
   server/convergence.js domain rules, and server/db.js on real SQLite.
   Only the devices are simulated. Each device follows the shipped
   client contract:
     - outbox of partial patches carrying base_version (outbox.dart; no rebase)
     - idempotency_key per batch; a lost response ⇒ the same batch is retried
     - pull cursor (since, since_id), and after the last page (server_time, 0)
       (client/app.js and sync_client.dart)
     - server rows overwrite the local copy; tombstones remove it

   Two independent checks run on every scenario:
     P1  convergence: after everyone reconnects and drains, every device's
         replica equals the server, document for document (deep equal)
     P2  domain law: an oracle written straight from the spec
         (docs/cloud/41-conflict-policy.md, D-28), not from convergence.js,
         replays the ops in server-receipt order. Every op outcome
         (apply/merge/noop/conflict/reject) and the final value + version
         of every row must match the server.
   The PRNG is seeded (mulberry32), so every run is reproducible.
   A failure prints seed + step: FUZZ83_SEEDS=<seed> reproduces it.

   Negative (AC): remove or alter a domain rule in the real module
   (grades.score → auto, attendance rule deleted, everything-LWW) ⇒
   the oracle detects the divergence. A device that ignores tombstones
   ⇒ P1 detects it.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { openStore } = require('../server/db');
const sync = require('../server/sync');
const convergence = require('../server/convergence');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-fz83-'));
let passed = 0, failed = 0; const failures = [];
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 400)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

/* ── seeded PRNG ─────────────────────────────────────────────────── */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickOf = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

/* ── spec (independent of server/convergence.js) ─────────────────────
   docs/cloud/41-conflict-policy.md: attendance.status and grades.score are
   sensitive (manual). Notes/times auto-merge with server-receipt LWW.
   Any field not listed is manual (fail-closed).                       */
const SPEC = {
  attendance: { auto: ['note', 'arrival_time', 'leave_time', 'excuse_note'] },
  grades: { auto: ['note', 'teacher_note'] },
};
const FIELDS = {
  attendance: {
    manual: { status: ['present', 'absent', 'late'] },
    auto: { note: ['', 'n1', 'n2', 'n3'], arrival_time: ['07:30', '07:45', '08:00'], excuse_note: ['', 'e1', 'e2'] },
  },
  grades: {
    manual: { score: [10, 15, 18, 20] },
    auto: { note: ['', 'g1', 'g2', 'g3'], teacher_note: ['', 't1', 't2'] },
  },
};
const COLS = Object.keys(FIELDS);
const DOMAIN = { attendance: ['status', 'note', 'arrival_time', 'excuse_note', 'student_id', 'class_id', 'date'], grades: ['score', 'note', 'teacher_note', 'student_id', 'subject_id', 'term'] };
const specClass = (col, f) => (SPEC[col] && SPEC[col].auto.includes(f) ? 'auto' : 'manual');
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
const META = new Set(['id', '_version', 'version', 'at', 'uid', 'device_id', 'created_at', 'updated_at', 'school_id', 'tenant_id', 'deleted_at']);

/* ── oracle: what the server MUST do, op by op ───────────────────── */
function makeOracle() {
  const rows = new Map();          /* key → { doc, version, deleted } */
  const seen = new Set();          /* op uid */
  const idem = new Map();          /* idempotency_key → outcomes */
  const conflicts = [];            /* in creation order */
  const key = (c, id) => c + '#' + id;
  function op(o) {
    if (seen.has(o.uid)) return 'duplicate';
    const k = key(o.collection, o.id);
    const r = rows.get(k);
    const live = r && !r.deleted;
    if (o.type === 'del') {
      if (!live) return 'rejected';
      if (o.base_version != null && o.base_version !== r.version) {
        conflicts.push({ collection: o.collection, record_id: o.id, local: {} });
        return 'conflict';
      }
      r.deleted = true; r.version++; seen.add(o.uid); return 'deleted';
    }
    if (!live) {
      if (o.base_version > 0) { conflicts.push({ collection: o.collection, record_id: o.id, local: o.data }); return 'conflict'; }
      if (r) return 'rejected';    /* id of a tombstone: insert hits the primary key */
      rows.set(k, { doc: Object.assign({}, o.data, { id: o.id }), version: 1, deleted: false });
      seen.add(o.uid); return 'applied';
    }
    if (o.base_version === r.version) {
      Object.assign(r.doc, o.data); r.version++; seen.add(o.uid); return 'applied';
    }
    const changed = Object.keys(o.data).filter(f => !META.has(f) && !same(r.doc[f], o.data[f]));
    if (!changed.length) { seen.add(o.uid); return 'noop'; }
    if (changed.some(f => specClass(o.collection, f) === 'manual')) {
      conflicts.push({ collection: o.collection, record_id: o.id, local: o.data }); return 'conflict';
    }
    for (const f of changed) r.doc[f] = o.data[f];
    r.version++; seen.add(o.uid); return 'merged';
  }
  function batch(idemKey, ops) {
    if (idem.has(idemKey)) return { replayed: true, outcomes: idem.get(idemKey) };
    const outcomes = ops.map(op);
    idem.set(idemKey, outcomes);
    return { replayed: false, outcomes };
  }
  function resolve(i, decision) {
    const c = conflicts[i];
    if (c.resolved) return;
    c.resolved = decision;
    if (decision !== 'local') return;
    const r = rows.get(key(c.collection, c.record_id));
    const patch = Object.assign({}, c.local); delete patch._version;
    Object.assign(r.doc, patch); r.version++;
  }
  return { rows, conflicts, batch, resolve, key };
}

/* server response → outcome label for one op */
function outcomeOf(resp, uid) {
  if (resp.conflicts.some(c => c.uid === uid)) return 'conflict';
  if (resp.rejected.some(c => c.uid === uid)) return 'rejected';
  const a = resp.applied.find(c => c.uid === uid);
  if (!a) return 'missing';
  if (a.duplicate) return 'duplicate';
  if (a.deleted) return 'deleted';
  return 'ok';                     /* applied / merged / noop share one shape */
}
const OK_SET = new Set(['applied', 'merged', 'noop']);

/* ── one scenario ────────────────────────────────────────────────── */
function scenario(seed, opts = {}) {
  const rnd = mulberry32(seed);
  const steps = opts.steps || 160;
  const nDev = 3 + Math.floor(rnd() * 3);                 /* 3–5 devices */
  const store = openStore(path.join(TMP, `s${seed}-${opts.tag || 'x'}-${Math.floor(rnd() * 1e9)}.sqlite`));
  const mgr = store.insert('users', { name: 'مدیر', role: 'manager', active: true });
  const actor = { user: mgr, role: 'manager', device: null };
  const oracle = makeOracle();
  const trace = [];
  const stats = { pushes: 0, ops: 0, lost: 0, replayed: 0, dup: 0, conflicts: 0, merged: 0, noop: 0, applied: 0, deleted: 0, rejected: 0, resolved: 0, offline_toggles: 0, pulls: 0, self_chain_conflicts: 0 };
  let firstDivergence = null;
  const diverge = (step, what) => { if (!firstDivergence) firstDivergence = `seed=${seed} step=${step} ${what}`; };

  /* compare one push with the oracle */
  function serverPush(step, dev, idemKey, ops) {
    const body = { ops: ops.map(o => ({ uid: o.uid, collection: o.collection, type: o.type, id: o.id, data: o.data, base_version: o.base_version })), idempotency_key: idemKey };
    const resp = sync.push(store, actor, body, { device_id: 'dev-' + dev.n });
    const exp = oracle.batch(idemKey, ops);
    stats.pushes++;
    if (resp.replayed) stats.replayed++;
    if (!!resp.replayed !== exp.replayed) diverge(step, `replay mismatch key=${idemKey}`);
    ops.forEach((o, i) => {
      const got = outcomeOf(resp, o.uid);
      const want = exp.outcomes[i];
      const okWant = OK_SET.has(want) ? 'ok' : want;
      if (!exp.replayed) {
        stats.ops++;
        stats[want === 'duplicate' ? 'dup' : want === 'conflict' ? 'conflicts' : want] = (stats[want === 'duplicate' ? 'dup' : want === 'conflict' ? 'conflicts' : want] || 0) + 1;
        if (want === 'conflict' && o.chain) stats.self_chain_conflicts++;
      }
      if (got !== okWant) diverge(step, `op ${o.uid} ${o.collection}#${o.id} ${o.type} base=${o.base_version} data=${JSON.stringify(o.data)}: server=${got} spec=${want}`);
    });
    trace.push([step, dev.n, idemKey, ops.map(o => o.uid + ':' + exp.outcomes[ops.indexOf(o)]).join(',')]);
    return resp;
  }

  /* seed rows (server side, before devices exist) */
  const seedOps = [];
  for (const col of COLS) {
    for (let i = 1; i <= 5; i++) {
      const id = 100 + i;
      const data = col === 'attendance'
        ? { student_id: i, class_id: 1, date: '2026-11-0' + i, status: 'present', note: '', arrival_time: '07:30', excuse_note: '' }
        : { student_id: i, subject_id: 2, term: 1, score: 15, note: '', teacher_note: '' };
      seedOps.push({ uid: `seed-${col}-${id}`, collection: col, type: 'put', id, data, base_version: 0 });
    }
  }
  serverPush(-1, { n: 0 }, 'seed-batch', seedOps);

  /* devices */
  const devs = [];
  for (let n = 1; n <= nDev; n++) devs.push({ n, online: true, replica: new Map(), outbox: [], since: '1970-01-01T00:00:00.000Z', sinceId: 0, seq: 0, nextId: 1000 * n, lost: null });
  const rkey = (c, id) => c + '#' + id;

  function pull(dev) {
    stats.pulls++;
    for (let guard = 0; guard < 50; guard++) {
      const r = sync.pull(store, actor, { since: dev.since, since_id: dev.sinceId, collections: COLS.join(',') });
      for (const col of Object.keys(r.collections)) for (const row of r.collections[col]) dev.replica.set(rkey(col, row.id), Object.assign({}, row));
      if (!opts.ignoreTombstones) for (const d of r.deleted) dev.replica.delete(rkey(d.collection, d.id));
      if (r.more) { dev.since = r.next_since; dev.sinceId = Number(r.next_id || 0); continue; }
      dev.since = r.server_time; dev.sinceId = 0;      /* client/app.js: (server_time, 0) */
      return;
    }
    throw new Error('pull did not finish');
  }

  function flush(step, dev) {
    if (!dev.outbox.length) return;
    /* a batch whose response was lost is retried as-is (same key, same uids) */
    let ops, idemKey;
    if (dev.lost && rnd() < 0.7) { ops = dev.lost.ops; idemKey = dev.lost.key; }
    else {
      ops = dev.outbox.slice(0, 1 + Math.floor(rnd() * 8));
      idemKey = 'd' + dev.n + '-' + crypto.createHash('sha1').update(ops.map(o => o.uid).join('|')).digest('hex').slice(0, 16);
    }
    const resp = serverPush(step, dev, idemKey, ops);
    if (rnd() < 0.12) {                       /* response lost on the wire, device drops offline */
      stats.lost++; dev.lost = { ops, key: idemKey }; dev.online = false; return;
    }
    dev.lost = null;
    const done = new Set(ops.map(o => o.uid));
    for (const c of resp.conflicts) done.add(c.uid);
    dev.outbox = dev.outbox.filter(o => !done.has(o.uid));
  }

  function localEdit(dev) {
    const known = [...dev.replica.keys()];
    const r = rnd();
    let op;
    if (r < 0.06 || !known.length) {                     /* new row with a device-owned id */
      const col = pickOf(rnd, COLS);
      const id = dev.nextId++;
      const data = col === 'attendance'
        ? { student_id: 50 + dev.n, class_id: 1, date: '2026-11-20', status: pickOf(rnd, FIELDS.attendance.manual.status), note: '', arrival_time: '07:45', excuse_note: '' }
        : { student_id: 50 + dev.n, subject_id: 2, term: 1, score: pickOf(rnd, FIELDS.grades.manual.score), note: '', teacher_note: '' };
      op = { collection: col, type: 'put', id, data, base_version: 0 };
      dev.replica.set(rkey(col, id), Object.assign({ id, _version: 0 }, data));
    } else if (r < 0.09) {                                /* delete (manager) */
      const k = pickOf(rnd, known); const row = dev.replica.get(k); const col = k.split('#')[0];
      op = { collection: col, type: 'del', id: row.id, data: {}, base_version: row._version };
      dev.replica.delete(k);
    } else {                                              /* partial patch */
      const k = pickOf(rnd, known); const row = dev.replica.get(k); const col = k.split('#')[0];
      const F = FIELDS[col];
      const data = {};
      const kinds = rnd() < 0.3 ? ['manual'] : rnd() < 0.85 ? ['auto'] : ['manual', 'auto'];
      for (const kind of kinds) {
        const names = Object.keys(F[kind]);
        const f = pickOf(rnd, names);
        data[f] = pickOf(rnd, F[kind][f]);
        if (rnd() < 0.3) { const g = pickOf(rnd, names); data[g] = pickOf(rnd, F[kind][g]); }
      }
      op = { collection: col, type: 'put', id: row.id, data, base_version: row._version };
      Object.assign(row, data);
    }
    op.uid = `d${dev.n}-${++dev.seq}`;
    op.chain = dev.outbox.some(o => o.collection === op.collection && o.id === op.id);
    dev.outbox.push(op);
  }

  devs.forEach(pull);
  for (let step = 0; step < steps; step++) {
    const dev = pickOf(rnd, devs);
    const a = rnd();
    if (a < 0.12) { dev.online = !dev.online; stats.offline_toggles++; continue; }
    if (a < 0.62) { localEdit(dev); continue; }
    if (a < 0.67) {                                        /* a human resolves an open conflict */
      const open = oracle.conflicts.map((c, i) => [c, i]).filter(([c]) => !c.resolved);
      if (open.length) {
        const [c, i] = pickOf(rnd, open);
        const live = oracle.rows.get(oracle.key(c.collection, c.record_id));
        const decision = live && !live.deleted && rnd() < 0.5 ? 'local' : 'server';
        const srv = store.all('conflicts').filter(x => x.kind !== 'rejected');
        const target = srv[i];
        if (!target || target.collection !== c.collection || Number(target.record_id) !== Number(c.record_id)) diverge(step, `conflict #${i} not recorded as spec says (${c.collection}#${c.record_id})`);
        else {
          const res = sync.resolveConflict(store, actor, target.id, decision, { device_id: 'admin' });
          if (!res.ok) diverge(step, 'resolve failed ' + res.error);
          oracle.resolve(i, decision); stats.resolved++;
        }
      }
      continue;
    }
    if (!dev.online) continue;
    flush(step, dev);
    if (dev.online && !dev.outbox.length) pull(dev);
  }

  /* everyone reconnects and drains, then a final pull for all */
  for (const d of devs) d.online = true;
  for (let round = 0; round < 60 && devs.some(d => d.outbox.length); round++) {
    for (const d of devs) { d.online = true; flush(steps + round, d); }
  }
  for (const d of devs) { d.online = true; pull(d); }
  const left = devs.reduce((s, d) => s + d.outbox.length, 0);
  if (left) diverge(steps, `outbox not drained: ${left}`);

  /* P1: every replica deep-equals the server */
  const strip = (row) => { const o = Object.assign({}, row); delete o._updated_at; return o; };
  const serverRows = new Map();
  for (const col of COLS) for (const row of store.all(col)) serverRows.set(rkey(col, row.id), strip(row));
  const canon = (m) => JSON.stringify([...m.keys()].sort().map(k => [k, m.get(k)]));
  const srvCanon = canon(serverRows);
  const p1 = [];
  for (const d of devs) {
    const rep = new Map([...d.replica].map(([k, v]) => [k, strip(v)]));
    if (canon(rep) !== srvCanon) {
      const miss = [...serverRows.keys()].filter(k => !rep.has(k)).length;
      const extra = [...rep.keys()].filter(k => !serverRows.has(k)).length;
      const diff = [...serverRows.keys()].filter(k => rep.has(k) && JSON.stringify(rep.get(k)) !== JSON.stringify(serverRows.get(k))).length;
      p1.push(`device ${d.n}: missing=${miss} extra=${extra} differing=${diff}`);
    }
  }

  /* P2: domain law: oracle rows == server rows (domain fields + version) */
  const p2 = [];
  for (const [k, r] of oracle.rows) {
    const col = k.split('#')[0];
    const s = serverRows.get(k);
    if (r.deleted) { if (s) p2.push(`${k} should be deleted`); continue; }
    if (!s) { p2.push(`${k} missing on server`); continue; }
    if (s._version !== r.version) p2.push(`${k} version server=${s._version} spec=${r.version}`);
    for (const f of DOMAIN[col]) if (!same(s[f], r.doc[f])) p2.push(`${k}.${f} server=${JSON.stringify(s[f])} spec=${JSON.stringify(r.doc[f])}`);
  }
  for (const k of serverRows.keys()) if (!oracle.rows.has(k)) p2.push(`${k} unexpected on server`);
  const srvConf = store.all('conflicts').filter(x => x.kind !== 'rejected').length;
  if (srvConf !== oracle.conflicts.length) p2.push(`conflicts server=${srvConf} spec=${oracle.conflicts.length}`);
  if (p2.length) diverge(steps, 'final state vs spec: ' + p2.slice(0, 3).join(' | ') + (p2.length > 3 ? ` (+${p2.length - 3})` : ''));

  const digest = crypto.createHash('sha256').update(JSON.stringify(trace)).update(srvCanon.replace(/"(school_id|tenant_id)":[^,}]*,?/g, '')).digest('hex').slice(0, 16);
  try { store.close && store.close(); } catch (e) { /* ignore */ }
  return { seed, nDev, stats, p1, divergence: firstDivergence, digest, rows: serverRows.size };
}

/* ── seeds ───────────────────────────────────────────────────────── */
const SEEDS = process.env.FUZZ83_SEEDS
  ? process.env.FUZZ83_SEEDS.split(',').map(s => Number(s.trim())).filter(Number.isFinite)
  : Array.from({ length: Number(process.env.FUZZ83_RUNS || 40) }, (_, i) => 8300 + i * 7919);

function runAll(seeds, opts) {
  const out = []; for (const s of seeds) out.push(scenario(s, opts)); return out;
}
function sum(results, k) { return results.reduce((s, r) => s + (r.stats[k] || 0), 0); }

/* temporarily alter the real module (negative controls), always restored */
function withMutation(apply, fn) {
  const saved = { rules: JSON.parse(JSON.stringify(convergence.RULES)), decide: convergence.decide };
  try { apply(); return fn(); } finally {
    for (const k of Object.keys(convergence.RULES)) delete convergence.RULES[k];
    Object.assign(convergence.RULES, saved.rules);
    convergence.decide = saved.decide;
  }
}

(async () => {
  let base;
  await check('FZ-01', `property run: ${SEEDS.length} seeded scenarios × 3–5 devices, random offline/online, lost responses, retries, deletes, human resolutions`, async () => {
    base = runAll(SEEDS, { tag: 'base' });
    const devs = base.reduce((s, r) => s + r.nDev, 0);
    const bad = base.filter(r => r.divergence || r.p1.length);
    assert(!bad.length, 'divergence: ' + bad.slice(0, 2).map(r => r.divergence || `seed=${r.seed} P1 ${r.p1[0]}`).join(' || '));
    const n = (k) => sum(base, k);
    assert(n('conflicts') > 0 && n('merged') > 0 && n('lost') > 0 && n('replayed') > 0 && n('deleted') > 0 && n('resolved') > 0, 'scenario mix too thin: ' + JSON.stringify(base[0].stats));
    return `scenarios=${base.length} devices=${devs} pushes=${n('pushes')} ops=${n('ops')} applied=${n('applied')} merged=${n('merged')} noop=${n('noop')} conflicts=${n('conflicts')} deleted=${n('deleted')} rejected=${n('rejected')} duplicates=${n('dup')} lost_responses=${n('lost')} replayed=${n('replayed')} resolved=${n('resolved')} pulls=${n('pulls')}`;
  });

  await check('FZ-02', 'P1 convergence: after reconnect + drain every device replica deep-equals the server (no row missing, extra or different)', async () => {
    assert(base && base.every(r => !r.p1.length), 'P1 failed');
    const rows = base.reduce((s, r) => s + r.rows * r.nDev, 0);
    return `replica rows compared=${rows} mismatches=0`;
  });

  await check('FZ-03', 'P2 domain law: per-op outcome and final value+version of every row equal the spec oracle (sensitive fields never auto-merged; auto fields LWW by server receipt; idempotent retries)', async () => {
    assert(base && base.every(r => !r.divergence), 'P2 failed');
    return `ops checked=${sum(base, 'ops')} · sensitive conflicts kept for review=${sum(base, 'conflicts')} · same-device chains that conflicted=${sum(base, 'self_chain_conflicts')}`;
  });

  await check('FZ-04', 'reproducible: the same seed yields the same trace + final state digest; a different seed differs', async () => {
    const s = SEEDS[0];
    const a = scenario(s, { tag: 'r1' }), b = scenario(s, { tag: 'r2' }), c = scenario(s + 1, { tag: 'r3' });
    assert(a.digest === b.digest, `same seed differs: ${a.digest} vs ${b.digest}`);
    assert(a.digest !== c.digest, 'different seeds collide');
    return `seed=${s} digest=${a.digest} (twice) · seed=${s + 1} digest=${c.digest}`;
  });

  const NEG = SEEDS.slice(0, 12);
  const caught = (results) => results.find(r => r.divergence || r.p1.length);

  await check('FZ-05', 'negative: domain rule removed: grades.score made auto-mergeable ⇒ divergence detected (seed/step reported)', async () => {
    const res = withMutation(() => { convergence.RULES.grades.auto.push('score'); }, () => runAll(NEG, { tag: 'm1' }));
    const hit = caught(res);
    assert(hit, 'mutant survived: score auto-merge not detected');
    return 'detected: ' + (hit.divergence || hit.p1[0]).slice(0, 160);
  });

  await check('FZ-06', 'negative: attendance rule deleted (falls back to manual-only) ⇒ divergence detected', async () => {
    const res = withMutation(() => { delete convergence.RULES.attendance; }, () => runAll(NEG, { tag: 'm2' }));
    const hit = caught(res);
    assert(hit, 'mutant survived: missing attendance rule not detected');
    return 'detected: ' + (hit.divergence || hit.p1[0]).slice(0, 160);
  });

  await check('FZ-07', 'negative: domain law replaced by blind last-writer-wins on every field ⇒ divergence detected', async () => {
    const res = withMutation(() => {
      const orig = convergence.decide;
      convergence.decide = (a) => { const d = orig(a); return d.action === 'conflict' && a.type === 'put' ? Object.assign({}, d, { action: 'merge', fields: d.fields }) : d; };
    }, () => runAll(NEG, { tag: 'm3' }));
    const hit = caught(res);
    assert(hit, 'mutant survived: blind LWW not detected');
    return 'detected: ' + (hit.divergence || hit.p1[0]).slice(0, 160);
  });

  await check('FZ-08', 'negative (P1 is live): a device that ignores tombstones ⇒ replica divergence detected; unmodified run of the same seeds is clean', async () => {
    const res = runAll(NEG, { tag: 'm4', ignoreTombstones: true });
    const hit = res.find(r => r.p1.length);
    assert(hit, 'P1 did not notice a device keeping deleted rows');
    const clean = runAll(NEG, { tag: 'm4b' });
    assert(clean.every(r => !r.p1.length && !r.divergence), 'baseline not clean');
    return `detected seed=${hit.seed}: ${hit.p1[0]} · baseline clean`;
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log(`# passed=${passed} failed=${failed}${failures.length ? ' failures=' + failures.join(',') : ''}`);
  console.log(failed ? 'CONVERGENCE-FUZZ-83-FAILED' : 'CONVERGENCE-FUZZ-83-OK');
  process.exit(failed ? 1 : 0);
})();
