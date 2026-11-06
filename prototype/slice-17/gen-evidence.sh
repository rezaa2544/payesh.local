#!/usr/bin/env bash
# شاهد خودکار نمونهٔ فنی ۱۷ — دسترسی مجاز/غیرمجاز + جداسازی tenant
# اجرا: bash prototype/slice-17/gen-evidence.sh
# خروجی سبز: docs/cloud/reports/evidence/slice-17-rbac.txt
# قاعدهٔ fail-closed: اگر آزمون یا هر ادعا شکست بخورد، شاهد سبز نوشته نمی‌شود.
set -u
cd "$(dirname "$0")/../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
OUT="docs/cloud/reports/evidence/slice-17-rbac.txt"
TS=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

if ! node prototype/slice-17/tests/run.js >"$TMP" 2>&1; then
  BAD="docs/cloud/reports/evidence/slice-17-rbac.FAILED-$TS.txt"
  cp "$TMP" "$BAD"
  echo "SLICE-17-FAILED: جزئیات در $BAD" >&2
  grep '^✗' "$BAD" >&2 || true
  exit 1
fi

PASS=$(sed -n 's/^SUMMARY pass=\([0-9]*\).*/\1/p' "$TMP")
FAIL=$(sed -n 's/^SUMMARY pass=[0-9]* fail=\([0-9]*\).*/\1/p' "$TMP")
TOTAL=$(sed -n 's/^.* total=\([0-9]*\)$/\1/p' "$TMP")

if [ "${FAIL:-1}" != "0" ] || [ "${PASS:-0}" -lt 30 ] || [ "$PASS" != "$TOTAL" ]; then
  BAD="docs/cloud/reports/evidence/slice-17-rbac.FAILED-$TS.txt"
  cp "$TMP" "$BAD"
  echo "SLICE-17-FAILED: شمارش ناسازگار (pass=$PASS fail=$FAIL total=$TOTAL)" >&2
  exit 1
fi

# گارد مکمل: کد محصول نباید در این مرحله تغییر کرده باشد (این مرحله نمونهٔ جداست)
PROD=$(git diff --name-only f2fc472 HEAD -- server client tests scripts package.json package-lock.json installer desktop install deploy | wc -l | tr -d ' ')
if [ "$PROD" != "0" ]; then
  echo "SLICE-17-FAILED: کد محصول $PROD فایل تغییر کرده — نمونهٔ ۱۷ نباید محصول را دست بزند" >&2
  exit 1
fi

{
  echo "# شاهد نمونهٔ فنی ۱۷ — ورود و مجوزدهی نقش‌محور + جداسازی tenant"
  echo "# تولید: bash prototype/slice-17/gen-evidence.sh"
  echo "# base_head: $(git rev-parse HEAD)"
  echo "# generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $(node -v)"
  echo "# command: node prototype/slice-17/tests/run.js"
  echo "# product_diff_vs_f2fc472: $PROD فایل (۰ = کد محصول دست‌نخورده)"
  echo "# مرجع طراحی: ۰۱ §۳.۲ (ماتریس نقش×داده) · ۱۲ §۱–۲ (Tenant Resolver + DAL) · ۱۲ §۳ (sessions/audit) · D‑24"
  echo
  echo "## خلاصه"
  echo "SUMMARY pass=$PASS fail=$FAIL total=$TOTAL"
  echo "tenant_isolation_cases=$(grep -c 'مستأجر' "$TMP")"
  echo "claims_passed=$(grep -c '^✓' "$TMP")"
  echo "explicit_401_403_cases=$(grep -cE '40[13]' "$TMP")"
  echo
  echo "## ماتریس سیاست (از policy.js — همان جدول ۰۱ §۳.۲، زیرمجموعهٔ نمونه)"
  node -e '
    const p = require("./prototype/slice-17/policy.js");
    for (const [res, rows] of Object.entries(p.SCHOOL_DATA)) {
      for (const [role, perm] of Object.entries(rows)) {
        console.log(`${res.padEnd(12)} ${role.padEnd(15)} ${Object.entries(perm).map(([k,v]) => k+":"+v).join(" ")}`);
      }
    }
    console.log("platform_health " + Object.entries(p.PLATFORM_DATA.platform_health).map(([r,pp]) => r+":"+Object.entries(pp).map(([k,v])=>k+":"+v).join("/")).join(" "));
  '
  echo
  echo "## خروجی خام آزمون"
  cat "$TMP"
} >"$OUT"

echo "→ $OUT"
echo "SLICE-17-OK"
echo "checks_pass=$PASS fail=$FAIL total=$TOTAL"
