'use strict';
/* ═══════════════════════════════════════════════════════════════════
   zip قطعی (deterministic) و خوانندهٔ حداقلی — PR‑4 · ردیف ۹۹
   · بدون وابستگی؛ فقط node:zlib
   · نام‌ها مرتب، زمان ثابت ۱۹۸۰‑۰۱‑۰۱، مجوز 0644، deflate سطح ۹
     ⇒ ورودی یکسان = بایت‌های یکسان = sha256 یکسان
   · readZip از central directory می‌خواند (APK امضاشده با APK Signing
     Block هم درست خوانده می‌شود) و CRC هر ورودی را بررسی می‌کند.
   ═══════════════════════════════════════════════════════════════════ */
const zlib = require('node:zlib');

let TABLE = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

function buildZip(entries) {
  const list = entries.map(e => ({ name: e.name, data: Buffer.from(e.data) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Set();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of list) {
    if (!e.name || e.name.startsWith('/') || e.name.includes('..') || e.name.includes('\\')) {
      throw new Error('unsafe zip entry name: ' + e.name);
    }
    if (seen.has(e.name)) throw new Error('duplicate zip entry: ' + e.name);
    seen.add(e.name);
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const comp = zlib.deflateRawSync(e.data, { level: 9 });
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x0314, 4); // made by: unix, 2.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** ⇒ Map(name → Buffer). هر ناسازگاری ساختاری یا CRC ⇒ throw */
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a zip (too short)');
  let eo = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eo = i; break; }
  }
  if (eo < 0) throw new Error('not a zip (no end of central directory)');
  const count = buf.readUInt16LE(eo + 10);
  const cdSize = buf.readUInt32LE(eo + 12);
  const cdOff = buf.readUInt32LE(eo + 16);
  if (cdOff + cdSize > eo) throw new Error('corrupt zip (central directory out of range)');
  const out = new Map();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip (central header)');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lo = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('corrupt zip (local header) ' + name);
    const lnlen = buf.readUInt16LE(lo + 26);
    if (buf.slice(lo + 30, lo + 30 + lnlen).toString('utf8') !== name) throw new Error('corrupt zip (local/central name mismatch) ' + name);
    const start = lo + 30 + lnlen + buf.readUInt16LE(lo + 28);
    const raw = buf.slice(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error('unsupported zip method ' + method + ' for ' + name);
    if (data.length !== usize) throw new Error('size mismatch in ' + name);
    if (crc32(data) !== crc) throw new Error('crc mismatch in ' + name);
    out.set(name, data);
  }
  return out;
}

module.exports = { buildZip, readZip, crc32 };
