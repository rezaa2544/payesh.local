#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Central-DB migration CLI (row 86). Wraps server/migrator.js.

   node tools/migrate-86.mjs lint     [--dir D]
   node tools/migrate-86.mjs status   [--dir D]
   node tools/migrate-86.mjs up       [--dir D] [--to ID] [--allow-contract]
                                      [--lock-timeout-ms N] [--statement-timeout-ms N]
   node tools/migrate-86.mjs rollback --to ID [--dir D]
   node tools/migrate-86.mjs set-client-floor X.Y.Z      (OWNER: N-1 retired)
   --track NAME   bookkeeping namespace (default: directory name, e.g. "central")

   DB: $PAYESH_MIGRATE_URL or $PAYESH_PG_ADMIN (an admin/owner connection).
   Default dir: db/migrations/central
   Output: one JSON line per event plus a final MIGRATE-86-OK / MIGRATE-86-FAILED line.
   Exit: 0 ok · 1 refused/failed (lint, gate, checksum, lock, SQL error) · 2 usage
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrator = require(path.join(ROOT, 'server', 'migrator.js'));

function parse(argv) {
  const out = { cmd: argv[0], flags: new Set(), values: {}, rest: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-contract' || a === '--json') out.flags.add(a.slice(2));
    else if (a.startsWith('--')) { out.values[a.slice(2)] = argv[++i]; }
    else out.rest.push(a);
  }
  return out;
}

export async function main(argv) {
  const a = parse(argv);
  const dir = path.resolve(ROOT, a.values.dir || 'db/migrations/central');
  const say = (o) => console.log(JSON.stringify(o));
  if (!['lint', 'status', 'up', 'rollback', 'set-client-floor'].includes(a.cmd)) {
    console.error('usage: migrate-86.mjs lint|status|up|rollback|set-client-floor …');
    return 2;
  }
  if (a.cmd === 'lint') {
    const list = migrator.loadDir(dir);
    const errs = migrator.lintAll(list);
    for (const e of errs) say({ event: 'lint_error', id: e.id, phase: e.phase, rule: e.rule, why: e.why });
    console.log((errs.length ? 'MIGRATE-86-FAILED' : 'MIGRATE-86-OK') + ` lint migrations=${list.length} errors=${errs.length}`);
    return errs.length ? 1 : 0;
  }
  const url = process.env.PAYESH_MIGRATE_URL || process.env.PAYESH_PG_ADMIN;
  if (!url) { console.error('PAYESH_MIGRATE_URL / PAYESH_PG_ADMIN not set'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: url, application_name: 'payesh-migrate-86' });
  await c.connect();
  try {
    let res;
    const opts = {
      allowContract: a.flags.has('allow-contract'), to: a.values.to || null, track: a.values.track || null,
      lockTimeoutMs: Number(a.values['lock-timeout-ms'] || 3000),
      statementTimeoutMs: Number(a.values['statement-timeout-ms'] || 120000),
      log: say,
    };
    if (a.cmd === 'status') res = await migrator.status(c, dir, opts);
    else if (a.cmd === 'up') res = await migrator.up(c, dir, opts);
    else if (a.cmd === 'rollback') {
      if (!opts.to) { console.error('rollback needs --to ID (exclusive)'); return 2; }
      res = await migrator.rollback(c, dir, opts);
    } else res = await migrator.setClientFloor(c, a.rest[0]);
    say({ event: 'result', cmd: a.cmd, result: res });
    console.log('MIGRATE-86-OK ' + a.cmd);
    return 0;
  } catch (e) {
    say({ event: 'refused', cmd: a.cmd, code: e.code || 'error', detail: e.detail || String(e.message || e).slice(0, 300) });
    console.log('MIGRATE-86-FAILED ' + a.cmd + ' code=' + (e.code || 'error'));
    return 1;
  } finally {
    await c.end().catch(() => {});
  }
}

let isMain = false;
try { isMain = import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch (e) { isMain = false; }
if (isMain) main(process.argv.slice(2)).then(code => process.exit(code), (e) => { console.error(e); process.exit(1); });
