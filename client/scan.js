'use strict';
/* ═══════════════════════════════════════════════════════════════════
   اسکن کد پیوند — هم با دوربین، هم از روی عکسِ گالری.

   چرا این فایل؟ کاربر گفت: «برای کد پیوند هیچ گزینه‌ای نزاشتی تا اسکن
   دوربین باز بشه… باید هم از دوربین اسکن کنه و هم از روی عکس توی
   گالری». پس یک صفحهٔ اسکن داریم که در هر سه محیط کار می‌کند:

     ۱) برنامهٔ اندروید: دوربینِ زنده با پل بومی (PayeshNative.scanQr)
        و انتخاب عکس از گالری با (PayeshNative.pickQr).
     ۲) مرورگرهایی که BarcodeDetector دارند: عکس یا دوربین مستقیم.
     ۳) هر جای دیگر: پیام روشن + کادر زدنِ دستی کد (هیچ‌وقت بن‌بست).

   کد پیوند دیگر یک‌بارمصرف نیست؛ تا مدیر «کد تازه» نسازد کار می‌کند.
   ═══════════════════════════════════════════════════════════════════ */

/* کد را از هر متنی که اسکن شد بیرون می‌کشد:
   payesh://pair?c=ABCD1234 · https://…/#/pair=ABCD1234 · #/pair?c=… · خودِ کد */
function scanExtractCode(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '';
  const patterns = [
    /[?&]c=([A-Za-z0-9-]{4,})/,
    /#\/(?:pair|join)[=\/]?([A-Za-z0-9-]{4,})/,
    /payesh:\/\/pair[^A-Za-z0-9]*([A-Za-z0-9-]{4,})/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return m[1].replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  }
  /* متن ساده: «ABCD-1234» یا «ABCD1234» */
  const bare = t.replace(/\s+/g, '');
  if (/^[A-Za-z0-9-]{6,14}$/.test(bare) && !/^https?:/i.test(t)) {
    return bare.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  }
  return '';
}

function scanStatus(msg, tone) {
  const box = document.getElementById('scan-status');
  if (!box) return;
  box.innerHTML = msg || '';
  box.style.color = tone === 'err' ? '#b91c1c' : tone === 'ok' ? '#0f766e' : '';
}

/* نتیجهٔ اسکنِ بومی (اندروید) به اینجا می‌رسد */
function payeshOnQr(text) {
  const code = scanExtractCode(text);
  if (!code) {
    scanStatus('این QR کدِ پایش نبود. کارت پیوند مدرسه را اسکن کنید.', 'err');
    if (typeof toast === 'function') toast('کد پیوند در این QR پیدا نشد', 'err');
    return;
  }
  scanPairWithCode(code);
}

function payeshOnQrError(reason) {
  const map = {
    cancel: 'اسکن لغو شد.',
    no_code: 'در این عکس کدی پیدا نشد — عکس واضح‌تری از همان کارت بگیرید.',
    camera_denied: 'اجازهٔ دوربین داده نشد — از گالری عکس انتخاب کنید یا کد را دستی بزنید.',
    no_camera: 'دوربین در دسترس نیست — از گالری عکس انتخاب کنید.',
  };
  scanStatus(map[String(reason || '')] || 'اسکن انجام نشد.', 'err');
}

async function scanPairWithCode(code) {
  const clean = String(code || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (clean.length < 6) { scanStatus('کد پیوند ناقص است — کد کاملِ روی کارت را بزنید.', 'err'); return; }
  scanStatus('کد «' + clean.slice(0, 4) + '-' + clean.slice(4) + '» خوانده شد — در حال ورود…');
  try {
    const r = await api('/api/auth/pair', {
      method: 'POST',
      body: { code: clean, platform: (typeof platformName === 'function' ? platformName() : 'web'), name: (typeof deviceName === 'function' ? deviceName() : 'گوشی') },
    });
    saveDevice(r.device_token);
    saveSession(r.session.token);
    S.user = r.user; S.role = r.user.role;
    scanStatus('خوش آمدید ' + (r.user.name || ''), 'ok');
    if (typeof toast === 'function') toast('وارد شدید — ' + (r.user.name || ''), 'ok');
    location.hash = '#/home';
    if (typeof start === 'function') await start();
  } catch (e) {
    const map = {
      bad_code: 'این کد در سامانه نیست — کارت را دوباره بگیرید.',
      code_revoked: 'این کارت باطل شده — مدیر کد تازه ساخته است؛ کارت تازه را بگیرید.',
      code_used: 'این کارت باطل شده — کارت تازه بگیرید.',
      code_expired: 'این کد منقضی شده — کارت تازه بگیرید.',
      user_inactive: 'حساب این کارت غیرفعال است.',
      rate_limited: 'تلاش‌های زیاد — یک دقیقه بعد دوباره امتحان کنید.',
    };
    const msg = map[String((e && e.message) || '')] || ('ورود نشد: ' + ((e && e.message) || 'خطای نامشخص'));
    scanStatus('⚠️ ' + msg, 'err');
  }
}

/* فایل یا دوربین داخل مرورگر (بدون پل بومی) */
async function scanImageFile(file) {
  if (!file) return;
  scanStatus('در حال خواندن عکس…');
  const BD = (typeof window !== 'undefined') && (window.BarcodeDetector || null);
  if (!BD) {
    scanStatus('این مرورگر اسکنِ داخل برنامه را پشتیبانی نمی‌کند — با دوربین گوشی روی QR بگیرید یا کد را دستی بزنید.', 'err');
    return;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const found = await new BD({ formats: ['qr_code'] }).detect(bitmap);
    if (!found || !found.length) { payeshOnQrError('no_code'); return; }
    payeshOnQr(found[0].rawValue || '');
  } catch (e) {
    payeshOnQrError('no_code');
  }
}

/* ── انتخاب فایل (گالری یا دوربینِ خود گوشی) در مرورگر ── */
function scanPickFile(withCamera) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  if (withCamera) input.setAttribute('capture', 'environment');
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    input.remove();
    if (f) scanImageFile(f);
  });
  document.body.appendChild(input);
  input.click();
}

/* ── دوربینِ زنده در مرورگرهایی که BarcodeDetector دارند ── */
let SCAN_STREAM = null;
function scanStopCamera() {
  try { if (SCAN_STREAM) SCAN_STREAM.getTracks().forEach(t => t.stop()); } catch (e) { /* noop */ }
  SCAN_STREAM = null;
  const box = document.getElementById('scan-camera-box');
  if (box) box.remove();
}

async function scanLiveCamera() {
  const BD = window.BarcodeDetector;
  if (!BD || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    /* بدون اسکنرِ مرورگر: دوربینِ خود گوشی با یک عکس */
    scanStatus('دوربین برنامه در این مرورگر باز نمی‌شود — از دوربین گوشی عکس بگیرید…');
    scanPickFile(true);
    return;
  }
  scanStatus('در حال روشن‌کردن دوربین…');
  try {
    SCAN_STREAM = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    payeshOnQrError('camera_denied');
    return;
  }
  const wrap = document.createElement('div');
  wrap.id = 'scan-camera-box';
  wrap.style.cssText = 'position:relative;margin-top:10px;border-radius:14px;overflow:hidden;background:#000';
  wrap.innerHTML = '<video playsinline muted style="width:100%;display:block"></video>'
    + '<button type="button" data-act="scan-stop" style="position:absolute;inset-inline-end:8px;top:8px">✕</button>';
  const host = document.getElementById('scan-status');
  if (host && host.parentNode) host.parentNode.insertBefore(wrap, host.nextSibling);
  const video = wrap.querySelector('video');
  video.srcObject = SCAN_STREAM;
  await video.play().catch(() => {});
  const detector = new BD({ formats: ['qr_code'] });
  const tick = async () => {
    if (!SCAN_STREAM) return;
    try {
      const found = await detector.detect(video);
      if (found && found.length) {
        const text = found[0].rawValue || '';
        scanStopCamera();
        payeshOnQr(text);
        return;
      }
    } catch (e) { /* فریم بعدی */ }
    setTimeout(tick, 220);
  };
  scanStatus('دوربین روشن است — QR کارت را داخل کادر بگیرید.');
  tick();
}

function scanNativeAvailable() {
  try { return !!(window.PayeshNative && window.PayeshNative.scanQr); } catch (e) { return false; }
}

function scanPageBody() {
  return `<div class="card">
    <b>📷 اسکن کارت پیوند</b>
    <div class="small muted" style="margin-top:6px;line-height:2">
      کد پیوند روی کارتی است که مدیر مدرسه چاپ کرده. با دوربین یا از روی عکسِ گالری بخوانید — بدون هیچ رمزی.
    </div>
    <div class="row" style="gap:8px;margin-top:12px">
      <button class="btn primary grow" data-act="scan-camera">📷 اسکن با دوربین</button>
      <button class="btn grow" data-act="scan-gallery">🖼️ عکس از گالری</button>
    </div>
    <div id="scan-status" class="small" style="margin-top:10px;min-height:20px"></div>
    <div class="small muted" style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--line);line-height:2">
      دوربین باز نشد؟ کد کارت را همین‌جا بزنید:
    </div>
    <form data-form="scan-code" style="margin-top:8px">
      <div class="row" style="gap:8px">
        <input class="input ltr grow" name="code" placeholder="XXXX-XXXX" maxlength="12" autocomplete="off">
        <button class="btn" type="submit">ورود</button>
      </div>
    </form>
  </div>
  <div class="small muted" style="line-height:2">
    هر کد پیوند تا وقتی مدیر «کد تازه» نسازد کار می‌کند؛ لازم نیست برای هر دستگاه کد تازه بگیرید.
  </div>`;
}

if (window.PAGES) {
  window.PAGES.scan = () => (typeof pageHead === 'function'
    ? pageHead('اسکن کد پیوند', 'دوربین یا گالری — بدون رمز', '<button class="btn sm ghost" data-act="goto" data-route="home">بازگشت</button>') + scanPageBody()
    : scanPageBody());
}

/* صفحهٔ اسکن پیش از ورود (وقتی هنوز نشستی نیست) */
function renderScanPage() {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = `<div class="auth">
    <img class="logo-img" src="/icons/logo.png" alt="پایش">
    <h1>اسکن کد پیوند</h1>
    <div class="sub">دوربین را روی QR کارت بگیرید یا از گالری عکس انتخاب کنید</div>
    ${scanPageBody()}
    <div class="card tight small muted center">
      <a href="#" data-act="login-mode" data-id="password">ورود با شمارهٔ همراه و رمز عبور</a>
    </div>
  </div>`;
}

window.scanExtractCode = scanExtractCode;
window.scanPairWithCode = scanPairWithCode;
window.scanImageFile = scanImageFile;
window.scanNativeAvailable = scanNativeAvailable;
window.scanLiveCamera = scanLiveCamera;
window.scanStopCamera = scanStopCamera;
window.scanPickFile = scanPickFile;
window.payeshOnQr = payeshOnQr;
window.payeshOnQrError = payeshOnQrError;
window.renderScanPage = renderScanPage;
