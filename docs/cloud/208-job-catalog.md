# ردیف ۲۰۸ — کاتالوگ نوع‌کارها و طبقه‌بندی داده (DP-3)

منبع اجرایی: `server/helper-v2.js` ‏(`JOB_CATALOG`) — همین جدول آنجاست و `canLease` از رویش داوری می‌کند.

| نوع‌کار | ورودی → خروجی | کلاس داده | executor مجاز | سقف زمان | idempotent |
|---|---|---|---|---|---|
| storage.usage | prefix → objects/bytes/groups | internal | owner, school, cloudflare, actions | ۱۲۰s | بله |
| object.verify | key(+sha256/size) → exists/size/sha256/match | internal | owner, school, cloudflare, actions | ۳۰۰s | بله |
| endpoint.check | url عمومی → reachable/status/ms | public | همه | ۳۰s | بله |
| bucket.gc | — → deleted_* | internal | owner, cloudflare, actions | ۱۸۰s | بله |
| backup.verify | مانند object.verify روی بک‌آپ | internal | owner, school, actions | ۶۰۰s | بله |
| report.aggregate | گزارش تجمیعی مدرسه | **school-content** | **فقط owner یا همان مدرسه** | ۶۰۰s | بله |
| update.build | ساخت بستهٔ دلتا | internal | owner, actions | ۹۰۰s | بله |

قواعد: (۱) `school-content` هرگز روی cloudflare/actions و هرگز روی مدرسهٔ دیگر. (۲) کار مدرسهٔ دیگر برای helper مدرسه فقط با کلاس `public` مجاز است. (۳) failover همه: انقضای اجاره ⇒ برداشت دیگری؛ هیچ‌کس ⇒ اجرای محلی درخواست‌دهنده. (۴) مثال‌ها مصنوعی‌اند.

## نیازمند تصمیم مالک
- فعال‌سازی واقعی `report.aggregate` و `update.build` (در کاتالوگ تعریف شده‌اند ولی executorها فقط وقتی caps اعلام کنند برمی‌دارند؛ پیش‌فرض caps بیرونی فقط ۴ نوع v1 است).
