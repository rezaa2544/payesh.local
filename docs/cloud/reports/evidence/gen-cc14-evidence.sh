#!/usr/bin/env bash
# دروازهٔ شرط‌های باز ردیف ۱۴ (CC-14-1..5 — تعارض و هم‌گرایی) — FAIL-CLOSED
#
# اجرا: bash docs/cloud/reports/evidence/gen-cc14-evidence.sh
# خروجی موفق:  docs/cloud/reports/evidence/cc14-gate.txt  ⇒  CC14-OK
# خروجی ناموفق: همان فایل با CC14-FAIL + exit 1
#
# منطق: هر شرط فقط وقتی «بسته» است که برچسب‌های حداقلیِ آن از **خروجی واقعی آزمون**
# با علامت ✓ دیده شوند؛ Manifest: cc14-required-labels.txt
#
# قرارداد سخت‌گیرانه:
#   1) نمونهٔ ۱۹ باید exit=0 بدهد                                                   (وگرنه FAIL)
#   2) SUMMARY باید «fail=0» و «pass = تعداد واقعی خطوط ✓» باشد                    (شاهد ساختگی رد می‌شود)
#   3) هر برچسب manifest باید «✓ <label>» باشد و هیچ «✗ <label>» نباشد             (نبود = شرط باز)
#   4) sha256 کد آزمون و اثر انگشت درخت محصول در سرصفحه ثبت می‌شود
#
# متغیرهای اختیاری (فقط آزمون منفی): CC14_S19_CMD · CC14_OUT · CC14_MANIFEST · CC14_RAW_DIR
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

OUT=${CC14_OUT:-docs/cloud/reports/evidence/cc14-gate.txt}
MAN=${CC14_MANIFEST:-docs/cloud/reports/evidence/cc14-required-labels.txt}
RAWDIR=${CC14_RAW_DIR:-docs/cloud/reports/evidence}
S19=${CC14_S19_CMD:-node prototype/slice-19/tests/run.js}
RAW19="$RAWDIR/cc14-raw-slice19.txt"

RC=0
CHECKS=""
fail() { RC=1; CHECKS="${CHECKS}FAIL  $1"$'\n'; echo "CC14-FAIL: $1" >&2; }
ok()   { CHECKS="${CHECKS}PASS  $1"$'\n'; }

[ -f "$MAN" ] || { echo "CC14-FAIL: manifest not found: $MAN" >&2; exit 3; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---------- ۱) اجرای واقعی نمونهٔ ۱۹ ----------
{
  echo "# شاهد خام نمونهٔ ۱۹ — تعارض و هم‌گرایی"
  echo "# تولید: bash docs/cloud/reports/evidence/gen-cc14-evidence.sh"
  echo "# فرمان: $S19"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $(git rev-parse HEAD)"
  echo "# node: $(node -v) · os: $(uname -srm)"
  echo
} > "$RAW19"

bash -c "$S19" > "$TMP/s19.out" 2>&1
RC19=$?
tee -a "$RAW19" < "$TMP/s19.out" >/dev/null
printf 'EXIT=%s\n' "$RC19" >> "$RAW19"
if [ "$RC19" -eq 0 ]; then ok "slice-19 exited 0"; else fail "slice-19 exited non-zero ($RC19)"; fi

# ---------- ۲) SUMMARY در برابر شمارش واقعی ----------
SUM=$(grep -o 'SUMMARY pass=[0-9]* fail=[0-9]*' "$RAW19" | tail -1)
PASS19=$(grep -c '^✓' "$RAW19" || true)
[ -z "${PASS19:-}" ] && PASS19=0
if [ -z "${SUM:-}" ]; then
  fail "slice-19 has no SUMMARY line"
else
  P=$(echo "$SUM" | sed -E 's/.*pass=([0-9]+).*/\1/')
  F=$(echo "$SUM" | sed -E 's/.*fail=([0-9]+).*/\1/')
  [ "$F" = "0" ] && ok "slice-19: $SUM" || fail "slice-19 reports fail=$F"
  [ "$P" = "$PASS19" ] && ok "slice-19: declared pass matches body ($P)" || fail "slice-19: declared pass=$P ≠ body ✓=$PASS19"
fi

# ---------- ۳) برچسب‌های هر شرط ----------
declare -A REQ FOUND
CONDS=$(awk -F'\t' '!/^#/ && NF>=3 {print $1}' "$MAN" | awk '!seen[$0]++')
for c in $CONDS; do REQ[$c]=0; FOUND[$c]=0; done

while IFS=$'\t' read -r cond runner label; do
  case "$cond" in \#*|"") continue;; esac
  [ -z "${label:-}" ] && continue
  raw="$RAW19"
  REQ[$cond]=$(( ${REQ[$cond]:-0} + 1 ))
  if grep -qxF "✓ $label" "$raw"; then
    FOUND[$cond]=$(( ${FOUND[$cond]:-0} + 1 ))
  elif grep -qxF "✗ $label" "$raw"; then
    fail "$cond — assertion FAILED: $label"
  else
    fail "$cond — required assertion missing: $label"
  fi
done < "$MAN"

for c in $CONDS; do
  if [ "${REQ[$c]:-0}" -ge 1 ] && [ "${FOUND[$c]:-0}" -eq "${REQ[$c]}" ]; then
    ok "$c: ${FOUND[$c]}/${REQ[$c]} required assertions seen as ✓"
  fi
done

# ---------- ۴) شاهد تعلق ----------
HASHES=$(sha256sum prototype/slice-19/tests/run.js prototype/slice-19/conflict-server.js \
  | awk '{print $2" = "$1}')

{
  echo "# دروازهٔ شرط‌های CC-14-1..5 (ردیف ۱۴ — تعارض و هم‌گرایی چنددستگاهی)"
  echo "# تولید: bash docs/cloud/reports/evidence/gen-cc14-evidence.sh"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $(git rev-parse HEAD)"
  echo "# product_tree_sha256: $(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d' ' -f1)"
  echo "# شاهد خام: $RAW19"
  echo "# کد آزمون‌شده:"
  echo "$HASHES" | sed 's/^/#   /'
  echo
  printf '%s' "$CHECKS"
  echo
  for c in $CONDS; do
    echo "$c  required=${REQ[$c]:-0}  verified=${FOUND[$c]:-0}"
  done
  echo
  echo "slice-19: pass=$PASS19 fail=0"
  echo
  if [ "$RC" = "0" ]; then echo "CC14-OK"; else echo "CC14-FAIL"; fi
} > "$OUT"

if [ "$RC" = "0" ]; then
  echo "CC14-OK — همهٔ برچسب‌های لازم برای CC-14-1..5 با ✓ دیده شدند (slice-19=$PASS19)"
  echo "→ $OUT"
  exit 0
fi
echo "CC14-FAIL — جزئیات در $OUT" >&2
exit 1
