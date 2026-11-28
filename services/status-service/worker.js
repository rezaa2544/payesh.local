// Payesh status + Helper executor — Cloudflare Workers free tier (no card, no sleep).
// - GET /health, /api/status: public endpoint health (no school data).
// - scheduled (cron): Helper executor class "cloudflare" for the Arvan-bucket
//   job queue (rows 205/206/210). Configured ONLY via Worker secrets:
//   HELPER_S3_ENDPOINT, HELPER_S3_BUCKET, HELPER_S3_ACCESS_KEY,
//   HELPER_S3_SECRET_KEY, HELPER_BOX_SECRET (bucket secret for seal/open).
//   Without them the executor stays off and status reports configured:false.
// Contract = server/helper-jobs.js v1 envelope + v2 plain fields:
//   key=HKDF-SHA256(utf8(secret), salt="payesh/helper-jobs", info="v1", 32),
//   AES-256-GCM, AAD="<kind>/v1/<rev>", keys payesh/helpers|jobs/req|lease|res.
const TARGETS = [
  { name: 'site', url: 'https://payeshschool.ir/' },
  { name: 'web-app', url: 'https://app.payeshschool.ir/' },
  { name: 'school-servers', url: 'https://payeshschool.ir/payesh/pub/school-servers.json' },
];
const HELPER_ID = 'cf00000000000001';
const KINDS = ['storage.usage', 'object.verify', 'endpoint.check', 'bucket.gc'];
const LEASE_MS = 60000;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
async function probe(t) {
  const started = Date.now();
  try {
    const res = await fetch(t.url, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
    return { name: t.name, ok: res.status === 200, status: res.status, ms: Date.now() - started };
  } catch { return { name: t.name, ok: false, status: 0, ms: Date.now() - started }; }
}

/* ── crypto (byte-identical to Node seal/open) ─────────────────────── */
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64u(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function boxKey(secret) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(secret)), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('payesh/helper-jobs'), info: enc.encode('v1') }, base, 256);
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(secret, kind, rev, plainText) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await boxKey(secret);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: enc.encode(`${kind}/v1/${rev}`) }, key, enc.encode(plainText));
  return { v: 1, kind, rev, alg: 'HKDF-SHA256/A256GCM', nonce: b64u(nonce), ct: b64u(ct) };
}
async function openBox(secret, kind, env) {
  if (!env || env.v !== 1 || env.kind !== kind) throw new Error('bad_format');
  const all = unb64u(env.ct);
  const key = await boxKey(secret);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(env.nonce), additionalData: enc.encode(`${kind}/v1/${env.rev}`) }, key,
    all); // WebCrypto expects tag appended — Node ct already is body||tag
  const plain = JSON.parse(new TextDecoder().decode(pt));
  if (plain.v !== 1 && plain.v !== 2) throw new Error('bad_plain');
  return plain;
}

/* ── minimal S3 (SigV4, path style) ────────────────────────────────── */
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256hex(text) {
  return hexOf(await crypto.subtle.digest('SHA-256', typeof text === 'string' ? enc.encode(text) : text));
}
function s3cfg(env) {
  if (!env.HELPER_S3_ENDPOINT || !env.HELPER_S3_BUCKET || !env.HELPER_S3_ACCESS_KEY || !env.HELPER_S3_SECRET_KEY || !env.HELPER_BOX_SECRET) return null;
  return { endpoint: env.HELPER_S3_ENDPOINT.replace(/\/+$/, ''), bucket: env.HELPER_S3_BUCKET,
    ak: env.HELPER_S3_ACCESS_KEY, sk: env.HELPER_S3_SECRET_KEY, region: env.HELPER_S3_REGION || 'ir-central1',
    secret: env.HELPER_BOX_SECRET, prefix: env.HELPER_PREFIX || 'payesh/' };
}
async function s3(env, cfg, method, key, body) {
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${key}`);
  const now = new Date();
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amz.slice(0, 8);
  const payloadHash = await sha256hex(body || '');
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amz };
  const signed = Object.keys(headers).sort();
  const canon = `${method}\n${url.pathname}\n${url.searchParams.toString()}\n` +
    signed.map((h) => `${h}:${headers[h]}\n`).join('') + `\n${signed.join(';')}\n${payloadHash}`;
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const sts = `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${await sha256hex(canon)}`;
  let k = await hmac(enc.encode('AWS4' + cfg.sk), date);
  k = await hmac(k, cfg.region); k = await hmac(k, 's3'); k = await hmac(k, 'aws4_request');
  const sig = hexOf(await hmac(k, sts));
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${cfg.ak}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${sig}`;
  return fetch(url, { method, headers, body: body || undefined });
}
const s3get = async (env, cfg, key) => {
  const r = await s3(env, cfg, 'GET', key);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('s3_' + r.status);
  return r.text();
};
const s3put = async (env, cfg, key, text) => {
  const r = await s3(env, cfg, 'PUT', key, text);
  if (!r.ok) throw new Error('s3_put_' + r.status);
};
const s3del = async (env, cfg, key) => { await s3(env, cfg, 'DELETE', key).catch(() => {}); };
async function s3list(env, cfg, prefix) {
  const keys = [];
  let token = '';
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${cfg.endpoint}/${cfg.bucket}`);
    url.searchParams.set('list-type', '2'); url.searchParams.set('prefix', prefix);
    if (token) url.searchParams.set('continuation-token', token);
    // sign manually with query
    const saved = cfg.endpoint;
    const r = await (async () => {
      const now = new Date(); const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); const date = amz.slice(0, 8);
      const payloadHash = await sha256hex('');
      const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amz };
      const signed = Object.keys(headers).sort();
      const q = [...url.searchParams.entries()].sort().map(([a, b]) => `${encodeURIComponent(a)}=${encodeURIComponent(b)}`).join('&');
      const canon = `GET\n${url.pathname}\n${q}\n` + signed.map((h) => `${h}:${headers[h]}\n`).join('') + `\n${signed.join(';')}\n${payloadHash}`;
      const scope = `${date}/${cfg.region}/s3/aws4_request`;
      const sts = `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${await sha256hex(canon)}`;
      let k = await hmac(enc.encode('AWS4' + cfg.sk), date); k = await hmac(k, cfg.region); k = await hmac(k, 's3'); k = await hmac(k, 'aws4_request');
      headers.Authorization = `AWS4-HMAC-SHA256 Credential=${cfg.ak}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${hexOf(await hmac(k, sts))}`;
      return fetch(`${url.origin}${url.pathname}?${q}`, { headers });
    })();
    cfg.endpoint = saved;
    if (!r.ok) throw new Error('s3_list_' + r.status);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Contents><Key>([^<]+)<\/Key><Size>(\d+)<\/Size>/g)) keys.push({ key: m[1], size: Number(m[2]) });
    const trunc = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const nt = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!trunc || !nt) break;
    token = nt[1];
  }
  return keys;
}
const readPlain = async (env, cfg, key, kind) => {
  const text = await s3get(env, cfg, key);
  if (!text) return null;
  try { return await openBox(cfg.secret, kind, JSON.parse(text)); } catch { return null; }
};
const writePlain = async (env, cfg, key, kind, rev, plain) =>
  s3put(env, cfg, key, JSON.stringify(await seal(cfg.secret, kind, rev, JSON.stringify(plain))));

function isPrivateHost(host) {
  return host === 'localhost' || /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(host);
}
async function runJob(env, cfg, kind, params) {
  if (kind === 'endpoint.check') {
    const u = new URL(String(params.url || ''));
    if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) return { reachable: false, error: 'private_address' };
    const t0 = Date.now();
    try {
      const r = await fetch(u, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) });
      return { reachable: r.status < 500, status: r.status, ms: Date.now() - t0 };
    } catch { return { reachable: false, error: 'network', ms: Date.now() - t0 }; }
  }
  if (kind === 'storage.usage') {
    const prefix = String(params.prefix || cfg.prefix);
    if (!prefix.startsWith(cfg.prefix)) throw Object.assign(new Error('bad_params'), { code: 'bad_params' });
    const keys = await s3list(env, cfg, prefix);
    const groups = {}; let bytes = 0;
    for (const k of keys) {
      const rest = k.key.slice(prefix.length); const g = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : '(root)';
      groups[g] = groups[g] || { objects: 0, bytes: 0 }; groups[g].objects++; groups[g].bytes += k.size; bytes += k.size;
    }
    return { objects: keys.length, bytes, groups, truncated: false };
  }
  if (kind === 'object.verify') {
    const key = String(params.key || '');
    if (!key.startsWith(cfg.prefix)) throw Object.assign(new Error('bad_params'), { code: 'bad_params' });
    const r = await s3(env, cfg, 'GET', key);
    if (r.status === 404) return { exists: false, size: 0, sha256: null, match: params.sha256 || params.size !== undefined ? false : null };
    const buf = new Uint8Array(await r.arrayBuffer());
    const sha = await sha256hex(buf);
    const want = params.sha256 !== undefined || params.size !== undefined;
    return { exists: true, size: buf.length, sha256: sha,
      match: want ? ((params.sha256 === undefined || params.sha256 === sha) && (params.size === undefined || params.size === buf.length)) : null };
  }
  if (kind === 'bucket.gc') {
    let deleted = 0;
    for (const d of ['jobs/req/', 'jobs/lease/', 'jobs/res/']) {
      for (const k of await s3list(env, cfg, cfg.prefix + d)) {
        const id = k.key.split('/').pop().replace(/\.json$/, '');
        const at = Number(id.slice(0, 13));
        if (!/^[0-9]{13}-[0-9a-f]{16}$/.test(id) || Date.now() - at > 3600000) { await s3del(env, cfg, k.key); deleted++; }
      }
    }
    return { deleted_jobs: deleted, deleted_helpers: 0, deleted_blobs: 0 };
  }
  throw Object.assign(new Error('unknown_kind'), { code: 'unknown_kind' });
}

/* school-content / other-school jobs are never leased here (contract v2) */
const canLease = (req) => {
  if (!KINDS.includes(req.kind)) return false;
  const dc = req.data_class || 'internal';
  if (dc === 'school-content') return false;
  return true;
};

let counters = { done: 0, failed: 0, at: null };
async function executorTick(env) {
  const cfg = s3cfg(env);
  if (!cfg) return { configured: false };
  const now = Date.now();
  const P = cfg.prefix;
  await writePlain(env, cfg, `${P}helpers/${HELPER_ID}.json`, 'payesh-helper', now, {
    v: 2, helper_id: HELPER_ID, host: 'cloudflare-worker', app: 'payesh-status', version: 'dp-1',
    slots: 1, paused: false, kinds: KINDS, caps: KINDS, cls: 'cloudflare', capacity: 1,
    cpu_cap: null, region: 'cf', contract: '2', school_id: null, at: now, done: counters.done, failed: counters.failed,
  });
  const keys = await s3list(env, cfg, P + 'jobs/');
  const names = keys.map((k) => k.key.slice((P + 'jobs/').length));
  let claimed = 0;
  for (const n of names.filter((x) => x.startsWith('req/')).sort()) {
    if (claimed >= 3) break;
    const id = n.slice(4, -5);
    if (names.includes('res/' + id + '.json')) continue;
    const req = await readPlain(env, cfg, P + 'jobs/req/' + id + '.json', 'payesh-job');
    if (!req || req.job_id !== id || !canLease(req)) continue;
    if (req.deadline_at && Date.now() > req.deadline_at) continue;
    if (names.includes('lease/' + id + '.json')) {
      const lease = await readPlain(env, cfg, P + 'jobs/lease/' + id + '.json', 'payesh-job-lease');
      if (lease && Number(lease.until) > Date.now()) continue;
    }
    const token = hexOf(crypto.getRandomValues(new Uint8Array(8)));
    const putLease = () => writePlain(env, cfg, P + 'jobs/lease/' + id + '.json', 'payesh-job-lease', Date.now(),
      { v: 1, job_id: id, helper_id: HELPER_ID, token, until: Date.now() + LEASE_MS });
    await putLease();
    await new Promise((r) => setTimeout(r, 1500));
    const back = await readPlain(env, cfg, P + 'jobs/lease/' + id + '.json', 'payesh-job-lease');
    if (!back || back.token !== token) continue;
    claimed++;
    const started = Date.now();
    let result = null, error = null;
    try { result = await runJob(env, cfg, req.kind, req.params || {}); }
    catch (e) { error = e.code || 'failed'; }
    await writePlain(env, cfg, P + 'jobs/res/' + id + '.json', 'payesh-job-result', Date.now(), {
      v: 1, job_id: id, helper_id: HELPER_ID, ok: !error, result, error,
      idempotency_key: req.idempotency_key || id, started_at: started, finished_at: Date.now(),
    });
    if (error) counters.failed++; else counters.done++;
    counters.at = new Date().toISOString();
  }
  return { configured: true, claimed, ...counters };
}

async function helpersStatus(env) {
  const cfg = s3cfg(env);
  if (!cfg) return { configured: false };
  try {
    const keys = await s3list(env, cfg, cfg.prefix + 'jobs/');
    const count = (d) => keys.filter((k) => k.key.includes('/' + d + '/')).length;
    return { configured: true, executor: 'cloudflare', helper_id: HELPER_ID,
      queue: { pending: count('req'), leased: count('lease'), done: count('res') }, ...counters };
  } catch (e) { return { configured: true, error: 'unreachable' }; }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') return json({ ok: true, service: 'payesh-status', at: new Date().toISOString() });
    if (pathname === '/api/status') {
      const results = await Promise.all(TARGETS.map(probe));
      const helpers = await helpersStatus(env || {});
      return json({ at: new Date().toISOString(), allOk: results.every((r) => r.ok), results, helpers });
    }
    return json({ ok: false, error: 'not-found' }, 404);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(executorTick(env).catch(() => {}));
  },
};
