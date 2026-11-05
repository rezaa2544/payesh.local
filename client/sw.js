/* ═══════════════════════════════════════════════════════════════════
   سرویس‌ورکر پایش-لوکال
   • شل برنامه را کش می‌کند تا آفلاین باز شود
   • آپدیت را «فقط با فایل‌های تغییرکرده» می‌گیرد (delta)
   • API هرگز کش نمی‌شود
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const CACHE = 'payesh-app-v3';
const VERSION_KEY = '/__payesh_version';
const SHELL = ['/', '/index.html', '/app.js', '/pages.js', '/styles.css', '/manifest.webmanifest', '/icons/icon-192.png',
  '/lib/sigv4.js', '/lib/s3mini.js', '/lib/hash.js', '/lib/phone.js', '/lib/xlsx.js', '/cloud-baked.js'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async url => {
      try { await cache.add(new Request(url, { cache: 'reload' })); } catch (e) { /* noop */ }
    }));
    try {
      /* نسخهٔ دقیق همین فایل‌هایی که الان کش شدند = نسخهٔ مانیفست سرور */
      const r = await fetch('/api/update/check?current=0.0.0', { cache: 'no-store' });
      const j = await r.json();
      await cache.put(VERSION_KEY, new Response(JSON.stringify({ version: j.version, built_at: j.built_at }), { headers: { 'content-type': 'application/json' } }));
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

  /* شل برنامه (HTML/JS/CSS): اول شبکه، بعد کش.
     اگر برعکس باشد، بعد از هر آپدیت نسخهٔ کهنه تا ری‌لود بعدی می‌ماند. */
  const isShell = req.mode === 'navigate' || /\.(js|css|html|webmanifest)$/.test(url.pathname);
  if (isShell) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await Promise.race([
          fetch(req, { cache: 'no-store' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
        ]);
        if (fresh && fresh.ok) { try { await cache.put(req, fresh.clone()); } catch (e) { /* noop */ } return fresh; }
      } catch (e) { /* آفلاین یا کند → کش */ }
      const cached = await cache.match(req);
      return cached || new Response('offline', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: false });
    if (cached) {
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
  /* سرور فهرست کلاینت‌محور می‌دهد (info.client)؛ فایل‌های کد سرور در
     مرورگر معنا ندارند و هرگز در کش نوشته نمی‌شوند. */
  const changed = Array.isArray(info.client)
    ? info.client
    : (info.changed || [])
      .filter(f => String(f.path).startsWith('client/') || !String(f.path).includes('/'))
      .map(f => Object.assign({}, f, { path: String(f.path).replace(/^client\//, '') }));
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
  if (d.type === 'GET_VERSION') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      const version = await currentVersion(cache);
      if (event.ports && event.ports[0]) event.ports[0].postMessage({ type: 'VERSION', version });
    })());
    return;
  }
  if (d.type === 'CHECK_UPDATE') {
    event.waitUntil(applyDelta(!!d.reload).catch(err => notify({ type: 'UPDATE_FAILED', error: String(err.message || err) })));
  }
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
});
