#!/usr/bin/env bash
# بازتولید شاهد خام ساختاری مأموریت ۰۲
# اجرا از ریشهٔ مخزن:  bash docs/cloud/reports/evidence/gen-mission-02-evidence.sh > docs/cloud/reports/evidence/mission-02-structure.txt
# این اسکریپت هیچ چیزی را تغییر نمی‌دهد؛ فقط می‌خواند و چاپ می‌کند.
set -u

D=docs/cloud/02-scenarios.md
C=docs/00-PAYESH-CLOUD-CONSTITUTION.md

echo "# شاهد خام ساختاری — مأموریت ۰۲ (سناریوهای آنلاین/آفلاین/قطع دیتاسنتر)"
echo "# تاریخ: ۱۴۰۴/۰۸/۱۵ · مخزن: rezaa2544/payesh.local · تغییر کد محصول: هیچ (فاز ۰)"
echo
echo "\$ git rev-parse HEAD   (قبل از کامیت شاهد)"
git rev-parse HEAD
echo
echo "\$ git status --porcelain"
git status --porcelain
echo
echo "\$ grep -oP '^\| S[0-9]+[^ ]*' $D | wc -l   # تعداد شناسه سناریو (انتظار: ۲۶)"
grep -oP '^\| S[0-9]+[^ ]*' "$D" | wc -l
echo
echo "\$ grep -oP '^\| S[0-9]+[^ ]*' $D | sed 's/^| //' | tr '\n' ' '"
grep -oP '^\| S[0-9]+[^ ]*' "$D" | sed 's/^| //' | tr '\n' ' '
echo
echo
echo "\$ grep -c '^| AC' $D   # تعداد ردیف ماتریس معیارهای پذیرش (انتظار: ۱۴)"
grep -c '^| AC' "$D"
echo
echo "\$ grep -n 'orphaned' $D   # اصلاح ۱: ابطال دستگاه = تعیین تکلیف صف سپس پاک‌سازی"
grep -n 'orphaned' "$D"
echo
echo "\$ grep -n 'applied_ops' $D   # اصلاح ۲: تعریف commit و idempotency"
grep -n 'applied_ops' "$D"
echo
echo "\$ grep -n 'وابستگی‌محور' $D   # اصلاح ۳: ترتیب وابستگی‌محور"
grep -n 'وابستگی‌محور' "$D"
echo
echo "\$ grep -c 'مقدار پیشنهادی، اثبات‌نشده' $D   # اصلاح ۴: آستانهٔ ۱۵ ثانیه اثبات‌نشده"
grep -c 'مقدار پیشنهادی، اثبات‌نشده' "$D"
echo
echo "\$ grep -c 'ورود بسته است' $D   # اصلاح ۵: تفکیک expired از suspended"
grep -c 'ورود بسته است' "$D"
echo
echo "\$ grep -c '^| \*\*D‑2[678]\*\*' $C   # تصمیم‌های ثبت‌شده در قانون اساسی (انتظار: ۳)"
grep -c '^| \*\*D‑2[678]\*\*' "$C"
echo
echo "\$ git diff --stat"
git diff --stat
