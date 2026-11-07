# قرارداد همگام‌سازی پایش — نسخهٔ ۱ (Sync v1)

> **وضعیت:** اجراشده و آزمون‌شده در محصول (`server/sync.js`، `server/db.js`، مسیرهای `/api/sync` و `/api/v1/pull`).
> **شاهد:** `docs/cloud/reports/evidence/sync-contract-v1.txt` · آزمون: `npm run test:contract`
> **طرح ماشینی:** [`sync-v1.schema.json`](./sync-v1.schema.json) (JSON Schema 2020‑12، همین پوشه)

این سند «قرارداد» است، نه پیشنهاد: هر رفتاری که این‌جا نوشته شده با آزمون روی سرور واقعی سنجیده می‌شود و اگر کد رفتار دیگری داشته باشد، آزمون شکست می‌خورد.

| مورد | مقدار |
|---|---|
| نسخهٔ قرارداد | `1` (فیلد `schema_version` در هر دو پاسخ) |
| سقف عملیات هر push | **۲۰۰** (`MAX_OPS`) → خطای `too_many_ops` |
| سقف ردیف هر کالکشن در هر pull | **۳۰۰۰** (`ROW_LIMIT`) → `more: true` |
| سقف بدنهٔ درخواست push | ۸ مگابایت → `413 body_too_large` |
| واحد زمان | ISO‑8601 UTC با میلی‌ثانیه (`2026‑11‑07T14:30:41.008Z`) |
| احراز هویت | `Authorization: Bearer <session token>`؛ بدون آن `401 unauthorized` |
| مرجع هویت مستأجر/مدرسه | فقط نشست سمت سرور؛ `school_id`/`tenant_id` کلاینت حذف می‌شود |

---

## ۱. `GET /api/v1/pull` — دریافت تغییرات از سرور

### پارامترها
| پارامتر | نوع | الزام | معنا |
|---|---|---|---|
| `since` | ISO | لازم* | فقط ردیف‌هایی که `updated_at > since` (یا در مکان‌نمای مرکب برابر با `since` و `id > since_id`) تغییر کرده‌اند |
| `since_seq` | ISO | لازم* | **نام رسمی AC**؛ معادل کامل `since`. اگر هر دو بیایند `since` مقدم است. مقدار نامعتبر ⇒ از ابتدا (fail-safe، نه خطا) |
| `since_id` | int ≥ 0 | اختیاری | **مکان‌نمای مرکب**: شکستن تساوی مهر زمانی. بدون آن رفتار قدیمی (اکید `>`) حفظ می‌شود |
| `collections` | CSV | اختیاری | فهرست کالکشن‌ها؛ خالی = همهٔ پیش‌فرض‌ها. کالکشن ناشناس/غیرمجاز بی‌صدا حذف می‌شود |

### پاسخ ۲۰۰
```json
{
  "ok": true,
  "schema_version": 1,
  "server_time": "2026-11-07T14:30:41.008Z",
  "since": "2026-11-07T13:00:00.000Z",
  "since_id": 0,
  "next_since": "2026-11-07T14:29:56.987Z",
  "next_id": 6001,
  "more": true,
  "limits": { "row_limit": 3000, "max_ops": 200 },
  "collections": { "attendance": [ { "id": 6001, "student_id": 32, "_version": 1 } ] },
  "deleted": [ { "collection": "attendance", "id": 5900, "at": "2026-11-07T14:00:00.000Z" } ]
}
```

قواعد سخت:
1. **کالکشن غایب = تغییری نیست.** پاسخ بدون تغییر: `collections: {}`، `more: false`، `deleted: []`.
2. **مکان‌نمای مرکب الزامی است.** هرگاه `more: true` باشد، کلاینت باید `next_since` **و** `next_id` را در درخواست بعدی بفرستد. اگر فقط `next_since` بفرستد، ردیف‌هایی که همان مهر زمانی مرز صفحه را دارند **گم می‌شوند** (این باگ در شبیه‌سازی سال تحصیلی اندازه‌گیری شد: ۱۷ ردیف از ۷۲٬۳۰۴).
3. **ترتیب ثابت:** ردیف‌ها با `(updated_at, id)` صعودی می‌آیند.
4. **tombstone** (ردیف حذف‌شده) در `deleted` می‌آید: `{collection, id, at}`.
5. `_version` هر ردیف همان مقداری است که برای `base_version` در push باید برگردد.
6. ردیف‌های خارج از اسکوپ نقش کاربر **هرگز** در پاسخ نمی‌آیند (نه با ۴۰۳؛ با حذف سمت سرور).

---

## ۲. `POST /api/sync` — فرستادن صف عملیات

### بدنه
```json
{ "ops": [
  { "uid": "d1-17-k3f9a2", "collection": "attendance", "type": "put",
    "data": { "student_id": 32, "class_id": 1, "date": "2026-10-14", "status": "present" } },
  { "uid": "d1-18-m8c1b7", "collection": "attendance", "type": "put", "id": 6001,
    "base_version": 1, "data": { "student_id": 32, "class_id": 1, "date": "2026-10-14", "status": "late" } }
] }
```

| فیلد | الزام | معنا |
|---|---|---|
| `uid` | لازم، ۱ تا ۸۰ کاراکتر | **کلید idempotency در سطح عملیات**؛ تکرار همان uid هرگز دوباره اعمال نمی‌شود |
| `idempotency_key` | اختیاری، ≤ ۱۲۰ | **کلید idempotency در سطح درخواست** (نام رسمی AC): تکرار همان کلید ⇒ همان پاسخ قبلی با `replayed: true` و صفر عملیات دوباره |
| `collection` | لازم | باید در فهرست مجاز سیاست باشد، وگرنه `unknown_collection` |
| `type` | `put` یا `del` (پیش‌فرض `put`) | حذف فقط با نقش مدیر |
| `id` | اختیاری | شناسهٔ ردیف موجود؛ بدون آن ردیف تازه ساخته می‌شود |
| `base_version` | اختیاری | کنترل همروندی (OCC)؛ عدم تطابق → تعارض ثبت می‌شود، نه بازنویسی |
| `data` | لازم | بدنهٔ ردیف. `password_plain`/`password_enc` همیشه حذف مي‌شوند |

### پاسخ ۲۰۰
```json
{
  "ok": true, "schema_version": 1, "server_time": "…",
  "applied":   [ { "uid": "d1-17-k3f9a2", "id": 72001, "version": 1 } ],
  "conflicts": [ { "uid": "d1-18-m8c1b7", "collection": "attendance", "id": 6001,
                   "server_version": 2, "server": { "…": "…" }, "conflict_id": 4 } ],
  "rejected":  [ { "uid": "d9-1-aa11bb", "error": "role_denied" } ]
}
```

1. سه سبد **جدا** است: `applied` (ثبت شد)، `conflicts` (برای تصمیم مدیر نگه داشته شد)، `rejected` (رد شد).
2. uid تکراری در `applied` با `duplicate: true` برمی‌گردد و هیچ نوشتنی رخ نمی‌دهد.
3. `del` موفق: `{uid, id, deleted: true}`.
4. تعارض OCC هرگز باعث بازنویسی کور نمی‌شود؛ ردیف تعارض در کالکشن `conflicts` ثبت و فقط با مدیر حل می‌شود (`POST /api/conflicts/:id/resolve`).

### کدهای خطای push (سطح عملیات)
`bad_uid` · `unknown_collection` · `not_found` · `role_denied` · `role_change_denied` · `duplicate_phone` · `out_of_scope` · `student_not_in_class` · `bad_status` · `bad_score` · `bad_kind` · `write_failed`

### کدهای خطای سطح درخواست
`401 unauthorized` · `400 bad_json` · `413 body_too_large` · `400 too_many_ops` (همراه `limit: 200`) · `400 bad_idempotency_key` (همراه `limit: 120`)

---

## ۳. idempotency و ترتیب

- دو لایهٔ idempotency: **درخواست** (`idempotency_key`, اختیاری — تکرار کل درخواست همان پاسخ را با `replayed:true` برمی‌گرداند) و **عملیات** (`uid`). لایهٔ عملیات حتی وقتی کلاینت کلید درخواست نمی‌فرستد محافظت می‌کند.
- واحد idempotency عملیات = `uid`، در جدول `sync_log` سمت سرور نگه داشته می‌شود و **پس از ری‌استارت هم باقی می‌ماند** (آزمون F‑01/F‑02 در شبیه‌سازی: پس از `kill -9`، بازفرست ۳۴ ردیف هیچ ردیف تکراری نساخت و ۱۷ بازفرست به‌درستی `duplicate` علامت خورد).
- ترتیب اعمال = ترتیب آرایهٔ `ops`. ترتیب شبکه‌ای بین دو دستگاه تضمین نمی‌شود؛ تعارض با OCC مدیریت می‌شود.
- تلاش دوباره با همان بدنه **بی‌خطر** است (semantics: at-least-once + idempotent).

## ۴. اسکوپ و مجوز

| نقش | می‌نویسد | می‌خواند (به‌طور مؤثر) |
|---|---|---|
| manager | همهٔ کالکشن‌های مجاز | همه |
| teacher | attendance/grades در کلاس‌های خودش، leaves، internships، discipline | فقط کلاس‌های خودش |
| parent | فقط `leaves` برای فرزند خودش (و وضعیت به `pending` تبدیل می‌شود) | فقط فرزند خودش |
| student | فقط `leaves` برای خودش | فقط رکورد خودش |
| counselor | `counselor_notes`، `counselor_refs` | فقط یادداشت‌های مشاوره |
| guard | هیچ | هیچ ردیف دانش‌آموزی |

هر نوشتن خارج از این جدول با کد مشخص در `rejected` برمی‌گردد؛ **هیچ‌گاه ۲۰۰ با اعمال ناخواسته**.

## ۵. تحول طرح (schema evolution)

- فیلدهای تازه **افزودنی** هستند؛ کلاینت باید فیلد ناشناس را نادیده بگیرد، نه اینکه خطا بدهد.
- `schema_version` عدد صحیح است؛ افزایش آن فقط با تغییر ناسازگار (major) و ثبت در همین سند.
- کالکشن تازه: سرور آن را در همان `pull` برمی‌گرداند؛ کلاینت ناشناخته را رد می‌کند ولی pull را نمی‌شکند.

## ۶. رفتار تلاش دوباره (retry)

| وضعیت | رفتار کلاینت |
|---|---|
| قطع شبکه / timeout | همان بسته با همان uidها دوباره؛ امن است |
| `500`/`502` | backoff نمایی + jitter |
| `429` | احترام به `Retry-After` (سقف ورود: ۲۰ در دقیقه برای هر شماره) |
| `400 bad_json` | باگ کلاینت — تلاش دوباره بی‌فایده است |
| `413` | بسته را به ≤۲۰۰ عملیات بشکن |
| `more: true` در pull | ادامه با `next_since` **و** `next_id` |
