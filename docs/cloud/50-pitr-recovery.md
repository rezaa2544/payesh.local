# پشتیبان‌گیری مدیریت‌شده / PITR و تمرین بازیابی — ردیف ۵۰

| | |
|---|---|
| ردیف | ۵۰ (فاز ۶ — عملیات، SRE و مقیاس دیتابیس) · وابسته به ۳۴ و ۵۶ (`O-20`) |
| وضعیت | **In Progress / Review (کد، آزمون، تطبیق چک‌سام سه‌لایه و ران‌بوک کامل است؛ اجرای `[M]` روی PostgreSQL مدیریت‌شده منتظر تصمیم `O-20` است)** |
| کد و ابزار | `server/pitr.js` · `tools/pitr-drill-50.mjs` · `server/transfer.js` (تطبیق سه‌لایه) |
| آزمون و شاهد | `npm run test:pitr50` → `tests/pitr-50.js` (`PT‑01..PT‑10`) · `docs/cloud/reports/evidence/pitr-50.txt` |

---

## ۱. هدف و مرز صداقت (`[S]` در برابر `[M]`)

معیار پذیرش ردیف ۵۰ چهار بخش دارد:
1. **PITR فعال روی دیتابیس واقعی** (`wal_level=replica/logical` و آرشیو پیوستهٔ WAL یا branching مدیریت‌شده).
2. **تمرین restore با `RPO <= ۵ دقیقه` (`300,000 ms`) و `RTO <= ۲ ساعت` (`7,200,000 ms`)** روی پلن واقعی مدیریت‌شده (`[M]`).
3. **تأیید یکپارچگی سه‌لایه** (`counts` + `SHA-256 checksums` + `seqs` به‌ازای هر جدول و هر `tenant_id`).
4. **مستندسازی رویهٔ failover دستی**.

> **مرز صداقت:** تمرین قبلی ردیف ۲۹ (`RPO = 1210 ms`، `RTO = 404 ms`) روی PostgreSQL موقت تک‌میزبان بود (`[S]`). در `server/pitr.js` و `tools/pitr-drill-50.mjs`، هر میزبان محلی (`localhost`, `127.0.0.1`) به‌طور خودکار برچسب `[S]` (`PITR-50-SIMULATED-OK`) می‌گیرد و با پرچم `--require-managed` با کد خروج `3` (`PITR-50-NOT-MANAGED-PG`) رد می‌شود تا هرگز تمرین تک‌میزبان به‌جای شاهد تولیدی `[M]` ثبت نشود.

---

## ۲. معماری بازیابی به نقطهٔ زمانی (PITR) و تطبیق چک‌سام

```
basebackup.json (SHA-256)  +  wal.jsonl (LSN + ISO timestamp + CRC SHA-256)
          │
          ▼  restoreToPointInTime(target_iso)
  بازپخش تراکنش‌های t <= target_iso  ·  حذف تراکنش‌های مخرب t > target_iso
          │
          ▼  reconcile(expectedAtTarget, restoredSnapshot)
  لایه ۱: شمارش ردیف هر جدول
  لایه ۲: SHA-256 محتوای مرتب‌شدهٔ هر جدول (بدون وابستگی به ترتیب فیزیکی)
  لایه ۳: تطبیق seq / version تک‌تک رکوردها در change-feed
```

---

## ۳. رویهٔ گام‌به‌گام Failover دستی (Manual Failover Runbook)

در صورت بروز خرابی غیرقابل‌برگشت در نمونهٔ اصلی یا فساد منطقی داده پس از لحظهٔ `T_target`:

### گام ۱ — توقف نوشتن (Write Freeze)
پیش از تغییر مسیر ترافیک، نوشتن روی مستأجر(ها) یا کل Gateway را متوقف کنید تا split-brain رخ ندهد:
```bash
PAYESH_CELL_TRANSFER_ENABLED=1 node tools/cell-transfer-54.mjs \
  --freeze --tenant <TENANT_UUID> --from "$PRIMARY_DATABASE_URL" --reason "pitr-failover"
```

### گام ۲ — ساخت شاخه/نمونهٔ بازیابی در نقطهٔ هدف (`T_target`)
- **در Neon:** ساخت شاخهٔ بازیابی در لحظهٔ `T_target` (`neon branches create --name pitr-restore --parent main --time "$T_TARGET"`).
- **در Supabase / RDS:** اجرای Point-in-Time Restore به `T_target` و دریافت رشتهٔ اتصال نمونهٔ جدید (`$RESTORED_DATABASE_URL`).

### گام ۳ — راستی‌آزمایی WAL/LSN و تطبیق سه‌لایهٔ چک‌سام
پیش از هدایت ترافیک به نمونهٔ بازیابی‌شده، ابزار ردیف ۵۰ را اجرا کنید:
```bash
node tools/pitr-drill-50.mjs --pg-drill \
  --primary "$PRIMARY_DATABASE_URL" \
  --restored "$RESTORED_DATABASE_URL" \
  --tenant "<TENANT_UUID>" \
  --target-time "$T_TARGET" \
  --require-managed
```
شرط عبور: خروجی باید `reconciliation.ok: true`، `rpo_ok: true` (`<= 300000 ms`)، `rto_ok: true` (`<= 7200000 ms`) و حکم `PITR-50-MANAGED-OK` بدهد.

### گام ۴ — تغییر مسیر ترافیک (Promote & Repoint)
1. مقدار `DATABASE_URL` (و در صورت وجود `DATABASE_REPLICA_URL`) را در محیط Gateway به `$RESTORED_DATABASE_URL` تغییر دهید.
2. سلامت سرویس را با `/readyz` و `/metrics` (`payesh_ready == 1` و `payesh_db_up == 1`) بررسی کنید.

### گام ۵ — باز کردن نوشتن (Unfreeze) یا بازگشت (Rollback)
- در صورت سبز بودن `/readyz` و تطبیق چک‌سام:
  ```bash
  PAYESH_CELL_TRANSFER_ENABLED=1 node tools/cell-transfer-54.mjs \
    --unfreeze --tenant <TENANT_UUID> --from "$RESTORED_DATABASE_URL"
  ```
- در صورت مشاهدهٔ هرگونه عدم تطبیق (`PITR-50-FAILED`): ترافیک را روی نمونهٔ قبلی نگه دارید و شاخهٔ معیوب را حذف کنید (Rollback).

---

## ۴. آنچه اثبات شده (`[S]`) و آنچه منتظر تصمیم مالک (`O-20`) است (`[M]`)

- **اثبات‌شده در این مخزن (`[S]`):**
  - موتور `server/pitr.js` و ابزار `tools/pitr-drill-50.mjs`؛
  - ۱۰ آزمون خودکار (`PT-01..PT-10`) شامل کنترل‌های منفی فساد ۱ بایت چک‌سام، نشت تراکنش پس از `target_iso`، کسری رکورد WAL، نقض RPO/RTO، و رد شدن میزبان غیرمدیریت‌شده در حالت `--require-managed`.
- **باقی‌مانده برای بستن نهایی ردیف ۵۰ (`[M]`):**
  - پس از اعلام تصمیم مالک در ردیف ۵۶ (`O-20`) و دریافت `$PRIMARY_DATABASE_URL` و `$RESTORED_DATABASE_URL` روی پلن مدیریت‌شده، اجرای دستور گام ۳ توسط هرمس و ثبت خروجی `PITR-50-MANAGED-OK`.
