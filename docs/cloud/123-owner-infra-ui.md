# ردیف ۱۲۳ — صفحهٔ «زیرساخت» و فرم «ساخت مدرسه» در پنل مالک

> برچسب‌ها: **[S]** = اجرا در sandbox/CI؛ **[M]** = اجرا روی میزبان واقعی. در این ردیف هیچ کار [M] انجام نشده است.
> امنیت تا ردیف ۹۲ (آزمون نفوذ انسانی) **UNKNOWN** است.

## ۱. چه چیزی اضافه شد

| بخش | فایل | توضیح |
|---|---|---|
| صفحهٔ «زیرساخت» | `apps/owner-panel/web/app.js` (`LOADERS.infra`) | ارائه‌دهنده‌ها، سرویس‌ها با ۱۰ سنجهٔ ظرفیت/مصرف، Endpointها با سلامت، هشدارهای باز و تاریخچهٔ درخواست‌های تغییر؛ همه از `GET /infra` و `GET /infra/changes` (ردیف ۱۲۲) |
| فرم‌های ثبت دستی | همان فایل (`infraAddProvider`، `infraAddService`، `infraAddEndpoint`، `infraRecordMetric`) | فقط ثبت؛ هیچ سروری ساخته نمی‌شود (Provisioning خودکار وجود ندارد و صفحه همین را صریح می‌گوید) |
| Health Check دستی | `infraCheck` | `POST /infra/endpoints/{id}/check`؛ پاسخ 429 `check_cooldown` به پیام فارسی «۳۰ ثانیه» نگاشت می‌شود |
| عملیات پرخطر | `infraRequestChange`، `infraRequestCredential`، `infraApprove` | دومرحله‌ای: (۱) درخواست با بازتایپ هدف و دلیل ≥۱۰ نویسه ⇒ بی‌اثر؛ (۲) تأیید فقط مالک با بازتایپ شناسهٔ کوتاه هدف ⇒ اجرا یک بار؛ هر دو در ممیزی |
| ساخت مدرسه | `createSchool`، `showOnce` | دکمه در صفحهٔ «مدارس» فقط برای مالک؛ `POST /tenants` (ردیف ۱۲۱)؛ تلاش دوباره همان `provision_op_id`؛ کد فعال‌سازی مدیر فقط یک بار در پنجرهٔ جدا |
| نقش‌ها | `CAPS` | owner: همه؛ operator: ثبت/بررسی/درخواست، بدون تأیید و ساخت مدرسه؛ support: فقط مشاهده. سرور همین را جدا اعمال می‌کند (403 `role_forbidden`) |
| پیام خطا | `ERRORS` | `credentials_not_accepted`، `credential_must_be_reference`، `provider_api_not_implemented`، `label_required`، `check_cooldown`، `endpoint_disabled`، `invalid_endpoint`، `invalid_slug`، `school_provisioning_not_configured`، `school_provisioning_failed`، … |

## ۲. قواعد صداقت داده

- عددی که منبع ندارد **«نامعلوم»** است (برچسب «بدون داده»)، نه `۰` و نه عدد ساختگی. سلامت Endpoint بررسی‌نشده «نامعلوم» و آخرین بررسی «هرگز» است.
- هر عدد ثبت‌شده برچسب **[M]** (اندازه‌گیری‌شده) یا **[E]** (برآورد) دارد؛ مقدار خالی به‌صورت «نامعلوم» (`label='?'`) ذخیره می‌شود.
- اگر سرور ادعای Provisioning خودکار کند، پنل آن را بدون شاهد تأیید نمی‌کند.

## ۳. Secret

- فرم‌ها فیلد رمز ندارند؛ فقط **ارجاع** `secret:NAME` پذیرفته می‌شود (اعتبارسنجی سمت کلاینت + سرور).
- پنل فقط نام ارجاع را نشان می‌دهد؛ مقدار Secret هرگز به مرورگر نمی‌رسد. آزمون یک مقدار canary در env قرار می‌دهد و ثابت می‌کند در DOM، بدنهٔ درخواست‌ها و ممیزی نیست.
- کد فعال‌سازی مدیر در flash، localStorage، نشانی یا ممیزی نیست و پس از بستن پنجره از DOM حذف می‌شود.

## ۴. شاهد [S]

| فرمان | نتیجه |
|---|---|
| `node apps/owner-panel/tests/owner-spa-infra.test.js` | `OWNER-SPA-INFRA-123 checks=67 negative_controls=28 failures=0` |
| جهش‌ها (`arena/wip123/mut123.py`، خارج از مخزن) | `MUTANTS-123 19/19 RED` (عدد ساختگی بجای «نامعلوم»، فیلد رمز، پذیرش توکن خام، حذف مرحلهٔ دوم/بازتایپ، دکمهٔ تأیید برای operator، نمایش دوبارهٔ کد فعال‌سازی، ذخیرهٔ کد، op_id تازه در تلاش دوباره، …) |
| `node apps/owner-panel/tests/owner-spa.test.js` | `OWNER-SPA checks=140` (۹ صفحه شامل «زیرساخت»: API واقعی، empty، error، loading) |
| `node tests/reconcile-118.js` | R09 = PASS [S]؛ R08 = PARTIAL [S]؛ جهش‌های M11/M12 (PASS بدون فرم UI / بدون آداپتور واقعی) قرمز |

آزمون روی API واقعی (`createPlatformApi`) با PGlite و migrations 001..006، از راه پروکسی same-origin پنل اجرا می‌شود؛ checker سلامت و provisioner سمت مدرسه stub قطعی‌اند (شبکه و پایگاه مدرسه در ردیف‌های ۱۲۱/۱۲۲ جدا آزموده شده‌اند).

## ۵. NOT RUN / باقی‌مانده

- **[M]** اجرای پنل روی میزبان واقعی، Health Check به Endpoint واقعی، ساخت مدرسه روی Gateway واقعی: NOT RUN.
- اتصال API واقعی ارائه‌دهنده (ظرفیت/مصرف خودکار): ردیف ۱۲۴. تا آن زمان R08 = PARTIAL.
- دسترس‌پذیری صفحه با صفحه‌خوان واقعی: NOT RUN (فقط ساختار role/aria در jsdom).
