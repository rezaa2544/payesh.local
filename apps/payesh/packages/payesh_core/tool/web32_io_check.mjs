// Runner for tool/web32_io_check.dart compiled with dart2js (row 169, D-50).
// usage: node tool/web32_io_check.mjs <compiled.js>
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';

const big = Buffer.alloc(3000000);
for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url.startsWith('/hello')) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-echo': req.headers['x-payesh'] || '', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ path: req.url }));
    } else if (req.url === '/echo') {
      res.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    } else if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': big.length });
      let at = 0;
      const pump = () => { while (at < big.length) { const n = Math.min(65536, big.length - at); const ok = res.write(big.subarray(at, at + n)); at += n; if (!ok) return res.once('drain', pump); } res.end(); };
      pump();
    } else if (req.url === '/slow') {
      setTimeout(() => { res.writeHead(200); res.end('late'); }, 3000);
    } else { res.writeHead(404); res.end('no'); }
  });
});
server.listen(0, '127.0.0.1', () => {
  globalThis.self = globalThis;
  globalThis.PAYESH_CHECK_HTTP = `http://127.0.0.1:${server.address().port}/`;
  const log = console.log;
  let result = null;
  console.log = (...a) => {
    const s = a.join(' ');
    log(s);
    if (/^WEB32-IO-(OK|FAIL)/.test(s)) { result = s; server.closeAllConnections?.(); server.close(); setTimeout(() => process.exit(s.startsWith('WEB32-IO-OK') ? 0 : 1), 50); }
  };
  vm.runInThisContext(fs.readFileSync(process.argv[2], 'utf8'));
  setTimeout(() => { if (!result) { log('WEB32-IO-FAIL timeout'); process.exit(1); } }, 60000);
});
