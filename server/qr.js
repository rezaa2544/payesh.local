'use strict';
/* ═══════════════════════════════════════════════════════════════════
   تولید QR بدون هیچ وابستگی (byte mode، سطح تصحیح خطا M)
   • encode(text)  → { version, size, modules: boolean[][] }
   • toPNG(matrix) → Buffer (PNG سیاه‌وسفید، grayscale)
   فقط نسخه‌های ۱ تا ۱۰ پشتیبانی می‌شوند؛ برای آدرس‌های این سامانه کافی است
   (تا ۲۱۳ بایت = کافی برای دامنهٔ طولانی + مسیر).
   ─────────────────────────────────────────────────────────────────── */
const zlib = require('zlib');

/* ── جدول ساختار بلوک‌ها: [تعداد بلوک، کل کدواژه، کدواژهٔ داده] ────── */
const RS_BLOCKS_M = [
  null,
  [[1, 26, 16]],
  [[1, 44, 28]],
  [[1, 70, 44]],
  [[2, 50, 32]],
  [[2, 67, 43]],
  [[4, 43, 27]],
  [[4, 49, 31]],
  [[2, 60, 38], [2, 61, 39]],
  [[3, 58, 36], [2, 59, 37]],
  [[4, 69, 43], [1, 70, 44]],
];
const ECC_PER_BLOCK_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const MAX_VERSION = 10;

/* ── میدان گالوا GF(256) ──────────────────────────────────────────── */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, eccLen) {
  const gen = rsGenerator(eccLen);
  const res = new Array(eccLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < eccLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

/* ── انتخاب نسخه و ساخت بیت‌استریم ────────────────────────────────── */
function dataCapacity(version) {
  let data = 0;
  for (const [n, , d] of RS_BLOCKS_M[version]) data += n * d;
  const lenBits = version < 10 ? 8 : 16;
  return Math.floor((data * 8 - 4 - lenBits) / 8);
}

function pickVersion(byteLen) {
  for (let v = 1; v <= MAX_VERSION; v++) if (dataCapacity(v) >= byteLen) return v;
  throw new Error('qr_too_long');
}

function buildCodewords(text, version) {
  const bytes = Buffer.from(text, 'utf8');
  const blocks = [];
  for (const [n, total, dlen] of RS_BLOCKS_M[version]) for (let i = 0; i < n; i++) blocks.push({ total, dlen });

  const totalData = blocks.reduce((a, b) => a + b.dlen, 0);
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };

  push(0b0100, 4);                       /* byte mode */
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacityBits = totalData * 8;
  const term = Math.min(4, capacityBits - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  const pads = [0xec, 0x11];
  let k = 0;
  while (data.length < totalData) data.push(pads[k++ % 2]);

  /* تقسیم به بلوک + کد تصحیح خطا */
  const dataBlocks = [];
  const eccBlocks = [];
  let offset = 0;
  for (const b of blocks) {
    const chunk = data.slice(offset, offset + b.dlen);
    offset += b.dlen;
    dataBlocks.push(chunk);
    eccBlocks.push(rsRemainder(chunk, b.total - b.dlen));
  }

  /* درهم‌بافی (interleave) */
  const out = [];
  const maxData = Math.max(...dataBlocks.map(b => b.length));
  for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  const maxEcc = Math.max(...eccBlocks.map(b => b.length));
  for (let i = 0; i < maxEcc; i++) for (const b of eccBlocks) if (i < b.length) out.push(b[i]);
  return out;
}

/* ── چیدمان ماتریس ────────────────────────────────────────────────── */
const ALIGN_POS = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

function bchFormat(data) {              /* 15 بیت، ژنراتور 0x537 */
  let v = data << 10;
  for (let i = 4; i >= 0; i--) if (v & (1 << (i + 10))) v ^= 0x537 << i;
  return ((data << 10) | v) ^ 0x5412;
}
function bchVersion(version) {          /* 18 بیت، ژنراتور 0x1f25 */
  let v = version << 12;
  for (let i = 5; i >= 0; i--) if (v & (1 << (i + 12))) v ^= 0x1f25 << i;
  return (version << 12) | v;
}

function buildMatrix(text, version, mask) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFn = (r, c, dark) => { m[r][c] = !!dark; fn[r][c] = true; };

  /* الگوهای یابنده + جداکننده */
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                       (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setFn(rr, cc, inRing || inCore);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  /* الگوهای زمان‌بندی */
  for (let i = 8; i < size - 8; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  /* الگوهای هم‌ترازی */
  const pos = ALIGN_POS[version] || [];
  for (const r of pos) {
    for (const c of pos) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFn(r + dr, c + dc, dark);
        }
      }
    }
  }

  /* ماژول تیره + جای اطلاعات نسخه */
  setFn(size - 8, 8, true);
  if (version >= 7) {
    const vinfo = bchVersion(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vinfo >> i) & 1;
      const a = Math.floor(i / 3), b = i % 3;
      setFn(size - 11 + b, a, bit);
      setFn(a, size - 11 + b, bit);
    }
  }

  /* رزرو ناحیهٔ اطلاعات قالب (ماژول‌های تابع قبلی دست‌نخورده می‌مانند) */
  for (let i = 0; i < 9; i++) {
    if (!fn[8][i]) setFn(8, i, false);
    if (!fn[i][8]) setFn(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!fn[8][size - 1 - i]) setFn(8, size - 1 - i, false);
    if (!fn[size - 1 - i][8]) setFn(size - 1 - i, 8, false);
  }

  /* چیدن داده‌ها (زیگزاگ) */
  const codewords = buildCodewords(text, version);
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < size; k++) {
      const row = upward ? size - 1 - k : k;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (fn[row][cc]) continue;
        let dark = false;
        if (bitIndex < totalBits) {
          dark = ((codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
        m[row][cc] = dark;
      }
    }
    upward = !upward;
  }

  /* اعمال ماسک */
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!fn[r][c] && mask(r, c)) m[r][c] = !m[r][c];
    }
  }

  /* اطلاعات قالب (سطح M = 00) — چیدمان استاندارد ISO/IEC 18004 */
  const fmt = bchFormat((0b00 << 3) | maskIndex(mask));
  for (let i = 0; i < 15; i++) {
    const bit = !!((fmt >> i) & 1);
    /* نسخهٔ اول: بیت‌های ۰..۵ در ستون ۸، ۶ در (۷,۸)، ۷ در (۸,۸)، ۸ در (۸,۷)، ۹..۱۴ در سطر ۸ */
    if (i < 6) m[i][8] = bit;
    else if (i < 8) m[i + 1][8] = bit;      /* ۶→۷ ، ۷→۸ */
    else if (i === 8) m[8][7] = bit;
    else m[8][14 - i] = bit;                /* ۹→۵ … ۱۴→۰ */
    /* نسخهٔ دوم: بیت‌های ۰..۷ در سمت راست سطر ۸، بیت‌های ۸..۱۴ در پایین ستون ۸ */
    if (i < 8) m[8][size - 1 - i] = bit;
    else m[size - 15 + i][8] = bit;
  }
  m[size - 8][8] = true;
  return m;
}

function maskIndex(fn) {
  for (let i = 0; i < MASKS.length; i++) if (MASKS[i] === fn) return i;
  return 0;
}

/* ── امتیاز جریمه برای انتخاب بهترین ماسک ──────────────────────────── */
function penalty(size, get) {
  let score = 0;
  for (let i = 0; i < size; i++) {
    let runRow = 1, runCol = 1;
    for (let j = 1; j < size; j++) {
      if (get(i, j) === get(i, j - 1)) runRow++; else { if (runRow >= 5) score += 3 + (runRow - 5); runRow = 1; }
      if (get(j, i) === get(j - 1, i)) runCol++; else { if (runCol >= 5) score += 3 + (runCol - 5); runCol = 1; }
    }
    if (runRow >= 5) score += 3 + (runRow - 5);
    if (runCol >= 5) score += 3 + (runCol - 5);
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = get(r, c);
      if (v === get(r, c + 1) && v === get(r + 1, c) && v === get(r + 1, c + 1)) score += 3;
    }
  }
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (get(r, c)) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

function encode(text) {
  const version = pickVersion(Buffer.byteLength(String(text), 'utf8'));
  let best = null;
  for (let mi = 0; mi < MASKS.length; mi++) {
    const matrix = buildMatrix(String(text), version, MASKS[mi]);
    const size = matrix.length;
    const p = penalty(size, (r, c) => matrix[r][c]);
    if (!best || p < best.penalty) best = { matrix, penalty: p, mask: mi };
  }
  return { version, size: best.matrix.length, mask: best.mask, modules: best.matrix };
}

/* ── خروجی PNG (grayscale، بدون شفافیت) ───────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function toPNG(qr, scale = 8, margin = 4) {
  const size = qr.size;
  const dim = (size + margin * 2) * scale;
  const raw = Buffer.alloc((dim + 1) * dim, 0xff);
  for (let y = 0; y < dim; y++) raw[y * (dim + 1)] = 0;      /* filter: none */

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!qr.modules[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const y = (r + margin) * scale + dy;
        const rowStart = y * (dim + 1) + 1;
        for (let dx = 0; dx < scale; dx++) raw[rowStart + (c + margin) * scale + dx] = 0x00;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8;      /* bit depth */
  ihdr[9] = 0;      /* grayscale */
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { encode, toPNG };
