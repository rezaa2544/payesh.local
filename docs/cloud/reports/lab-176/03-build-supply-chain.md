# گزارش ۰۳ — ساخت و زنجیرهٔ تأمین

SHA: `bd447dc4` (ساخت روی PC، از `psim\repo` پس از `reset --hard` به همین SHA؛ WIP قبلی کاربر در `stash@{0}` محفوظ است).
**یادآوری:** «ساخت موفق» یعنی بسته ساخته شد، نه این‌که محصول درست کار می‌کند. درستیِ رفتار در گزارش‌های ۰۴ تا ۱۲ سنجیده شده است.

## ۱. ساخت‌های آزمایشگاهی روی PC — [R-DEV]
| ID | خروجی | نتیجه | شاهد |
|---|---|---|---|
| BLD-AND-1 | ساخت مدرسه، تلاش ۱ | FAIL: اتصال به Kotlin daemon نشد. اصلاح: `kotlin.compiler.execution.strategy=in-process` | `evidence/pc/build-school-17601.run1-kotlin-daemon-fail.log` |
| BLD-AND-2 | تلاش ۲ | FAIL: ‏`tools/android21/build-repo.py` فایل `annotation-jvm-1.8.1.jar` را از dl.google.com می‌گیرد (404 پشت DNS جعلی PC). نسخهٔ Aliyun با sha1 ‏`b8a16fe5…` (برابر نسخهٔ رسمی) جایگذاری شد | `evidence/pc/build-school-17601.run2-android21-404.log` |
| BLD-AND-3 | تلاش ۳ (۳ ABI موازی) | FAIL: کمبود حافظه در `gen_snapshot` و کرش malloc در JVM ‏Gradle. اصلاح: فقط arm64 و توقف موقت ۱۴ کانتینر کاربر (با تأیید) | `evidence/pc/build-*-run3-OOM-3abi.log` |
| BLD-AND-4 | school-lab-17601 / 17602، owner-lab-17601 | PASS (debug-signed، arm64-v8a، minSdk 21، target 36، پسوند `.lab176`) | `evidence/pc/build-school-17601.log`، `build-school-17602.log`، `build-owner-17601.log` |
| BLD-WIN | `payesh_app.exe` 0.2.17601، `payesh_owner.exe` 1.1.17601 | PASS | `evidence/pc/build-win-app-17601.log`، `build-win-owner-17601.log` |

### هش‌ها
| بسته | sha256 | امضا |
|---|---|---|
| owner-lab-17601.apk | `a159bde8…a03c8` | CN=Android Debug ‏`e3689fa1…d20d` |
| school-lab-17602.apk (11,035,578 B) | `ac353482…9cd8` | همان |
| payesh_app.exe 0.2.17601 | `face667f…cb2c` | **NotSigned** (Authenticode) |
| payesh_owner.exe 1.1.17601 | `aff1bcd3…d861` | **NotSigned** |

## ۲. راستی‌آزمایی کش Gradle در برابر منبع رسمی — GRADLE-VERIFY
- **عدد «444/444» که پیش‌تر گزارش شده بود، اینجا نقل نمی‌شود.** لاگ خام آن در بازنشانی sandbox از بین رفت و دیگر شاهد اجرایی ندارد.
- **به‌جایش یک اجرای واقعی تازه انجام شد:** فهرست کامل کش Gradle روی PC ‏(`gradle-cache-index.full.txt`، ‏۶۱۲ مدخل، sha256 ‏`007c7765…4f47` پس از انتقال تطبیق داده شد). نام پوشهٔ هر مدخل همان SHA-1 محتوای فایل است. این SHA-1 با فایل `.sha1` رسمی همان مختصات در Maven Central / Google Maven / Gradle Plugin Portal مقایسه شد.
- **نتیجه: `GRADLE-VERIFY total=612 match=612 mismatch=0 notfound=0`**. تفکیک: repo1.maven.org ‏۳۸۰، dl.google.com ‏۲۲۷، plugins.gradle.org ‏۵.
  شاهد: `evidence/GRADLE-VERIFY.log`. بازتولید: `bash scripts/gradle-verify.sh`.
- اجرای اول ۸ «mismatch» نشان داد. علت باگ مقایسه بود: Gradle نام پوشه را بدون صفرهای ابتدایی می‌نویسد. شاهد آن تلاش جدا نگه داشته شده است (`GRADLE-VERIFY.attempt1-compare-bug.log`) و به‌عنوان نتیجه شمرده نمی‌شود.
- **محدودیت:** این بررسی می‌گوید کش با منبع رسمی برابر است. نمی‌گوید خودِ منبع رسمی سالم است.

## ۳. وابستگی‌ها
| ID | سطح | نتیجه | شاهد |
|---|---|---|---|
| FL-00 | sandbox | `flutter pub get --enforce-lockfile`، EXIT 0 | `evidence/FL-00-pub-get.log` |
| FL-01 | sandbox | گیت وابستگی‌های بومی، EXIT 0 | `evidence/FL-01-native-deps.log` |
| SEC-05 | sandbox | `npm audit`: ‏`found 0 vulnerabilities` | `evidence/SEC-05-npm-audit.log` |
| NI-01..04 | sandbox | گیت بومی (WebView/Node ممنوع) و کنترل‌های منفی: `NATIVE-GATE-63-TEST-OK`، `NATIVE-RELEASE-76-77-OK checks=28`، `NATIVE-GATE-NEGATIVE-CONTROL-OK` | `evidence/NI-01..04*.log` |

## ۴. ساخت ابری (CI)
- اجرای native-client شمارهٔ ‏#199 (`45252135389`، ‏workflow_dispatch روی `bd447dc4`): هر ۱۳ کار سبز. **ولی منتشر نکرد**، چون کارهای انتشار فقط با `event == 'push'` اجرا می‌شوند. کانال‌ها هنوز روی build 198 هستند (گزارش ۰۴).
- **قرمزِ ازپیش‌موجود:** build-and-release روی همین HEAD (`45251081712`) در «آزمون‌های سرور» شکست خورد: `sim-173 S173-07` به‌جای 200 پاسخ `429 rate_limited` گرفت. این commit فقط مستندات را تغییر داده بود و همین مجموعه روی `764d2542` سبز بود. پس آزمون sim-173 ناپایدار است (گزارش ۱۳).

## ۵. یافته‌ها
- امضای release در آزمایشگاه **آزموده نشد** (BLOCKED): کلید امضای مالک عمداً بیرون از آزمایشگاه ماند. APKهای آزمایشگاهی debug-signed هستند.
- exeهای ویندوز امضای کد ندارند و SmartScreen هشدار می‌دهد (شناخته‌شده؛ ردیف ۱۷۵).
- `android21.gradle` نشانی dl.google.com را ثابت نوشته است، پس پشت DNS جعلی، ساخت بدون mirror شکست می‌خورد (مشاهده).
