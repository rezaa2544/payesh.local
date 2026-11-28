# به‌روزرسانی خودکار وابستگی‌ها — Dependabot

تسک Notion: «[اکنون] فعال‌سازی Dependabot برای npm + GitHub Actions (و تعیین تکلیف پوشش pub)» — تصمیم مالک ۱۴۰۵/۰۹/۰۶.

## پیکربندی
فایل: `.github/dependabot.yml` — هفتگی (شنبه، به وقت تهران)، حداکثر ۵ PR باز برای هر اکوسیستم، minor/patch گروهی.

| اکوسیستم | پوشه | چه چیزی را پوشش می‌دهد |
|---|---|---|
| `npm` | `/` | سرور Node، ابزارها، تست‌ها؛ از جمله `overrides` امنیتی `lodash`/`lodash-es` |
| `github-actions` | `/` | همهٔ ۱۹ گردش‌کار؛ اکشن‌ها با SHA پین شده‌اند (CI-HARDENING) و Dependabot SHA + کامنت نسخه را با هم بالا می‌برد |
| `pub` | `/apps/payesh` | هر ۹ پکیج Flutter workspace: app، owner، payesh_core، payesh_data، payesh_sync، payesh_secure، payesh_ui، payesh_owner_api، payesh_update |

## مکث ۷ روزه (cooldown)

هر سه اکوسیستم `cooldown.default-days: 7` دارند: Dependabot برای نسخه‌ای که کمتر از ۷ روز از انتشارش گذشته PR باز نمی‌کند. بیشتر بسته‌های آلوده (supply-chain) در همین چند روز اول کشف و از رجیستری برداشته می‌شوند. این همان قاعدهٔ `dependabot-cooldown` در zizmor است؛ `zizmor .github/dependabot.yml` بدون یافته است (گیت CI فقط `.github/workflows` را بررسی می‌کند، این فایل را محلی بررسی کردیم). به‌روزرسانی‌های امنیتی (security updates) مشمول این مکث نیستند.

## تصمیم pub: Dependabot (نه Renovate)
- `apps/payesh/pubspec.yaml` ریشهٔ یک **pub workspace** است (`workspace:` + `resolution: workspace` در پکیج‌ها، یک `pubspec.lock`).
- updater پاب Dependabot فقط روی **ریشهٔ workspace** اجرا می‌شود. اگر پوشهٔ تک‌تک پکیج‌ها داده شود، هر اجرا با
  `dependency_services failed: Only apply dependency_services to the root of the workspace.` شکست می‌خورد
  (همین خطا در چند مخزن عمومی گزارش و با «فقط ریشه» رفع شده است).
- از ریشه، pub یک resolution مشترک برای هر ۹ پکیج می‌سازد ⇒ پوشش کامل است و Renovate لازم نیست.
- **نصب هم‌زمان Dependabot و Renovate ممنوع است** (PR تکراری و رقابت روی lockfile).
- بازنگری: اگر اجرای pub در «Insights › Dependency graph › Dependabot» خطا داد، Renovate (پشتیبانی Dart/Flutter) فقط ارزیابی و نتیجه در همان تسک Notion ثبت شود.

## قید سخت مرج
- هیچ PR آپدیتی **خودکار مرج نمی‌شود** (auto-merge در این پیکربندی نیست).
- روی هر PR این گردش‌کارها خودبه‌خود اجرا می‌شوند: `release-gate` (شامل `npm test`)، `api-contract`، `native-client`، `win32-edition`، `security-scan`، `installables`.
- مرج فقط وقتی همهٔ آن‌ها سبزند؛ سپس انتشار عادی طبق `docs/release/RELEASE-LAW-ALL-PLATFORMS.md`.
