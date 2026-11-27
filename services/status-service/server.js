// Payesh status service for Render free tier.
// Tiny, dependency-free, holds NO project/school data. It only reports the
// health of the public endpoints so the app/site can show a live status and
// external uptime tools have a Render-side heartbeat. Sleeps when idle on
// the free plan (~1 min cold start) by design.
import http from 'node:http';

const TARGETS = [
  { name: 'site', url: 'https://payeshschool.ir/' },
  { name: 'web-app', url: 'https://app.payeshschool.ir/' },
  { name: 'school-servers', url: 'https://payeshschool.ir/payesh/pub/school-servers.json' },
];
let cache = { at: 0, body: null };
const CACHE_MS = 60_000;

async function probe(t) {
  const started = Date.now();
  try {
    const res = await fetch(t.url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
    return { name: t.name, ok: res.status === 200, status: res.status, ms: Date.now() - started };
  } catch {
    return { name: t.name, ok: false, status: 0, ms: Date.now() - started };
  }
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (req.url === '/health') return send(200, { ok: true, service: 'payesh-status', at: new Date().toISOString() });
  if (req.url === '/api/status') {
    if (Date.now() - cache.at > CACHE_MS || !cache.body) {
      const results = [];
      for (const t of TARGETS) results.push(await probe(t));
      cache = { at: Date.now(), body: { at: new Date().toISOString(), allOk: results.every(r => r.ok), results } };
    }
    return send(200, cache.body);
  }
  return send(404, { ok: false, error: 'not-found' });
});

server.listen(process.env.PORT || 8080, () => console.log('payesh-status listening'));
