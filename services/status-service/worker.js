// Payesh status Worker — Cloudflare Workers free tier (no card, no sleep).
// Same contract as server.js (Render variant): holds NO school data, only
// reports health of the public endpoints. Deployed with Wrangler:
//   cd services/status-service && npx wrangler deploy
const TARGETS = [
  { name: 'site', url: 'https://payeshschool.ir/' },
  { name: 'web-app', url: 'https://app.payeshschool.ir/' },
  { name: 'school-servers', url: 'https://payeshschool.ir/payesh/pub/school-servers.json' },
];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function probe(t) {
  const started = Date.now();
  try {
    const res = await fetch(t.url, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
    return { name: t.name, ok: res.status === 200, status: res.status, ms: Date.now() - started };
  } catch {
    return { name: t.name, ok: false, status: 0, ms: Date.now() - started };
  }
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') return json({ ok: true, service: 'payesh-status', at: new Date().toISOString() });
    if (pathname === '/api/status') {
      const results = await Promise.all(TARGETS.map(probe));
      return json({ at: new Date().toISOString(), allOk: results.every(r => r.ok), results });
    }
    return json({ ok: false, error: 'not-found' }, 404);
  },
};
