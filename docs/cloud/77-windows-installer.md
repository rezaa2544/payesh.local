# ۷۷ — نصب‌کنندهٔ Windows اپ بومی (Inno Setup) با دروازهٔ ۶۳

> وضعیت: پیاده‌سازی و آزموده روی `windows-latest` (ردیف ۷۷). نصب روی ویندوز تمیز واقعی = **OWNER**.

## ۱. ساختار
- اسکریپت: `apps/payesh/app/windows/installer/payesh-native.iss` — AppId اختصاصی `{F022A94A-885F-4620-9730-3E5EF0086EBE}` (جدا از نصب‌کنندهٔ سرور مدرسه `7C4E2A51…` و پنل مالک `20AE76FD…`)، نصب **per-user** در `{localappdata}\Programs\PayeshNative` بدون نیاز به مدیر.
- محتوا: `build\windows\x64\runner\Release\*` (`payesh_app.exe`، `flutter_windows.dll`، `data\app.so`، `data\icudtl.dat`، …).
- `#error` در زمان کامپایل اگر `node.exe` یا `WebView2Loader.dll` در بسته باشد (اپ بومی نه Node دارد نه WebView).
- runtime MSVC به‌صورت app-local (`msvcp140`، `vcruntime140`، `vcruntime140_1` از `Microsoft.VC143.CRT`) کنار exe کپی می‌شود ⇒ ویندوز تمیز بدون VC++ Redistributable هم اجرا می‌کند؛ با `dumpbin /dependents` بررسی می‌شود (`MSVC-APP-LOCAL-OK`).

## ۲. مراحل CI (job ویندوز در `native-client.yml`)
1. ساخت `flutter build windows --release` و دروازهٔ ۶۳ روی خروجی.
2. امضای Authenticode اختیاری `payesh_app.exe` (Secrets `PAYESH_WIN_PFX_B64` / `PAYESH_WIN_PFX_PASS`).
3. ISCC (`choco install innosetup`)، نسخه از `pubspec.yaml` ⇒ `native-out\payesh-native-setup.exe`؛ امضای اختیاری نصب‌کننده.
4. نصب بی‌صدا `/VERYSILENT /CURRENTUSER`، بررسی فایل‌ها و کلید رجیستری AppId، نبودن AppId بیگانه، **دروازهٔ ۶۳ روی پوشهٔ نصب‌شده**، بررسی MSVC، حذف نصب ⇒ `INSTALLER-77-OK` در `native-out\installer-77.txt`.
5. وضعیت Authenticode: با Secrets باید `Valid`، بدون آن `NotSigned` (هر حالت دیگر = خطا) و `SHA256SUMS-installer`.
6. پاک‌کردن pfx موقت.

## ۳. Secrets (اختیاری، OWNER)
| نام | کاربرد |
|---|---|
| `PAYESH_WIN_PFX_B64` | گواهی code-signing (PFX، base64) |
| `PAYESH_WIN_PFX_PASS` | رمز PFX |
بدون آن‌ها نصب‌کننده ساخته و آزموده می‌شود ولی امضا ندارد (SmartScreen هشدار می‌دهد).

## ۴. آزمون
`tests/android-release-76.js` بخش W (W-3..W-6): AppId یکتا، `#error` برای node.exe/WebView2، per-user، مراحل نصب/دروازه/حذف در workflow. اجرای واقعی روی `windows-latest` در هر PR مرتبط.

## ۵. OWNER
1. نصب روی ویندوز ۱۰/۱۱ تمیز واقعی، اجرای اپ و ورود (برچسب M).
2. در صورت تمایل، تهیهٔ گواهی code-signing و تنظیم دو Secret بالا.
