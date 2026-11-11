'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Structured JSON logging without PII (row 85)

   Every line is a single JSON object:
     {"ts":…,"level":…,"service":…,"event":…,"request_id":…,"school_id":…, …}

   Two independent safety layers. Both must hold before a line is written:
     1) Allowlist of keys. Any field whose name is not in SAFE_KEYS is dropped,
        and the line records only the count (`dropped_keys`), never the name or
        value. A caller cannot log `body`, `phone`, `national_code` or `name`
        by accident, because those keys never reach stdout.
     2) Value redaction. Every string that does get through (path, error
        message, detail) is scrubbed for patterns that look like PII or
        secrets: an Iranian national code (10 digits), a mobile number, an
        email, a Bearer token or JWT, and long hex/base64 secrets. Persian and
        Arabic-Indic digits are normalised first, so "۰۰۱۲۳۴۵۶۷۸" cannot slip
        past a regex that only knows ASCII digits.

   scanPii(text) is the same detector, exported for the negative gate
   (tools/log-pii-scan-85.mjs, tests/observability-85.js). If a log line
   carries PII, the gate turns red.

   Out of scope: request bodies are never logged at all (not even redacted).
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');

const SERVICE = process.env.PAYESH_SERVICE_NAME || 'payesh-local';

/* Keys that may appear in a log line. Nothing identifies a person: ids are
   opaque (request/school/tenant), and the rest are counts, codes or durations. */
const SAFE_KEYS = new Set([
  'ts', 'level', 'service', 'event', 'instance',
  'request_id', 'school_id', 'auth', 'role',
  'method', 'path', 'route', 'status', 'ms', 'bytes',
  'error', 'error_code', 'detail', 'component',
  'count', 'reason', 'signal', 'inflight', 'timeout_ms', 'port', 'host', 'configured',
  'version', 'dropped_keys', 'redactions',
]);

/* ── digit normalisation (Persian ۰-۹ U+06F0, Arabic-Indic ٠-٩ U+0660) ── */
function normDigits(s) {
  return String(s).replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660));
}

/* Order matters: the more specific secrets go first, so a JWT is not
   half-eaten by the hex rule. */
const PATTERNS = [
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  /* mobile: 09xxxxxxxxx, +989xxxxxxxxx, 00989xxxxxxxxx, 989xxxxxxxxx */
  { kind: 'phone', re: /(?<![0-9A-Za-z])(?:\+98|0098|98|0)9[0-9]{9}(?![0-9A-Za-z])/g },
  /* national code: exactly 10 digits, also with dashes 3-6-1 */
  { kind: 'national_code', re: /(?<![0-9A-Za-z])[0-9]{3}-?[0-9]{6}-?[0-9](?![0-9A-Za-z])/g },
  /* long secrets: ≥32 hex or ≥40 base64url-ish characters */
  { kind: 'secret', re: /(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])/g },
  { kind: 'secret', re: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g },
  /* key=value pairs whose key names PII or a secret (e.g. a query string in an error message) */
  { kind: 'kv', re: /\b(?:password|passwd|pass|token|secret|code|national_code|nationalcode|phone|mobile|email|name|first_name|last_name)=([^&\s"']+)/gi },
];

/* digit rules are bounded by non-alphanumerics, so the 12-hex tail of a
   uuid (e.g. …-0123456789ab) is not mistaken for a national code. */

function redactString(s) {
  let out = normDigits(s);
  let n = 0;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (m) => { n++; return p.kind === 'kv' ? m.split('=')[0] + '=[' + p.kind + ']' : '[' + p.kind + ']'; });
  }
  return { text: out, n };
}

/* scanPii — same detector, read-only: returns the hits (kind + offset, never
   the value itself, so the gate's own report does not leak). */
function scanPii(text) {
  const src = normDigits(text);
  const hits = [];
  for (const p of PATTERNS) {
    let m;
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    while ((m = re.exec(src))) {
      /* the redaction markers themselves are not PII */
      if (p.kind === 'kv' && /^\[[a-z_]+\]$/.test(m[1] || '')) continue;
      hits.push({ kind: p.kind, at: m.index });
    }
  }
  return hits;
}

const RESERVED = new Set(['ts', 'level', 'service', 'event']);

function cleanValue(v, budget) {
  if (v == null) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const r = redactString(v.slice(0, 300));
    budget.n += r.n;
    return r.text;
  }
  /* objects/arrays are never logged verbatim — only their size */
  return '[object]';
}

/* build — pure function (exported for tests): fields → safe JSON object */
function build(level, event, fields) {
  const out = { ts: new Date().toISOString(), level, service: SERVICE, event: String(event || 'log') };
  const budget = { n: 0 };
  let dropped = 0;
  for (const [k, v] of Object.entries(fields || {})) {
    if (RESERVED.has(k)) continue;              /* callers cannot forge ts/level/service/event */
    if (!SAFE_KEYS.has(k)) { dropped++; continue; }
    out[k] = cleanValue(v, budget);
  }
  if (dropped) out.dropped_keys = dropped;
  if (budget.n) out.redactions = budget.n;
  return out;
}

function enabled() { return process.env.PAYESH_LOG !== '0'; }

function write(level, event, fields) {
  /* PAYESH_LOG=0 silences info/warn (tests, quiet mode); errors always reach stderr */
  if (level !== 'error' && !enabled()) return null;
  const obj = build(level, event, fields);
  try {
    const line = JSON.stringify(obj) + '\n';
    if (level === 'error') process.stderr.write(line); else process.stdout.write(line);
  } catch (e) { /* logging must never throw into the request path */ }
  return obj;
}

/* ── request id ─────────────────────────────────────────────────────
   An incoming X-Request-Id is honoured only when it is short and opaque
   ([A-Za-z0-9._-], 8..64). Anything else (too long, spaces, a phone number
   pasted by a proxy) is replaced, so the header cannot smuggle PII into logs. */
const RID_RE = /^[A-Za-z0-9._-]{8,64}$/;
function requestId(headers) {
  const h = String((headers && headers['x-request-id']) || '').trim();
  if (RID_RE.test(h) && scanPii(h).length === 0) return h;
  return crypto.randomUUID();
}

/* path only, never the query string; ids inside the path are kept (they are
   opaque row ids), but the redactor still runs over it. */
function pathOnly(rawUrl) {
  return String(rawUrl || '').split('?')[0].slice(0, 160);
}

module.exports = {
  SAFE_KEYS, PATTERNS, SERVICE,
  normDigits, redactString, scanPii, build, requestId, pathOnly,
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
};
