// Runner for tool/web32_sqlite_check.dart (row 169). usage: node … <compiled.js> <sqlite3mc.wasm> [fixture.b64]
import fs from 'node:fs';
import vm from 'node:vm';
globalThis.self = globalThis;
globalThis.PAYESH_WASM = new Uint8Array(fs.readFileSync(process.argv[3]));
if (process.argv[4]) globalThis.PAYESH_FIXTURE = fs.readFileSync(process.argv[4], 'utf8');
const log = console.log;
let done = false;
console.log = (...a) => {
  const s = a.join(' ');
  log(s);
  if (/^WEB32-SQLITE-(OK|FAIL)/.test(s)) { done = true; setTimeout(() => process.exit(s.startsWith('WEB32-SQLITE-OK') ? 0 : 1), 20); }
};
vm.runInThisContext(fs.readFileSync(process.argv[2], 'utf8'));
setTimeout(() => { if (!done) { log('WEB32-SQLITE-FAIL timeout'); process.exit(1); } }, 60000);
