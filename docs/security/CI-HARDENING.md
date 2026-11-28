# سفت‌کردن CI — zizmor + پین SHA + Gitleaks (۲۰۲۶-۱۱-۲۸)

تسک Notion: «[اکنون] سفت‌کردن CI: ‏zizmor + پین‌کردن اکشن‌ها به SHA + اسکن سکرت Gitleaks (باینری)»
مجری: دستیار (خط Z). دامنه طبق دستور مالک ثابت ماند: فقط `.github/` و کانفیگ اسکن؛ **هیچ فایل محصولی و هیچ مسیر انتشار واقعی تغییر نکرده** (به‌جز اصلاحات متنیِ داخل خود ورک‌فلوها که رفتار انتشار را عوض نمی‌کند: انتقال مقادیر از قالب `${{ }}` داخل `run:` به `env:`، خروجی مرحله به‌جای `$GITHUB_ENV`، و خاموش‌کردن کش در گیت انتشار).

## ۱) وضعیت قبل / بعد (zizmor 1.33.1، روی هر ۱۸ ورک‌فلو)

| یافته | قبل | بعد |
|---|---|---|
| `unpinned-uses` (error) | ۱۲۶ | **۰** |
| `artipacked` (warning) | ۳۸ | ۱ (عمدی، پایین) |
| `cache-poisoning` (error) | ۸ | **۰** |
| `dangerous-triggers` (error) | ۶ | ۰ (ignore خطی با دلیل، پایین) |
| `template-injection` | ۲ error + چند info | **۰** |
| `github-env` (error) | ۱ | **۰** |
| `secrets-inherit` (warning) | ۱ | **۰** |
| `excessive-permissions` (warning) | ۱ | **۰** |
| `superfluous-actions` (info) | ۱ | ۱ (عمدی، پایین) |

گزارش‌های خام: `zizmor-before.txt` و `zizmor-after.txt` در همین پوشه.

## ۲) چه شد

- **پین SHA:** همهٔ `uses:`ها به SHA کامل ۴۰رقمی پین شدند و نسخه در کامنت ماند (`# v4`) تا Dependabot بتواند به‌روز کند. نگاشت نسخه→SHA از `git ls-remote` خود مخزن هر اکشن گرفته شد (برای تگ‌های annotated، commit پوست‌کنده `^{}`).
- **artipacked:** برای همهٔ checkoutها `persist-credentials: false` ست شد **به‌جز `build.yml`** (دلیل در بخش ۳).
- **دسترسی حداقلی:** `helper-executor.yml` تنها ورک‌فلوی بدون بلوک `permissions` بود و دسترسی پیش‌فرض پهن داشت؛ `permissions: contents: read` گرفت. بقیه از قبل حداقلی بودند (read؛ و write فقط جاهایی که انتشار/کامیت مانیفست لازم دارد: `build.yml`، `directory-mirror.yml`، `downloads-page.yml` و جاب‌های انتشار).
- **cache-poisoning:** در `build.yml` و `release-gate.yml` (تریگر تگ/انتشار) برای setup-node گزینهٔ `package-manager-cache: false` و برای setup-gradle گزینهٔ `cache-disabled: true` ست شد و `cache: npm`های گیت انتشار حذف شدند.
- **template-injection:** مقادیر `github.event.workflow_run.*` و `steps.signing.outputs.ready` از داخل متن `run:` به `env:` مرحله منتقل شدند (`school-native-publish`، `owner-native-publish`، `owner-panel`، `build`).
- **github-env:** در `web-app-publish` نوشتن در `$GITHUB_ENV` (متغیرهای `W` و `SKIP`) با خروجی مرحله (`$GITHUB_OUTPUT` + `steps.*.outputs`) جایگزین شد.
- **secrets-inherit:** در `release-gate` به‌جای `secrets: inherit` فهرست صریح ۱۰ سکرت لازم برای native-client نوشته شد.
- **dangerous-triggers:** تریگر `workflow_run` ستون فقرات زنجیرهٔ انتشار است (قانون انتشار: انتشار فقط بعد از موفقیت native-client/win32 روی main). حذفش ممکن نیست؛ هر ۶ مورد با کامنت `# zizmor: ignore[dangerous-triggers]` **فقط روی همان خط** ignore شدند. دلیل امن‌بودن: همهٔ این ورک‌فلوها در `if:` جاب، `conclusion == 'success' && event == 'push' && head_branch == 'main'` را fail-closed چک می‌کنند، از `head_sha` همان اجرا checkout می‌کنند و آرتیفکت‌ها را قبل از انتشار دوباره Verify می‌کنند (native-independence-gate).

## ۳) یافته‌های باقی‌مانده — با دلیل کتبی

1. **`artipacked` در `build.yml:25`:** همان جاب در انتها مانیفست انتشار را روی main کامیت و `git push` می‌کند (کانال به‌روزرسانی درجا). برداشتن اعتبار ماندگار checkout این انتشار را می‌شکند؛ پس عمداً نگه داشته شد. ریسک محدود است چون این ورک‌فلو روی PR خارجی اجرا نمی‌شود.
2. **`superfluous-actions` در `build.yml:585` (info):** پیشنهاد zizmor جایگزینی `softprops/action-gh-release` با `gh release` است. این مرحله مسیر انتشار روی تگ است؛ طبق خط قرمز تسک («صفر تغییر در مسیر انتشار واقعی») دست نخورد و فقط پین شد.
3. **تریگرهای `workflow_run`:** در بخش ۲ توضیح داده شد؛ ignoreها خطی و مستدل‌اند.

## ۴) Gitleaks (باینری 8.30.1، نه اکشن مارکت‌پلیس)

- اسکن درخت کاری قبل از اصلاح: **۵۲ یافته** — گزارش redacted در `gitleaks-before-redacted.json` (بدون مقدار سکرت).
- بررسی دستی: همه یا **بردار/فیکسچر تست**‌اند (کلیدهای برداری `sk-vector-…` و کلیدهای ساختگی تست‌ها)، یا سورس وندورشدهٔ sqlite3mc، یا کلیدهای محیط شبیه‌سازی لوکال (`tools/sim`) و شواهد آزمایشگاهی قدیمی. **هیچ سکرت واقعیِ عملیاتی پیدا نشد**؛ پس توقف و چرخش کلید لازم نشد.
- baseline در `.gitleaksignore` (اثر انگشت دقیق هر ۵۲ مورد) ثبت شد؛ `.gitleaks.toml` قوانین پیش‌فرض را extend می‌کند و مسیر وندور را allowlist می‌کند.
- Verify بعد: `gitleaks dir .` با همین کانفیگ و baseline → **بدون یافتهٔ جدید**.
- اسکن تاریخچه (`gitleaks git .`): ۱۸ یافتهٔ دیگر از همان خانواده (فیکسچرها و بردارهای قدیمی در کامیت‌های گذشته؛ از جمله کلید AWS **ساختگیِ** کنترل منفی در تست ردیف ۴۸) — اثر انگشت آن‌ها هم به baseline اضافه شد تا اسکن تاریخچه هم سبز باشد.

## ۴٫۵) هم‌گام‌سازی حداقلی دو تست با فرم سخت‌شده

دو تست مخزن متنِ ورک‌فلوها را string-match می‌کردند و با فرم سخت‌شده ناسازگار شدند؛ فقط همان دو نقطه به‌روزرسانی شد (کد محصول دست نخورد):

- `tests/landing-114.js` (LP-08): رشته‌های موتانت `deploy-pages@v4` و `checkout@v4` به فرم پین‌شدهٔ SHA تغییر کردند تا موتانت‌ها همچنان قرمز شوند (Verify محلی: ۲۰/۲۰ موتانت قرمز، LANDING-114-OK).
- `tests/android-release-76.js` (W-6): گزارهٔ `secrets: inherit` به «عبور صریح سکرت‌های امضا یا inherit» تعمیم یافت تا فهرست صریح سکرت‌ها را هم بپذیرد (Verify محلی: ۲۸/۲۸).

## ۵) گیت دائمی از این به بعد

ورک‌فلوی جدید `.github/workflows/security-scan.yml` (فقط `contents: read`، خودش هم پین‌شده):

- جاب **zizmor**: نسخهٔ پین‌شدهٔ 1.33.1؛ گیت روی `--min-severity high` قرمز می‌شود (کلاس error قدیم).
- جاب **gitleaks**: دانلود باینری 8.30.1 از ریلیز رسمی + Verify با فایل checksums خود ریلیز (`sha256sum -c`)؛ اسکن درخت کاری و تاریخچهٔ گیت؛ هر یافتهٔ خارج از baseline قرمز است.

## ۶) قانون انتشار

این تغییر فقط زیرساخت CI است و طبق قانون انتشار همهٔ نسخه‌ها، بعد از merge باید سبزشدن CI روی main و برابری مانیفست‌های زنده با HEAD مثل همیشه Verify شود؛ خودِ این تسک هیچ بستهٔ کاربری تازه‌ای تولید نمی‌کند.
