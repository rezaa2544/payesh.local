#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 173 — HTTPS front door of the Docker simulation.
   Production has HTTPS in front of the central server (serv00 Passenger /
   app.payeshschool.ir) and of the bucket (ArvanCloud); the servers refuse a
   plain-http central or bucket that is not on the same machine. This front
   terminates TLS with a simulation-only CA (tools/sim/run-sim.ps1 makes it;
   every container trusts it through NODE_EXTRA_CA_CERTS) and forwards by Host:
     ROUTES="central.sim=central:8080,s3.sim=s3:9000"
   The Host header is passed unchanged (S3 SigV4 signs it); X-Forwarded-For
   and X-Forwarded-Proto are added like a real reverse proxy.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const http = require('http');
const https = require('https');

const routes = new Map();
for (const part of String(process.env.ROUTES || '').split(/[\s,]+/).filter(Boolean)) {
  const [host, target] = part.split('=');
  const [h, p] = String(target || '').split(':');
  if (host && h) routes.set(host.toLowerCase(), { host: h, port: Number(p || 80) });
}
const count = {};
const server = https.createServer({
  cert: fs.readFileSync(process.env.TLS_CERT || '/certs/front.crt'),
  key: fs.readFileSync(process.env.TLS_KEY || '/certs/front.key'),
}, (req, res) => {
  const name = String(req.headers.host || '').split(':')[0].toLowerCase();
  const r = routes.get(name);
  count[name] = (count[name] || 0) + 1;
  if (req.url === '/__front') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(count)); }
  if (!r) { res.writeHead(421); return res.end('unknown host'); }
  /* simulation only: X-Sim-Client-IP = «this request comes from that internet address» (the front
     plays the internet edge, so many devices can be emulated from one driver). Like nginx
     proxy_add_x_forwarded_for, whatever the client sent stays on the LEFT, the peer is appended. */
  const simIp = String(req.headers['x-sim-client-ip'] || '').trim();
  const peer = /^\d{1,3}(\.\d{1,3}){3}$/.test(simIp) ? simIp : req.socket.remoteAddress.replace('::ffff:', '');
  const xff = [req.headers['x-forwarded-for'], peer].filter(Boolean).join(', ');
  const fwd = Object.assign({}, req.headers, { 'x-forwarded-for': xff, 'x-forwarded-proto': 'https' });
  delete fwd['x-sim-client-ip'];
  const up = http.request({ host: r.host, port: r.port, method: req.method, path: req.url,
    headers: fwd }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.setTimeout(60_000, () => up.destroy(new Error('upstream timeout')));
  up.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end('bad gateway: ' + e.message); });
  req.pipe(up);
});
/* like nginx (keepalive_timeout 75s): node's 5 s default races the client's idle keep-alive socket ⇒ ECONNRESET */
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;
server.listen(Number(process.env.PORT || 443), '0.0.0.0', () => console.log('tls-front up', [...routes.keys()].join(' ')));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(() => process.exit(0)));
