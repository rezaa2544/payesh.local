#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 173 — a small S3-compatible object store for the Docker simulation
   (tools/sim/docker-compose.sim.yml). It stands in for the owner's ArvanCloud
   bucket («دیتابیس») when real S3 images cannot be pulled (minio/quay are
   not reachable from the owner's network).

   What it checks like the real thing:
     • AWS SigV4 header signatures recomputed from scratch (wrong key ⇒ 403);
     • x-amz-content-sha256 against the real body hash;
     • presigned GET URLs (signature + expiry);
     • anonymous GET only for objects written with x-amz-acl: public-read
       (Arvan behaviour that pub/school-servers.json and pub/connect/ rely on);
     • ListBuckets, ListObjectsV2 (prefix, max-keys, continuation-token),
       PUT / GET / HEAD / DELETE, bucket sub-resources (?cors) accepted.
   Objects are stored byte-exact on disk (S3_DIR), so a container restart
   keeps the «database». S3_LATENCY_MS adds a fixed delay per request to
   imitate the round trip to the real bucket. Every request is counted per
   method in GET /__stats (unsigned, for the simulation driver only).
   Environment: PORT (9000), S3_DIR (/data), S3_ACCESS_KEY, S3_SECRET,
   S3_BUCKET (payesh-sim), S3_LATENCY_MS (0).
   ═══════════════════════════════════════════════════════════════════ */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 9000);
const DIR = process.env.S3_DIR || '/data';
const AK = process.env.S3_ACCESS_KEY || 'sim-access';
const SK = process.env.S3_SECRET || 'sim-secret';
const REGION = String(process.env.S3_REGION || '').trim();
const BUCKET = process.env.S3_BUCKET || 'payesh-sim';
const LATENCY = Number(process.env.S3_LATENCY_MS || 0);

const sha256hex = (x) => crypto.createHash('sha256').update(x).digest('hex');
const hmac = (k, m) => crypto.createHmac('sha256', k).update(m).digest();
function uriEncode(str, keepSlash) {
  let out = '';
  for (const c of Buffer.from(String(str), 'utf8')) {
    const ch = String.fromCharCode(c);
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) ||
        ch === '-' || ch === '_' || ch === '.' || ch === '~' || (keepSlash && ch === '/')) out += ch;
    else out += '%' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase();
  }
  return out;
}
const canonicalUri = (p) => p.split('/').map(s => uriEncode(decodeURIComponent(s), false)).join('/') || '/';
function canonicalQuery(sp, skip = []) {
  const pairs = [];
  for (const [k, v] of sp.entries()) if (!skip.includes(k)) pairs.push([k, v]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
  return pairs.map(([k, v]) => uriEncode(k) + '=' + uriEncode(v)).join('&');
}
function signingKey(secret, ds, rg, svc) { return hmac(hmac(hmac(hmac('AWS4' + secret, ds), rg), svc), 'aws4_request'); }
function amzTime(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/* ── storage: <DIR>/<bucket>/<sha256(key)>.bin + .json (meta: key, type, acl, mtime) ── */
const bucketDir = (b) => path.join(DIR, b);
const fileOf = (b, key) => path.join(bucketDir(b), sha256hex(key));
function ensureBucket(b) { fs.mkdirSync(bucketDir(b), { recursive: true }); }
function putObj(b, key, body, type, acl) {
  ensureBucket(b);
  const f = fileOf(b, key);
  fs.writeFileSync(f + '.bin.tmp', body); fs.renameSync(f + '.bin.tmp', f + '.bin');
  const meta = { key, type: type || 'application/octet-stream', acl: acl || 'private', mtime: Date.now(), size: body.length, etag: sha256hex(body).slice(0, 32) };
  fs.writeFileSync(f + '.json', JSON.stringify(meta));
  return meta;
}
function metaOf(b, key) { try { return JSON.parse(fs.readFileSync(fileOf(b, key) + '.json', 'utf8')); } catch (e) { return null; } }
function bodyOf(b, key) { return fs.readFileSync(fileOf(b, key) + '.bin'); }
function delObj(b, key) { for (const s of ['.bin', '.json']) fs.rmSync(fileOf(b, key) + s, { force: true }); }
function listMetas(b) {
  let names = [];
  try { names = fs.readdirSync(bucketDir(b)).filter(n => n.endsWith('.json')); } catch (e) { return []; }
  const out = [];
  for (const n of names) { try { out.push(JSON.parse(fs.readFileSync(path.join(bucketDir(b), n), 'utf8'))); } catch (e) { /* half written */ } }
  return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

const stats = { started: new Date().toISOString(), requests: 0, by_method: {}, rejected: 0, anonymous_ok: 0, anonymous_denied: 0, bytes_in: 0, bytes_out: 0 };
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function xmlErr(res, status, code, msg) {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${esc(msg || code)}</Message></Error>`);
}

function verify(req, url, body) {
  const auth = req.headers.authorization;
  if (!auth) {
    const sig = url.searchParams.get('X-Amz-Signature');
    if (!sig) return { anonymous: true };
    const cred = String(url.searchParams.get('X-Amz-Credential') || '').split('/');
    if (cred[0] !== AK) return { error: ['InvalidAccessKeyId', 'unknown access key'] };
    const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders') || 'host';
    const amzDate = url.searchParams.get('X-Amz-Date');
    const cr = [req.method, canonicalUri(url.pathname), canonicalQuery(url.searchParams, ['X-Amz-Signature']),
      signedHeaders.split(';').map(h => h + ':' + String(h === 'host' ? req.headers.host : req.headers[h] || '').trim() + '\n').join(''),
      signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
    if (REGION && cred[2] !== REGION) return { error: ['AuthorizationQueryParametersError', `the region '${cred[2]}' is wrong; expecting '${REGION}'`] };
    const sts = ['AWS4-HMAC-SHA256', amzDate, cred.slice(1, 5).join('/'), sha256hex(cr)].join('\n');
    const want = crypto.createHmac('sha256', signingKey(SK, cred[1], cred[2], cred[3])).update(sts).digest('hex');
    if (want !== sig) return { error: ['SignatureDoesNotMatch', 'presigned signature mismatch'] };
    if ((Date.now() - amzTime(amzDate)) / 1000 > Number(url.searchParams.get('X-Amz-Expires') || 0)) return { error: ['AccessDenied', 'Request has expired'] };
    return { ok: true };
  }
  const m = auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/);
  if (!m) return { error: ['AuthorizationHeaderMalformed', 'bad Authorization header'] };
  const [, ak, scope, signedHeaders, signature] = m;
  if (ak !== AK) return { error: ['InvalidAccessKeyId', 'unknown access key'] };
  const declared = req.headers['x-amz-content-sha256'];
  if (!declared) return { error: ['MissingSecurityHeader', 'x-amz-content-sha256'] };
  if (declared !== 'UNSIGNED-PAYLOAD' && declared !== sha256hex(body)) return { error: ['XAmzContentSHA256Mismatch', 'body hash mismatch'] };
  const amzDate = req.headers['x-amz-date'];
  if (Math.abs(Date.now() - amzTime(amzDate)) > 15 * 60_000) return { error: ['RequestTimeTooSkewed', 'clock skew > 15 min'] };
  const ch = signedHeaders.split(';').map(n => n + ':' + String(n === 'host' ? req.headers.host || '' : req.headers[n] == null ? '' : req.headers[n]).trim().replace(/\s+/g, ' ') + '\n').join('');
  const cr = [req.method, canonicalUri(url.pathname), canonicalQuery(url.searchParams), ch, signedHeaders, declared].join('\n');
  const [ds, rg, svc] = scope.split('/');
  /* a real provider has ONE region: a request signed for another one is refused (S3_REGION, optional) */
  if (REGION && rg !== REGION) return { error: ['AuthorizationHeaderMalformed', `the region '${rg}' is wrong; expecting '${REGION}'`] };
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(cr)].join('\n');
  const want = crypto.createHmac('sha256', signingKey(SK, ds, rg, svc)).update(sts).digest('hex');
  if (want !== signature) return { error: ['SignatureDoesNotMatch', 'header signature mismatch'] };
  return { ok: true };
}

function handle(req, res, body) {
  const url = new URL(req.url, 'http://s3.local');
  stats.requests++; stats.by_method[req.method] = (stats.by_method[req.method] || 0) + 1; stats.bytes_in += body.length;
  if (url.pathname === '/__stats') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(stats)); }
  if (url.pathname === '/__health') { res.writeHead(200); return res.end('ok'); }
  const parts = url.pathname.replace(/^\//, '').split('/');
  const b = decodeURIComponent(parts.shift() || '');
  const key = parts.map(decodeURIComponent).join('/');
  const v = verify(req, url, body);
  if (v.error) { stats.rejected++; return xmlErr(res, 403, v.error[0], v.error[1]); }
  if (v.anonymous) {
    /* Arvan: only public-read objects are readable without a signature */
    const meta = b && key ? metaOf(b, key) : null;
    if ((req.method === 'GET' || req.method === 'HEAD') && meta && meta.acl === 'public-read') {
      stats.anonymous_ok++;
      const data = bodyOf(b, key);
      res.writeHead(200, { 'content-type': meta.type, 'content-length': data.length, etag: '"' + meta.etag + '"', 'last-modified': new Date(meta.mtime).toUTCString() });
      stats.bytes_out += req.method === 'GET' ? data.length : 0;
      return res.end(req.method === 'GET' ? data : undefined);
    }
    stats.anonymous_denied++;
    return xmlErr(res, 403, 'AccessDenied', 'Access Denied');
  }
  if (!b) {
    if (req.method !== 'GET') return xmlErr(res, 405, 'MethodNotAllowed');
    res.writeHead(200, { 'content-type': 'application/xml' });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult><Owner><ID>sim</ID></Owner><Buckets><Bucket><Name>${esc(BUCKET)}</Name><CreationDate>${stats.started}</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>`);
  }
  if (b !== BUCKET) return xmlErr(res, 404, 'NoSuchBucket', 'The specified bucket does not exist');
  if (!key) {
    if (url.searchParams.has('cors') || url.searchParams.has('acl') || url.searchParams.has('policy')) {
      if (req.method === 'PUT') { res.writeHead(200); return res.end(); }
      return xmlErr(res, 404, 'NoSuchCORSConfiguration');
    }
    if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
    if (req.method !== 'GET') return xmlErr(res, 405, 'MethodNotAllowed');
    const prefix = url.searchParams.get('prefix') || '';
    const max = Math.min(1000, Number(url.searchParams.get('max-keys') || 1000));
    const after = url.searchParams.get('continuation-token') || url.searchParams.get('start-after') || '';
    const all = listMetas(b).filter(m => m.key.startsWith(prefix) && (!after || m.key > after));
    const page = all.slice(0, max);
    const trunc = all.length > page.length;
    res.writeHead(200, { 'content-type': 'application/xml' });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${esc(b)}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${trunc}</IsTruncated>` +
      (trunc ? `<NextContinuationToken>${esc(page[page.length - 1].key)}</NextContinuationToken>` : '') +
      page.map(m => `<Contents><Key>${esc(m.key)}</Key><LastModified>${new Date(m.mtime).toISOString()}</LastModified><ETag>"${m.etag}"</ETag><Size>${m.size}</Size></Contents>`).join('') +
      '</ListBucketResult>');
  }
  if (req.method === 'PUT') {
    const meta = putObj(b, key, body, req.headers['content-type'], req.headers['x-amz-acl']);
    res.writeHead(200, { etag: '"' + meta.etag + '"' });
    return res.end();
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const meta = metaOf(b, key);
    if (!meta) return req.method === 'HEAD' ? (res.writeHead(404), res.end()) : xmlErr(res, 404, 'NoSuchKey', 'The specified key does not exist.');
    const data = bodyOf(b, key);
    res.writeHead(200, { 'content-type': meta.type, 'content-length': data.length, etag: '"' + meta.etag + '"', 'last-modified': new Date(meta.mtime).toUTCString() });
    stats.bytes_out += req.method === 'GET' ? data.length : 0;
    return res.end(req.method === 'GET' ? data : undefined);
  }
  if (req.method === 'DELETE') { delObj(b, key); res.writeHead(204); return res.end(); }
  return xmlErr(res, 405, 'MethodNotAllowed');
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const go = () => { try { handle(req, res, body); } catch (e) { xmlErr(res, 500, 'InternalError', String(e.message || e)); } };
    if (LATENCY > 0) setTimeout(go, LATENCY); else go();
  });
});
if (require.main === module) {
  ensureBucket(BUCKET);
  server.listen(PORT, '0.0.0.0', () => console.log(`s3-lite listening :${PORT} bucket=${BUCKET} latency=${LATENCY}ms dir=${DIR}`));
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(() => process.exit(0)));
}
module.exports = { server };
