// Row 207 — GitHub Actions Helper executor (batch/heavy jobs only).
// Config via repo secrets ONLY (values never printed):
//   PAYESH_HELPER_S3_ENDPOINT, PAYESH_HELPER_S3_BUCKET,
//   PAYESH_HELPER_S3_ACCESS_KEY, PAYESH_HELPER_S3_SECRET_KEY,
// Writes artifact helper-executor-report.json (counts only, no content).
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const hj = require('../../server/helper-jobs.js');
const executor = require('../../server/helper-executor.js');

const env = process.env;
const need = ['PAYESH_HELPER_S3_ENDPOINT', 'PAYESH_HELPER_S3_BUCKET', 'PAYESH_HELPER_S3_ACCESS_KEY', 'PAYESH_HELPER_S3_SECRET_KEY'];
const missing = need.filter((k) => !env[k]);
const report = { at: new Date().toISOString(), executor: 'actions' };
if (missing.length) {
  report.configured = false; report.missing = missing;
  fs.writeFileSync('helper-executor-report.json', JSON.stringify(report, null, 2));
  console.log('helper-executor: not configured, missing ' + missing.join(','));
  process.exit(0); // never-fail: monitoring/queue must not break CI
}
const cfg = hj && require('../../server/s3mem.js').normalize({
  endpoint: env.PAYESH_HELPER_S3_ENDPOINT, bucket: env.PAYESH_HELPER_S3_BUCKET,
  accessKey: env.PAYESH_HELPER_S3_ACCESS_KEY, secretKey: env.PAYESH_HELPER_S3_SECRET_KEY,
  region: env.PAYESH_HELPER_S3_REGION || '',
  prefix: env.PAYESH_HELPER_PREFIX || 'payesh/',
});
const me = { id: 'ac00000000000001', cls: 'actions', host: 'github-actions',
  caps: ['storage.usage', 'object.verify', 'endpoint.check', 'bucket.gc', 'backup.verify', 'update.build'],
  capacity: 1, version: 'dp-2' };
// s3mini normalize uses `secret` as secretKey field name in this repo; keep both aligned:
cfg.secret = env.PAYESH_HELPER_S3_SECRET_KEY; // repo design: bucket secret signs S3 and seals boxes
try {
  await executor.writePresence(cfg, me, {});
  const r = await executor.pollOnce(cfg, me, { maxJobs: Number(env.HELPER_MAX_JOBS || 5) });
  Object.assign(report, { configured: true, ...r });
} catch (e) {
  report.configured = true; report.error = String(e && e.code || 'unreachable');
}
fs.writeFileSync('helper-executor-report.json', JSON.stringify(report, null, 2));
console.log('helper-executor:', JSON.stringify(report));
