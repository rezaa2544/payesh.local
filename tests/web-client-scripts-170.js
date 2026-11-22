'use strict';
/* ردیف ۱۷۰: پنل وب «نبض» (client/index.html) در مرورگر واقعی بالا نمی‌آمد — از ردیف ۴۴
   engine-web.js / outbox-web.js / secure-web.js با `const api`/`const DB_NAME` سطح بالا
   کنار app.js بار می‌شدند و همهٔ اسکریپت‌های کلاسیک یک دامنهٔ سراسری مشترک دارند ⇒
   SyntaxError: Identifier 'api' has already been declared ⇒ «در حال بارگذاری…» برای همیشه.
   این آزمون همهٔ <script src> صفحه را به همان ترتیب در یک realm اجرا می‌کند (معنای مرورگر). */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
const srcs = [...html.matchAll(/<script\s+src="\/([^"]+)"/g)].map(m => m[1]);
assert.ok(srcs.length >= 10, 'اسکریپت‌های صفحه پیدا نشد');

const noop = () => {};
const store = new Map();
const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : el()), apply: () => el(), construct: () => el() });
const sandbox = {
  console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
  setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
  queueMicrotask: noop, URL, URLSearchParams, TextEncoder, TextDecoder, crypto: globalThis.crypto,
  fetch: () => new Promise(noop), atob, btoa,
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  navigator: { userAgent: 'node', onLine: true, serviceWorker: undefined },
  location: { hash: '#/', href: 'http://payesh.test/', origin: 'http://payesh.test', protocol: 'http:', host: 'payesh.test', pathname: '/', search: '' },
  addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }),
  indexedDB: undefined,
};
sandbox.document = { addEventListener: noop, readyState: 'loading', getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: el, documentElement: el(), body: el(), head: el() };
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let failed = null;
for (const s of srcs) {
  const code = fs.readFileSync(path.join(ROOT, 'client', s), 'utf8');
  try {
    vm.runInContext(code, sandbox, { filename: s });
  } catch (e) {
    if (e instanceof SyntaxError || /already been declared/.test(String(e && e.message))) { failed = s + ': ' + e.message; break; }
    /* خطای اجرایی ناشی از DOM ساختگی مهم نیست؛ فقط برخورد نام‌های سراسری */
  }
}
assert.strictEqual(failed, null, 'برخورد نام سراسری در پنل وب: ' + failed);
for (const g of ['PayeshEngine', 'PayeshOutbox', 'PayeshSecure']) {
  if (/engine|outbox|secure/i.test(g)) assert.ok(sandbox[g], g + ' روی globalThis نیست');
}
console.log('WEB-CLIENT-SCRIPTS-OK ' + srcs.length);
