#!/usr/bin/env bash
# آزمون منفی دروازهٔ شاهد — هر حملهٔ جعل/ناقص‌سازی باید exit≠0 بدهد
# اجرا: bash docs/cloud/reports/evidence/verify-evidence-gate-negative.sh
# خروجی: docs/cloud/reports/evidence/mission-b-evidence-gate-negative.txt
#
# پوشش: C-01 (شمارش بدنه) · C-02 (هش بدنه) · C-03 (اثر انگشت کامل) · C-04 (append-only)
# در یک clone دورریختنی اجرا شود تا شاهد سالم مخزن دست‌نخورده بماند.
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found"; exit 2; }

EVID=docs/cloud/reports/evidence
LOG="$EVID/mission-05-tests-run.log"
GATE="$EVID/gen-audit-evidence.sh"
RUN="$EVID/run-tests-evidence.sh"
OUT="$EVID/mission-b-evidence-gate-negative.txt"
cp "$LOG" /tmp/evidence-log.bak

RC=0
{
  echo "# آزمون منفی دروازهٔ شاهد (C-01..C-04)"
  echo "# تولید: bash docs/cloud/reports/evidence/verify-evidence-gate-negative.sh"
  echo "# تاریخ: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# SHA: $(git rev-parse HEAD)"
  echo "# node: $(node -v) · os: $(uname -srm)"
  echo

  run_case() {  # $1 = شناسه، $2 = توضیح
    echo "=== [$1] $2"
    out=$(bash "$GATE" 2>&1); code=$?
    echo "$out" | sed 's/^/    /'
    echo "    EXIT=$code"
    if [ "$code" -eq 0 ]; then echo "    RESULT=FAIL (دروازه جعل را پذیرفت)"; RC=1; else echo "    RESULT=OK (رد شد)"; fi
    echo
    cp /tmp/evidence-log.bak "$LOG"
  }

  # ---------- N1: بدنهٔ جعلی با SUMMARY ساختگی ----------
  python3 - <<'PY'
p='docs/cloud/reports/evidence/mission-05-tests-run.log'
s=open(p,encoding='utf-8').read()
head=s.split('# ===== RAW OUTPUT =====')[0]
open(p,'w',encoding='utf-8').write(head + "# ===== RAW OUTPUT =====\n\n  ✓ tests/fake.test.js — آزمون ساختگی\n\n# ===== FOOTER =====\nSUMMARY pass=88 fail=0\nEXIT=0\nREGISTERED=88\n")
PY
  run_case N1 "بدنهٔ ۱✓ جعلی + SUMMARY pass=88 (حملهٔ B-01)"

  # ---------- N2: بدنهٔ ناقص/خالی ----------
  python3 - <<'PY'
p='docs/cloud/reports/evidence/mission-05-tests-run.log'
s=open(p,encoding='utf-8').read()
head=s.split('# ===== RAW OUTPUT =====')[0]
open(p,'w',encoding='utf-8').write(head + "# ===== RAW OUTPUT =====\n\n# ===== FOOTER =====\nSUMMARY pass=88 fail=0\nEXIT=0\nREGISTERED=88\n")
PY
  run_case N2 "بدنهٔ خالی + SUMMARY pass=88"

  # ---------- N3: دست‌کاری بدنه (هش نمی‌خواند) ----------
  python3 - <<'PY'
p='docs/cloud/reports/evidence/mission-05-tests-run.log'
s=open(p,encoding='utf-8').read()
s=s.replace('✓','✓ ',1)   # یک فاصله در بدنه؛ تعداد ✓ هم‌چنان ۸۸
open(p,'w',encoding='utf-8').write(s)
PY
  run_case N3 "یک بایت تغییر در بدنه (raw_output_sha256 نمی‌خواند)"

  # ---------- N4: تعداد آزمون‌ها با رجیستری نمی‌خواند ----------
  python3 - <<'PY'
import re
p='docs/cloud/reports/evidence/mission-05-tests-run.log'
s=open(p,encoding='utf-8').read()
s=s.replace('# tests_registered: 88','# tests_registered: 87')
s=s.replace('SUMMARY pass=88 fail=0','SUMMARY pass=88 fail=0')
## حذف یک ✓ تا COUNT بدنه هم ۸۷ شود: هم‌زمان SUMMARY را ۸۷ می‌کنیم
lines=s.split('\n')
for i,l in enumerate(lines):
    if '✓' in l:
        lines.pop(i); break
s='\n'.join(lines)
s=re.sub(r'SUMMARY pass=\d+ fail=0','SUMMARY pass=87 fail=0',s)
open(p,'w',encoding='utf-8').write(s)
PY
  run_case N4 "SUMMARY/بدنه ۸۷ ولی رجیستری tests/run.js = ۸۸ (و tests_registered=87)"

  # ---------- N5: تغییر کد محصول نسبت به درخت آزمون ----------
  echo "// tamper" >> server/util.js
  run_case N5 "تغییر یک فایل محصول پس از اجرای آزمون (اثر انگشت C-03)"
  git checkout -- server/util.js

  # ---------- N6: اجرای ناموفق نباید شاهد سالم را بازنویسی کند ----------
  echo "=== [N6] اجرای ناموفق آزمون — شاهد سالم باید دست‌نخورده بماند (C-04)"
  BEFORE=$(sha256sum "$LOG" | cut -d' ' -f1)
  SHIM=$(mktemp -d)
  printf '#!/usr/bin/env bash\necho "  ✓ fake"\nprintf "  ✗ failing\\n"\nexit 1\n' > "$SHIM/npm"
  chmod +x "$SHIM/npm"
  out=$(PATH="$SHIM:$PATH" bash "$RUN" 2>&1); code=$?
  rm -rf "$SHIM"
  echo "$out" | sed 's/^/    /'
  echo "    EXIT=$code"
  AFTER=$(sha256sum "$LOG" | cut -d' ' -f1)
  echo "    canonical_before=$BEFORE"
  echo "    canonical_after =$AFTER"
  if [ "$code" -eq 0 ]; then echo "    RESULT=FAIL (اجرای ناموفق کد صفر داد)"; RC=1; fi
  if [ "$BEFORE" != "$AFTER" ]; then echo "    RESULT=FAIL (شاهد سالم بازنویسی شد)"; RC=1; else echo "    RESULT=OK (شاهد سالم دست‌نخورده)"; fi
  echo

  cp /tmp/evidence-log.bak "$LOG"
  rm -f "$EVID"/tests-run-FAILED-*.log
  echo "=== SUMMARY"
  if [ "$RC" -eq 0 ]; then echo "ALL NEGATIVE CASES REJECTED (N1..N6) — گیت fail-closed است"; else echo "GATE DEFECT REMAINS"; fi
} > "$OUT" 2>&1

cp /tmp/evidence-log.bak "$LOG"
cat "$OUT"
echo "NEGATIVE_EXIT=$RC"
exit "$RC"
