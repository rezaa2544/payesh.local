/* ═══════════════════════════════════════════════════════════════════
   سرویس‌ورکر پایش-لوکال
   • شل برنامه را کش می‌کند تا آفلاین باز شود
   • آپدیت را «فقط با فایل‌های تغییرکرده» می‌گیرد (delta)
   • API هرگز کش نمی‌شود
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const CACHE = 'payesh-app-v1';
const VERSION_KEY = '/__payesh_version';
const SHELL = ['/', '/index.html', '/app.js', '/pages.js', '/styles.css', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async url => {
      try { await cache.add(new Request(url, { cache: 'reload' })); } catch (e) { /* noop */ }
    }));
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      const j = await r.json();
      await cache.put(VERSION_KEY, new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } }));
    } catch (e) { /* noop */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;            /* API: همیشه شبکه */

  if (req.method !== 'GET') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: false });
    if (cached) {
      /* stale-while-revalidate: پاسخ سریع + تازه‌سازی پس‌زمینه */
      event.waitUntil((async () => {
        try {
          const fresh = await fetch(req, { cache: 'no-cache' });
          if (fresh && fresh.ok) await cache.put(req, fresh.clone());
        } catch (e) { /* آفلاین */ }
      })());
      return cached;
    }
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok && (req.mode === 'navigate' || /\.(js|css|png|webmanifest)$/.test(url.pathname))) {
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (e) {
      if (req.mode === 'navigate') {
        const fallback = await cache.match('/index.html');
        if (fallback) return fallback;
      }
      return new Response(JSON.stringify({ ok: false, offline: true }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
  })());
});

/* ── دریافت دلتا ─────────────────────────────────────────────────── */
async function currentVersion(cache) {
  try {
    const r = await cache.match(VERSION_KEY);
    if (!r) return '0.0.0';
    const j = await r.json();
    return j.version || '0.0.0';
  } catch (e) { return '0.0.0'; }
}

async function applyDelta(reload) {
  const cache = await caches.open(CACHE);
  const cur = await currentVersion(cache);
  const res = await fetch('/api/update/check?current=' + encodeURIComponent(cur), { cache: 'no-store' });
  if (!res.ok) throw new Error('update_check_failed');
  const info = await res.json();
  if (info.up_to_date) {
    notify({ type: 'UPDATE_DONE', up_to_date: true, version: info.version });
    if (reload) notify({ type: 'UPDATE_READY', reload: true, version: info.version });
    return;
  }
  const changed = info.changed || [];
  /* دانلود موازی با سقف ۴ هم‌زمان */
  let i = 0;
  const workers = Array.from({ length: Math.min(4, changed.length || 1) }, async () => {
    while (i < changed.length) {
      const f = changed[i++];
      try {
        const r = await fetch('/' + f.path + '?v=' + encodeURIComponent(info.version), { cache: 'no-store' });
        if (r.ok) await cache.put('/' + f.path, r.clone());
      } catch (e) { /* فایل بعدی */ }
    }
  });
  await Promise.all(workers);
  for (const removed of info.removed || []) {
    try { await cache.delete('/' + removed); } catch (e) { /* noop */ }
  }
  const payload = { version: info.version, built_at: info.built_at };
  await cache.put(VERSION_KEY, new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }));
  notify({ type: 'UPDATE_DONE', version: info.version, changed: changed.length, bytes: info.total_size || 0 });
  notify({ type: 'UPDATE_READY', version: info.version, reload: !!reload });
}

function notify(msg) {
  self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(cs => cs.forEach(c => c.postMessage(msg)));
}

self.addEventListener('message', event => {
  const d = event.data || {};
  if (d.type === 'CHECK_UPDATE') {
    event.waitUntil(applyDelta(!!d.reload).catch(err => notify({ type: 'UPDATE_FAILED', error: String(err.message || err) })));
  }
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
});
