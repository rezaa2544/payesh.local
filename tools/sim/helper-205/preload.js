'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 205 — measuring probe loaded with `node -r` into the REAL school server
   (and into the helper replica). It changes no behaviour; it only counts:
     • every SQLite statement the server runs (node:sqlite StatementSync
       run/get/all/iterate + DatabaseSync.exec) and the time spent in them;
     • every outgoing HTTP(S) request (the bucket = «دیتابیس» of the owner panel),
       by method and by area of the key (jobs/, helpers/, control/, mirror, …).
   The totals are written every second to $PROBE_OUT (JSON), read by the driver.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const http = require('http');
const https = require('https');

const OUT = process.env.PROBE_OUT || '/out/probe.json';
const c = {
  pid: process.pid,
  sql: { statements: 0, exec: 0, ms: 0, reads: 0, writes: 0 },
  net: { total: 0, by_method: {}, by_area: {} },
  at: 0,
};

/* ── SQLite ─────────────────────────────────────────────────────────── */
try {
  const sqlite = require('node:sqlite');
  const S = sqlite.StatementSync && sqlite.StatementSync.prototype;
  const timed = (fn, kind) => function (...a) {
    const t = process.hrtime.bigint();
    try { return fn.apply(this, a); } finally {
      c.sql.ms += Number(process.hrtime.bigint() - t) / 1e6;
      c.sql.statements++;
      if (kind === 'w') c.sql.writes++; else c.sql.reads++;
    }
  };
  if (S) {
    for (const [m, kind] of [['run', 'w'], ['get', 'r'], ['all', 'r'], ['iterate', 'r']]) {
      if (typeof S[m] === 'function') S[m] = timed(S[m], kind);
    }
  }
  const D = sqlite.DatabaseSync && sqlite.DatabaseSync.prototype;
  if (D && typeof D.exec === 'function') {
    const ex = D.exec;
    D.exec = function (...a) {
      const t = process.hrtime.bigint();
      try { return ex.apply(this, a); } finally {
        c.sql.ms += Number(process.hrtime.bigint() - t) / 1e6;
        c.sql.exec++;
      }
    };
  }
} catch (e) { /* no node:sqlite in this process */ }

/* ── outgoing HTTP(S) (the bucket) ──────────────────────────────────── */
function areaOf(path) {
  let p = String(path || '').split('?')[0];
  const q = String(path || '').includes('list-type=2') ? 'list:' : '';
  if (q) { const m = /[?&]prefix=([^&]*)/.exec(String(path)); p = '/b/' + (m ? decodeURIComponent(m[1]) : ''); }
  const keyPath = `${p}/`;
  const m = /\/payesh\/([^/]+)\/(?:([^/]+)\/)?/.exec(keyPath);
  if (!m) return q + (p.length > 1 ? 'other' : 'root');
  if (m[1] === 'jobs' || m[1] === 'outbox') return q + m[1] + '/' + (m[2] || '');
  return q + m[1] + '/';
}
function wrap(mod) {
  const orig = mod.request;
  mod.request = function (...args) {
    try {
      const a = args[0];
      const o = typeof a === 'string' || a instanceof URL ? new URL(String(a)) : a || {};
      const opts = args[1] && typeof args[1] === 'object' && !(args[1] instanceof Function) ? args[1] : {};
      const method = String(opts.method || o.method || 'GET').toUpperCase();
      const host = String(o.hostname || o.host || '');
      const port = String(o.port || '');
      const path = (o.pathname || o.path || '') + (o.search || '');
      /* everything except calls to the school server itself (port 8080) */
      if (host && port !== String(process.env.SELF_PORT || '8080')) {
        c.net.total++;
        c.net.by_method[method] = (c.net.by_method[method] || 0) + 1;
        const k = method + ' ' + areaOf(path);
        c.net.by_area[k] = (c.net.by_area[k] || 0) + 1;
      }
    } catch (e) { /* counting must never break a request */ }
    return orig.apply(this, args);
  };
}
wrap(http);
wrap(https);

/* ── totals to disk ─────────────────────────────────────────────────── */
function flush() {
  c.at = Date.now();
  c.cpu = process.cpuUsage();
  try { fs.writeFileSync(OUT + '.tmp', JSON.stringify(c)); fs.renameSync(OUT + '.tmp', OUT); } catch (e) { /* next time */ }
}
setInterval(flush, 1000).unref();
process.on('exit', flush);
