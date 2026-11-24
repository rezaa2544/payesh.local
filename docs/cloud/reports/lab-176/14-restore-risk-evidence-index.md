# گزارش ۱۴ — بازگردانی، ریسک باقی‌مانده و فهرست شواهد

> **وضعیت پس از push (2026-11-24 10:02Z):** push انجام شد؛ main = `92466ec0`؛ CI سبز (#862)؛ build 200 و سرور 0.9.32 منتشر شدند و هش/امضا با شواهد برابر است. نصب روی کاربران هنوز دیده نشده؛ آزمون بی‌صدای گوشی BLOCKED (گوشی وصل نبود)؛ serv00 مرکزی به‌روز نشد. جزئیات: گزارش ۰۱ §۷.

## ۱. بازگردانی (همه انجام و راستی‌آزمایی شد)
| مورد | حالت اصلی | بازگردانی | شاهد |
|---|---|---|---|
| سرویس واقعی Payesh Data Service | Running روی 0.0.0.0:8080، نسخهٔ سلامت 0.9.30 | ‏03:40:43Z دوباره Running، 8080، سلامت 0.9.30. قطعی حدود ۲۰ دقیقه (03:20:49Z تا 03:40:43Z) با تأیید مالک. تعریف task و داده دست نخورد | `evidence/pc/datasvc-original-176.txt`، `datasvc-stop-176.txt`، `datasvc-restore-176.txt` |
| فایروال | — | قاعده‌های `Payesh-LAB-176*` حذف شدند (۰ باقی) | LEDGER |
| relay حلقهٔ محلی | — | متوقف شد | LEDGER |
| گوشی | stay_on=0، Wi-Fi روشن، VPN روشن، بدون adb reverse | ‏03:51:37Z: ‏`adb reverse` حذف شد، هواپیما 1←0، Wi-Fi 0←1، stay_on 2←0. VPN را کاربر روشن کرد و `CONNECTED` تأیید شد. اپ‌های واقعی 0.2.198 / 1.1.198 دست‌نخورده | `C:\lab\evidence\android\RESTORE-PHONE-176.txt` |
| ۱۴ کانتینر کاربر | Up | ‏`docker start` برای هر ۱۴. **۱۳ از ۱۴ Up.** `benzin-api-1` مدام ری‌استارت می‌شود، چون پایگاه داده‌اش `benzin-postgres-1` حدود **۲۹ ساعت پیش از آزمایشگاه** Exited(127) شده بود و در فهرست توقف ما نبود. دست زده نشد | `C:\lab\evidence\RESTORE-CONTAINERS-176.txt` |
| پشتهٔ آزمایشگاه | — | ‏`payesh-lab-school-1`/`fwd-1`/`pg-1` و Gateway آزمایشگاه متوقف شدند (حذف نشدند) | LEDGER |
| مخزن روی PC ‏(`psim\repo`) | WIP ردیف ۱۷۳ | WIP در `stash@{0}` «pre-lab-176 backup of row-173 WIP (965e8bb)» **محفوظ است و drop نشده** | — |
| باقی‌ماندهٔ بی‌خطر | — | ‏`C:\lab\*` (ابزار، پروفایل آزمایشگاه، شواهد، اسرار آزمایشگاه) روی PC ماند | — |

## ۲. محدودیت‌ها (صریح)
1. **انتشار:** اصلاح D-04/D-05 push و منتشر شد (0.9.32 و build 200، 2026-11-24 09:44–09:46Z؛ §۵). **نصب روی کاربران هنوز دیده نشده** و سرور مرکزی serv00 به‌روز نشد (اسرار استقرار تنظیم نشده).
2. **به‌روزرسانی بی‌صدای اندروید (ردیف ۱۷۵) اثبات نشد:** build 200 منتشر شده، ولی هنگام آزمون پس از push گوشی آزمایشگاه به PC وصل نبود (BLOCKED؛ PP-07).
3. **PostgreSQL 17 به‌جای 16:** آزمایشگاه روی 17.11 اجرا شد و CI روی 16 است.
4. **owner-native-it روی PGlite** [EMB] است، نه سرور Postgres.
5. **S3 و سرور مرکزی فقط شبیه‌سازی شدند** [SIM]. استقرار serv00 در CI پیکربندی نشده و هر بار skip می‌شود (`::notice::serv00 secrets not set — skipped`).
6. **امضای release آزموده نشد:** کلید مالک بیرون از آزمایشگاه ماند. APKها debug-signed و exeها بدون امضا بودند.
7. **کارایی:** ‏sandbox ‏۲ هسته و ۲ GB است و کلاینت‌های بار ساختگی‌اند. بار چنددستگاهی واقعی انجام نشد.
8. **فقط یک گوشی** (Android 16 / HyperOS) و **یک PC** (Windows 11) آزموده شد. Android 5 و 6 فقط در CI روی شبیه‌ساز اجرا شده است.
9. **قطع شبکه** با قطع `adb reverse` یا relay شبیه‌سازی شد، نه با قطع واقعی Wi-Fi یا برق.
10. **دسترس‌پذیری ویندوز** با Narrator تأیید نشد.
11. **گم‌شدن شواهد:** بازنشانی sandbox نخستین لاگ‌های خام را از بین برد. همهٔ نتایج نقل‌شده **دوباره اجرا شده‌اند**. عدد Gradle «444/444» نقل نشده و GRADLE-VERIFY ‏612/612 جای آن را گرفته است.
12. **کمبود حافظهٔ sandbox:** دو اجرای Flutter کشته شدند و **نامعتبر** علامت خوردند. نتایج نقل‌شده از اجرای دوم و تنها هستند (dmesg بدون kill تازه).
13. **وضعیت امنیتی UNKNOWN** است (سیاست §۱۰.۲ و D-25). این آزمایشگاه ممیزی مستقل نیست.
14. S3/MinIO واقعی، اسکن هدفمند Play Protect و رفتار SmartScreen آزموده نشدند.
15. **استثنای جداسازی در sandbox (D-08):** مجموعه‌های `identity-65` و `lan-mode-127` با cloudflared **واقعی** quick tunnel عمومی به Cloudflare باز کردند. ۸ پردازه از اجرای ID65-postfix تا ۵۲ دقیقه یتیم ماندند. دادهٔ آزمایشگاهی بود و به هیچ سرور واقعی Payesh وصل نشد. اجراهای قبلیِ همین دو مجموعه (REG-01/02، NI، CI محلی) هم ممکن است تونل کوتاه‌عمر باز کرده باشند و این **بعداً قابل اثبات نیست**. پشتهٔ آزمایشگاهی PC و اپ‌های اندروید و ویندوز درگیر نبودند (`PAYESH_TUNNEL_AUTO=0`، شبکهٔ `internal=true`). اصلاح شد (فقط آزمون).

## ۳. ریسک‌های باز
| ریسک | شدت | اقدام پیشنهادی |
|---|---|---|
| تا انتشار D-04، دبیران روی رایانهٔ مشترک قفل می‌شوند | Medium/High | 0.9.32 منتشر شد؛ ریسک تا نصب واقعی روی سرورها/کاربران باقی است. سرورهای مدرسه خودکار نصب نمی‌کنند (`server/update.js`)، پس نصب دستی/تأیید لازم است. serv00 مرکزی به‌روز نشده |
| CI ‏build-and-release روی HEAD فعلی قرمز است (D-07) | Low | **برطرف شد:** build-and-release ‏#862 روی `8223b59b` سبز شد (‏#861 روی `e31f70f9` به‌خاطر `.gitignore` قرمز بود) |
| نسخهٔ وب هنگام عوض‌شدن کاربر دستگاه کاربر قبلی را تا ۳۰ روز نگه می‌دارد | Low | ردیف جدا. پیشنهاد: در `issueLogin`، دستگاهِ قبلیِ همان مرورگر برای کاربر دیگر باطل شود |
| D-03 (روز UTC) و D-06 (برچسب نسخه) | Low | ردیف جدا |
| `/data` گوشی ۹۸٪ پر | محیطی | آزادسازی فضا پیش از به‌روزرسانی‌ها |
| `benzin-postgres-1` خاموش | خارج از دامنه | تصمیم مالک |
| `tests/restart.js` سرور ری‌استارت‌شده را یتیم می‌گذارد | Low (آزمون) | پاک‌سازی در پایان آزمون |
| سرور با `HOST` غیر loopback به‌طور پیش‌فرض تونل عمومی خودکار باز می‌کند و cloudflared فرزند هنگام کشته‌شدن سرور جمع نمی‌شود (D-08) | Medium | آزمون‌ها اصلاح شدند. پیشنهاد ردیف جدا: جمع‌کردن cloudflared در خروج سرور و `PAYESH_TUNNEL_AUTO=0` در همهٔ آزمون‌هایی که سرور را spawn می‌کنند |

## ۴. اثر push (پیش از هر push بررسی شد)
| workflow | با push این تغییر | محیط |
|---|---|---|
| native-client ← school-native-publish / owner-native-publish | اجرا می‌شود (مسیر `server/auth.js`) و در صورت سبز بودن، build تازه را در `native-continuous` / `owner-continuous` منتشر می‌کند. کد اپ تغییری ندارد و فقط شمارهٔ build بالا می‌رود | **واقعی:** گوشی‌های اندروید ۱۲+ بی‌صدا به‌روز می‌شوند و اپ‌های ویندوز به‌روزرسانی می‌گیرند |
| build-and-release | بستهٔ سرور 0.9.32 در `continuous` + commit ربات مانیفست | **واقعی:** به سرورهای مدرسه پیشنهاد می‌شود. بررسی و نصب خودکار به‌طور پیش‌فرض **خاموش** است (`server/update.js`) |
| serv00-central | اجرا می‌شود ولی skip می‌شود (اسرار تنظیم نشده) | هیچ |
| api-contract، owner-panel، installables | فقط آزمون | هیچ |

commit سوم (`6896e144`، فقط `tests/`) اثری بر انتشار ندارد. مانیفست 0.9.32 پس از آن دوباره ساخته شد و فقط `built_at` تغییر کرد، پس مانیفست `7e326568` معتبر ماند.

## ۵. فهرست شواهد
- `evidence/SUMMARY.txt`: یک خط برای هر اجرا (TEST_ID، EXIT، مدت). اجراهای نامعتبر صریحاً INVALID علامت خورده‌اند.
- `evidence/<ID>.log`: سرآیند `TEST_ID / PURPOSE / SHA / ENV / CMD / START`، خروجی خام، `EXIT / END / DURATION_S`.
  شامل: REG-01..03، SEC-01..08، CH-01..05، DB-01..21، DBR-01..21، FL-00..07، NI-01..18، GRADLE-VERIFY، DEF-04-05-repro(-AFTER)، FIX-D04-D05-TEST، ID65-postfix، D07-sim173، D08-AFTER-ID65، D08-AFTER-LAN127، REG-03 (تلاش ۱ و ۲ INVALID: کمبود حافظه).
- `evidence/FIX-D01-D02.diff`، `evidence/FIX-D04-D05.diff`، `evidence/FIX-D08.diff`، `evidence/D08-BEFORE-orphans.txt`، `evidence/WATCHDOG.log`، `evidence/EVID-01-evidence-nopush.log` (شواهد مخزن: `tests-run 158/158`، `EVIDENCE-SHA-89-OK failures=0`، commit `62179d50`، بدون push).
- پشتیبان سه commit محلی به‌صورت `git format-patch` فقط در پوشهٔ آزمایشگاه نگه داشته شد (خارج از مخزن؛ خود commitها در تاریخچهٔ git هستند).
- `evidence/ci-out/`: مصنوعات گام‌های CI (همان فایل‌هایی که CI آپلود می‌کند).
- `evidence/pc/`: ساخت‌ها، ENV-01، flutter doctor، سرویس داده، ویندوز، اندروید (ISO، INS، DRV، OWN، PERF، REC، CRASH)، sim-s3، کش Gradle.
- `evidence/WIN-*.jpg`: اسکرین‌شات‌های ویندوز (نصف اندازه).
- `scripts/`: ‏`run-t.sh`، `ci-pg-suite.py`، `ci-native-it.py`، `gradle-verify.sh`، `def04-05-repro.js`، `fl-seq.sh`، `postfix.sh`، `watchdog.sh`، `d08-verify.sh`.
- بازتولید هر آزمون: فرمان `CMD=` در سرآیند لاگ همان آزمون، روی SHA همان سرآیند.

## ۵. پس از push (2026-11-24 10:02Z)
| workflow | پیش‌بینی §۴ | واقعیت |
|---|---|---|
| native-client ← school/owner-native-publish | build تازه منتشر می‌شود | ✓ native-client ‏#200، school ‏#73، owner ‏#83 ← build 200 در `native-continuous` / `owner-continuous` |
| build-and-release | 0.9.32 در `continuous` + commit ربات | ✓ پس از اصلاح: ‏#861 ✗ ← `8223b59b` ← ‏#862 ✓؛ ربات `92466ec0` |
| serv00-central | skip | ✓ همان: ‏#23 «success» ولی استقرار skip شد |
| api-contract، owner-panel، installables | فقط آزمون | ✓ سبز |

شواهد پس از push (پوشهٔ آزمایشگاه `raw/post-push/`):
- `PP-01-main-sha.txt` — SHA ‏main و ۹ commit آخر
- `PP-02-runs.txt` — ۱۶ اجرای پس از 09:20Z
- `PP-03-jobs.txt` و `PP-03-log-*.txt` — همهٔ کارها و لاگ کامل کارهای کلیدی
- `PP-05-artifact-verify.txt`، `PP-05b-signer-198-vs-200.txt` — هش، امضا، SHA256SUMS، مقایسه با 198
- `PP-06-release-assets-*.txt` — شمار دانلود
- `PP-07-phone-silent-update.txt` — BLOCKED (گوشی وصل نیست)
