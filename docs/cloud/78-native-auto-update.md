# ۷۸ — به‌روزرسانی خودکار امضاشدهٔ اپ بومی (APK / EXE)

> وضعیت: بخش ARENA انجام شد (منطق + آزمون). کلید امضای ناشر = **OWNER** (ردیف ۶۱/۷۸) و هرگز در مخزن نیست.
> کد: `apps/payesh/packages/payesh_secure/lib/src/native_update.dart` · ابزار ناشر: `tools/native-update-78.mjs` · بردارها: [`contracts/native-update-vectors-78.json`](contracts/native-update-vectors-78.json)
> آزمون: `payesh_secure/test/native_update_test.dart` (NU-01..NU-10، در کار Flutter با پوشش ≥۸۰٪) و `tests/native-update-78.js` (NU78-01..07، در `native-client.yml`). شواهد [S]: `reports/evidence/78-native-update.txt`.

## ۱. مدل اعتماد
میزبان به‌روزرسانی (GitHub Releases، آینه، سرور مالک) **مورد اعتماد نیست**. اپ فقط مانیفستی را می‌پذیرد که امضای Ed25519 یکی از کلیدهای عمومی **پین‌شده در اپ** را داشته باشد. فایل نصب هم فقط وقتی پذیرفته می‌شود که SHA-256 و اندازه‌اش با مانیفست امضاشده یکی باشد.

```
envelope = { "format": "payesh-update-envelope/1", "key_id", "manifest_b64", "sig_b64" }
sig      = Ed25519(کلید خصوصی ناشر, بایت‌های خام مانیفست)        ← بدون canonicalization
key_id   = ۱۶ نویسهٔ اول hex از SHA-256(کلید عمومی خام)
```

مانیفست (`payesh-native-update/1`، طرح بسته — فیلد ناشناخته ⇒ رد):

| فیلد | قاعده |
|---|---|
| `channel` | `stable` \| `pilot` \| `beta`؛ باید با کانال اپ یکی باشد |
| `version` / `build` | semver / عدد صحیح مثبت |
| `published_at` / `expires_at` | ISO با `Z`؛ مانیفست منقضی ⇒ رد (آینهٔ یخ‌زده یا replay) |
| `halt` | کلید توقف ناشر |
| `artifacts.android` / `artifacts.windows` | `url` فقط **https**، `sha256` (۶۴ hex)، `size` (حداکثر ۵۱۲ MiB) |

## ۲. تصمیم اپ
| حالت | نتیجه |
|---|---|
| امضا/کلید/طرح/کانال/انقضا نادرست | `Refused(<کد>)`؛ اپ نصب‌شده بی‌تغییر کار می‌کند |
| `build` کمتر از بزرگ‌ترین build دیده‌شده | `Refused(upd_rollback)` — **downgrade ممنوع** |
| `build` = build نصب‌شده | `UpToDate` |
| `halt: true` | `Halted(publisher_halt)` — هیچ دانلودی؛ فایل‌های staged پاک می‌شوند |
| پاسخ 503 با `feature_disabled` از سرور به‌روزرسانی | `Halted(server_kill_switch)` (همان قرارداد kill-switch ردیف ۶۷) |
| نسخهٔ جدیدتر معتبر | `UpdateAvailable(autoInstall)` |

کدها: `upd_bad_envelope`، `upd_unknown_key`، `upd_bad_signature`، `upd_bad_manifest`، `upd_wrong_channel`، `upd_expired`، `upd_rollback`، `upd_no_artifact`، `upd_bad_size`، `upd_bad_hash`، `upd_server`.

## ۳. دانلود و هش
`ArtifactStager` فایل را در `update-<build>.part` می‌نویسد و هم‌زمان SHA-256 می‌گیرد. اگر حجم از مانیفست بیشتر شود، دانلود همان لحظه قطع می‌شود. اگر حجم یا هش نخواند، فایل partial **پاک** می‌شود (`upd_bad_size` / `upd_bad_hash`). فقط فایل سالم به `update-<build>.apk|exe` تغییر نام می‌دهد. **آزمون منفی NU-05: با تغییر یک بایت، هیچ فایلی روی دیسک نمی‌ماند.**

## ۴. پیش‌فرض پایلوت و بازگشت (rollback)
- نصب خودکار فقط با `--dart-define=PAYESH_UPDATE_AUTO=1` روشن می‌شود. **پیش‌فرض پایلوت خاموش است**؛ کاربر پیش از نصب تأیید می‌کند (NU-03).
- `UpdateState`: پس از نصب، build قبلی نگه داشته و build جدید «در انتظار» علامت می‌خورد. اگر build جدید در **۲ اجرا** به حالت سالم نرسد (ورود + اولین همگام‌سازی ⇒ `confirmedHealthy`)، در اجرای سوم به build محلی قبلی برمی‌گردد. کف ضد-بازگشت (`highest_seen_build`) حفظ می‌شود تا شبکه نتواند نسخهٔ قدیمی‌تری را دوباره پیشنهاد کند (NU-07/08).
- چرخش کلید: اپ چند کلید عمومی را با `key_id` می‌پذیرد (NU-09).

## ۵. ابزار ناشر (OWNER)
```
node tools/native-update-78.mjs keygen --out <پوشه‌ای بیرون از مخزن>   # 0600؛ داخل Git work tree رد می‌شود؛ هرگز بازنویسی نمی‌کند
node tools/native-update-78.mjs sign --key <pem> --manifest m.json --out pilot.json
node tools/native-update-78.mjs verify --pub <base64> --envelope pilot.json --installed 57 --highest 57
```
`sign` همان قواعد طرح را اجرا می‌کند و مثلاً URL با http را امضا نمی‌کند (NU78-03).

## ۶. آزمون‌ها
- **NU-02 / NU78-02:** ۱۴ بردار مشترک، در Dart و JS با نتیجهٔ یکسان: معتبر، هم‌نسخه، downgrade، دست‌کاری پس از امضا، کلید ناشناس، کلید مهاجم با key_id پین‌شده، منقضی، کانال دیگر، halt، فیلد اضافه، http، نبود artifact، JSON خراب، امضای کوتاه.
- **NU78-07:** هفت جهش (حذف بررسی امضا، downgrade، انقضا، کانال، halt، https یا طرح بسته)؛ هر کدام دست‌کم یک بردار را قرمز می‌کند.
- **NU78-05:** در فایل‌های ردیابی‌شدهٔ مخزن هیچ کلید خصوصی‌ای نیست؛ کلید بردارها از یک برچسب عمومی ساخته شده و فقط برای آزمون است.

## ۷. OWNER / بعدی
- ساخت کلید ناشر با `keygen` روی سیستم مالک و قرار دادن کلید عمومی در پیکربندی اپ (`UpdateConfig.publisherKeys`).
- میزبان مانیفست/فایل‌ها، و آزمایش واقعی نصب روی دستگاه [M].
- اتصال UI (پرسش از کاربر، نصب APK با `PackageInstaller` و EXE با Inno Setup بی‌صدا) در موج‌های ردیف ۷۴.
