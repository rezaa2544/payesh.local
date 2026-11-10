# ۷۲ — مدل تهدید دستگاه و ذخیره‌سازی امن کلاینت بومی (ADR‑43)

> وضعیت: پیاده‌سازی شده و در CI آزموده شده (ردیف ۷۲). آزمون واقعی روی دستگاه = **OWNER** (بخش ۸).
> دامنه: فقط اپ بومی Flutter مدرسه (Android APK/AAB و Windows EXE). سرور، Gateway و کلیدهای امضا خارج از دامنه‌اند
> (ردیف ۶۱: «به کلیدها دست نزن» — این سند هیچ کلید امضا یا Secret مخزن را لمس نمی‌کند؛ کلید پایگاه محلی
> در زمان اجرا روی خود دستگاه ساخته می‌شود و هرگز از دستگاه خارج نمی‌شود).

## ۱. دارایی‌ها

| دارایی | محل نگهداری | حساسیت |
|---|---|---|
| توکن نشست (`session.token`) | SecureStore | بالا — دسترسی به API به نام کاربر |
| شناسهٔ دستگاه (`device.id`) | SecureStore | متوسط — همبستگی درخواست‌ها |
| کلید پایگاه محلی (`db.key.v1`، ۲۵۶ بیت) | SecureStore | بالا — رمزگشایی همهٔ دادهٔ محلی |
| دادهٔ محلی (دانش‌آموز، نمره، حضور، صندوق خروجی) | `payesh.db` رمزنگاری‌شده | بالا (دادهٔ کودکان) |
| فهرست «نیازمند بررسی» تعارض‌ها (`sync_review`) | داخل همان پایگاه رمزنگاری‌شده | بالا |

## ۲. سازوکارها (آنچه پیاده شد)

| لایه | Android | Windows | آزمون |
|---|---|---|---|
| SecureStore | `KeystoreSecureStore.kt`: AES‑256‑GCM با کلید **غیرقابل‌استخراج** داخل Android Keystore (alias `payesh_secure_v1`، سخت‌افزاری در صورت پشتیبانی)، IV تصادفی، نام مدخل به‌عنوان AAD؛ فقط `iv‖ciphertext` در SharedPreferences خصوصی | `DpapiSecureStore`: `CryptProtectData` (کاربر جاری ویندوز، `CRYPTPROTECT_UI_FORBIDDEN`) با entropy وابسته به اپ و نام مدخل؛ فایل `<key>.dpapi` با نوشتن اتمی | Dart سمت کانال: `app/test/secure_storage_test.dart`؛ DPAPI **واقعی**: `payesh_secure/test/dpapi_windows_test.dart` روی `windows-latest`؛ fake: `secure_store_test.dart` |
| رمزنگاری پایگاه | SQLite3 Multiple Ciphers (MIT، بدون OpenSSL) از طریق build hook بستهٔ `sqlite3` (`source: sqlite3mc`)؛ رمز پیش‌فرض ChaCha20‑Poly1305 با MAC هر صفحه | همان | `payesh_data/test/encrypted_database_test.dart` روی ubuntu و Windows؛ بررسی وجود کتابخانهٔ رمزدار در APK و بستهٔ Windows |
| کلید پایگاه | `DatabaseKeyManager`: ۳۲ بایت از `Random.secure()`، فقط در SecureStore؛ چرخش امن در برابر crash (`db.key.next` قبل از rekey، ارتقا پس از موفقیت) | همان | `secure_store_test.dart` |
| پشتیبان‌گیری | `allowBackup=false`، `fullBackupContent=false`، `data_extraction_rules.xml` (cloud و device‑transfer مستثنا)؛ پایگاه در `noBackupFilesDir` | پوشهٔ `%LOCALAPPDATA%\Payesh` (غیر roaming) | بازبینی manifest در PR |
| شکست بسته (fail‑closed) | خطای SecureStore ⇒ هیچ پایگاهی باز نمی‌شود؛ نبود رمزنگاری در SQLite لینک‌شده ⇒ `EncryptionUnavailableException`؛ هرگز بازگشت به متن ساده نیست | همان | `openLocalStorage` آزمون‌ها |
| مهاجرت | فایل متن‌سادهٔ قدیمی ⇒ یک‌بار در جا رمزنگاری (`PRAGMA hexrekey`) | همان | آزمون مهاجرت |

## ۳. تهدیدها (STRIDE) و پاسخ

| # | تهدید | پاسخ | ریسک باقی‌مانده |
|---|---|---|---|
| T1 | گم/دزدیده‌شدن گوشی خاموش یا قفل؛ استخراج فایل‌ها | پایگاه رمزنگاری‌شده؛ کلید در Keystore (غیرقابل‌استخراج) | کم |
| T2 | کپی فایل‌های اپ از ویندوز به رایانهٔ دیگر یا حساب کاربری دیگر | DPAPI به کاربر و ماشین گره خورده؛ کپی قابل باز شدن نیست | کم |
| T3 | کاربر دیگر ویندوز روی همان رایانهٔ مدرسه | DPAPI حساب جاری؛ `%LOCALAPPDATA%` با ACL کاربر | کم (مدیر محلی سیستم می‌تواند با ابزار ویژه‌ای DPAPI کاربر را در جلسهٔ فعال او بشکند) |
| T4 | پشتیبان ابری / انتقال گوشی به گوشی | پشتیبان‌گیری غیرفعال؛ کلید Keystore به هر حال منتقل نمی‌شود | کم |
| T5 | دست‌کاری فایل پایگاه (Tampering) | MAC هر صفحه ⇒ خطا، نه خواندن خاموش | کم |
| T6 | جابه‌جاکردن blobهای SecureStore بین مدخل‌ها | AAD (Android) / entropy (Windows) وابسته به نام مدخل | کم |
| T7 | تزریق از طریق کلید در `PRAGMA` | کلید فقط ۶۴ رقم hex کوچک؛ اعتبارسنجی پیش از اجرا | ناچیز |
| T8 | بدافزار با دسترسی همان کاربر/روت در حین اجرای اپ | خارج از توان کلاینت؛ توکن نشست کوتاه‌عمر و ابطال سمت سرور | **متوسط — پذیرفته** |
| T9 | نشت توکن در لاگ | کانال خطا فقط نوع استثنا را برمی‌گرداند؛ مقدارها هرگز لاگ نمی‌شوند | کم |
| T10 | از دست رفتن کلید (پاک‌شدن Keystore، نصب مجدد، تغییر قفل صفحه در برخی دستگاه‌ها) | فایل قدیمی **قرنطینه** (حذف نمی‌شود) و پایگاه تازهٔ رمزنگاری‌شده ساخته می‌شود؛ داده از سرور دوباره pull می‌شود | عملیات ارسال‌نشدهٔ صندوق خروجی از دست می‌رود — به کاربر نمایش داده می‌شود |
| T11 | نسخهٔ ساخت بدون رمزنگاری (پیکربندی اشتباه) | اپ باز نمی‌شود (`EncryptionUnavailableException`)؛ CI وجود «SQLite3 Multiple Ciphers» را در APK و DLL ویندوز چک می‌کند | کم |
| T12 | ریشه‌کردن (root) گوشی | Keystore سخت‌افزاری کلید را حفظ می‌کند ولی اپ در حال اجرا قابل hook است؛ کشف root در این ردیف نیست | متوسط — پذیرفته، بازبینی در ردیف ۷۵ (pinning) |

## ۴. انتخاب SQLite3 Multiple Ciphers به‌جای SQLCipher

معیار ردیف «SQLCipher یا معادل» است. SQLite3MC انتخاب شد چون: مجوز MIT (SQLCipher Community با OpenSSL لینک می‌شود و مجوز جدا دارد)،
بدون وابستگی OpenSSL روی Android/Windows، نسخهٔ SQLite جدیدتر، و پشتیبانی رسمی از طریق hook بستهٔ `sqlite3` با sha256 تأییدشده.
در صورت نیاز به سازگاری فایل با SQLCipher، SQLite3MC می‌تواند طرح `sqlcipher` را با `PRAGMA cipher` انتخاب کند (تصمیم آتی، بدون تغییر API).

## ۵. خارج از دامنه

- کلیدهای امضای اپ و Secretهای مخزن (ردیف ۶۱، به تصمیم مالک).
- Certificate pinning (ردیف ۷۵).
- کشف root/jailbreak و ضد دیباگ.

## ۶. وابستگی‌ها و مجوزها

- `sqlite3` (MIT) + SQLite3 Multiple Ciphers (MIT)، `ffi` (BSD‑3).
- هیچ پلاگین/وابستگی WebView یا JS؛ گیت بومی (ردیف ۶۳) روی هر ساخت اجرا می‌شود.

## ۷. شواهد CI

- `dart` job: analyze بدون هشدار و آزمون/پوشش همهٔ بسته‌ها از جمله `payesh_secure` و آزمون‌های رمزنگاری `payesh_data`.
- `windows` job: آزمون‌های DPAPI **واقعی** (`DPAPI-WINDOWS-OK`) + آزمون پایگاه رمزنگاری‌شده روی Windows + `SQLITE-CIPHER-WINDOWS-OK`.
- `android` job: `SQLITE-CIPHER-ANDROID-OK` (کتابخانهٔ رمزدار برای هر ABI داخل APK).
- خروجی خام: `docs/cloud/reports/evidence/native-72-ci.txt`.

## ۸. آزمون روی دستگاه — OWNER

1. نصب APK آرتیفکت `native-android` روی گوشی واقعی (Android ≥ 7)؛ اجرای اپ ⇒ متن «پایگاه محلی رمزنگاری‌شده فعال است».
2. بستن و بازکردن دوباره ⇒ همان پیام (کلید از Keystore خوانده شد).
3. (اختیاری، دستگاه دیباگ) `adb shell run-as ir.payesh.school.payesh_app ls no_backup` ⇒ `payesh.db` وجود دارد؛ ۱۶ بایت اول آن «SQLite format 3» **نیست**.
4. `adb backup` / انتقال گوشی ⇒ دادهٔ اپ منتقل نمی‌شود.
5. Windows: اجرای `payesh_app.exe` از آرتیفکت `native-windows` ⇒ همان پیام؛ پوشهٔ `%LOCALAPPDATA%\Payesh\secure\db.key.v1.dpapi` موجود و بدون متن خوانا.
6. ورود با حساب کاربری دیگر ویندوز روی همان رایانه و کپی پوشه ⇒ اپ کلید را نمی‌تواند باز کند (پایگاه قرنطینه و تازه ساخته می‌شود).
