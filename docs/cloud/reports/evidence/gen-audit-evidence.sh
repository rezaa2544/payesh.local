#!/usr/bin/env bash
# شاهد ساختاری ممیزی‌های ۰۵ تا ۱۱  —  FAIL-CLOSED
# اجرا: bash docs/cloud/reports/evidence/gen-audit-evidence.sh
# خروجی: docs/cloud/reports/evidence/mission-05-11-structure.txt
#
# قرارداد (اصلاح‌شده پس از A-01):
#   * اگر لاگ خام آزمون نباشد  ⇒ خروج با کد ۳ (شاهد موجود نیست)
#   * اگر لاگ ناقص/شکست‌خورده باشد ⇒ خروج غیرصفر
#   * اگر ادعای اسناد با عدد واقعی نخواند ⇒ خروج غیرصفر
#   * هیچ پیام «موفق» بدون بررسی واقعی چاپ نمی‌شود.
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

LOG=docs/cloud/reports/evidence/mission-05-tests-run.log
OUT=docs/cloud/reports/evidence/mission-05-11-structure.txt
DOCS="docs/cloud/05-audit-sha-freeze.md docs/cloud/06-audit-auth-session.md docs/cloud/07-audit-roles-tenant.md docs/cloud/08-audit-source-of-truth.md docs/cloud/09-audit-cache-queue-sync.md docs/cloud/10-audit-crypto-backup-restore.md docs/cloud/11-gap-report.md"
FA=docs/cloud/0[6-9]*.md
FB=docs/cloud/10*.md

RC=0
fail() { echo "EVIDENCE-FAIL: $*" >&2; RC=1; }

# ---------- ۱) وجود و سلامت لاگ خام ----------
if [ ! -f "$LOG" ]; then
  echo "EVIDENCE-FAIL: log not found: $LOG" >&2
  echo "EVIDENCE-FAIL: run  bash docs/cloud/reports/evidence/run-tests-evidence.sh  first" >&2
  exit 3
fi

SUMMARY=$(grep -o 'SUMMARY pass=[0-9]* fail=[0-9]*' "$LOG" | tail -1)
EXITC=$(grep -o '^EXIT=[0-9]*' "$LOG" | tail -1 | cut -d= -f2)
LOGSHA=$(grep -m1 '^# commit_sha:' "$LOG" | awk '{print $3}')
LOGTIME=$(grep -m1 '^# started_utc:' "$LOG" | awk '{print $3}')
LOGFP=$(grep -m1 '^# product_tree_sha256:' "$LOG" | awk '{print $3}')
HEADFP=$(git ls-tree -r HEAD -- server client tests installer scripts desktop | sha256sum | cut -d" " -f1)

[ -n "$SUMMARY" ] || fail "no SUMMARY line in raw log (evidence incomplete)"
[ -n "$EXITC" ]   || fail "no EXIT=<code> line in raw log"
PASS=$(echo "$SUMMARY" | sed -E 's/.*pass=([0-9]+).*/\1/')
FAILS=$(echo "$SUMMARY" | sed -E 's/.*fail=([0-9]+).*/\1/')
[ -n "${PASS:-}" ] || PASS=0
[ -n "${FAILS:-}" ] || FAILS=0

[ "${EXITC:-x}" = "0" ] || fail "npm test exit code is '${EXITC:-missing}', not 0"
[ "$FAILS" = "0" ] || fail "$FAILS failing test(s) in raw log"
[ "$PASS" -ge 1 ] || fail "raw log contains no passing test"
if ! echo "$LOGSHA" | grep -Eq '^[0-9a-f]{40}$'; then
  fail "raw log has no valid commit_sha (got '${LOGSHA:-none}')"
fi
if [ -z "${LOGFP:-}" ]; then
  fail "raw log has no product_tree_sha256 (cannot attribute evidence to product code)"
elif [ "$LOGFP" != "$HEADFP" ]; then
  fail "product code differs from the tested tree: log=$LOGFP head=$HEADFP — rerun run-tests-evidence.sh"
fi

# ---------- ۲) شمارش واقعی احکام ----------
P=$(grep -rho '| \*\*PASS\*\*' $FA $FB 2>/dev/null | wc -l)
F=$(grep -rho '| \*\*FAIL'      $FA $FB 2>/dev/null | wc -l)
U=$(grep -rho '| \*\*UNKNOWN'   $FA $FB 2>/dev/null | wc -l)
B=$(grep -rho '| \*\*BLOCKED'   $FA $FB 2>/dev/null | wc -l)
TOTAL=$((P + F + U + B))

# ---------- ۳) ادعاهای اسناد ----------
read -r CLAIM_TESTS CLAIM_PASS CLAIM_FAIL CLAIM_UNK <<<"$(python3 - <<'PYEOF'
import re
fa = lambda s: int(''.join(str(ord(c)-0x06f0) for c in s)) if s else None
d05 = open('docs/cloud/05-audit-sha-freeze.md', encoding='utf-8').read()
d11 = open('docs/cloud/11-gap-report.md', encoding='utf-8').read()
m = re.search(r'([\u06f0-\u06f9]+) موفق', d05)
t = fa(m.group(1)) if m else None
def row(label):
    mm = re.search(r'\|\s*\*\*' + label + r'\*\*\s*\|\s*([\u06f0-\u06f9]+)', d11)
    return fa(mm.group(1)) if mm else None
print(t if t is not None else '', row('PASS') if row('PASS') is not None else '',
      row('FAIL') if row('FAIL') is not None else '', row('UNKNOWN') if row('UNKNOWN') is not None else '')
PYEOF
)"

[ -n "${CLAIM_TESTS:-}" ] || fail "docs 05/11 no longer state the test count — claims and evidence are not linked"
if [ -n "${CLAIM_TESTS:-}" ] && [ "$CLAIM_TESTS" != "$PASS" ]; then
  fail "docs claim ${CLAIM_TESTS} passing tests but raw log shows ${PASS}"
fi

# ---------- ۴) تغییر کد محصول ----------
PROD_DIFF=$(git diff --name-only f2fc472 HEAD -- server client tests installer scripts 2>/dev/null | wc -l)
[ "$PROD_DIFF" = "0" ] || fail "product code changed vs audit base f2fc472: $PROD_DIFF file(s)"

# ---------- ۵) تولید شاهد ----------
{
  echo "# شاهد ساختاری ممیزی ۰۵–۱۱"
  echo "# تولید: bash docs/cloud/reports/evidence/gen-audit-evidence.sh"
  echo "# تاریخ تولید: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# تاریخ اجرای آزمون (از لاگ خام): ${LOGTIME:-?}"
  echo "# SHA اجرای آزمون (از لاگ خام): ${LOGSHA:-?}"
  echo "# SHA فعلی HEAD: $(git rev-parse HEAD)"
  echo "# اثر انگشت کد محصول (log / HEAD): ${LOGFP:-?} / ${HEADFP}"
  echo "# branch: $(git rev-parse --abbrev-ref HEAD)"
  echo
  echo "## آزمون واقعی مخزن (از لاگ خام، بدون دست‌کاری)"
  echo "SUMMARY: ${SUMMARY:-MISSING}"
  echo "EXIT: ${EXITC:-MISSING}"
  echo "ادعای اسناد: ${CLAIM_TESTS:-?} آزمون موفق"
  echo
  echo "## پروب‌های اجرایی ۰۶–۱۰ (خروجی خام: mission-06-10-probes.txt)"
  echo "تعداد خط شاهد: $(grep -c '^\[' docs/cloud/reports/evidence/mission-06-10-probes.txt 2>/dev/null || echo MISSING)"
  grep -o 'F-0[0-9]' docs/cloud/reports/evidence/mission-06-10-probes.txt 2>/dev/null | sort | uniq -c | sed 's/^/  /'
  echo
  echo "## وضعیت هر سند"
  for d in $DOCS; do
    echo "--- $d"
    echo "خطوط: $(wc -l < "$d") · ردیف AC: $(grep -c '^| AC' "$d")"
    grep -n '^| وضعیت' "$d" | head -1
    grep -o 'F‑0[0-9]' "$d" | sort -u | tr '\n' ' ' | sed 's/^/یافته‌ها: /'
    echo
  done
  echo
  echo "## شمارش احکام ممیزی (پایهٔ درصد ۱۱)"
  printf 'PASS    : %s (ادعای سند ۱۱: %s)\n' "$P" "${CLAIM_PASS:-?}"
  printf 'FAIL    : %s (ادعای سند ۱۱: %s)\n' "$F" "${CLAIM_FAIL:-?}"
  printf 'UNKNOWN : %s (ادعای سند ۱۱: %s)\n' "$U" "${CLAIM_UNK:-?}"
  printf 'BLOCKED : %s\n' "$B"
  printf 'TOTAL   : %s\n' "$TOTAL"
  echo
  echo "## تطبیق ادعا با اندازه‌گیری"
  if [ -n "${CLAIM_PASS:-}" ] && [ "$CLAIM_PASS" = "$P" ] && [ "$CLAIM_FAIL" = "$F" ] && [ "${CLAIM_UNK:-}" = "$U" ]; then
    echo "MATCH: بله"
  else
    echo "MATCH: خیر — ادعای سند ۱۱ با شمارش واقعی جدول‌ها نمی‌خواند"
  fi
  echo
  echo "## تغییر کد محصول در کل ممیزی"
  echo "diff محصول f2fc472..HEAD: ${PROD_DIFF} فایل"
  git status --porcelain -- server client tests installer scripts
  echo
  echo "## ۶۲ مسیر API (سطح حمله)"
  grep -o "'/api/[a-z0-9/_-]*'" server/index.js | sort -u | tr '\n' ' '
  echo
  echo
  echo "## حکم نهایی اسکریپت"
  if [ "$RC" = "0" ] && [ "${CLAIM_PASS:-x}" = "$P" ] && [ "${CLAIM_FAIL:-x}" = "$F" ]; then
    echo "EVIDENCE-OK"
  else
    echo "EVIDENCE-FAIL"
  fi
} > "$OUT"

echo "→ $OUT (pass=$PASS fail=$FAILS measured P/F/U=$P/$F/$U)"
if [ "$RC" != "0" ]; then
  echo "EVIDENCE-FAIL: see messages above" >&2
fi
exit $RC
