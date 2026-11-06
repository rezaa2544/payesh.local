#!/usr/bin/env bash
# بازبینی یکپارچگی PR #73 — FAIL-CLOSED
# اجرا: bash docs/cloud/reports/evidence/review-pr73-integrity.sh
# خروجی: docs/cloud/reports/evidence/mission-a-pr73-integrity.txt
#
# چه چیزی را بررسی می‌کند:
#   ۱) فهرست واقعی فایل‌های تغییرکرده نسبت به پایهٔ ممیزی + شمارش افزوده/تغییر/حذف
#   ۲) تغییر کد محصول (باید صفر باشد)
#   ۳) اعتبار همهٔ SHAهای ۷ و ۴۰ نویسه‌ای که در اسناد آمده‌اند
#   ۴) وجود همهٔ مسیرهای فایلی که اسناد به آن‌ها ارجاع می‌دهند
#   ۵) وجود همهٔ اسکریپت‌های شاهد
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

BASE=f2fc472
OUT=docs/cloud/reports/evidence/mission-a-pr73-integrity.txt
RC=0
fail() { echo "INTEGRITY-FAIL: $*" >&2; RC=1; }

CHANGED=$(git diff --name-status "$BASE" HEAD)
ADDED=$(echo "$CHANGED" | grep -c '^A' || true)
MODIFIED=$(echo "$CHANGED" | grep -c '^M' || true)
DELETED=$(echo "$CHANGED" | grep -c '^D' || true)
TOTAL=$((ADDED + MODIFIED + DELETED))

PROD=$(git diff --name-only "$BASE" HEAD -- server client tests installer scripts desktop | wc -l | tr -d ' ')
[ "$PROD" = "0" ] || fail "product code changed: $PROD file(s)"

DOCS=$(git diff --name-only "$BASE" HEAD -- docs | sort)

# ---------- SHAهای ذکرشده ----------
SHAS=$(grep -rhoE '\b[0-9a-f]{7,40}\b' docs/cloud/*.md docs/00-PAYESH-CLOUD-CONSTITUTION.md 2>/dev/null | sort -u)
BAD_SHA=""
CHECKED_SHA=0
for sh in $SHAS; do
  # فقط رشته‌هایی که شبیه SHA گیت‌اند (حداقل ۷ نویسه، حداقل یک رقم و یک حرف)
  case "$sh" in
    *[0-9]*) ;; *) continue ;;
  esac
  case "$sh" in
    *[a-f]*) ;; *) continue ;;
  esac
  [ ${#sh} -ge 7 ] || continue
  CHECKED_SHA=$((CHECKED_SHA + 1))
  if ! git cat-file -e "${sh}^{commit}" 2>/dev/null; then
    # ممکن است blob یا عدد نباشد؛ فقط اگر به‌صراحت «SHA» نامیده شده باشد خطاست
    if grep -rqE "(SHA|commit)[^a-z]{0,12}$sh" docs/cloud/*.md docs/00-PAYESH-CLOUD-CONSTITUTION.md 2>/dev/null; then
      BAD_SHA="$BAD_SHA $sh"
    fi
  fi
done
[ -z "$BAD_SHA" ] || fail "SHA(s) cited as commit but not found in repo:$BAD_SHA"

# ---------- مسیرهای ارجاع‌داده‌شده ----------
PATHS=$(grep -rhoE '`[A-Za-z0-9_./-]+\.(md|sh|log|txt|mjs|js|json)`' docs/cloud/*.md docs/00-PAYESH-CLOUD-CONSTITUTION.md 2>/dev/null \
        | tr -d '`' | sort -u)
MISSING=""
CHECKED_PATHS=0
for rel in $PATHS; do
  case "$rel" in
    */*) ;;              # فقط مسیرهای دارای اسلش
    *) continue ;;
  esac
  case "$rel" in
    docs/*|server/*|client/*|tests/*|scripts/*|installer/*|install/*|deploy/*|.github/*) ;;
    *) continue ;;
  esac
  CHECKED_PATHS=$((CHECKED_PATHS + 1))
  if [ ! -e "$rel" ]; then
    # مسیرهای آینده/مقصد مجازند اگر صریحاً «پیشنهادی» علامت خورده باشند — ولی شاهد نه
    MISSING="$MISSING $rel"
  fi
done
[ -z "$MISSING" ] || fail "documents reference non-existent path(s):$MISSING"

# ---------- اسکریپت‌های شاهد ----------
SCRIPTS="docs/cloud/reports/evidence/run-tests-evidence.sh
docs/cloud/reports/evidence/gen-audit-evidence.sh
docs/cloud/reports/evidence/gen-mission-12-16b.sh
docs/cloud/reports/evidence/verify-evidence-gate-negative.sh
docs/cloud/reports/evidence/rls-execution-test.sh
docs/cloud/reports/evidence/rls-execution-test.cjs"
for f in $SCRIPTS; do
  [ -f "$f" ] || fail "evidence script missing: $f"
done

{
  echo "# بازبینی یکپارچگی PR #73"
  echo "# تولید: bash docs/cloud/reports/evidence/review-pr73-integrity.sh"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $(git rev-parse HEAD)"
  echo "# base: $(git rev-parse "$BASE")"
  echo
  echo "## شمارش تغییرات نسبت به پایهٔ ممیزی"
  echo "added=$ADDED modified=$MODIFIED deleted=$DELETED total=$TOTAL"
  echo
  echo "## فهرست کامل فایل‌های تغییرکرده"
  echo "$CHANGED"
  echo
  echo "## تغییر کد محصول (server client tests installer scripts desktop)"
  echo "files=$PROD"
  git diff --stat "$BASE" HEAD -- server client tests installer scripts desktop
  echo
  echo "## SHAهای بررسی‌شده"
  echo "checked=$CHECKED_SHA invalid_as_commit=${BAD_SHA:-none}"
  echo
  echo "## مسیرهای ارجاع‌شده در اسناد"
  echo "checked=$CHECKED_PATHS missing=${MISSING:-none}"
  echo
  echo "## حکم"
  if [ "$RC" = "0" ]; then echo "INTEGRITY-OK"; else echo "INTEGRITY-FAIL"; fi
} > "$OUT"

echo "→ $OUT (added=$ADDED modified=$MODIFIED deleted=$DELETED prod=$PROD)"
[ "$RC" = "0" ] || echo "INTEGRITY-FAIL: see messages above" >&2
exit $RC
