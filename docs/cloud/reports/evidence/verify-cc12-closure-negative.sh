#!/usr/bin/env bash
# آزمون منفی دروازهٔ CC‑12 ‑CLOSURE — «سند ناسازگار، عدد دست‌کاری‌شده یا تصمیم ثبت‌نشده نباید PASS بگیرد»
# اجرا: bash docs/cloud/reports/evidence/verify-cc12-closure-negative.sh
# خروجی: docs/cloud/reports/evidence/cc12-closure-negative.txt ⇒ NEGATIVE-OK (pass=N fail=0)
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
GATE=$D/gen-cc12-closure.sh
OUT=$D/cc12-closure-negative.txt
CONST=docs/00-PAYESH-CLOUD-CONSTITUTION.md
DOC4=docs/cloud/04-capacity-and-availability.md
DOC4B=docs/cloud/04b-plan-caps-usage-model.md
DOC12=docs/cloud/12-multitenant-architecture.md
DOC16B=docs/cloud/16b-tenant-provisioning-migration.md
BENCH=$D/mission-12-cc3-load-baseline.txt
TESTS=$D/mission-05-tests-run.log

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
LOG=$TMP/result.txt; : > "$LOG"
PASS=0; FAIL=0

pass_case() { PASS=$((PASS+1)); echo "PASS  $1  $2" | tee -a "$LOG"; }
fail_case() { FAIL=$((FAIL+1)); echo "FAIL  $1  $2" | tee -a "$LOG"; }

reject() { # id, desc, expected-reason, env pairs...
  local id="$1" desc="$2" want="$3"; shift 3
  local err rc
  err=$(env "$@" CC12_OUT=/dev/null CC12_FAILDIR="$TMP" bash "$GATE" 2>&1 >/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$err" | grep -q 'CC12-CLOSURE-FAIL' && printf '%s' "$err" | grep -q "$want"; then
    pass_case "$id" "رد شد: $desc → $(printf '%s' "$err" | head -1 | cut -c1-84)"
  else
    fail_case "$id" "پذیرفته شد/دلیل اشتباه: $desc → exit=$rc want=$want got=$(printf '%s' "$err" | head -1)"
  fi
}

# ── کنترل مثبت ─────────────────────────────────────────────────────────────
if CC12_OUT="$TMP/pos.txt" CC12_FAILDIR="$TMP" bash "$GATE" >/dev/null 2>&1 && grep -qF 'CC12-CLOSURE-OK' "$TMP/pos.txt"; then
  pass_case P0 "شاهد سالم پذیرفته شد (کنترل مثبت)"
else
  fail_case P0 "شاهد سالم رد شد — دروازه معیوب است"
fi

# ── N1: تصمیم D‑31 از Decision Log حذف شود ─────────────────────────────────
grep -v '^| \*\*D‑31\*\*' "$CONST" > "$TMP/const.n31.md"
reject N1 "تصمیم D‑31 (O‑07) از Decision Log حذف شد" "CONST-DECISION" CC12_CONST="$TMP/const.n31.md"

# ── N2: پرسش O‑14 بی‌پاسخ شود ──────────────────────────────────────────────
sed 's/^| O‑14 |.*$/| O‑14 | سقف‌های پلن | خیر | ۰۱، ۰۴ |/' "$CONST" > "$TMP/const.o14.md"
reject N2 "پاسخ O‑14 به «خیر» برگشت (تصمیم مالک نادیده)" "CONST-O14" CC12_CONST="$TMP/const.o14.md"

# ── N3: بخش §۲.۱ سند ۰۴ حذف شود ────────────────────────────────────────────
python3 - "$DOC4" "$TMP/doc4.nosec.md" <<'PY'
import sys
s=open(sys.argv[1],encoding='utf-8').read()
i=s.index('## ۲.۱'); j=s.index('## ۳. اهداف کمی')
open(sys.argv[2],'w',encoding='utf-8').write(s[:i]+s[j:])
PY
reject N3 "بخش «خط پایهٔ اندازه‌گیری‌شده» از سند ۰۴ حذف شد" "DOC04-SECTION" CC12_DOC4="$TMP/doc4.nosec.md"

# ── N4: عدد p95 در سند دست‌کاری شود ────────────────────────────────────────
sed 's/۴۸۶ms/۵۸۶ms/' "$DOC4" > "$TMP/doc4.p95.md"
reject N4 "p95 سطح ۳۸۴ در سند جابه‌جا شد (۴۸۶→۵۸۶)" "DOC04-P95" CC12_DOC4="$TMP/doc4.p95.md"

# ── N5: خط CAP در شاهد بار دست‌کاری شود ───────────────────────────────────
sed 's/^BENCH-CAP max_ok_devices=768 /BENCH-CAP max_ok_devices=384 /' "$BENCH" > "$TMP/bench.cap.txt"
reject N5 "خط CAP با بازمحاسبهٔ ردیف‌ها نمی‌خواند (۷۶۸→۳۸۴)" "BENCH-CAP-MISMATCH" CC12_BENCH="$TMP/bench.cap.txt"

# ── N6: یک تکرار زانو زیر آستانه شود ──────────────────────────────────────
sed 's/p95_ms=1628 /p95_ms=900 /' "$BENCH" > "$TMP/bench.knee.txt"
reject N6 "یک نمونهٔ زانو زیر آستانه جا‌زده شد (ادعای زانو بی‌شاهد)" "BENCH-KNEE" CC12_BENCH="$TMP/bench.knee.txt"

# ── N7: بسته‌شدن CC‑12‑4 از سند ۱۲ حذف شود ────────────────────────────────
sed 's/| \*\*CC‑12‑4\*\*.*$/| CC‑12‑4 | نام پوشه‌ها | باز | — |/' "$DOC12" > "$TMP/doc12.cc4.md"
reject N7 "شرط CC‑12‑4 از حالت CLOSED خارج شد" "DOC12-CC4" CC12_DOC12="$TMP/doc12.cc4.md"

# ── N8: نقشهٔ نهایی مسیرها از ۱۶‑ب حذف شود ─────────────────────────────────
grep -v 't/<tenant>/exports/' "$DOC16B" > "$TMP/doc16b.map.md"
reject N8 "مسیر exports از نقشهٔ ۱۶‑ب حذف شد" "DOC16B-MAP" CC12_DOC16B="$TMP/doc16b.map.md"

# ── N9: یک ردیف AC از سند ۰۴ حذف شود ──────────────────────────────────────
grep -v '^| AC‑14 |' "$DOC4" > "$TMP/doc4.ac13.md"
reject N9 "یک ردیف AC از سند ۰۴ حذف شد (۱۴→۱۳)" "DOC04-AC" CC12_DOC4="$TMP/doc4.ac13.md"

# ── N10: سند ۱۲ (پس از D‑35) دوباره CC‑12‑2 را باز اعلام کند ───────────────
# دیگر ادعای «به‌دروغ CLOSED» معنا ندارد؛ خطر واقعی، عقب ماندن سند از واقعیت است.
sed 's/CLOSED (۲۰\/۲۰)/PARTIAL/' "$DOC12" > "$TMP/doc12.cc2.md"
reject N10 "سند ۱۲ دوباره CC‑12‑2 را PARTIAL می‌داند" "DOC12-CC2" CC12_DOC12="$TMP/doc12.cc2.md"

# ── N11: ابزار سنجش معیوب ─────────────────────────────────────────────────
printf '#!/usr/bin/env node\nconsole.error("BENCH-ERROR simulated");process.exit(1);\n' > "$TMP/broken.cjs"
reject N11 "ابزار سنجش خراب است (smoke شکست)" "BENCH-SMOKE" CC12_BENCH_SCRIPT="$TMP/broken.cjs"

# ── N12: پایهٔ ممیزی ناموجود ──────────────────────────────────────────────
reject N12 "پایهٔ ممیزی ناموجود ⇒ تعمیم بی‌اعتبار" "BASE-MISSING" CC12_BASE=0000000

# ── N13: لاگ آزمون ناموفق ────────────────────────────────────────────────
sed -E 's/^SUMMARY pass=([0-9]+) fail=0$/SUMMARY pass=\1 fail=3/' "$TESTS" > "$TMP/tests.fail.log"
reject N13 "لاگ آزمون محصول ناموفق است (۸۵/۳)" "TESTS" CC12_TESTS="$TMP/tests.fail.log"

{
  echo "# آزمون منفی دروازهٔ CC‑12‑CLOSURE"
  echo "generated_by: docs/cloud/reports/evidence/verify-cc12-closure-negative.sh"
  echo "head: $(git rev-parse HEAD)"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  cat "$LOG"
  echo
  echo "SUMMARY pass=$PASS fail=$FAIL"
  if [ "$FAIL" -eq 0 ] && [ "$PASS" -ge 14 ]; then echo "NEGATIVE-OK"; else echo "NEGATIVE-FAIL"; fi
} > "$OUT"
tail -3 "$OUT"
[ "$FAIL" -eq 0 ] || exit 1
