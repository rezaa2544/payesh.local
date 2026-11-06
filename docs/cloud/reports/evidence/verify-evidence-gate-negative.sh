#!/usr/bin/env bash
# آزمون منفی دروازهٔ شواهد (A-01): اثبات اینکه اسکریپت در نبود/خرابی شاهد FAIL می‌شود
# اجرا: bash docs/cloud/reports/evidence/verify-evidence-gate-negative.sh
# خروجی: docs/cloud/reports/evidence/mission-a-evidence-gate-behaviour.txt
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

LOG=docs/cloud/reports/evidence/mission-05-tests-run.log
GEN=docs/cloud/reports/evidence/gen-audit-evidence.sh
OUT=docs/cloud/reports/evidence/mission-a-evidence-gate-behaviour.txt
BAK=$(mktemp)
cp "$LOG" "$BAK"
restore() { cp "$BAK" "$LOG"; rm -f "$BAK"; }
trap restore EXIT

RC=0
{
  echo "# آزمون منفی دروازهٔ شواهد — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $(git rev-parse HEAD)"
  echo "# اصل: اجرای ${GEN} باید در نبود شاهد یا شاهد خراب، غیرصفر برگردد"
  echo

  echo "## حالت ۱ — لاگ خام وجود ندارد (انتظار: exit=3)"
  rm -f "$LOG"
  bash "$GEN" >/dev/null 2>&1; c1=$?
  echo "exit=$c1"
  [ "$c1" = "3" ] && echo "RESULT: PASS" || { echo "RESULT: FAIL (expected 3)"; RC=1; }
  echo

  echo "## حالت ۲ — لاگ خراب با ۲ آزمون ناموفق (انتظار: exit غیرصفر)"
  printf 'SUMMARY pass=5 fail=2\nEXIT=1\n' > "$LOG"
  bash "$GEN" >/dev/null 2>&1; c2=$?
  echo "exit=$c2"
  [ "$c2" != "0" ] && echo "RESULT: PASS" || { echo "RESULT: FAIL (expected non-zero)"; RC=1; }
  echo

  echo "## حالت ۳ — لاگ واقعی بازگردانده شد (انتظار: exit=0)"
  restore; trap - EXIT
  bash "$GEN" >/dev/null 2>&1; c3=$?
  echo "exit=$c3"
  [ "$c3" = "0" ] && echo "RESULT: PASS" || { echo "RESULT: FAIL (expected 0)"; RC=1; }
  echo
  echo "## حکم"
  [ "$RC" = "0" ] && echo "NEGATIVE-TESTS-OK — دروازه در نبود/خرابی شاهد باز نمی‌شود" \
                  || echo "NEGATIVE-TESTS-FAIL"
} > "$OUT"

cat "$OUT" | tail -12
echo "→ $OUT"
exit $RC
