'use strict';
/* Row 82 negative controls ONLY (tests/load-82.js). Preloaded into a gateway
   child via NODE_OPTIONS=--require. Never used by the product.
     LOAD82_INJECT_LEAK_KB=<n>   keep n KB per request alive forever (memory leak)
     LOAD82_INJECT_DELAY_MS=<n>  hold every request n ms before the handler (slow server) */
const http = require('node:http');
const leakKb = Number(process.env.LOAD82_INJECT_LEAK_KB || 0);
const delayMs = Number(process.env.LOAD82_INJECT_DELAY_MS || 0);
const kept = [];
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (ev, req, res) {
  if (ev !== 'request' || !req || !String(req.url || '').startsWith('/api/gw/')) return emit.apply(this, arguments);
  if (leakKb > 0) kept.push(Buffer.alloc(leakKb * 1024, 1));
  if (delayMs > 0) { const args = arguments; setTimeout(() => emit.apply(this, args), delayMs); return true; }
  return emit.apply(this, arguments);
};
