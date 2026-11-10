#!/usr/bin/env node
/* Row 63 — native independence gate (ADR-43 / D-43).
   Inspects REAL build output, never source. A "native" claim is accepted only when this gate passes on
   the artifact produced by CI.
     Android (APK/AAB): parses every classes*.dex (string_ids → type_ids → method_ids, class_defs) and
       fails on method references to android.webkit.WebView (constructor, loadUrl, loadData*,
       addJavascriptInterface, evaluateJavascript, postUrl), WebViewClient/WebChromeClient construction,
       class prefixes of androidx.webkit / Capacitor / Cordova / Ionic, and bundled web UI entries
       (assets/www/, assets/public/index.html).
       Method references (not the bare type string) are checked on purpose: the Flutter embedding may
       mention the WebView type for accessibility or platform views without ever creating or loading one.
     Windows (directory or .zip): requires at least one .exe; fails on node.exe, WebView2Loader.dll,
       Microsoft.Web.WebView2.*.dll, runtime/ or node_modules/ directories, a bundled web UI or Node server
       (client/index.html, server/index.js), and the WebView2 loader strings inside any .exe/.dll (ASCII or UTF-16LE).
   Criterion: docs/cloud/43-native-independence.json (machine-readable, the only rule source).

   Usage: node tools/native-independence-gate.mjs --android <apk|aab>... --windows <dir|zip>... [--json] [--criterion f]
          node tools/native-independence-gate.mjs --expect-fail --android <apk>   (negative control: exit 0 only if it FAILS)
   Exit: 0 pass · 1 violation · 2 input error (missing file, not a zip, no dex, unparsable dex) */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ── minimal ZIP reader (central directory; stored + deflate) ── */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error('not a zip (no end of central directory)'), { input: true });
  let count = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) { // zip64
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdOff = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }
  const entries = [];
  let p = cdOff;
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw Object.assign(new Error('bad central directory'), { input: true });
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    let lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    // zip64 extra field
    let x = p + 46 + nlen; const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = buf.readUInt16LE(x); const sz = buf.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (lho === 0xffffffff) { lho = Number(buf.readBigUInt64LE(q)); }
      }
      x += 4 + sz;
    }
    entries.push({ name, method, csize, usize, lho });
    p += 46 + nlen + xlen + clen;
  }
  const data = e => {
    const n = buf.readUInt16LE(e.lho + 26); const xl = buf.readUInt16LE(e.lho + 28);
    const start = e.lho + 30 + n + xl;
    const raw = buf.subarray(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw Object.assign(new Error('unsupported zip method ' + e.method + ' for ' + e.name), { input: true });
  };
  return { entries, data };
}

/* ── DEX parser: strings, types, method refs, defined classes ── */
function uleb(buf, off) {
  let result = 0; let shift = 0; let b;
  do { b = buf[off++]; result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80 && shift < 35);
  return [result >>> 0, off];
}
export function parseDex(buf) {
  if (buf.length < 0x70 || buf.toString('latin1', 0, 4) !== 'dex\n') throw Object.assign(new Error('not a dex file'), { input: true });
  const u32 = o => buf.readUInt32LE(o);
  const stringIdsSize = u32(56); const stringIdsOff = u32(60);
  const typeIdsSize = u32(64); const typeIdsOff = u32(68);
  const methodIdsSize = u32(88); const methodIdsOff = u32(92);
  const classDefsSize = u32(96); const classDefsOff = u32(100);
  if (stringIdsOff + stringIdsSize * 4 > buf.length || methodIdsOff + methodIdsSize * 8 > buf.length) {
    throw Object.assign(new Error('dex tables out of bounds'), { input: true });
  }
  const strings = new Array(stringIdsSize);
  for (let i = 0; i < stringIdsSize; i++) {
    let off = u32(stringIdsOff + i * 4);
    [, off] = uleb(buf, off);
    let end = off; while (end < buf.length && buf[end] !== 0) end++;
    strings[i] = buf.toString('utf8', off, end); // MUTF-8 ≈ UTF-8 for ASCII identifiers
  }
  const types = new Array(typeIdsSize);
  for (let i = 0; i < typeIdsSize; i++) types[i] = strings[u32(typeIdsOff + i * 4)];
  const methods = new Array(methodIdsSize);
  for (let i = 0; i < methodIdsSize; i++) {
    const o = methodIdsOff + i * 8;
    methods[i] = { cls: types[buf.readUInt16LE(o)], name: strings[u32(o + 4)] };
  }
  const classes = new Array(classDefsSize);
  for (let i = 0; i < classDefsSize; i++) classes[i] = types[u32(classDefsOff + i * 32)];
  return { strings, types, methods, classes };
}

/* ── build a minimal valid-enough DEX (used by tests to create synthetic positives/negatives) ── */
export function buildDex({ classes = [], methodRefs = [], extraStrings = [] } = {}) {
  const strSet = new Set(extraStrings);
  for (const c of classes) strSet.add(c);
  for (const m of methodRefs) { strSet.add(m.cls); strSet.add(m.name); }
  strSet.add('V'); // proto shorty/return
  const strings = [...strSet].sort();
  const sIdx = s => strings.indexOf(s);
  const typeList = [...new Set([...classes, ...methodRefs.map(m => m.cls), 'V'])].sort((a, b) => sIdx(a) - sIdx(b));
  const tIdx = t => typeList.indexOf(t);
  const header = 0x70;
  const stringIdsOff = header;
  const typeIdsOff = stringIdsOff + strings.length * 4;
  const protoIdsOff = typeIdsOff + typeList.length * 4;
  const methodIdsOff = protoIdsOff + 12;
  const classDefsOff = methodIdsOff + methodRefs.length * 8;
  const dataOff = classDefsOff + classes.length * 32;
  const strData = []; let cur = dataOff; const strOffs = [];
  for (const s of strings) {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.from([Math.min(127, s.length)]);
    strOffs.push(cur); strData.push(len, b, Buffer.from([0])); cur += 1 + b.length + 1;
  }
  const total = cur;
  const buf = Buffer.alloc(total);
  buf.write('dex\n035\0', 0, 'latin1');
  buf.writeUInt32LE(total, 32); buf.writeUInt32LE(header, 36); buf.writeUInt32LE(0x12345678, 40);
  buf.writeUInt32LE(strings.length, 56); buf.writeUInt32LE(stringIdsOff, 60);
  buf.writeUInt32LE(typeList.length, 64); buf.writeUInt32LE(typeIdsOff, 68);
  buf.writeUInt32LE(1, 72); buf.writeUInt32LE(protoIdsOff, 76);
  buf.writeUInt32LE(methodRefs.length, 88); buf.writeUInt32LE(methodIdsOff, 92);
  buf.writeUInt32LE(classes.length, 96); buf.writeUInt32LE(classDefsOff, 100);
  strOffs.forEach((o, i) => buf.writeUInt32LE(o, stringIdsOff + i * 4));
  typeList.forEach((t, i) => buf.writeUInt32LE(sIdx(t), typeIdsOff + i * 4));
  buf.writeUInt32LE(sIdx('V'), protoIdsOff); buf.writeUInt32LE(tIdx('V'), protoIdsOff + 4); buf.writeUInt32LE(0, protoIdsOff + 8);
  methodRefs.forEach((m, i) => {
    const o = methodIdsOff + i * 8;
    buf.writeUInt16LE(tIdx(m.cls), o); buf.writeUInt16LE(0, o + 2); buf.writeUInt32LE(sIdx(m.name), o + 4);
  });
  classes.forEach((c, i) => { const o = classDefsOff + i * 32; buf.writeUInt32LE(tIdx(c), o); buf.writeUInt32LE(0xffffffff, o + 12); });
  Buffer.concat(strData).copy(buf, dataOff);
  return buf;
}

/* ── minimal ZIP writer (stored) for tests ── */
export function buildZip(files) {
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = []; const centrals = []; let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nb = Buffer.from(name, 'utf8'); const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, data); centrals.push(ch, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function loadCriterion(file = path.join(ROOT, 'docs/cloud/43-native-independence.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

/* ── Android check ── */
export function checkAndroid(buf, crit) {
  const c = crit.android;
  const { entries, data } = readZip(buf);
  const violations = [];
  const norm = n => n.replace(/^base\//, '');
  for (const f of c.forbidden_entries) {
    const hits = entries.filter(e => { const n = norm(e.name); return f.endsWith('/') ? n.startsWith(f) : n === f; });
    if (hits.length) violations.push(`entry ${f} (bundled web UI; ${hits.length} file(s), e.g. ${hits[0].name})`);
  }
  const dexes = entries.filter(e => /(^|\/)classes\d*\.dex$/.test(e.name));
  if (!dexes.length) throw Object.assign(new Error('no classes*.dex in package'), { input: true });
  const stats = { dex: dexes.length, methods: 0, classes: 0 };
  for (const e of dexes) {
    const dex = parseDex(data(e));
    stats.methods += dex.methods.length; stats.classes += dex.classes.length;
    for (const rule of c.forbidden_method_refs) {
      for (const m of dex.methods) if (m.cls === rule.class && rule.names.includes(m.name)) violations.push(`${e.name}: method ref ${m.cls}->${m.name}`);
    }
    for (const pre of c.forbidden_class_prefixes) {
      const hitT = dex.types.find(t => t && t.startsWith(pre));
      if (hitT) violations.push(`${e.name}: type ${hitT} (forbidden prefix ${pre})`);
    }
    for (const s of c.forbidden_strings || []) if (dex.strings.includes(s)) violations.push(`${e.name}: string "${s}"`);
  }
  return { violations: [...new Set(violations)], stats };
}

/* ── Windows check ── */
function listDir(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { out.push({ name: r + '/', dir: true }); walk(path.join(d, ent.name), r); } else out.push({ name: r, read: () => fs.readFileSync(path.join(d, ent.name)) });
    }
  };
  walk(dir, '');
  return out;
}
export function checkWindows(input, crit) {
  const c = crit.windows;
  let items;
  if (Buffer.isBuffer(input)) {
    const { entries, data } = readZip(input);
    items = entries.map(e => ({ name: e.name, dir: e.name.endsWith('/'), read: () => data(e) }));
  } else items = listDir(input);
  const violations = [];
  const base = n => n.replace(/\/$/, '').split('/').pop().toLowerCase();
  const dirsOf = n => { const parts = n.split('/'); parts.pop(); return parts.map(p => p.toLowerCase() + '/'); };
  const files = items.filter(i => !i.dir);
  const exes = files.filter(f => /\.exe$/i.test(f.name));
  if (c.require_exe && !exes.length) violations.push('no .exe in bundle (not a standalone Windows app)');
  for (const f of files) {
    if (c.forbidden_files.includes(base(f.name))) violations.push(`file ${f.name}`);
    for (const d of dirsOf(f.name)) if (c.forbidden_dirs.includes(d)) { violations.push(`dir ${d} (${f.name})`); break; }
    const low = f.name.toLowerCase();
    for (const e of c.forbidden_entries || []) if (low === e || low.endsWith('/' + e)) violations.push(`entry ${f.name} (web UI / Node server)`);
  }
  const needles = (c.forbidden_binary_strings || []).flatMap(s => [Buffer.from(s, 'latin1'), Buffer.from(s, 'utf16le')]);
  for (const f of files.filter(x => /\.(exe|dll)$/i.test(x.name))) {
    const b = f.read();
    for (const n of needles) if (b.indexOf(n) >= 0) { violations.push(`binary ${f.name} contains "${n.toString(n.length && n[1] === 0 ? 'utf16le' : 'latin1')}"`); break; }
  }
  // de-duplicate dir violations to keep the report readable
  const seen = new Set(); const vv = [];
  for (const v of violations) { const k = v.replace(/ \(.*\)$/, ''); if (!seen.has(k)) { seen.add(k); vv.push(v); } }
  return { violations: vv, stats: { files: files.length, exes: exes.map(e => e.name) } };
}

function main() {
  const argv = process.argv.slice(2);
  const crit = loadCriterion(argv.includes('--criterion') ? argv[argv.indexOf('--criterion') + 1] : undefined);
  const jobs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--android' || argv[i] === '--windows') {
      const kind = argv[i].slice(2);
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) jobs.push({ kind, file: argv[++i] });
    }
  }
  const expectFail = argv.includes('--expect-fail');
  if (!jobs.length) { console.error('usage: --android <apk|aab>... --windows <dir|zip>... [--expect-fail]'); process.exit(2); }
  const report = []; let anyViolation = false; let inputError = false;
  for (const j of jobs) {
    try {
      const st = fs.statSync(j.file);
      let res; let sum = null;
      if (j.kind === 'android') { const b = fs.readFileSync(j.file); sum = sha256(b); res = checkAndroid(b, crit); } else if (st.isDirectory()) res = checkWindows(j.file, crit);
      else { const b = fs.readFileSync(j.file); sum = sha256(b); res = checkWindows(b, crit); }
      const verdict = res.violations.length ? 'FAIL' : 'PASS';
      if (res.violations.length) anyViolation = true;
      report.push({ kind: j.kind, file: j.file, sha256: sum, verdict, stats: res.stats, violations: res.violations });
    } catch (e) {
      inputError = true;
      report.push({ kind: j.kind, file: j.file, verdict: 'INPUT-ERROR', error: String(e.message || e) });
    }
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ criterion: crit.id + '@v' + crit.version, report }, null, 2));
  else {
    console.log(`# native-independence-gate criterion=${crit.id}@v${crit.version} mode=${expectFail ? 'expect-fail (negative control)' : 'enforce'}`);
    for (const r of report) {
      console.log(`${r.verdict} ${r.kind} ${r.file}${r.sha256 ? ' sha256=' + r.sha256 : ''}`);
      if (r.stats) console.log('  stats ' + JSON.stringify(r.stats));
      for (const v of (r.violations || []).slice(0, 25)) console.log('  - ' + v);
      if ((r.violations || []).length > 25) console.log(`  … ${r.violations.length - 25} more`);
      if (r.error) console.log('  error ' + r.error);
    }
  }
  /* with --json, stdout carries only the JSON document; the verdict line goes to stderr */
  const say = argv.includes('--json') ? (m => console.error(m)) : (m => console.log(m));
  if (inputError) { say('NATIVE-GATE-INPUT-ERROR'); process.exit(2); }
  if (expectFail) {
    const allFailed = report.every(r => r.verdict === 'FAIL');
    say(allFailed ? 'NATIVE-GATE-NEGATIVE-CONTROL-OK (every input was rejected)' : 'NATIVE-GATE-NEGATIVE-CONTROL-BROKEN (a WebView/Node bundle passed)');
    process.exit(allFailed ? 0 : 1);
  }
  say(anyViolation ? 'NATIVE-GATE-FAIL' : 'NATIVE-GATE-OK');
  process.exit(anyViolation ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
