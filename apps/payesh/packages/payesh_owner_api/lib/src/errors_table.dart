// Generated once from apps/owner-panel/web/app.js (OwnerPanel.ERRORS): the same Persian
// texts as the retired WebView panel.
// test/parity_test.dart re-derives the map from app.js and fails on any drift.

/// Server error code (or client kind) → Persian message.
const Map<String, String> ownerErrors = {
  'network': 'ارتباط با سرور برقرار نشد. اتصال شبکه یا Gateway را بررسی کنید.',
  'bad_response': 'پاسخ سرور قابل‌خواندن نبود.',
  'unauthorized': 'نشست شما معتبر نیست یا منقضی شده است؛ دوباره وارد شوید.',
  'role_forbidden': 'نقش شما اجازهٔ این کار را ندارد (سرور درخواست را رد کرد).',
  'forbidden': 'لایهٔ داده اجازهٔ این کار را نداد.',
  'not_configured': 'API پلتفرم روی سرور پیکربندی نشده است (not_configured).',
  'upstream_not_configured':
      'آدرس API پلتفرم برای این سرور پنل تنظیم نشده است.',
  'upstream_unavailable': 'API پلتفرم در دسترس نیست.',
  'rate_limited': 'تعداد درخواست‌ها از سقف گذشت؛ کمی بعد دوباره تلاش کنید.',
  'rate_limit_unavailable': 'سامانهٔ سهمیهٔ درخواست در دسترس نیست.',
  'reason_too_short': 'دلیل باید دست‌کم ۱۰ نویسه باشد.',
  'grant_required': 'برای خواندن محتوا مجوز فعال لازم است.',
  'bulk_content_forbidden': 'دریافت انبوه محتوای مدرسه مجاز نیست.',
  'tenant_deletion_disabled': 'حذف فوری مدرسه مجاز نیست؛ فقط درخواست حذف با تأیید مالک دوم و مهلت ۲۴ ساعت.',
  'four_eyes_required': 'درخواست‌دهندهٔ حذف نمی‌تواند خودش آن را تأیید کند؛ مالک دیگری باید تأیید کند.',
  'deletion_delay_pending': 'مهلت ۲۴ ساعتهٔ پس از تأیید هنوز تمام نشده است.',
  'confirm_mismatch': 'شناسهٔ تکرارشدهٔ مدرسه با مدرسهٔ انتخاب‌شده یکسان نیست.',
  'tenant_not_found': 'مدرسه پیدا نشد.',
  'subscription_not_found': 'اشتراک پیدا نشد.',
  'request_not_found': 'درخواست پیدا نشد.',
  'grant_not_found': 'مجوز پیدا نشد.',
  'invalid_scope': 'دامنهٔ مجوز نامعتبر است.',
  'invalid_tenant_id': 'شناسهٔ مدرسه نامعتبر است.',
  'invalid_input': 'ورودی با قیدهای داده سازگار نیست.',
  'conflict': 'این رکورد قبلاً ثبت شده است (برای این مدرسه درخواست باز دیگری وجود دارد).',
  'body_too_large': 'حجم درخواست بیش از حد مجاز است.',
  'bad_json': 'بدنهٔ درخواست JSON معتبر نیست.',
  'login_unavailable': 'صادرکنندهٔ ورود (رمز + TOTP، تصمیم D‑45) روی این سرور نصب نشده است (migration 004)؛ ورود ممکن نیست.',
  'login_failed': 'شناسه، رمز یا کد دومرحله‌ای نادرست است. هر کد فقط یک بار پذیرفته می‌شود و پس از ۵ تلاش ناموفق، حساب ۱۵ دقیقه قفل می‌شود.',
  'credentials_not_accepted': 'رمز، توکن یا کلید خام پذیرفته نمی‌شود؛ فقط ارجاع به Secret به شکل secret:NAME.',
  'credential_must_be_reference':
      'Credential باید ارجاع به Secret باشد: secret:NAME.',
  'provider_api_not_implemented': 'اتصال به API ارائه‌دهنده هنوز پیاده نشده است (ردیف ۱۲۴)؛ فقط ثبت دستی ممکن است.',
  'label_required':
      'هر عدد باید برچسب [M] (اندازه‌گیری‌شده) یا [E] (برآورد) داشته باشد.',
  'check_cooldown': 'این Endpoint همین الان بررسی شده است؛ بین دو بررسی دستی دست‌کم ۳۰ ثانیه فاصله لازم است.',
  'endpoint_disabled': 'این Endpoint غیرفعال است.',
  'endpoint_not_found': 'Endpoint پیدا نشد.',
  'invalid_endpoint': 'نشانی Endpoint نامعتبر است (فقط http/https/tcp و بدون نام کاربری و رمز).',
  'invalid_action': 'نوع درخواست تغییر نامعتبر است.',
  'invalid_slug': 'نشانی کوتاه مدرسه نامعتبر است.',
  'invalid_display_name': 'نام نامعتبر است.',
  'invalid_manager_name': 'نام مدیر نامعتبر است.',
  'school_provisioning_not_configured': 'ساخت مدرسه روی این سرور پیکربندی نشده است (اتصال Gateway به پایگاه مدرسه).',
  'school_provisioning_failed': 'ساخت سمت مدرسه ناموفق بود؛ مدرسه در حالت «در حال ساخت» مانده است و تلاش دوباره با همان فرم امن است.',
  'slug_taken_in_school_db':
      'این نشانی کوتاه در پایگاه مدرسه قبلاً گرفته شده است.',
  'internal_error': 'خطای داخلی سرور.',
  'not_found': 'مسیر روی سرور وجود ندارد.',
};
