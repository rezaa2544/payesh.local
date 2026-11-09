#!/usr/bin/env node
/*
 * Read-only size inventory for an owner-authorized PostgreSQL database.
 *
 * This measures a database environment; it is not a penetration test,
 * migration, readiness certification, or security-status decision. No table
 * rows are read and no database writes are issued.
 *
 * Usage:
 *   DATABASE_URL='postgres://…' node tools/t2-measure.mjs --allow-local
 *   DATABASE_URL='postgres://…' node tools/t2-measure.mjs --managed-target --json
 *   DATABASE_URL='postgres://…' node tools/t2-measure.mjs --dry-run [--allow-local|--managed-target]
 *
 * A local/private target is always labelled [S]. A remote URL is [ ? ] unless
 * the operator explicitly confirms it is the authorized managed target.
 */
import { createRequire } from 'node:module';
import { isIP } from 'node:net';

const require = createRequire(import.meta.url);
const args = new Set(process.argv.slice(2));
const jsonOutput = args.has('--json');
const allowLocal = args.has('--allow-local');
const managedTarget = args.has('--managed-target');
const dryRun = args.has('--dry-run');
const unknownArgs = [...args].filter((arg) => !['--json', '--allow-local', '--managed-target', '--dry-run'].includes(arg));

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

function hostIsLocal(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || ['localhost', 'host.docker.internal'].includes(host)) return true;
  if (['.localhost', '.local', '.internal', '.test', '.invalid'].some((suffix) => host.endsWith(suffix))) return true;

  const version = isIP(host);
  if (version === 4) {
    const octets = host.split('.').map(Number);
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  if (version === 6) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  }
  return false;
}

function emit(result) {
  if (jsonOutput) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`T2-DB-MEASURE-OK tag=[${result.evidence_tag}]`);
    console.log(`database=${result.database}`);
    console.log(`server_version=${result.server_version}`);
    console.log(`database_size_bytes=${result.database_size_bytes}`);
    console.log(`relations_measured=${result.relations.length}`);
    for (const relation of result.relations) {
      console.log(`relation=${relation.schema}.${relation.name} total_bytes=${relation.total_bytes} estimated_rows=${relation.estimated_rows}`);
    }
    console.log('mode=read-only; table_rows_read=0; writes=0');
  }
}

async function main() {
  if (unknownArgs.length) throw new Error(`unsupported argument: ${unknownArgs[0]}`);
  if (allowLocal && managedTarget) throw new Error('--allow-local and --managed-target are mutually exclusive');

  const connectionString = process.env.DATABASE_URL || '';
  if (!connectionString) throw new Error('DATABASE_URL is required; never pass or store credentials in command-line arguments');
  const url = safeUrl(connectionString);
  if (!url) throw new Error('DATABASE_URL must be a valid postgres:// or postgresql:// URL; the URL is not printed');

  const local = hostIsLocal(url.hostname);
  if (managedTarget && local) {
    throw new Error('a local/private URL cannot be labelled [M]; managed-target confirmation requires a non-local endpoint');
  }
  if (local && !allowLocal) {
    throw new Error('local/private DATABASE_URL refused by default; for a local simulation explicitly pass --allow-local (it is always tagged [S])');
  }
  const evidenceTag = local ? 'S' : managedTarget ? 'M' : '?';
  if (dryRun) {
    const check = {
      result: 'T2-DB-MEASURE-PREFLIGHT-OK',
      evidence_tag: evidenceTag,
      local_or_private_target: local,
      database_contacted: false,
    };
    if (jsonOutput) console.log(JSON.stringify(check, null, 2));
    else console.log(`${check.result} tag=[${evidenceTag}] local_or_private=${local} database_contacted=false`);
    return;
  }

  const { Client } = require('pg');
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    application_name: 'payesh-t2-readonly-measure',
  });

  let transactionOpen = false;
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '8s'");
    await client.query("SET LOCAL lock_timeout = '1s'");

    const meta = await client.query(`
      SELECT current_database() AS database,
             current_setting('server_version') AS server_version,
             pg_database_size(current_database())::text AS database_size_bytes`);
    const relations = await client.query(`
      SELECT n.nspname AS schema,
             c.relname AS name,
             pg_total_relation_size(c.oid)::text AS total_bytes,
             GREATEST(c.reltuples, 0)::bigint::text AS estimated_rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'm', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY pg_total_relation_size(c.oid) DESC, n.nspname, c.relname`);

    const result = {
      measurement: 'postgresql-database-size-inventory',
      evidence_tag: evidenceTag,
      database: meta.rows[0].database,
      server_version: meta.rows[0].server_version,
      database_size_bytes: Number(meta.rows[0].database_size_bytes),
      relations: relations.rows.map((row) => ({
        schema: row.schema,
        name: row.name,
        total_bytes: Number(row.total_bytes),
        estimated_rows: Number(row.estimated_rows),
      })),
      safety: {
        transaction: 'READ ONLY',
        writes: 0,
        table_rows_read: 0,
        local_or_private_target: local,
        managed_target_operator_confirmed: managedTarget,
      },
    };
    await client.query('ROLLBACK');
    transactionOpen = false;
    emit(result);
  } catch (error) {
    // Do not print driver errors: they may include connection details.
    const code = error && typeof error.code === 'string' ? error.code : 'MEASUREMENT_FAILED';
    throw new Error(`measurement failed (${code}); connection details were suppressed`);
  } finally {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original result/error */ }
    }
    try { await client.end(); } catch { /* preserve original result/error */ }
  }
}

main().catch((error) => {
  console.error(`T2-DB-MEASURE-FAIL: ${error.message}`);
  process.exitCode = 1;
});
