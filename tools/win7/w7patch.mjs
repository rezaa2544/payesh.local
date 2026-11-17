#!/usr/bin/env node
// w7patch.mjs — makes Windows binaries that import Win8+ APIs load on Windows 7 SP1.
//
// For every import descriptor that pulls in a Win8+ function (list: win8plus-apis.json) the
// DLL name is rewritten in place to "pw7.dll"; pw7.dll (tools/win7/pw7shim.c) implements the
// Win8+ functions (real API when present, Win7 fallback otherwise) and forwards every other
// function of that descriptor to the original DLL (ordinal imports are re-exported at the
// same ordinal as "DLL.#n" forwarders). This tool writes the matching pw7.def.
// The PE OS/subsystem version is lowered to 6.0 (the Win7 loader rejects 10.0 images), the
// Authenticode table is dropped (the signature would be invalid after the patch anyway).
//
//   node tools/win7/w7patch.mjs --arch x64|x86 --def out/pw7.def [--check] file.dll file.exe ...
//   node tools/win7/w7patch.mjs --scan file...        report Win8+ imports, exit 1 if any
//   node tools/win7/w7patch.mjs --verify pw7.dll file...   built shim satisfies every importer
//
// --check: do not write anything, exit 1 when a file still needs patching (CI gate).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_DLL = 'pw7.dll';

// Functions pw7.dll implements: name -> stdcall argument bytes on x86 (null = x64 only).
export const SHIM = {
  GetSystemTimePreciseAsFileTime: 4,
  CreateFile2: 20,
  CopyFile2: 12,
  GetCurrentThreadStackLimits: 8,
  WaitOnAddress: 16,
  WakeByAddressSingle: 4,
  WakeByAddressAll: 4,
  PathAllocCanonicalize: 12,
  PathCchCombineEx: 20,
  PathCchRemoveFileSpec: 8,
  GetHostNameW: 8,
  EventSetInformation: 20,
  RtlAddGrowableFunctionTable: null,
  RtlDeleteGrowableFunctionTable: null,
  RtlGrowFunctionTable: null,
};

// Where forwarded (non-Win8) functions of a renamed descriptor really live on Windows 7.
function forwardTarget(dll) {
  const d = dll.toLowerCase().replace(/\.dll$/, '');
  if (d.startsWith('api-ms-win-core-')) return 'KERNEL32'; // Win7 kernel32 exports the Win7-era core API
  return d.toUpperCase() === 'NTDLL' ? 'ntdll' : d.toUpperCase();
}

export function loadWin8Plus() {
  const j = JSON.parse(fs.readFileSync(path.join(HERE, 'win8plus-apis.json'), 'utf8'));
  return new Set(Object.keys(j.apis));
}

class PE {
  constructor(buf, file) {
    this.buf = buf;
    this.file = file;
    if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error(`${file}: not an MZ image`);
    this.pe = buf.readUInt32LE(0x3c);
    if (buf.readUInt32LE(this.pe) !== 0x4550) throw new Error(`${file}: no PE signature`);
    this.coff = this.pe + 4;
    this.machine = buf.readUInt16LE(this.coff);
    this.nsec = buf.readUInt16LE(this.coff + 2);
    const optSize = buf.readUInt16LE(this.coff + 16);
    this.opt = this.coff + 20;
    this.magic = buf.readUInt16LE(this.opt);
    this.is64 = this.magic === 0x20b;
    if (!this.is64 && this.magic !== 0x10b) throw new Error(`${file}: unknown optional header magic`);
    this.dd = this.opt + (this.is64 ? 112 : 96);
    this.ndd = buf.readUInt32LE(this.opt + (this.is64 ? 108 : 92));
    this.secs = [];
    const st = this.opt + optSize;
    for (let i = 0; i < this.nsec; i++) {
      const o = st + i * 40;
      this.secs.push({
        name: buf.toString('latin1', o, o + 8).replace(/\0+$/, ''),
        vsize: buf.readUInt32LE(o + 8),
        va: buf.readUInt32LE(o + 12),
        rsize: buf.readUInt32LE(o + 16),
        raw: buf.readUInt32LE(o + 20),
      });
    }
  }
  get arch() {
    return this.machine === 0x8664 ? 'x64' : this.machine === 0x14c ? 'x86' : `0x${this.machine.toString(16)}`;
  }
  dir(i) {
    if (i >= this.ndd) return { rva: 0, size: 0, off: -1 };
    const o = this.dd + i * 8;
    return { rva: this.buf.readUInt32LE(o), size: this.buf.readUInt32LE(o + 4), off: o };
  }
  off(rva) {
    for (const s of this.secs) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rsize)) {
        const o = rva - s.va + s.raw;
        if (rva - s.va >= s.rsize) throw new Error(`${this.file}: RVA 0x${rva.toString(16)} not backed by file data`);
        return o;
      }
    }
    throw new Error(`${this.file}: RVA 0x${rva.toString(16)} outside every section`);
  }
  cstr(rva) {
    const o = this.off(rva);
    let e = o;
    while (this.buf[e] !== 0) e++;
    return { s: this.buf.toString('latin1', o, e), off: o, len: e - o };
  }
  thunks(rva) {
    const out = [];
    const w = this.is64 ? 8 : 4;
    let o = this.off(rva);
    for (;;) {
      const v = this.is64 ? this.buf.readBigUInt64LE(o) : BigInt(this.buf.readUInt32LE(o));
      if (v === 0n) break;
      const ordFlag = this.is64 ? 1n << 63n : 1n << 31n;
      if (v & ordFlag) out.push({ ordinal: Number(v & 0xffffn) });
      else out.push({ name: this.cstr(Number(v & 0x7fffffffn) + 2).s });
      o += w;
    }
    return out;
  }
  imports() {
    const d = this.dir(1);
    const res = [];
    if (!d.rva) return res;
    for (let o = this.off(d.rva); ; o += 20) {
      const ilt = this.buf.readUInt32LE(o);
      const nameRva = this.buf.readUInt32LE(o + 12);
      const iat = this.buf.readUInt32LE(o + 16);
      if (!ilt && !nameRva && !iat) break;
      const name = this.cstr(nameRva);
      res.push({ descOff: o, nameRva, name: name.s, nameOff: name.off, nameLen: name.len, funcs: this.thunks(ilt || iat) });
    }
    return res;
  }
  delayImports() {
    const d = this.dir(13);
    const res = [];
    if (!d.rva) return res;
    for (let o = this.off(d.rva); ; o += 32) {
      const attrs = this.buf.readUInt32LE(o);
      const nameRva = this.buf.readUInt32LE(o + 4);
      const intRva = this.buf.readUInt32LE(o + 16);
      if (!nameRva) break;
      if (!(attrs & 1)) continue; // old VA-based format: not produced by modern linkers
      res.push({ nameRva, name: this.cstr(nameRva).s, funcs: this.thunks(intRva) });
    }
    return res;
  }
  exports() {
    const d = this.dir(0);
    const names = new Map(); // name -> forwarder|null
    const ords = new Map(); // ordinal -> forwarder|null
    if (!d.rva) return { names, ords };
    const o = this.off(d.rva);
    const base = this.buf.readUInt32LE(o + 16);
    const nFun = this.buf.readUInt32LE(o + 20);
    const nNames = this.buf.readUInt32LE(o + 24);
    const funs = this.off(this.buf.readUInt32LE(o + 28));
    const nameTab = nNames ? this.off(this.buf.readUInt32LE(o + 32)) : 0;
    const ordTab = nNames ? this.off(this.buf.readUInt32LE(o + 36)) : 0;
    const fwd = (rva) => (rva >= d.rva && rva < d.rva + d.size ? this.cstr(rva).s : null);
    for (let i = 0; i < nFun; i++) {
      const rva = this.buf.readUInt32LE(funs + i * 4);
      if (rva) ords.set(base + i, fwd(rva));
    }
    for (let i = 0; i < nNames; i++) {
      const idx = this.buf.readUInt16LE(ordTab + i * 2);
      names.set(this.cstr(this.buf.readUInt32LE(nameTab + i * 4)).s, fwd(this.buf.readUInt32LE(funs + idx * 4)));
    }
    return { names, ords };
  }
  osVersion() {
    const b = this.buf;
    return [b.readUInt16LE(this.opt + 40), b.readUInt16LE(this.opt + 42), b.readUInt16LE(this.opt + 48), b.readUInt16LE(this.opt + 50)];
  }
}

// Analyse a file: which descriptors must go through pw7.dll and which Win8+ names are unhandled.
export function analyse(buf, file, win8) {
  const pe = new PE(buf, file);
  const imps = pe.imports();
  const redirect = [];
  const unhandled = [];
  for (const d of imps) {
    if (d.name.toLowerCase() === SHIM_DLL) continue;
    const need = d.funcs.filter((f) => f.name && win8.has(f.name)).map((f) => f.name);
    if (!need.length) continue;
    for (const n of need) {
      if (!(n in SHIM) || (pe.arch === 'x86' && SHIM[n] === null)) unhandled.push(`${d.name}!${n}`);
    }
    redirect.push(d);
  }
  for (const d of pe.delayImports()) {
    for (const f of d.funcs) if (f.name && win8.has(f.name)) unhandled.push(`delay ${d.name}!${f.name}`);
  }
  const shimmed = imps.some((d) => d.name.toLowerCase() === SHIM_DLL);
  const [osMaj, osMin, subMaj, subMin] = pe.osVersion();
  const versionOk = osMaj * 10 + osMin <= 61 && subMaj * 10 + subMin <= 61;
  return { pe, imps, redirect, unhandled, shimmed, versionOk };
}

function patchFile(file, win8, arch, check) {
  const buf = fs.readFileSync(file);
  const a = analyse(buf, file, win8);
  const { pe } = a;
  if (arch && pe.arch !== arch) throw new Error(`${file}: is ${pe.arch}, expected ${arch}`);
  if (a.unhandled.length) throw new Error(`${file}: Win8+ imports pw7.dll does not cover:\n  ${a.unhandled.join('\n  ')}`);
  const forwards = [];
  // Descriptors that already point at pw7.dll (re-run): rebuild the forward list from the
  // sidecar written by the first run so the .def stays complete.
  const side = `${file}.pw7.json`;
  if (a.shimmed && fs.existsSync(side)) forwards.push(...JSON.parse(fs.readFileSync(side, 'utf8')).forwards);
  else if (a.shimmed && !a.redirect.length) throw new Error(`${file}: already patched but ${path.basename(side)} is missing`);
  const needsWork = a.redirect.length > 0 || !a.versionOk;
  if (check) return { file, arch: pe.arch, needsWork, forwards, redirected: a.redirect.map((d) => d.name) };

  // A name string shared with a descriptor we are NOT redirecting cannot be rewritten in place.
  const keep = new Set(a.imps.filter((d) => !a.redirect.includes(d)).map((d) => d.nameRva));
  for (const d of pe.delayImports()) keep.add(d.nameRva);
  for (const d of a.redirect) {
    if (keep.has(d.nameRva)) throw new Error(`${file}: import name of ${d.name} is shared; cannot rename in place`);
    if (d.nameLen < SHIM_DLL.length) throw new Error(`${file}: import name ${d.name} shorter than ${SHIM_DLL}`);
    buf.fill(0, d.nameOff, d.nameOff + d.nameLen);
    buf.write(SHIM_DLL, d.nameOff, 'latin1');
    const target = forwardTarget(d.name);
    for (const f of d.funcs) {
      if (f.ordinal !== undefined) {
        forwards.push({ ordinal: f.ordinal, target, from: d.name }); // re-exported at the same ordinal
        continue;
      }
      if (f.name in SHIM && !(pe.arch === 'x86' && SHIM[f.name] === null)) continue;
      forwards.push({ name: f.name, target, from: d.name });
    }
  }
  // OS + subsystem version 6.0 (Vista+, accepted by the Win7 loader).
  const [osMaj, osMin, subMaj, subMin] = pe.osVersion();
  if (osMaj * 10 + osMin > 61) {
    buf.writeUInt16LE(6, pe.opt + 40);
    buf.writeUInt16LE(0, pe.opt + 42);
  }
  if (subMaj * 10 + subMin > 61) {
    buf.writeUInt16LE(6, pe.opt + 48);
    buf.writeUInt16LE(0, pe.opt + 50);
  }
  let out = buf;
  if (a.redirect.length) {
    // Bound imports would point at the old DLLs.
    const bound = pe.dir(11);
    if (bound.rva) buf.fill(0, bound.off, bound.off + 8);
    // Authenticode: the signature is invalid after the patch; drop it (file-offset based).
    const sec = pe.dir(4);
    if (sec.rva && sec.size) {
      buf.fill(0, sec.off, sec.off + 8);
      if (sec.rva + sec.size === buf.length) out = buf.subarray(0, sec.rva);
    }
    // PE checksum: recompute (only drivers require it, but keep the header honest).
    writeChecksum(out, pe.opt + 64);
  }
  fs.writeFileSync(file, out);
  fs.writeFileSync(side, `${JSON.stringify({ forwards }, null, 1)}\n`);
  return { file, arch: pe.arch, needsWork: false, forwards, redirected: a.redirect.map((d) => d.name) };
}

function writeChecksum(buf, csOff) {
  buf.writeUInt32LE(0, csOff);
  let sum = 0;
  const n = buf.length & ~1;
  for (let i = 0; i < n; i += 2) {
    sum += buf.readUInt16LE(i);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  if (buf.length & 1) {
    sum += buf[buf.length - 1];
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  buf.writeUInt32LE((sum + buf.length) >>> 0, csOff);
}

export function makeDef(arch, forwards) {
  const lines = ['; generated by tools/win7/w7patch.mjs — do not edit', 'LIBRARY pw7', 'EXPORTS'];
  for (const [n, bytes] of Object.entries(SHIM)) {
    if (arch === 'x86' && bytes === null) continue;
    lines.push(arch === 'x86' ? `  ${n}=pw7_${n}@${bytes}` : `  ${n}=pw7_${n}`);
  }
  lines.push(arch === 'x86' ? '  pw7_Info=pw7_Info@0' : '  pw7_Info');
  const ords = new Map();
  for (const f of forwards) {
    if (f.ordinal === undefined) continue;
    const prev = ords.get(f.ordinal);
    if (prev && prev !== f.target) throw new Error(`pw7.def: ordinal ${f.ordinal} imported from both ${prev} and ${f.target}`);
    ords.set(f.ordinal, f.target);
  }
  for (const [o, t] of [...ords.entries()].sort((x, y) => x[0] - y[0])) lines.push(`  __pw7_${t}_${o}="${t}.#${o}" @${o} NONAME`);
  const seen = new Map();
  for (const f of forwards) {
    if (f.ordinal !== undefined) continue;
    if (f.name in SHIM || f.name === 'pw7_Info') continue;
    const prev = seen.get(f.name);
    if (prev && prev !== f.target) {
      // e.g. RtlCaptureContext from KERNEL32 and ntdll: kernel32 forwards to ntdll, either works.
      if (prev === 'ntdll' || f.target === 'ntdll') {
        seen.set(f.name, 'ntdll');
        continue;
      }
      throw new Error(`pw7.def: ${f.name} forwarded to both ${prev} and ${f.target}`);
    }
    seen.set(f.name, f.target);
  }
  for (const [n, t] of [...seen.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) lines.push(`  ${n}=${t}.${n}`);
  return `${lines.join('\n')}\n`;
}

let win8Cache;
function win8Lazy() {
  win8Cache ??= loadWin8Plus();
  return win8Cache;
}

function main(argv) {
  const args = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--arch') args.arch = argv[++i];
    else if (a === '--def') args.def = argv[++i];
    else if (a === '--check') args.check = true;
    else if (a === '--scan') args.scan = true;
    else if (a === '--verify') args.verify = argv[++i];
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else args.files.push(a);
  }
  if (args.verify) {
    // Every pw7.dll import of every file must resolve in the built pw7.dll; pw7.dll itself
    // must be Win7-clean and of the same architecture.
    const shim = new PE(fs.readFileSync(args.verify), args.verify);
    const ex = shim.exports();
    const problems = [];
    const own = analyse(shim.buf, args.verify, win8Lazy());
    if (own.redirect.length || !own.versionOk) problems.push(`${args.verify} itself is not Windows 7 clean`);
    let n = 0;
    for (const f of args.files) {
      const pe = new PE(fs.readFileSync(f), f);
      if (pe.arch !== shim.arch) problems.push(`${f}: ${pe.arch} but ${args.verify} is ${shim.arch}`);
      for (const d of pe.imports()) {
        if (d.name.toLowerCase() !== SHIM_DLL) continue;
        for (const fn of d.funcs) {
          n++;
          if (fn.ordinal !== undefined ? !ex.ords.has(fn.ordinal) : !ex.names.has(fn.name)) {
            problems.push(`${f}: ${fn.ordinal !== undefined ? `#${fn.ordinal}` : fn.name} not exported by ${args.verify}`);
          }
        }
      }
    }
    for (const n2 of Object.keys(SHIM)) {
      if (shim.arch === 'x86' && SHIM[n2] === null) continue;
      if (!ex.names.has(n2) || ex.names.get(n2) !== null) problems.push(`${args.verify}: ${n2} is not implemented in the shim`);
    }
    if (problems.length) {
      console.error(problems.join('\n'));
      return 1;
    }
    console.log(`PW7-VERIFY-OK ${args.verify} [${shim.arch}] ${n} imports from ${args.files.length} file(s) resolve (${ex.names.size} named exports)`);
    return 0;
  }
  if (!args.files.length) throw new Error('usage: w7patch.mjs --arch x64|x86 --def pw7.def [--check] files... | --scan files...');
  const win8 = win8Lazy();
  if (args.scan) {
    let bad = 0;
    for (const f of args.files) {
      const a = analyse(fs.readFileSync(f), f, win8);
      const [om, on, sm, sn] = a.pe.osVersion();
      const w8 = a.redirect.flatMap((d) => d.funcs.filter((x) => x.name && win8.has(x.name)).map((x) => `${d.name}!${x.name}`));
      const ok = !w8.length && !a.unhandled.length && a.versionOk;
      if (!ok) bad++;
      console.log(`${ok ? 'W7-OK ' : 'W7-BAD'} ${f} [${a.pe.arch} os ${om}.${on} sub ${sm}.${sn}${a.shimmed ? ' pw7' : ''}]${w8.length ? ` ${w8.join(' ')}` : ''}`);
    }
    return bad ? 1 : 0;
  }
  if (!args.arch || !['x64', 'x86'].includes(args.arch)) throw new Error('--arch x64|x86 required');
  const results = args.files.map((f) => patchFile(f, win8, args.arch, args.check));
  for (const r of results) {
    console.log(`${args.check ? (r.needsWork ? 'NEEDS-PATCH' : 'PATCHED') : 'PATCHED'} ${r.file} -> ${SHIM_DLL} for [${r.redirected.join(', ')}] (${r.forwards.length} forwarders)`);
  }
  if (args.check) return results.some((r) => r.needsWork) ? 1 : 0;
  if (args.def) {
    fs.mkdirSync(path.dirname(path.resolve(args.def)), { recursive: true });
    fs.writeFileSync(args.def, makeDef(args.arch, results.flatMap((r) => r.forwards)));
    console.log(`wrote ${args.def}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`w7patch: ${e.message}`);
    process.exitCode = 2;
  }
}
