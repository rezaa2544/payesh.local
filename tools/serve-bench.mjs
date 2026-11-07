#!/usr/bin/env node
/* سرور ایستا برای اجرای bench/39 در مرورگر واقعی (بدون هیچ وابستگی).
   اجرا:  node tools/serve-bench.mjs [port]
   سپس:   http://127.0.0.1:<port>/bench/39/index.html?autorun=1&rows=100000&label=chrome-desktop
   نکته: IndexedDB در Chrome روی file:// در دسترس نیست؛ پس سرو از HTTP لازم است. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.argv[2] || process.env.PORT || 8788);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p.endsWith('/')) p += 'index.html';
    const full = normalize(join(ROOT, p));
    if (!full.startsWith(normalize(ROOT))) { res.writeHead(403).end('forbidden'); return; }
    const st = await stat(full);
    if (!st.isFile()) { res.writeHead(404).end('not found'); return; }
    const body = await readFile(full);
    res.writeHead(200, {
      'content-type': TYPES[extname(full)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`bench server → http://127.0.0.1:${PORT}/bench/39/index.html?autorun=1&rows=100000&label=chrome-desktop`);
});
