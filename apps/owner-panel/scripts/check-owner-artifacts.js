#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   گیت خروجی‌های پنل مالک — PR‑4 · ردیف ۹۹ · ADR‑62        (OWNER-ARTIFACTS)

   هر job ساخت، خروجی خودش را همراه یک meta (‎<name>.meta.json) می‌دهد:
     { name, sha256, size, signed, signature? }
   این گیت fail-closed قرمز می‌شود اگر:
     G1  یکی از سه خروجی ثابت نباشد یا خالی/کوچک‌تر از حداقل باشد
     G2  امضای فایل (magic) نادرست باشد (exe ⇒ MZ، apk/zip ⇒ PK)
     G3  sha256 فایل با meta همان job برابر نباشد
     G4  ساختار داخلی ناقص باشد (zip: web/index.html، app.js، static-server،
         BUILD-INFO با commit درست؛ apk: AndroidManifest.xml و classes.dex)
     G5  meta ادعای «امضاشده» کند ولی شاهد امضا نداشته باشد
         (apk: v2+v3 و اثر انگشت گواهی؛ exe: Authenticode=Valid و thumbprint)
     G6  نام خروجی‌ها با نام‌های ثابت یکی نباشد یا فایل ناشناخته‌ای کنار آن‌ها باشد
   خروجی:
     SHA256SUMS            همهٔ خروجی‌های ساخته‌شده (قالب sha256sum)
     SHA256SUMS.release    فقط خروجی‌های مجاز انتشار: وب؛ exe (امضاشده، یا امضانشده با برچسب
                           «unsigned-smartscreen-warning» — افزودهٔ مالک بر D‑44، ۱۴۰۵/۰۸/۱۹)؛
                           apk فقط اگر امضای تأییدشده دارد
     owner-artifacts-status.json
   اجرا:
     node check-owner-artifacts.js meta  --file <f> --signed false|true [--signature '<json>']
     node check-owner-artifacts.js verify --dir <dir> [--commit <sha>] [--out <dir>]
     node check-owner-artifacts.js --self-test
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { readZip, buildZip } = require('./zip-lite.js');

const ARTIFACTS = [
  { name: 'payesh-owner-setup.exe', kind: 'exe', min: 200 * 1024 },
  { name: 'payesh-owner.apk', kind: 'apk', min: 8 * 1024 },
  { name: 'payesh-owner-web.zip', kind: 'web', min: 8 * 1024 },
];
const NAMES = ARTIFACTS.map(a => a.name);
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const HEX = n => new RegExp(`^[0-9a-f]{${n}}$`);

function signatureProblem(kind, meta) {
  if (meta.signed !== true) return meta.signed === false ? null : 'signed must be boolean';
  const s = meta.signature || {};
  if (kind === 'apk') {
    if (s.scheme_v2 !== true || s.scheme_v3 !== true) return 'signed apk without verified v2+v3 schemes';
    if (!HEX(64).test(String(s.cert_sha256 || ''))) return 'signed apk without certificate sha256';
    return null;
  }
  if (kind === 'exe') {
    if (s.authenticode !== 'Valid') return 'signed exe without Authenticode=Valid';
    if (!HEX(40).test(String(s.thumbprint || '').toLowerCase())) return 'signed exe without certificate thumbprint';
    return null;
  }
  return 'web bundle cannot claim a code signature';
}

function verify(dir, { commit = '' } = {}) {
  const errors = [];
  const artifacts = [];
  let present = [];
  try { present = fs.readdirSync(dir); } catch (e) { errors.push(`G1 artifact dir missing: ${dir}`); }
  for (const f of present) {
    if (NAMES.includes(f) || NAMES.some(n => f === n + '.meta.json')) continue;
    if (['SHA256SUMS', 'SHA256SUMS.release', 'owner-artifacts-status.json'].includes(f)) continue;
    errors.push(`G6 unexpected file next to artifacts: ${f}`);
  }
  for (const a of ARTIFACTS) {
    const file = path.join(dir, a.name);
    if (!fs.existsSync(file)) { errors.push(`G1 missing artifact: ${a.name}`); continue; }
    const buf = fs.readFileSync(file);
    if (buf.length < a.min) { errors.push(`G1 artifact too small: ${a.name} (${buf.length} < ${a.min})`); continue; }
    const magicOk = a.kind === 'exe' ? buf[0] === 0x4d && buf[1] === 0x5a : buf.readUInt32LE(0) === 0x04034b50;
    if (!magicOk) { errors.push(`G2 wrong file type: ${a.name}`); continue; }
    const digest = sha256(buf);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(file + '.meta.json', 'utf8')); } catch (e) { errors.push(`G3 meta missing/invalid: ${a.name}.meta.json`); continue; }
    if (meta.name !== a.name) errors.push(`G6 meta name mismatch: ${meta.name} != ${a.name}`);
    if (meta.sha256 !== digest) errors.push(`G3 checksum mismatch: ${a.name}`);
    if (meta.size !== buf.length) errors.push(`G3 size mismatch: ${a.name}`);
    const sp = signatureProblem(a.kind, meta);
    if (sp) errors.push(`G5 ${a.name}: ${sp}`);
    if (a.kind !== 'exe') {
      let entries = null;
      try { entries = readZip(buf); } catch (e) { errors.push(`G4 ${a.name}: ${e.message}`); }
      if (entries && a.kind === 'apk') {
        for (const need of ['AndroidManifest.xml', 'classes.dex', 'resources.arsc']) {
          if (!entries.has(need)) errors.push(`G4 ${a.name}: missing ${need}`);
        }
      }
      if (entries && a.kind === 'web') {
        for (const need of ['web/index.html', 'web/app.js', 'web/theme.css', 'server/static-server.js', 'BUILD-INFO.json']) {
          if (!entries.has('payesh-owner-web/' + need)) errors.push(`G4 ${a.name}: missing ${need}`);
        }
        const info = entries.get('payesh-owner-web/BUILD-INFO.json');
        if (info) {
          let bi = null;
          try { bi = JSON.parse(info.toString('utf8')); } catch (e) { errors.push(`G4 ${a.name}: BUILD-INFO.json invalid`); }
          if (bi && commit && bi.commit !== commit) errors.push(`G4 ${a.name}: BUILD-INFO commit ${bi.commit} != ${commit}`);
          if (bi && Array.isArray(bi.files)) {
            for (const f of bi.files) {
              const d = entries.get('payesh-owner-web/' + f.path);
              if (!d || sha256(d) !== f.sha256) errors.push(`G4 ${a.name}: BUILD-INFO hash mismatch ${f.path}`);
            }
          }
        }
      }
    }
    const signed = meta.signed === true && !sp;
    artifacts.push({
      name: a.name, kind: a.kind, size: buf.length, sha256: digest,
      signed,
      signing: a.kind === 'web' ? 'n/a' : signed ? 'signed-verified'
        : a.kind === 'exe' ? 'unsigned-smartscreen-warning' : 'unsigned-test-only',
      /* وب همیشه؛ exe حتی امضانشده (با برچسب و SHA256)؛ APK فقط با امضای تأییدشده */
      release_eligible: a.kind === 'apk' ? signed : true,
      signature: signed ? meta.signature : undefined,
    });
  }
  return { ok: errors.length === 0, errors, artifacts };
}

function sumsText(list) {
  return list.slice().sort((a, b) => (a.name < b.name ? -1 : 1)).map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n';
}

function writeOutputs(outDir, result, commit) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), sumsText(result.artifacts));
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.release'), sumsText(result.artifacts.filter(a => a.release_eligible)));
  fs.writeFileSync(path.join(outDir, 'owner-artifacts-status.json'), JSON.stringify({
    gate: 'GREEN', commit, adr: 'ADR-62',
    official_release: false,
    note: 'apk is published only with a verified signature; exe may be published unsigned (labelled, SmartScreen warning, verify SHA256); device install not verified [?]',
    published_unsigned: result.artifacts.filter(a => a.release_eligible && a.kind !== 'web' && !a.signed).map(a => a.name),
    artifacts: result.artifacts,
  }, null, 2) + '\n');
}

function writeMeta(file, signed, signature) {
  const buf = fs.readFileSync(file);
  const meta = { name: path.basename(file), size: buf.length, sha256: sha256(buf), signed };
  if (signature) meta.signature = signature;
  fs.writeFileSync(file + '.meta.json', JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

/* ── خودآزمایی با کنترل‌های منفی ─────────────────────────────────── */
function selfTest() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-artifacts-'));
  const COMMIT = 'a'.repeat(40);
  const pad = n => crypto.randomBytes(n);
  function fixture(dir, mutate = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const exe = Buffer.concat([Buffer.from('MZ'), pad(210 * 1024)]);
    const apk = buildZip([
      { name: 'AndroidManifest.xml', data: pad(2000) }, { name: 'classes.dex', data: pad(9000) },
      { name: 'resources.arsc', data: pad(1000) },
    ]);
    const webFiles = ['web/index.html', 'web/app.js', 'web/theme.css', 'server/static-server.js']
      .map(n => ({ name: n, data: pad(3000) }));
    const info = { name: 'payesh-owner-web', commit: COMMIT, files: webFiles.map(f => ({ path: f.name, sha256: sha256(f.data) })) };
    const web = buildZip([...webFiles, { name: 'BUILD-INFO.json', data: Buffer.from(JSON.stringify(info)) }]
      .map(f => ({ name: 'payesh-owner-web/' + f.name, data: f.data })));
    const files = { 'payesh-owner-setup.exe': exe, 'payesh-owner.apk': apk, 'payesh-owner-web.zip': web };
    for (const [n, b] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, n), b);
      writeMeta(path.join(dir, n), false);
    }
    if (mutate.apply) mutate.apply(dir);
    return dir;
  }
  const good = verify(fixture(path.join(base, 'good')), { commit: COMMIT });
  if (!good.ok) throw new Error('self-test: positive fixture must be green: ' + good.errors.join('; '));
  const gApk = good.artifacts.find(a => a.name === 'payesh-owner.apk');
  const gExe = good.artifacts.find(a => a.name === 'payesh-owner-setup.exe');
  if (gApk.release_eligible) throw new Error('self-test: unsigned apk must never be release-eligible');
  if (!gExe.release_eligible || gExe.signed || gExe.signing !== 'unsigned-smartscreen-warning') {
    throw new Error('self-test: unsigned exe must be release-eligible only with the unsigned-smartscreen-warning label');
  }
  const p = (d, n) => path.join(d, n);
  const CASES = [
    ['missing exe', /G1 missing artifact: payesh-owner-setup\.exe/, d => fs.rmSync(p(d, 'payesh-owner-setup.exe'))],
    ['missing apk', /G1 missing artifact: payesh-owner\.apk/, d => fs.rmSync(p(d, 'payesh-owner.apk'))],
    ['missing web zip', /G1 missing artifact: payesh-owner-web\.zip/, d => fs.rmSync(p(d, 'payesh-owner-web.zip'))],
    ['empty apk', /G1 artifact too small: payesh-owner\.apk/, d => fs.writeFileSync(p(d, 'payesh-owner.apk'), '')],
    ['exe without MZ', /G2 wrong file type: payesh-owner-setup\.exe/, d => {
      const b = fs.readFileSync(p(d, 'payesh-owner-setup.exe')); b[0] = 0; fs.writeFileSync(p(d, 'payesh-owner-setup.exe'), b);
    }],
    ['checksum mismatch', /G3 checksum mismatch: payesh-owner-setup\.exe/, d => {
      const b = fs.readFileSync(p(d, 'payesh-owner-setup.exe')); b[b.length - 1] ^= 0xff; fs.writeFileSync(p(d, 'payesh-owner-setup.exe'), b);
    }],
    ['meta missing', /G3 meta missing\/invalid: payesh-owner\.apk/, d => fs.rmSync(p(d, 'payesh-owner.apk.meta.json'))],
    ['apk claims signed without evidence', /G5 payesh-owner\.apk: signed apk without verified v2\+v3/, d => {
      writeMeta(p(d, 'payesh-owner.apk'), true, { scheme_v2: true });
    }],
    ['exe claims signed with NotSigned', /G5 payesh-owner-setup\.exe: signed exe without Authenticode=Valid/, d => {
      writeMeta(p(d, 'payesh-owner-setup.exe'), true, { authenticode: 'NotSigned', thumbprint: 'b'.repeat(40) });
    }],
    ['web claims signature', /G5 payesh-owner-web\.zip: web bundle cannot claim/, d => writeMeta(p(d, 'payesh-owner-web.zip'), true, {})],
    ['apk without classes.dex', /G4 payesh-owner\.apk: missing classes\.dex/, d => {
      fs.writeFileSync(p(d, 'payesh-owner.apk'), buildZip([{ name: 'AndroidManifest.xml', data: pad(9000) }, { name: 'resources.arsc', data: pad(100) }]));
      writeMeta(p(d, 'payesh-owner.apk'), false);
    }],
    ['web zip missing index.html', /G4 payesh-owner-web\.zip: missing web\/index\.html/, d => {
      const m = readZip(fs.readFileSync(p(d, 'payesh-owner-web.zip')));
      m.delete('payesh-owner-web/web/index.html');
      fs.writeFileSync(p(d, 'payesh-owner-web.zip'), buildZip([...m].map(([name, data]) => ({ name, data }))));
      writeMeta(p(d, 'payesh-owner-web.zip'), false);
    }],
    ['web zip from another commit', /G4 payesh-owner-web\.zip: BUILD-INFO commit/, d => {
      const m = readZip(fs.readFileSync(p(d, 'payesh-owner-web.zip')));
      const bi = JSON.parse(m.get('payesh-owner-web/BUILD-INFO.json')); bi.commit = 'c'.repeat(40);
      m.set('payesh-owner-web/BUILD-INFO.json', Buffer.from(JSON.stringify(bi)));
      fs.writeFileSync(p(d, 'payesh-owner-web.zip'), buildZip([...m].map(([name, data]) => ({ name, data }))));
      writeMeta(p(d, 'payesh-owner-web.zip'), false);
    }],
    ['corrupt zip crc', /G4 payesh-owner-web\.zip: (crc mismatch|invalid|incorrect|unexpected)/i, d => {
      const b = fs.readFileSync(p(d, 'payesh-owner-web.zip'));
      b[Math.floor(b.length / 3)] ^= 0xff; fs.writeFileSync(p(d, 'payesh-owner-web.zip'), b); writeMeta(p(d, 'payesh-owner-web.zip'), false);
    }],
    ['unexpected extra artifact', /G6 unexpected file next to artifacts: app-release-unsigned\.apk/, d => {
      fs.writeFileSync(p(d, 'app-release-unsigned.apk'), 'x');
    }],
  ];
  let n = 0;
  for (const [label, expect, apply] of CASES) {
    const r = verify(fixture(path.join(base, 'neg-' + n), { apply }), { commit: COMMIT });
    n++;
    if (r.ok) throw new Error(`self-test: negative control "${label}" stayed green`);
    if (!r.errors.some(e => expect.test(e))) throw new Error(`self-test: "${label}" red for the wrong reason: ${r.errors.join('; ')}`);
  }
  // مثبت امضاشده: شاهد کامل ⇒ مجاز انتشار
  const signedDir = fixture(path.join(base, 'signed'), { apply: d => {
    writeMeta(p(d, 'payesh-owner.apk'), true, { scheme_v2: true, scheme_v3: true, cert_sha256: 'd'.repeat(64) });
    writeMeta(p(d, 'payesh-owner-setup.exe'), true, { authenticode: 'Valid', thumbprint: 'E'.repeat(40) });
  } });
  const sg = verify(signedDir, { commit: COMMIT });
  if (!sg.ok || sg.artifacts.filter(a => a.release_eligible).length !== 3) throw new Error('self-test: verified signatures must be release-eligible');
  fs.rmSync(base, { recursive: true, force: true });
  console.log(`OWNER-ARTIFACTS-SELFTEST negative_controls=${n} positives=2 failures=0`);
  return n;
}

module.exports = { verify, writeMeta, writeOutputs, sumsText, selfTest, ARTIFACTS, NAMES, signatureProblem };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  try {
    if (argv.includes('--self-test')) { selfTest(); process.exit(0); }
    if (argv[0] === 'meta') {
      const signed = arg('signed', '');
      if (signed !== 'true' && signed !== 'false') throw new Error('--signed true|false is required');
      const sig = arg('signature', '') ? JSON.parse(arg('signature')) : undefined;
      const m = writeMeta(path.resolve(arg('file')), signed === 'true', sig);
      console.log(`OWNER-ARTIFACT-META ${m.name} size=${m.size} sha256=${m.sha256} signed=${m.signed}`);
      process.exit(0);
    }
    if (argv[0] === 'verify') {
      const dir = path.resolve(arg('dir', '.'));
      const commit = arg('commit', '');
      const r = verify(dir, { commit });
      if (!r.ok) {
        for (const e of r.errors) console.log('::error title=owner-artifacts::' + e);
        console.log(`OWNER-ARTIFACTS-GATE RED errors=${r.errors.length}`);
        process.exit(1);
      }
      writeOutputs(path.resolve(arg('out', dir)), r, commit);
      for (const a of r.artifacts) console.log(`  ${a.sha256}  ${a.name}  ${a.size}B  ${a.signing}  release=${a.release_eligible}`);
      console.log(`OWNER-ARTIFACTS-GATE GREEN artifacts=${r.artifacts.length} commit=${commit || '-'}`);
      process.exit(0);
    }
    throw new Error('usage: meta | verify | --self-test');
  } catch (e) {
    console.error('OWNER-ARTIFACTS-GATE ERROR ' + e.message);
    process.exit(1);
  }
}
