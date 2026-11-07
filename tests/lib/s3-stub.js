'use strict';
/* ═══════════════════════════════════════════════════════════════════
   صندوقچهٔ S3 محلی با **بازبینی واقعی امضای SigV4** — ابزار آزمون ردیف ۵۳

   این فایل خودش یک «ذخیره‌ساز شیء سازگار با S3» کوچک است که:
     • امضای هدر Authorization را از صفر بازمحاسبه و مقایسه می‌کند
       (اگر امضای کلاینت غلط باشد، درخواست ۴۰۳ می‌گیرد)؛
     • هش محتوای اعلام‌شده را با هش واقعی بدنه مقایسه می‌کند؛
     • نشانی امضاشده (presigned) را بازبینی می‌کند و عمر آن را می‌سنجد.

   پیاده‌سازی بازبینی مستقل از client/lib/sigv4.js نوشته شده (فقط از
   crypto نود استفاده می‌کند) تا آزمون، خودش را تأیید نکند.
   ═══════════════════════════════════════════════════════════════════ */
const http = require('http');
const crypto = require('crypto');

function sha256hex(x) { return crypto.createHash('sha256').update(x).digest('hex'); }
function hmac(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); }

/* RFC3986 — همان قاعده‌ای که AWS می‌خواهد */
function uriEncode(str, keepSlash) {
  let out = '';
  const bytes = Buffer.from(String(str), 'utf8');
  for (const c of bytes) {
    const ch = String.fromCharCode(c);
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) ||
        ch === '-' || ch === '_' || ch === '.' || ch === '~' || (keepSlash && ch === '/')) out += ch;
    else out += '%' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase();
  }
  return out;
}

function canonicalUriOf(rawPath) {
  const bare = rawPath.split('?')[0];
  return bare.split('/').map(p => uriEncode(decodeURIComponent(p), false)).join('/') || '/';
}

function canonicalQueryOf(searchParams, skip = []) {
  const pairs = [];
  for (const [k, v] of searchParams.entries()) {
    if (skip.includes(k)) continue;
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs.map(([k, v]) => uriEncode(k) + '=' + uriEncode(v)).join('&');
}

function signingKey(secret, datestamp, region, service) {
  let k = hmac('AWS4' + secret, datestamp);
  k = hmac(k, region);
  k = hmac(k, service);
  return hmac(k, 'aws4_request');
}

function parseAmzDate(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

function startStub({ accessKey = 'test-ak', secret = 'test-sk', region = 'us-east-1', bucket = 'payesh-test' } = {}) {
  const objects = new Map();
  const counters = { verified: 0, rejected: 0, expired: 0, presigned_ok: 0, body_hash_mismatch: 0 };
  const log = [];

  function reject(res, code, message) {
    counters.rejected++;
    log.push({ code, message });
    res.writeHead(403, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const pathParts = url.pathname.replace(/^\//, '').split('/');
      const reqBucket = pathParts.shift();
      const key = decodeURIComponent(pathParts.join('/'));

      /* ── مسیر ۱: نشانی امضاشده (بدون هدر Authorization) ── */
      if (!req.headers.authorization) {
        const sig = url.searchParams.get('X-Amz-Signature');
        if (!sig) { counters.rejected++; log.push({ code: 'unsigned', key }); res.writeHead(403); return res.end('unsigned'); }
        const algorithm = url.searchParams.get('X-Amz-Algorithm');
        const credential = url.searchParams.get('X-Amz-Credential') || '';
        const amzDate = url.searchParams.get('X-Amz-Date');
        const expires = Number(url.searchParams.get('X-Amz-Expires'));
        const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders') || '';
        if (algorithm !== 'AWS4-HMAC-SHA256') return reject(res, 'BadAlgorithm', algorithm);
        const [ak, ds, rg, svc] = credential.split('/');
        if (ak !== accessKey) return reject(res, 'BadAccessKey', ak);
        const canonicalQuery = canonicalQueryOf(url.searchParams, ['X-Amz-Signature']);
        const canonicalRequest = [
          req.method, canonicalUriOf(url.pathname), canonicalQuery,
          'host:' + (req.headers.host || '') + '\n', signedHeaders, 'UNSIGNED-PAYLOAD',
        ].join('\n');
        const scope = ds + '/' + rg + '/' + svc + '/aws4_request';
        const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
        const expected = crypto.createHmac('sha256', signingKey(secret, ds, rg, svc)).update(stringToSign).digest('hex');
        if (expected !== sig) return reject(res, 'SignatureDoesNotMatch', 'presigned signature mismatch');
        const t = parseAmzDate(amzDate);
        if (!t) return reject(res, 'BadDate', amzDate);
        const ageSec = (Date.now() - t.getTime()) / 1000;
        if (ageSec > expires) { counters.expired++; return reject(res, 'AccessDenied', 'Request has expired'); }
        counters.verified++;
        counters.presigned_ok++;
        if (req.method === 'GET') {
          if (!objects.has(key)) { res.writeHead(404); return res.end('no key'); }
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(objects.get(key));
        }
        return reject(res, 'MethodNotAllowed', req.method);
      }

      /* ── مسیر ۲: امضای هدر ── */
      const auth = req.headers.authorization;
      const m = auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/);
      if (!m) return reject(res, 'MalformedAuth', auth.slice(0, 80));
      const [, ak, scope, signedHeaders, signature] = m;
      const [ds, rg, svc] = scope.split('/');
      if (ak !== accessKey) return reject(res, 'BadAccessKey', ak);

      const amzDate = req.headers['x-amz-date'];
      const declaredHash = req.headers['x-amz-content-sha256'];
      if (!declaredHash) return reject(res, 'MissingContentSha', 'x-amz-content-sha256');
      const actualHash = sha256hex(body);
      if (declaredHash !== actualHash) {
        counters.body_hash_mismatch++;
        return reject(res, 'XAmzContentSHA256Mismatch', declaredHash + ' != ' + actualHash);
      }

      const names = signedHeaders.split(';');
      const canonicalHeaders = names.map(n => {
        const v = n === 'host' ? (req.headers.host || '') : (req.headers[n] == null ? '' : String(req.headers[n]));
        return n + ':' + v.trim() + '\n';
      }).join('');
      const canonicalRequest = [
        req.method,
        canonicalUriOf(url.pathname),
        canonicalQueryOf(url.searchParams),
        canonicalHeaders,
        signedHeaders,
        declaredHash,
      ].join('\n');
      const stringToSign = ['AWS4-HMAC-SHA256', amzDate, ds + '/' + rg + '/' + svc + '/aws4_request', sha256hex(canonicalRequest)].join('\n');
      const expected = crypto.createHmac('sha256', signingKey(secret, ds, rg, svc)).update(stringToSign).digest('hex');
      if (expected !== signature) return reject(res, 'SignatureDoesNotMatch', 'header signature mismatch');
      counters.verified++;

      if (reqBucket !== bucket) return reject(res, 'NoSuchBucket', reqBucket);

      if (req.method === 'PUT') {
        objects.set(key, body.toString('utf8'));
        res.writeHead(200, { etag: '"' + sha256hex(body).slice(0, 16) + '"' });
        return res.end();
      }
      if (req.method === 'GET') {
        if (!objects.has(key)) { res.writeHead(404); return res.end('no key'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(objects.get(key));
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(405); res.end();
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        endpoint: 'http://127.0.0.1:' + port,
        bucket, accessKey, secret, region,
        objects, counters, log,
        cfg: { endpoint: 'http://127.0.0.1:' + port, bucket, accessKey, secret, region, prefix: 'payesh/', pathStyle: true },
        close: () => new Promise(r => server.close(r)),
        /* برای آزمون دستکاری: نوشتن مستقیم شیء بدون امضا */
        poke: (k, v) => objects.set(k, v),
      });
    });
  });
}

module.exports = { startStub, uriEncode, sha256hex };
