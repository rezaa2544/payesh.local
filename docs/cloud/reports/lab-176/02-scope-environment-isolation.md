# گزارش ۰۲ — دامنه، محیط و جداسازی (آزمایشگاه ردیف ۱۷۶)

| | |
|---|---|
| مخزن | `rezaa2544/payesh.local` — شاخهٔ `main` (بدون شاخه، worktree یا clone تازه) |
| SHA آزمایش‌شده | `bd447dc402bf916df4f7ca2cc9d4f7f7ae5939df` (+ اصلاح آزمون‌های D-01/D-02: `evidence/FIX-D01-D02.diff`؛ اجراهای «پس از اصلاح» + `evidence/FIX-D04-D05.diff`) |
| بازهٔ اجرا | 2026-11-23 تا 2026-11-24 (UTC) |
| قاعدهٔ وضعیت | PASS فقط با خروجی خام + فرمان بازتولید + SHA؛ FAIL با شاهد؛ BLOCKED وقتی ابزار/دسترسی نبود |

## ۱. سطح هر آزمون (تا شبیه‌ساز با اپ واقعی اشتباه نشود)
| برچسب | معنی |
|---|---|
| **[R-DEV]** | اپ واقعی (ساخت آزمایشگاهی از همین SHA) روی دستگاه واقعی: گوشی POCO X7 Pro یا رایانهٔ ویندوزی مالک |
| **[R-SRV]** | سرور واقعی محصول (`server/index.js` یا `server/gateway.js`) به‌صورت پردازهٔ واقعی؛ در کانتینر آزمایشگاهی روی PC یا در sandbox |
| **[R-PG]** | PostgreSQL 17.11 واقعی (سرور جداگانه) |
| **[EMB]** | پایگاه دادهٔ تعبیه‌شده (PGlite/WASM) — Postgres واقعی **نیست** |
| **[SIM]** | شبیه‌ساز: کلاینت‌های ساختگی بار، شبیه‌ساز S3 یا سرور مرکزی (`tools/sim`)، بردارهای قرارداد |

## ۲. ممیزی سیستم (مرحلهٔ ۱ مأموریت)
خروجی خام: `evidence/pc/ENV-01-pc-toolchain.txt` (PC، 2026-11-24T04:19:38Z)، `evidence/pc/flutter-doctor-v.txt`، `evidence/ENV-02-sandbox-toolchain.txt`.

| مورد | مقدار | وضعیت |
|---|---|---|
| ویندوز | Windows 11 Enterprise 10.0.22631 | PASS |
| CPU / مجازی‌سازی | Ryzen 7 PRO 3700U، ۴ هسته / ۸ رشته، VirtualizationFirmwareEnabled=True | PASS |
| RAM | ۱۳٫۹ GB (۳٫۸ GB آزاد هنگام ممیزی) | PASS با محدودیت: ساخت هم‌زمان ۳ ABI با کمبود حافظه شکست خورد، پس فقط arm64 ساخته شد (گزارش ۰۳) |
| SSD | SK hynix SC300 ‏۲۳۸ GB؛ C: ‏۲۷٫۲ GB آزاد | PASS (فضا تنگ است) |
| WSL2 | پیش‌فرض Ubuntu، نسخهٔ ۲ | PASS |
| Docker / Compose | Engine 29.8.2 (Desktop 4.95.0) / Compose v5.6.0 | PASS |
| Git | 2.55.0.windows.3 | PASS |
| Node / npm (PC) | v24.21.0 / 11.19.0 | VERSION_MISMATCH: CI روی Node 22 سنجاق است. آزمون‌های Node در sandbox با Node 22.23.5 اجرا شد |
| Flutter / Dart | 3.47.9 / 3.13.7 در `C:\lab\flutter` (برابر با سنجاق CI ‏`FLUTTER_VERSION: '3.47.9'`) | PASS؛ `dart` روی PATH سراسری نیست (MISSING روی PATH، بی‌اثر بر ساخت) |
| Android SDK | platform android-36، build-tools 36.0.0 | PASS |
| JDK 17 | Temurin 17.0.21.1 (در تنظیم Flutter) | PASS؛ `java` روی PATH سراسری 1.8 است (VERSION_MISMATCH روی PATH، بی‌اثر بر ساخت) |
| adb + گوشی | `NVCYXCF6YHKNFIJF device product:rodin_global model:2412DPC0AG` | PASS |
| Visual Studio C++ | Build Tools 2026 (18.8)، مؤلفهٔ VC.Tools.x86.x64 | PASS (جدیدتر از ۲۰۲۲) |
| PowerShell | 5.1.22621 | PASS |
| OpenSSL | روی PATH ویندوز نیست. در sandbox ‏3.5.7 است و آزمون‌های TLS آنجا اجرا شد | MISSING روی PC (برای این آزمایشگاه لازم نبود) |
| sandbox | Debian 13، ۲ هسته، ۲ GB RAM؛ Node 22.23.5، Flutter 3.47.9، PostgreSQL 17.11، OpenSSL 3.5.7 | PASS با محدودیت حافظه (گزارش ۱۴) |
| Docker/adb در sandbox | ندارد | BLOCKED در sandbox؛ روی PC انجام شد |

## ۳. وابستگی‌های مخزن (مرحلهٔ ۲)
- `npm ci` / `flutter pub get --enforce-lockfile`: هر دو سبز (FL-00، NI-09، NI-13، NI-17). قفل وابستگی رعایت شد.
- `npm audit`: صفر آسیب‌پذیری (`evidence/SEC-05-npm-audit.log`).
- PostgreSQL: CI از postgres:16 استفاده می‌کند و آزمایشگاه از **17.11**. یک ناسازگاری آزمون (D-01) فقط به همین دلیل پیدا شد.
- S3/MinIO: در آزمایشگاه از شبیه‌ساز S3 مخزن (`tools/sim`) استفاده شد **[SIM]**. هیچ S3 واقعی یا پولی به کار نرفت.

## ۴. جداسازی از سرورهای واقعی
| ID | سطح | چه شد | نتیجه | شاهد |
|---|---|---|---|---|
| EP-01 | [R-DEV] | پویش رشته‌های `libapp.so` در APKهای آزمایشگاهی | میزبان‌های واقعی **درون باینری هستند** (`app.payeshschool.ir`، `payeshschool.ir`، `raw.githubusercontent.com`، `github.com`، `s3.ir-central1.arvanstorage.ir`، tailscale). پس جداسازی باید در سطح شبکه باشد، نه با تنظیم اپ | `evidence/pc/android/EP-01-apk-endpoint-scan.txt` |
| ISO-01 | [R-DEV] | حالت هواپیما + خاموشی Wi-Fi/داده | **FAIL به‌عنوان اثبات**: VPN گوشی (`com.zedsecure.vpn`) رابط tun0 را با ICMP جعلیِ محلی نگه داشت | `evidence/pc/android/ISO-01-network-isolation.txt` |
| ISO-01b | [R-DEV] | VPN متوقف شد → فقط `lo` | PASS: ‏`ping 1.1.1.1` «Network is unreachable»؛ DNS برای همهٔ میزبان‌های واقعی unknown host؛ تنها مسیر = `adb reverse` به سرور آزمایشگاهی | `evidence/pc/android/ISO-01b-network-isolation-vpn-stopped.txt` |
| NET-UID-01 | [R-DEV] | آمار شبکهٔ UIDهای اپ آزمایشگاهی | owner: ۰ خط؛ school: ۱ مجموعه (ترافیک adb reverse به سرور آزمایشگاه) | `evidence/pc/android/AND-CRASH-NET-01.txt` |
| WIN-NET-01 | [R-DEV] | قاعدهٔ فایروال خروجی (فقط برای exeهای آزمایشگاهی) + relay حلقهٔ محلی | PASS: هیچ اتصال TCP جز relay دیده نشد | گزارش ۰۸ |
| ISO-APP | [R-DEV] | شناسهٔ بستهٔ جدا (`.lab176`) و بدون `--dart-define` ‏PAYESH_* | به‌روزرسان و فهرست سرورها خاموش؛ اپ‌های واقعی کاربر (`ir.payesh.school.payesh_app`، `ir.payesh.owner`) دست‌نخورده | `evidence/pc/android/INS-*.txt` |
| ISO-PCSTACK | [R-SRV] | بررسی فقط‌خواندنی کانتینرهای آزمایشگاه PC (`docker inspect`، `docker logs`) | PASS: ‏`payesh-lab-school-1` با `PAYESH_TUNNEL_AUTO=0` روی شبکهٔ `payesh-lab_labnet` (`internal=true`) اجرا شد. ۰ خط تونل/cloudflare در ۱۵۲۵ خط لاگ | LEDGER «D-08» |
| ISO-SBX-CF | [R-SRV] | پردازه‌ها و اتصال‌های sandbox هنگام عیب‌یابی REG-03 | **FAIL (استثنای جداسازی، D-08):** ‏۸ cloudflared **واقعی** از اجرای ID65-postfix با ۱۰ اتصال به لبهٔ Cloudflare ‏(`:7844`) تا ۵۲ دقیقه یتیم ماندند. quick tunnel عمومی، دادهٔ آزمایشگاهی، بدون تماس با سرور واقعی Payesh. کشته و اصلاح شد. پس از اصلاح CF_SEEN=0 | `evidence/D08-BEFORE-orphans.txt`، `evidence/D08-AFTER-*.log` |

**جمع‌بندی جداسازی:** هیچ آزمونی به سرور واقعی Payesh وصل نشد. اپ‌های آزمایشگاهی اندروید و ویندوز و پشتهٔ PC کاملاً جدا بودند. **دو استثنا صریح است:** (۱) آزمایش جداسازی ISO-01 نادرست بود. کشف شد، علامت خورد و جایگزین شد (ISO-01b). (۲) مجموعه‌های آزمون Node در sandbox (`identity-65`، `lan-mode-127`) با cloudflared واقعی تونل عمومی به Cloudflare (شخص ثالث) باز کردند (D-08، گزارش ۱۳). اصلاح شد. اجراهای قبلی این دو مجموعه را نمی‌توان بعداً بررسی کرد (گزارش ۱۴، محدودیت ۱۵).

## ۵. تغییرات موقت روی دستگاه‌های واقعی کاربر (همه با تأیید و همه بازگردانده شد؛ گزارش ۱۴)
- گوشی: stay-awake، حالت هواپیما، Wi-Fi، توقف VPN، `adb reverse`.
- PC: توقف ۲۰ دقیقه‌ای سرویس واقعی Payesh Data Service، توقف ۱۴ کانتینر کاربر برای آزادسازی RAM هنگام ساخت، قاعده‌های فایروال `Payesh-LAB-176*`.
