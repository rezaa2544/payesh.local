# ردیف ۵۱ — ریشه‌یابی ریستارت‌های مکرر سرور پایلوت (و آغاز پنجرهٔ پاک)

**تاریخ:** ۱۴۰۵/۰۸/۱۸ (۲۰۲۶-۱۱-۰۸، ساعت ~۲۰:۵۵ UTC)
**هدف:** `http://127.0.0.1:8080` — سرور نهفتهٔ `C:\Program Files\Payesh\server\index.js` زیر ناظر `Payesh.exe`

---

## ۱. حکم (یک خط)

ریستارت‌های مکرر **حلقهٔ به‌روزرسانی درجا (auto-update apply loop)** است، نه کرشِ از دست‌رفتن داده: سرور هر ۱۵ دقیقه مخزن دور `rezaa2544/payesh.local@main` را بررسی می‌کند، نسخه‌های جدید را به‌صورت خودکار/دستی اعمال کرده و با تغییر فایل‌های `server/` یک «راه‌اندازی مجدد» اجباری می‌زند؛ طولانی شدن قطعی‌ها به دلیل چرخهٔ بازآغازی ناظر دسکتاپ و یک باگ تایمر پس از بستن پایگاه‌داده است.

---

## ۲. یافته‌ها

### ۲.۱ مکانیزم به‌روزرسانی خودکار (کد)

- `server/index.js:2186` — سرور پس از `listen`، `update.start(store, { onApply })` را اجرا می‌کند؛ هر اعمال موفق با `restart`، `scheduleRestart('auto')` می‌زند.
- `server/update.js:587` — `start()`: بررسی اول ۱۲ ثانیه پس از بالا آمدن، سپس **هر ۱۵ دقیقه** (`everyMs = 15 * 60_000`).
- `server/update.js:77` — `autoCheckEnabled` **پیش‌فرض روشن** است (فقط با `PAYESH_UPDATE_AUTO=0` یا `update_auto=0` خاموش می‌شود).
- `server/update.js:196` — `needs_restart` هرگاه فایل‌های `server/` تغییر کرده باشند → خروج با کد ۷۵ و بازگشت توسط ناظر.
- `server/update.js:60` — `DEFAULT_BASES`: `raw.githubusercontent.com/rezaa2544/payesh.local/main/` + دو آینهٔ jsDelivr.
- `server/index.js:2068` — `closeServerForRestart()` سرور و `store` را می‌بندد ولی **تایمر به‌روزرسانی را متوقف نمی‌کند** → باگ §۲.۵.

### ۲.۲ مخزن دور در حال تغییر مداوم است

در **یک روز** (۸ نوامبر ۲۰۲۶) نسخه‌ها از ۰.۸.۶۷ تا ۰.۸.۷۴ صعود کردند:

| نسخه | زمان ساخت (built_at UTC) | منبع |
|---|---|---|
| 0.8.67 | (نسخهٔ نصب‌شدهٔ پایه) | `releases/` محلی |
| 0.8.72 | 18:49:46 | `releases/manifest.json` repo |
| 0.8.73 | 19:49:16 | `C:\Program Files\Payesh\releases\manifest.json` |
| **0.8.74** | **20:36:48** | مانیفست دور GitHub (در لحظهٔ نوشتن این سند) |

هر بار که نسخهٔ جدیدی در مخزن قرار می‌گیرد، اولین تیک ۱۵-دقیقه‌ای بعد از آن، اعمال + ریستارت را می‌زند.

### ۲.۳ شواهد پایگاه‌داده (اعمال خودکار، با مهر زمان)

`payesh-load55-MLwX2I/payesh.sqlite`، کلید `meta: update:last`:

```json
{ "version":"0.8.72", "from_version":"0.8.67", "files":4, "restart":true,
  "at":"2026-11-08T19:05:02.487Z", "by":"auto",
  "source":"https://raw.githubusercontent.com/rezaa2544/payesh.local/main/",
  "errors":[], "backed_up":4, "overlaid":0, "blocked":0 }
```

همچنین پوشه‌های فیزیکی:
- `backups/update-0.8.72/` ساخته‌شده در ۱۹:۰۵ UTC (دقیقاً منطبق بر اعمال بالا) + بکاپ `payesh-2026-11-08T19-05-03Z.sqlite`.
- `updates/stage-0.8.71/` (مرحلهٔ دانلود ۱۸:۵۰ UTC) — طبق کد، اعمال موفق stage را پاک می‌کند؛ باقی‌ماندن آن نشان‌گر یک چرخهٔ ناتمام/تلاش مجدد است.

### ۲.۴ ریستارت‌ها از دید نگهبان (pilot-51-live.jsonl)

بازنشانی‌های `uptime_s` (UTC): **15:34, 15:59, 17:29, 17:39, 18:09, 18:50, 19:05, 19:15, 20:00, 20:45**.

پنجره‌های قطعی واقعی:

| بازه | مدت | دلیل محتمل |
|---|---|---|
| 16:54 → 17:29 | ~۲۰ دقیقه | چرخهٔ بازآغازی ناظر (تلاش‌های مکرر + آزاد شدن پورت) |
| 18:14 → 18:50 | ~۳۶ دقیقه | همان + کرش §۲.۵ |
| 19:10 → 19:15 | ~۵ دقیقه | اعمال ۰.۸.۷۲ و بازآغازی `Payesh.exe` |
| ~20:42 | ~۳۰ ثانیه | اعمال ۰.۸.۷۴ |

۱۲ رکورد `STOP-CANDIDATE` (S4) از ۱۷:۰۹ تا ۱۹:۱۴ UTC با `down_s` انباشتهٔ ۱۲۰۰ → ۴۵۰۰ ثانیه (۷۵ دقیقه).

### ۲.۵ باگ کرش در مسیر ریستارت (ProgramData/Payesh/data/server.log)

در یکی از ریستارت‌ها، پس از `[update] راه‌اندازی مجدد (update)…`، پروسه/node کرش می‌کند چون تایمر ۱۵-دقیقه‌ایِ به‌روزرسانی پس از `store.close()` هنوز زنده است:

```
Error: database is not open
    at Store.getMeta (C:\Program Files\Payesh\server\db.js:148:23)
    at autoCheckEnabled (C:\Program Files\Payesh\server\update.js:78:25)
    at Timeout._onTimeout (C:\Program Files\Payesh\server\update.js:594:26)
```

سپس بنر راه‌اندازی نسخهٔ بعدی (۰.۸.۶۸) نشان می‌دهد که ناظر پروسه را دوباره آورده است — این کرش، هر قطعی را طولانی‌تر می‌کند.

### ۲.۶ به‌روزرسانی‌های دستی همزمان

در همان لاگ، درخواست‌های `POST /api/admin/update/check`، `POST /api/admin/update/download` و `POST /api/admin/update/install` دیده می‌شود که بلافاصله با `[update] راه‌اندازی مجدد (update)…` (دلیل `update` نه `auto`) همراه‌اند — یعنی علاوه بر تیک خودکار، از پنل مدیر هم به‌روزرسانی نصب می‌شده است. مجموعاً **۴۳** خط «راه‌اندازی مجدد» در این لاگ ثبت شده.

### ۲.۷ لاگ ناظر دسکتاپ (%LOCALAPPDATA%\Payesh\app.log)

خطوط `start` مکرر با PIDهای جدید نشان از بازآغازی کامل `Payesh.exe` دارد؛ نمونهٔ ۱۴۰۵/۰۸/۱۷ (UTC+۳:۳۰):

```
22:13:29 start ... serverMode=True   → 22:13:32 server started pid=2396
22:41:35 start ... serverMode=True   → 22:41:37 server started pid=2904
22:45:18 start ... serverMode=True
22:45:27 start ... serverMode=True   → 22:45:29 server started pid=3536
```

برخی `start`‌ها بدون `server started` مانده‌اند (تلاش‌های ناموفق پیش از آزاد شدن پورت ۸۰۸۰) — دلیل طولانی شدن قطعی‌ها.

همچنین کلید رجیستری `HKLM\...\Run` مقدار `PayeshLocal = "C:\Program Files\Payesh\desktop\Payesh.exe" --server --tray` دارد (ناظر در بوت بالا می‌آید).

### ۲.۸ وضعیت لحظهٔ نگارش سند

`GET /api/health` در ۲۰:۵۱ UTC: `"version":"0.8.74", "uptime_s":561, "restart_pending":false, "data_dir":"C:\ProgramData\Payesh\data"` — یعنی ۰.۸.۷۴ هم ~۲۰:۴۲ UTC اعمال شده و حلقه همچنان فعال است.

---

## ۳. رد فرضیات دیگر

- **کرش‌لوپِ داده/پایداری:** خیر — هر ریستارت با اعمال به‌روزرسانی (خودکار یا دستی) همراه است، `errors:[]`، `backed_up` کامل، و `restart_pending` درست شده.
- **مشکل سخت‌افزار/منبع:** خیر — سرور بین ریستارت‌ها کاملاً سالم است (uptime‌های پیوستهٔ تا ۱۶۸۳۵ ثانیه در صبح).
- **نقص ناظر (watchdog):** بخشی از طولانی‌شدن قطعی‌هاست (تلاش مجدد پورت)، اما عامل آغازگر نیست.

---

## ۴. توصیه برای پنجرهٔ پایدار ۷ روزه

1. **خاموش کردن اعمال خودکار روی میز پایلوت** (مهم‌ترین گام): تنظیم `PAYESH_UPDATE_AUTO=0` در محیط اجرای `Payesh.exe` (یا `update_auto=0` در `meta` از پنل مدیر) پیش از بازآغازی ناظر؛ تیک ۱۵-دقیقه‌ای دیگر اعمال نمی‌کند.
2. **عدم نصب دستی** از پنل مدیر (`/api/admin/update/install`) در طول پنجرهٔ ۷ روزه.
3. **تثبیت مخزن دور:** توقف push به `rezaa2544/payesh.local@main` (یا نشاندادن `PAYESH_UPDATE_BASE` به یک آینهٔ ثابت) برای مدت پایلوت.
4. **رفع باگ تایمر** (توسعه): در `closeServerForRestart()` (`server/index.js`) تایمر به‌روزرسانی با `update.stop()` پاک شود، یا در `update.js:78`/`db.js:148` حالت «بسته بودن store» مدیریت شود تا ریستارت‌ها تمیز خارج شوند.
5. پس از اعمال موارد ۱–۳، نگهبان را ری‌استارت کردیم (بازنشانی شمارندهٔ `dayDown`) — پنجرهٔ پاک از **~۲۰:۵۵ UTC ۲۰۲۶-۱۱-۰۸** آغاز شد؛ رویدادهای S4 پیشین همگی ناشی از حلقهٔ به‌روزرسانی بودند، نه حادثهٔ امنیتی یا از دست رفت داده.

---

## ۵. فایل‌های شاهد

- `docs/cloud/reports/evidence/pilot-51-live.jsonl` — خط زمانی uptime/قطعی + ۱۲ رکورد STOP-CANDIDATE
- `C:\Users\R.M\AppData\Local\Payesh\app.log` — لاگ ناظر دسکتاپ
- `C:\ProgramData\Payesh\data\server.log` — ۴۳ ریستارت + کرش + درخواست‌های ادمین
- `C:\Users\R.M\AppData\Local\Temp\payesh-load55-MLwX2I\payesh.sqlite` — `meta:update:last`/`update:checked`
- `C:\Program Files\Payesh\releases\manifest.json` (۰.۸.۷۳) و مانیفست دور GitHub (۰.۸.۷۴)
