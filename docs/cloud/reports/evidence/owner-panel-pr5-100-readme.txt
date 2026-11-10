base_sha=c91aa49a7e2ca78c7c3e482685e10eb4e2a2a25e
code_sha=119ad51b2a305ee50915ea1bf1f4abeb42e7f291
date_utc=2026-11-10T18:30:36Z
branch=arena/owner-readme-links-100
env=Linux x86_64 · node v22 (npx --package=node@22)
command=npx --yes --package=node@22 -c 'npm test && bash docs/cloud/reports/evidence/run-tests-evidence.sh && bash docs/cloud/reports/evidence/gen-audit-evidence.sh'
# ردیف ۱۰۰ — پنل مالک PR‑5: لینک مستقیم نصبی‌های مالک در README + گیت تطابق نام‌ها
# برچسب‌ها: [M] ماشینی/کد، [S] شاهد خام، [E] محیط/اجرا، [A] ادعا، [?] نامشخص · security_status=UNKNOWN

## محدودهٔ تغییر
- README.md — بلوک <!-- owner-panel-downloads:start … end --> بالای README (پس از نقل‌قول AGENTS)؛ ۴ لینک با نام دقیق:
  payesh-owner-setup.exe · payesh-owner.apk · payesh-owner-web.zip · SHA256SUMS
  پایه: https://github.com/rezaa2544/payesh.local/releases/download/owner-continuous/
  هشدار صریح: «نصبی فقط برای مالک؛ تست روی دستگاه واقعی هنوز تأیید نشده [?]». جدول دانلود مدرسه بدون تغییر.
- apps/owner-panel/tests/packaging.test.js — قانون P6_readme_links: نشانگرهای بلوک در بالای README؛ نام لینک‌ها = نام‌های حلقهٔ انتشار
  owner-panel.yml + SHA256SUMS؛ متن هشدار؛ توضیح SmartScreen؛ ردیف‌های جدول مدرسه دست‌نخورده. ۶ جهش جدید (همه گرفته شد).
- apps/owner-panel/scripts/check-owner-artifacts.js — هر خروجی kind و signing دارد:
  signed-verified · unsigned-smartscreen-warning (exe) · unsigned-test-only (apk)؛ APK فقط با امضای تأییدشده release_eligible؛
  exe بدون امضا با برچسب SmartScreen قابل انتشار (تصمیم مالک: EXE بدون امضا + SHA256 + توضیح محدودیت SmartScreen).
- .github/workflows/owner-panel.yml — یادداشت انتشار هر اجرا به‌روز (gh release edit)؛ چاپ وضعیت امضای هر فایل منتشرشده.
  بلوک تأیید APK امضاشده (PR #165، bd2cb53) بدون تغییر حفظ شد.
- docs/00-PAYESH-CLOUD-CONSTITUTION.md 1.15 (اصلاح D‑44) · docs/cloud/62-adr-owner-panel-packaging.md §9.
دست‌نخورده: build.yml، desktop/*، installer/payesh.iss، امضای اندروید مدرسه، ردیف ۶۳، استقلال بومی اپ مدرسه.

## نتایج اجرا روی code_sha
pass=110 fail=0 registered=110 (mission-05-tests-run.log) · EVIDENCE-OK
OWNER-PACKAGING rules=8 mutations_caught=28 gate_negative_controls=15 failures=0
OWNER-ARTIFACTS-SELFTEST negative_controls=15 positives=2 failures=0
OWNER-SPA checks=136 failures=0 · OWNER-LOGIN unit_checks=26 negative_controls=32 failures=0

## جدول «ادعا ← شاهد ← وضعیت»
| ادعا | شاهد | وضعیت |
|---|---|---|
| لینک‌ها بالای README با نام دقیق | P6_readme_links + README.md | [M] |
| گیت CI: نام لینک = نام خروجی workflow | P6 در npm test (CI «آزمون…») + ۶ جهش | [M] |
| هشدار صریح مالک | P6 متن را دقیق می‌سنجد | [M] |
| APK بدون امضا منتشر نمی‌شود | self-test: unsigned apk ⇒ release_eligible=false | [M] |
| لینک‌ها پس از انتشار main پاسخ می‌دهند | بررسی پس از merge (HTTP روی ۴ لینک) | [?] تا اجرای main |
| تست روی دستگاه واقعی | انجام نشده | [?] |
