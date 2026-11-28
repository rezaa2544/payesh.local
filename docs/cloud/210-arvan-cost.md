# ردیف ۲۱۰ — هزینهٔ آروان و مشاهده‌پذیری صف (DP-5)

اصل: آروان compute ندارد؛ هزینه = تعداد درخواست S3. اقلام صف: presence ‏(PUT هر ۶۰s برای هر helper)، polling فهرست، lease/result ‏(PUT/GET).

## برآورد پایه (از روی کد)
- هر helper مالک: presence ‏≈ ۱٬۴۴۰ PUT/روز + polling صف.
- Worker کلودفلر: cron دقیقه‌ای ⇒ presence+list ‏≈ ۲٬۸۸۰ درخواست/روز (فقط وقتی Secretها ست شوند).
- Actions: هر ۱۵ دقیقه، فقط وقتی صف کار دارد هزینهٔ معنادار دارد.

## کاهش پیاده‌شده
- `helper-v2.nextPollDelay`: صف خالی ⇒ backoff نمایی ۵s→۳۰۰s با jitter ‏(±۲۰٪)؛ کار هست ⇒ بازهٔ پایه. (executorهای نودی؛ Worker به‌علت cron ثابت دقیقه‌ای سقفش همان ۱ دقیقه است.)
- `helper-jobs.queueStatus(cfg)`: شمارش ‏pending/leased/done/stuck بدون خواندن محتوا؛ ‏`status()` سرور مدرسه و `/api/status` ‏Worker ‏(`helpers.queue`) آن را نمایش می‌دهند.
- کار گیرکرده = lease منقضی بدون نتیجه (`stuck`) — در همان شمارش مشخص است.

## نمای پنل
منبع دادهٔ نمای یکپارچه همان ‏`helpersOnline` (حالا با ‏cls/caps/capacity/school_id) + ‏`queueStatus` است؛ رندر UI پنل مالک از همین دو خروجی تغذیه می‌شود (تغییر UI در این سری انجام نشد تا ریسک Flutter صفر بماند؛ داده آماده است).
