/* ═══════════════════════════════════════════════════════════════════
   خواندن فایل اکسل (.xlsx) و CSV — بدون هیچ کتابخانهٔ بیرونی
   ───────────────────────────────────────────────────────────────────
   چرا خودمان می‌خوانیم؟ روی گوشی و رایانه نباید برای یک فایل اکسل،
   کتابخانهٔ حجیم اضافه شود و هیچ وابستگی اینترنتی هم نداریم.

   فایل xlsx در واقع یک بایگانی zip است:
     xl/workbook.xml          → نام برگه‌ها
     xl/sharedStrings.xml     → متن‌های مشترک
     xl/worksheets/sheet1.xml → خانه‌ها
   zip را با ساختار خودش می‌خوانیم و باز کردنِ فشرده‌سازی را با
   DecompressionStream خودِ مرورگر انجام می‌دهیم. اگر مرورگر قدیمی بود،
   پیام روشن داده می‌شود و CSV همچنان کار می‌کند.

   API:
     PayeshXlsx.read(arrayBuffer)  → { sheets: [{ name, rows: [[...]] }] }
     PayeshXlsx.fromCsv(text)      → { sheets: [{ name: 'CSV', rows }] }
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ── ابزار پایه ────────────────────────────────────────────────── */
  /* TextDecoder در همهٔ مرورگرها هست، ولی در محیط آزمون ممکن است نباشد؛
     به‌جای خطا، مسیر جایگزین ساده را می‌رویم. */
  function utf8(bytes) {
    if (typeof global.TextDecoder === 'function') return new global.TextDecoder('utf-8').decode(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(out)); } catch (e) { return out; }
  }

  function xmlUnescape(s) {
    return String(s == null ? '' : s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&amp;/g, '&');
  }

  /* ستون «AB» → شمارهٔ ۲۷ (صفر-پایه) */
  function colIndex(ref) {
    const m = /^([A-Z]+)/i.exec(String(ref || ''));
    if (!m) return -1;
    let n = 0;
    const letters = m[1].toUpperCase();
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }

  /* ── خواندن بایگانی zip ───────────────────────────────────────── */
  function findEOCD(u8) {
    const min = Math.max(0, u8.length - 66000);
    for (let i = u8.length - 22; i >= min; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) return i;
    }
    return -1;
  }

  function zipEntries(u8) {
    const eocd = findEOCD(u8);
    if (eocd < 0) throw new Error('این فایل یک بایگانی zip معتبر نیست (xlsx خراب یا رمزدار است).');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const out = new Map();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = utf8(u8.subarray(off + 46, off + 46 + nameLen));
      out.set(name, { method, compSize, localOff });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  async function readEntry(u8, entry) {
    if (!entry) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const nameLen = dv.getUint16(entry.localOff + 26, true);
    const extraLen = dv.getUint16(entry.localOff + 28, true);
    const start = entry.localOff + 30 + nameLen + extraLen;
    const raw = u8.subarray(start, start + entry.compSize);
    if (entry.method === 0) return raw;
    if (entry.method !== 8) throw new Error('روش فشرده‌سازی این فایل پشتیبانی نمی‌شود (روش ' + entry.method + ').');
    if (typeof global.DecompressionStream !== 'function') {
      throw new Error('این مرورگر فایل اکسل را باز نمی‌کند؛ فایل را در اکسل «ذخیره به‌صورت CSV» کنید و همان را بارگذاری کنید.');
    }
    const stream = new global.Blob([raw]).stream().pipeThrough(new global.DecompressionStream('deflate-raw'));
    const buf = await new global.Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /* ── پارس اجزای اکسل ──────────────────────────────────────────── */
  function parseSharedStrings(xml) {
    if (!xml) return [];
    const out = [];
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml))) {
      const texts = [];
      const tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let t;
      while ((t = tre.exec(m[1]))) texts.push(xmlUnescape(t[1]));
      out.push(texts.join(''));
    }
    return out;
  }

  function parseRels(xml) {
    const map = new Map();
    if (!xml) return map;
    const re = /<Relationship\b([^>]*)\/?>/g;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = m[1];
      const id = (/\bId="([^"]+)"/.exec(attrs) || [])[1];
      const target = (/\bTarget="([^"]+)"/.exec(attrs) || [])[1];
      if (id && target) map.set(id, target.replace(/^\/?xl\//, '').replace(/^\.\//, ''));
    }
    return map;
  }

  function parseWorkbook(xml) {
    const sheets = [];
    if (!xml) return sheets;
    const re = /<sheet\b([^>]*)\/?>/g;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = m[1];
      const name = xmlUnescape((/\bname="([^"]*)"/.exec(attrs) || [])[1] || ('برگهٔ ' + (sheets.length + 1)));
      const rid = (/\br:id="([^"]+)"/.exec(attrs) || [])[1] || '';
      sheets.push({ name, rid });
    }
    return sheets;
  }

  function parseSheet(xml, shared) {
    const rows = [];
    if (!xml) return rows;
    const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const rowNum = Number((/\br="(\d+)"/.exec(rm[1]) || [])[1] || (rows.length + 1));
      const cells = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cellRe.exec(rm[2]))) {
        const attrs = cm[1] || '';
        const body = cm[2] || '';
        const ref = (/\br="([A-Z]+\d+)"/i.exec(attrs) || [])[1] || '';
        const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || 'n';
        let value = '';
        if (type === 's') {
          const idx = Number((/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1]);
          value = shared[idx] != null ? shared[idx] : '';
        } else if (type === 'inlineStr') {
          const texts = [];
          const tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
          let t;
          while ((t = tre.exec(body))) texts.push(xmlUnescape(t[1]));
          value = texts.join('');
        } else if (type === 'str') {
          value = xmlUnescape((/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1] || '');
        } else if (type === 'b') {
          value = (String((/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1] || '') === '1') ? '1' : '0';
        } else {
          value = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1] || '';
        }
        const idx = ref ? colIndex(ref) : cells.length;
        if (idx >= 0) cells[idx] = String(value).trim();
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = '';
      rows[rowNum - 1] = cells;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return rows;
  }

  /* ── API اصلی ─────────────────────────────────────────────────── */
  async function read(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    const entries = zipEntries(u8);
    const get = async (name) => {
      const e = entries.get(name);
      if (!e) return null;
      const bytes = await readEntry(u8, e);
      return bytes ? utf8(bytes) : null;
    };
    const shared = parseSharedStrings(await get('xl/sharedStrings.xml'));
    const wb = await get('xl/workbook.xml');
    const rels = parseRels(await get('xl/_rels/workbook.xml.rels'));
    let list = parseWorkbook(wb);
    if (!list.length) list = [{ name: 'برگهٔ ۱', rid: '' }];
    const sheets = [];
    for (const s of list) {
      const target = rels.get(s.rid) || ('worksheets/sheet' + (sheets.length + 1) + '.xml');
      const path = target.startsWith('xl/') ? target : 'xl/' + target;
      let xml = await get(path);
      if (!xml) xml = await get('xl/worksheets/sheet' + (sheets.length + 1) + '.xml');
      if (!xml) continue;
      sheets.push({ name: s.name, rows: parseSheet(xml, shared) });
    }
    if (!sheets.length) throw new Error('هیچ برگه‌ای در این فایل اکسل پیدا نشد.');
    return { sheets };
  }

  /* CSV/TSV — جداکننده خودکار تشخیص داده می‌شود (کاما، نقطه‌ویرگول، تب) */
  function fromCsv(text) {
    const src = String(text || '').replace(/^\uFEFF/, '');
    const firstLine = (src.split(/\r?\n/)[0] || '');
    let sep = ',';
    const counts = [[',', (firstLine.match(/,/g) || []).length], [';', (firstLine.match(/;/g) || []).length], ['\t', (firstLine.match(/\t/g) || []).length]];
    counts.sort((a, b) => b[1] - a[1]);
    if (counts[0][1] > 0) sep = counts[0][0];

    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return { sheets: [{ name: 'CSV', rows }] };
  }

  const api = { read, fromCsv, xmlUnescape, colIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PayeshXlsx = api;
})(typeof window !== 'undefined' ? window : globalThis);
