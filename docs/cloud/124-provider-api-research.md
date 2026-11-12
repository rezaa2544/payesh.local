# ردیف ۱۲۴ — پژوهش API واقعی RadCloud و سایر Providerها

> فقط پژوهش روی مستندات عمومی، بدون خرید، بدون ساخت منبع و بدون فراخوانی API با کلید واقعی. تاریخ بررسی: ۲۰۲۶-۱۱-۱۲.
> برچسب‌ها: **[A]** = از مستند رسمی خوانده شد؛ **[E]** = برآورد یا برداشت از منبع غیررسمی؛ **[?]** = نامعلوم (منبع پیدا نشد یا تأیید نشد).
> «هزینه» فقط وقتی عدد دارد که منبع رسمی آن پیوند داده شده باشد؛ در غیر این صورت [?].
> این سند ادعای اجرا ندارد: هیچ فراخوانی [M] انجام نشده است.

## ۱. سه سطح قابلیت

| سطح | نام | معنا برای پنل مالک (ردیف ۱۲۲) |
|---|---|---|
| L1 | ثبت دستی | مالک منبع را در پنل ثبت می‌کند و عدد را با برچسب [M]/[E] دستی وارد می‌کند. همین امروز کار می‌کند (آداپتور `manual`). |
| L2 | پایش سلامت | پنل با API رسمی فقط **می‌خواند** (فهرست منابع، وضعیت، سنجه). هیچ تغییری نمی‌دهد. |
| L3 | Provisioning خودکار | پنل با API منبع را می‌سازد، تغییر می‌دهد یا حذف می‌کند. طبق ADR ۱۱۷ و قاعدهٔ ردیف ۱۲۲ **فعلاً ممنوع** است؛ اینجا فقط ثبت می‌شود که API آن را دارد یا نه. |

هر قابلیت در جدول زیر **دقیقاً یکی** از این سه سطح را دارد: بالاترین سطحی که منبع رسمی نشان می‌دهد. اگر منبع نیست، سطح L1 با برچسب [?] است.

## ۲. جدول قابلیت‌ها

| Provider | قابلیت | سطح | برچسب | منبع | توضیح |
|---|---|---|---|---|---|
| RadCloud | فهرست منابع | L1 | [?] | — | هیچ مستند عمومی API برای «RadCloud» پیدا نشد. دامنهٔ حدسی `radcloud.ir` پاسخ HTTP 500 داد. نتایج جست‌وجو به محصولات نامرتبط می‌رسد. |
| RadCloud | وضعیت و سلامت | L1 | [?] | — | تا وقتی API رسمی نیست، فقط Health Check خود پنل (HTTP/TCP روی Endpoint عمومی، ردیف ۱۲۲) ممکن است. |
| RadCloud | ظرفیت و مصرف | L1 | [?] | — | ثبت دستی با برچسب [M] از روی پنل RadCloud. |
| RadCloud | Provisioning | L1 | [?] | — | API شناخته نشد؛ ممنوع هم هست. |
| ArvanCloud | فهرست منابع | L2 | [A] | <https://docs.arvancloud.ir/en/developer-tools/api/api-usage> | `GET https://napi.arvancloud.ir/ecc/v1/regions/{region}/servers` با کلید Machine User در هدر `Authorization`. |
| ArvanCloud | وضعیت و سلامت | L2 | [A] | <https://docs.arvancloud.ir/en/developer-tools/api/api-usage> | پاسخ فهرست سرورها وضعیت هر سرور را دارد. شکل دقیق فیلد را باید از مشخصات رسمی `iaas/1.0` برداشت؛ آن صفحه هنگام بررسی خطای 500 داد [?]. |
| ArvanCloud | ظرفیت و مصرف | L2 | [E] | <https://pkg.go.dev/github.com/hamidfzm/arvancloud-go/iaas> | کلاینت غیررسمی Go مسیرهای `GET /regions/{region}/quota` و `GET /regions/{region}/reports/{id}/{metric}` را نشان می‌دهد. پیش از استفاده باید با مشخصات رسمی تطبیق داده شود. |
| ArvanCloud | Provisioning | L3 | [A] | <https://docs.arvancloud.ir/en/developer-tools/api/api-usage> | `POST /regions/{region}/servers` سرور می‌سازد. **در پنل ممنوع است.** |
| ParsPack | فهرست منابع | L2 | [A] | <https://docs.parspack.com/reference/api/instructions/> | `GET https://my.parspack.com/cserver/api/public/v1/vms` با `Authorization: Bearer`. توکن فقط یک بار نمایش داده می‌شود. |
| ParsPack | وضعیت و سلامت | L2 | [E] | <https://docs.parspack.com/reference/api/instructions/> | فهرست VMها منبع طبیعی وضعیت است، ولی فیلد وضعیت در صفحهٔ دستورالعمل نیامده و باید در «مستندات یکپارچه API» دیده شود. |
| ParsPack | ظرفیت و مصرف | L1 | [?] | — | در مستندات خوانده‌شده Endpoint سنجه (CPU/RAM/دیسک) دیده نشد. |
| ParsPack | Provisioning | L3 | [A] | <https://docs.parspack.com/reference/api/instructions/> | `POST https://my.parspack.com/cserver/api/v1/vms` (name/region/size/image). **در پنل ممنوع است.** |
| IranServer | فهرست منابع | L1 | [?] | <https://www.iranserver.com/api/> | صفحهٔ رسمی می‌گوید API سرور ابری و صدور توکن (فقط برای حساب احرازشده) دارد، ولی مسیرها و شکل پاسخ در این بررسی خوانده نشد. |
| IranServer | وضعیت و سلامت | L1 | [?] | <https://www.iranserver.com/api/> | مانند بالا؛ تا خواندن مستند فنی، نامعلوم. |
| IranServer | ظرفیت و مصرف | L1 | [?] | — | منبعی پیدا نشد. |
| IranServer | Provisioning | L1 | [?] | <https://www.iranserver.com/api/> | صفحه از «اجرای سرویس‌ها بدون پنل کاربری» می‌گوید، ولی Endpoint ساخت خوانده نشد. |
| Neon | فهرست منابع | L2 | [A] | <https://neon.com/docs/guides/consumption-limits> | Management API در `https://console.neon.tech/api/v2/projects` است. |
| Neon | وضعیت و سلامت | L2 | [A] | <https://api-docs.neon.tech/reference/getconsumptionhistoryperproject> | سند می‌گوید فراخوانی سنجه، compute خوابیده را بیدار نمی‌کند. این برای پایش دوره‌ای مهم است. |
| Neon | ظرفیت و مصرف | L2 | [A] | <https://neon.com/docs/guides/consumption-metrics-legacy> | `compute_time_seconds`، `active_time_seconds`، `written_data_bytes`. مسیر legacy فقط برای پلن Scale و بالاتر است؛ برای Launch باید از `/consumption_history/v2/projects` استفاده کرد. |
| Neon | Provisioning | L3 | [A] | <https://neon.com/docs/guides/consumption-limits> | `POST /api/v2/projects` (همراه با quota). **در پنل ممنوع است.** |
| Supabase | فهرست منابع | L2 | [A] | <https://supabase.com/docs/guides/integrations/supabase-for-platforms> | Management API در `https://api.supabase.com/v1`. |
| Supabase | وضعیت و سلامت | L2 | [A] | <https://supabase.com/docs/guides/integrations/supabase-for-platforms> | `GET /v1/projects/{ref}/health`، وضعیت `ACTIVE_HEALTHY`. |
| Supabase | ظرفیت و مصرف | L1 | [?] | — | در مستند خوانده‌شده Endpoint سنجهٔ مصرف دیده نشد. |
| Supabase | Provisioning | L3 | [A] | <https://supabase.com/docs/guides/integrations/supabase-for-platforms> | `POST /v1/projects` و تغییر اندازه با `PATCH /v1/projects/{ref}/billing/addons`. **در پنل ممنوع است.** |

## ۳. هزینه (فقط با منبع)

| Provider | مورد | مقدار | برچسب | منبع |
|---|---|---|---|---|
| RadCloud | هاست فعلی | از قبل پرداخت شده؛ مبلغ در مخزن نیست | [A] / مبلغ [?] | `docs/cloud/117-adr-staged-low-cost.md` |
| ArvanCloud | سرور ابری | — | [?] | صفحهٔ قیمت در این بررسی خوانده نشد |
| ParsPack | سرور ابری | — | [?] | صفحهٔ قیمت در این بررسی خوانده نشد |
| IranServer | سرور ابری | — | [?] | صفحهٔ قیمت در این بررسی خوانده نشد |
| Neon | پلن Free | ۰ دلار؛ ۱۰۰ CU-hr در ماه برای هر پروژه؛ ۱ GB فضا | [A] | <https://neon.com/pricing> |
| Neon | پلن Launch | ۰٫۱۰۶ دلار برای هر CU-hr؛ ۰٫۳۵ دلار برای هر GB-month؛ «هزینهٔ معمول» ۱۵ دلار در ماه به گفتهٔ خود Neon | [A] (عدد ۱۵ دلار برآورد خود Neon است [E]) | <https://neon.com/pricing> |
| Supabase | — | — | [?] | صفحهٔ قیمت در این بررسی خوانده نشد |

هیچ عدد هزینه‌ای در این سند از حدس ساخته نشده است. دسترسی ارائه‌دهندگان خارجی (Neon و Supabase) از ایران و پرداخت ارزی آن‌ها نیز [?] است و تصمیمش با مالک است (سند ۳۴).

## ۴. پیشنهاد حداقلی برای ردیف ۱۲۲

1. **آداپتور `manual` می‌ماند و پیش‌فرض است.** برای RadCloud (هاست فعلی) هیچ API شناخته نشد، پس R08 تا ارائهٔ مستند رسمی از سوی مالک PARTIAL می‌ماند.
2. **اولین آداپتور خواندنی، اگر مالک بخواهد: `arvancloud` در سطح L2.** فقط `GET .../servers` و (پس از تطبیق با مشخصات رسمی) `GET .../quota`. کلید از `secret:ARVAN_MU_KEY` خوانده می‌شود (ارجاع، طبق قاعدهٔ ۱۲۲). عددها با برچسب `M` و `source='provider_api'` ثبت می‌شوند و هر خطا «نامعلوم» می‌ماند.
3. **L3 در هیچ آداپتوری پیاده نمی‌شود.** متد `provision` همچنان `provider_api_not_implemented` برمی‌گرداند تا ADR تازه‌ای از مالک برسد.
4. پیش از کدنویسی، مالک باید (الف) نام دقیق و نشانی پنل RadCloud را بدهد و (ب) تأیید کند کدام Provider واقعاً استفاده می‌شود. این تصمیم مالک است [OWNER].

## ۵. NOT RUN

- هیچ فراخوانی API با کلید واقعی انجام نشد [M]: نه فهرست، نه سنجه، نه ساخت.
- مشخصات رسمی OpenAPI آروان (`iaas/1.0`) و «مستندات یکپارچه» پارس‌پک خط‌به‌خط خوانده نشد. ردیف‌های [E] باید پیش از کد تأیید شوند.
