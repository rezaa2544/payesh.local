# tools/web32 — نسخهٔ ویندوز ۳۲ بیتی (D‑50 / ADR‑169)

Flutter موتور ویندوز ۳۲ بیتی ندارد. نسخهٔ ۳۲ بیتی اپ مدرسه و پنل مالک **همان کد Flutter** است
(`apps/payesh/app/lib/`، `apps/payesh/owner/lib/`) که با `flutter build web` به JavaScript ترجمه می‌شود و
در یک برنامهٔ **۳۲ بیتی Chromium 109 (CEF 109.1.18)** اجرا می‌شود. Chromium 109 آخرین نسخهٔ سازگار با ویندوز ۷ است.
این نسخه **بومی خوانده نمی‌شود** و فقط روی کانال `win32-continuous` منتشر می‌شود. سند تصمیم:
[`docs/cloud/169-adr-web32-compat.md`](../../docs/cloud/169-adr-web32-compat.md).

| مسیر | چیست |
|---|---|
| `shell/` | برنامهٔ ۳۲ بیتی (C++17، CEF، `/MT`): پنجره، سرو فایل‌های `web\` از `http://payesh.localhost/` (بدون شبکه)، `window.payeshHost`، مسدود کردن پنجرهٔ بازشو، بارگذاری دوباره پس از کرش (۳ بار) |
| `installer/payesh-web32.iss` | نصب‌کنندهٔ Inno (per-user، ویندوز ۷ SP1+، AppId جدا؛ پوشه‌های `PayeshNative32` / `PayeshOwner32`)؛ بستهٔ ناقص را رد می‌کند |
| `web32-gate.mjs` | دروازه روی پوشه یا zip واقعی: PE ۳۲ بیتی، runtime کامل CEF، ساخت وب همین اپ (`payeshHost`، CanvasKit محلی)، `sqlite3mc.wasm` با sha256 ثابت، بدون node.exe / node_modules / WebView2 |
| `e2e.mjs` | آزمون سرتاسری روی برنامهٔ **نصب‌شده** با CDP: قرارداد میزبان، CORS، رد `window.open`، رندر Flutter، دیتابیس رمزنگاری‌شده، خروج |

## ساخت (CI: `.github/workflows/win32-edition.yml`)

```
# ۱) وب (لینوکس یا ویندوز) — همان نسخه‌ها و dart-defineهای نسخهٔ ۶۴ بیتی
cd apps/payesh/app   && flutter build web --release --no-web-resources-cdn --no-wasm-dry-run --no-source-maps -O2 \
       --build-name=0.2.N --dart-define=PAYESH_APP_BUILD=N --dart-define=PAYESH_SERVERS_URL=...
cd apps/payesh/owner && flutter build web --release --no-web-resources-cdn --no-wasm-dry-run --no-source-maps -O2 \
       --build-name=1.1.N --dart-define=PAYESH_OWNER_BUILD=N
# sqlite3mc.wasm (sqlite3.dart 3.9.1، sha256 408a1d9b…) کنار index.html اپ مدرسه

# ۲) برنامهٔ ۳۲ بیتی (Visual Studio، CEF windows32 minimal با sha1 ثابت)
cmake -S tools/web32/shell -B build32 -A Win32 -DCEF_ROOT=<cef_binary_109.1.18…_windows32_minimal>
cmake --build build32 --config Release      # → build32/Release/payesh_app.exe, payesh_owner.exe

# ۳) چیدمان: exe + Release\*.dll|*.bin|*.json + Resources\* + locales\{fa,en-US}.pak + web\
node tools/web32/web32-gate.mjs --app app web32-out/app --version 0.2.N
ISCC /DEdition=app /DAppVersion=0.2.N /DBundle=web32-out\app tools\web32\installer\payesh-web32.iss
```

## قرارداد میزبان — `window.payeshHost`

فقط در قاب اصلیِ مبدأ `http://payesh.localhost` نصب می‌شود. همهٔ تابع‌ها **همگام**‌اند؛ دادهٔ دودویی به‌صورت رشتهٔ
latin1 (هر بایت یک واحد UTF‑16) رد و بدل می‌شود؛ خطا یک `Error` با پیام `"<code>|<message>"` است.
لایهٔ Dart آن: `apps/payesh/packages/payesh_core/lib/src/io/web/host.dart`.

| گروه | تابع‌ها |
|---|---|
| اطلاعات | `info()` → `{os, osVersion, env, exe, pid, cpus, hostname, locale, temp, home, app, args, shell}` (`app` = `"app"` یا `"owner"`) |
| فایل | `stat`، `read`، `write`، `list`، `mkdir`، `remove`، `rename`، `copy`، `setMtime` |
| دستگیره (SQLite VFS) | `fopen`، `fread`، `fwrite`، `fsize`، `ftrunc`، `fsync`، `fclose` |
| سیستم | `dpapi` (CurrentUser)، `run` → `{pid, code, out, err}`، `spawn`، `kill`، `resolve` (DNS)، `openUrl`، `trustPem` (بی‌اثر: ریشه‌های Chromium)، `exit`، `log` |

داده‌ها همان جای نسخهٔ ۶۴ بیتی‌اند (`%LOCALAPPDATA%\Payesh`، `payesh.db` رمزنگاری‌شده با SQLite3MC/ChaCha20، کلید با DPAPI)؛
پروفایل Chromium در `%LOCALAPPDATA%\PayeshNative32` / `PayeshOwner32` و گزارش برنامه در `web32-shell.log`.
