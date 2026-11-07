# دایرکتوری مرکزی و مسیردهی مدرسه → cell — ردیف ۴۳

| | |
|---|---|
| ردیف | ۴۳ (فاز ۳ — نمونهٔ فنی) · وابسته به ۳۷ |
| وضعیت | **اجراشده و آزموده روی PostgreSQL واقعی** (۱۶ بررسی DR + رگرسیون ۳۸ و ۳۷) |
| کد محصول | `server/directory.js` + `server/gateway.js` (اتصال سخت توکن به cell) |
| آزمون | `tests/directory-pg.js` — DR‑01..DR‑16 روی سه Gateway و سه دیتابیس واقعی |
| شاهد | `docs/cloud/reports/evidence/directory-43.txt` (پایان: `DIRECTORY-43-OK`) |
| اجرا | `npm run test:directory` (بدون PostgreSQL ⇒ `BLOCKED` با کد ۳، نه PASS) |

---

## ۱. مسئله

هر مدرسه در **cell** خودش (دیتابیس مستقل با tenant خودش) زندگی می‌کند. سؤال ورود این است: «این مدرسه روی کدام cell است؟» و سؤال امنیتی این است: «اگر کسی توکن مدرسهٔ دیگر را به cell اشتباه ببرد چه می‌شود؟» پاسخ: هیچ — چون توکن، شناسهٔ cell را در خود دارد و Gateway هر cell فقط توکن خودش را می‌پذیرد.

## ۲. جدول مسیردهی (دیتابیس مرکزی)

```sql
directory_cells (cell_id uuid PK, name, region, status ∈ {active,draining,disabled}, created_at)
school_routes   (school_code text PK, cell_id uuid REFERENCES directory_cells ON DELETE RESTRICT, updated_at)
```

- `school_code` یکتاست (حروف کوچک/بزرگ نرمال می‌شوند؛ `SCHOOL-C` و `school-c` یک ردیف‌اند — DR‑15).
- حذف cell دارای مسیر **ممنوع** است (`ON DELETE RESTRICT`؛ DR‑15) تا مسیر معلق نماند.
- cell با `status='disabled'` ورود نمی‌دهد (`409 cell_disabled`؛ DR‑14).

## ۳. ورود → توکن حاوی cell

`directory.issueSession({schoolCode, uid, role, tenantId, secret})`:

```
مدرسه → resolve(school_code) → cell_id → signToken({ tid, cell, role, uid, did, iat, exp })
```

توکن همان توکن امضاشدهٔ ردیف ۲۶/۳۷ است؛ فقط claim `cell` اضافه شده. Gateway با `GW_CELL`:

| حالت | نتیجه |
|---|---|
| `claims.cell === GW_CELL` | عبور |
| `claims.cell` متفاوت | `403 wrong_cell` — **قبل از** هر کوئری داده |
| توکن بدون `claims.cell` | `403 missing_cell` |
| `GW_CELL` تنظیم نشده | رفتار تک‌cell ردیف ۳۷، بدون تغییر (توکن قدیمی هم پذیرفته می‌شود) |

`/healthz` و `/readyz` هم `cell` را برمی‌گردانند تا مسیردهی در مانیتورینگ دیده شود (DR‑06).

## ۴. کش مسیر با TTL و رفتار در قطع دایرکتوری

| پارامتر | پیش‌فرض | معنا |
|---|---|---|
| `DIR_CACHE_TTL_SEC` | ۶۰ | عمر کش مسیر؛ در این پنجره هیچ کوئری‌ای به دیتابیس مرکزی نمی‌رود |
| `DIR_STALE_MAX_SEC` | ۹۰۰ (۱۵ دقیقه) | پس از TTL، در صورت **خطای** دایرکتوری، مسیر کش‌شده تا این مدت با `stale=true` ادامه می‌دهد |

- تغییر مسیر پیش از پایان TTL دیده نمی‌شود و بعد از آن اثر می‌کند (DR‑11: `before_ttl=cell1 after_ttl=cell2`).
- با قطع دایرکتوری، مسیر کش‌شده سرو می‌شود (`stale=yes`)؛ اگر کشی نباشد `503 directory_unavailable` (DR‑12/۱۳) — یعنی قطع دایرکتوری **همه‌چیز را باز نمی‌کند**.

## ۵. اندازه‌گیری اجرای واقعی (این مخزن)

```
topology: directory=payesh_dir43 · cell1=payesh_cell1 · cell2=payesh_cell2 · legacy (بدون GW_CELL)
DR-01  مهاجرت دیتابیس مرکزی                     statements=3 tables=directory_cells,school_routes
DR-02  مسیردهی دو مدرسه به دو cell               a=…a1 b=…a2
DR-03  کش TTL                                    hits=1 misses=1 cache=1
DR-06  Gateway cell1 + توکن cell1                healthz_cell=ok pull=200
DR-07  توکن cell2 روی cell1 و برعکس              wrong_cell / wrong_cell
DR-08  توکن بدون cell روی Gateway مقید           missing_cell
DR-09  تک‌cell بدون GW_CELL                       pull=200 cell=null
DR-10  داده در دیتابیس خودِ cell                 cell1=1 cell2=0
DR-11  TTL و تغییر مسیر                          before_ttl=cell1 after_ttl=cell2
DR-12  قطع دایرکتوری با کش                       stale=yes cell2 kept
DR-13  قطع دایرکتوری بدون کش                     directory_unavailable/503
DR-14  cell غیرفعال                              cell_disabled/409
DR-15  یکتایی مسیر و FK                          unique=yes fk=23001
DR-16  توکن مدرسهٔ دیگر با tenant یکسان            wrong_cell
رگرسیون ۳۸: SCOPE-38-OK · رگرسیون ۳۷: ۱۹/۱۹ GW
DIRECTORY-43-OK
```

> محدودیت صریح: سه Gateway و سه دیتابیس روی **یک میزبان محلی** اجرا شده‌اند؛ این آزمون «چند cell روی چند ماشین/منطقه» یا مسیریابی جغرافیایی و failover را اثبات نمی‌کند. شکاف بین cellها با هشدار در ردیف ۴۹ دیده می‌شود.

## ۶. شروع با یک cell

در استقرار فعلی فقط یک cell فعال است: `GW_CELL` تنظیم نمی‌شود و رفتار همان ردیف ۳۷ می‌ماند (DR‑09). برای رفتن به چند cell فقط این‌ها لازم است: ثبت cell دوم، افزودن مسیر مدرسه‌ها، تنظیم `GW_CELL` روی نمونه‌های هر cell و صدور توکن از مسیر `issueSession`. **هیچ تغییر رفتاری برای کاربر** لازم نیست.

## ۷. آنچه در این ردیف اثبات نشد

- مهاجرت زندهٔ یک مدرسه از cell1 به cell2 بدون قطع نشست (dual-write/backfill) — ردیف ۵۳ و مسیر مهاجرت.
- هم‌زمانی چند دایرکتوری (consensus)؛ فقط تک‌نمونهٔ دایرکتوری با کش آزموده شد.
- وضعیت امنیتی سامانه همچنان **UNKNOWN** است.
