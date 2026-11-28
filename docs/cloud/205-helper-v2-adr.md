# ردیف ۲۰۵ — ADR قرارداد Helper v2 (DP-0)

تصمیم مالک ۲۰۲۶-۱۱-۲۸: همهٔ منابع پردازشی (پنل مالک، سرور مدارس، Cloudflare Worker، GitHub Actions) موازی روی یک صف (صندوقچهٔ آروان، `server/helper-jobs.js`) کار کنند؛ نبودِ هر executor ⇒ دیگری یا اجرای محلی (`by: local`)؛ آروان فقط صندوق نامه با کمترین درخواست.

## وضعیت موجود (مرجع)
- `server/helper-jobs.js`: صف `payesh/helpers/` + `jobs/req|lease|res`، پاکت v1 ‏(HKDF-SHA256/AES-256-GCM، ‏AAD=`<kind>/v1/<rev>`)، ‏`runJob` با failover محلی، `helpersOnline`، سیاست `control/infra-policy.json`.
- Dart: `apps/payesh/owner/lib/src/helper/helper_box.dart` (قرارداد)، `helper_jobs.dart` (اجرا)، `helper_node.dart` (رزرو/تمدید)، بردار مشترک `docs/cloud/contracts/helper-jobs-vectors.json`.
- نوع‌کارهای v1: ‏`storage.usage`، ‏`object.verify`، ‏`endpoint.check`، ‏`bucket.gc` — همه بدون محتوای مدرسه (D-21).

## تصمیم v2 (افزودنی، سازگار عقب‌رو)
1. **پاکت ثابت**: envelope همان v:1 می‌ماند؛ متن داخل (plain) می‌تواند `v:2` باشد. `open()` در Node و `openHelper()` در Dart هر دو v1 و v2 را می‌پذیرند؛ خوانندهٔ قدیمی فیلد اضافه را نادیده می‌گیرد.
2. **حضور v2**: `cls` ‏(owner|school|cloudflare|actions)، ‏`caps`، ‏`capacity`، ‏`cpu_cap`، ‏`region`، ‏`contract`، ‏`school_id`. پیش‌فرض plainِ v1: ‏`cls=owner`، ‏`caps=kinds`.
3. **کار v2**: `priority` ‏(high|normal|low)، ‏`deadline_at` (همان فیلد v1)، ‏`idempotency_key`، ‏`data_class` ‏(public|internal|school-content)، ‏`school_id`.
4. **انتخاب executor** (`helper-v2.pickExecutor`): فقط `canLease`‌های مجاز؛ امتیاز = ظرفیت + تازگی حضور + نزدیکی کلاس − بار. صف همچنان هرگز متوقف نمی‌شود: نبودِ برنده ⇒ `runJob` محلی.
5. **مدل تهدید**: نتیجهٔ جعلی ⇒ برچسب GCM + بازخوانی اجاره/توکن؛ اجارهٔ رها‌شده ⇒ انقضای ۶۰ث و برداشت دیگری (`helper-executor.pollOnce`)؛ افشای کلید ⇒ کلید محدود پیشوند صف برای executorهای بیرونی (Secret محیطی، هرگز در مخزن) و توکن مشتق‌شدهٔ هر مدرسه (۲۰۹) به‌جای کلید صندوقچه.

## بردارها
`docs/cloud/contracts/helper-jobs-vectors-v2.json`: حضور v2، کار با اولویت، انقضای اجاره، رد کلاس دادهٔ نامجاز، سازگاری v1، نتیجهٔ تکراری + توکن مدرسه.

## پیامد
پیاده‌سازی در ۲۰۶ (Cloudflare)، ۲۰۷ (Actions)، ۲۰۹ (مدارس)، ۲۱۰ (هزینه/مشاهده)، شاهد در ۲۱۱. دادهٔ `school-content` پیش‌فرض برای executor بیرونی ممنوع می‌ماند.
