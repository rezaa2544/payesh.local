#!/usr/bin/env bash
# دروازهٔ شرط‌های باز ردیف ۱۳ (CC-13-1..4) — FAIL-CLOSED
#
# اجرا: bash docs/cloud/reports/evidence/gen-cc13-evidence.sh
# خروجی موفق:  docs/cloud/reports/evidence/cc13-gate.txt  ⇒  CC13-OK
# خروجی ناموفق: همان فایل با CC13-FAIL + exit 1
#
# هر شرط فقط وقتی «بسته» اعلام می‌شود که برچسب‌های حداقلیِ آن از **خروجی واقعی آزمون**
# با علامت ✓ دیده شوند؛ Manifest برچسب‌ها: cc13-required-labels.txt
#
# قرارداد سخت‌گیرانه:
#   1) هر دو نمونهٔ ۱۸ و ۲۰‑ب باید exit=0 بدهند                                   (وگرنه FAIL)
#   2) SUMMARY هر نمونه باید «fail=0» و «pass = تعداد واقعی خطوط ✓» باشد         (شاهد ساختگی رد می‌شود)
#   3) هر برچسب manifest باید به‌صورت «✓ <label>» موجود و هیچ «✗ <label>» نباشد   (نبود = شرط باز)
#   4) sha256 فایل‌های آزمون/پیاده‌سازی در سرصفحهٔ شاهد ثبت می‌شود (شاهد متعلق به همین کد)
#
# متغیرهای اختیاری (فقط برای آزمون منفی):
#   CC13_S18_CMD / CC13_S20B_CMD   فرمان اجرای آزمون (پیش‌فرض: node prototype/slice-*/tests/run.js)
#   CC13_OUT                       مسیر فایل خروجی دروازه (پیش‌فرض: cc13-gate.txt ؛ /dev/null مجاز)
#   CC13_MANIFEST                  مسیر manifest برچسب‌ها
#   CC13_RAW_DIR                   پوشهٔ نوشتن شاهد خام
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

OUT=${CC13_OUT:-docs/cloud/reports/evidence/cc13-gate.txt}
MAN=${CC13_MANIFEST:-docs/cloud/reports/evidence/cc13-required-labels.txt}
RAWDIR=${CC13_RAW_DIR:-docs/cloud/reports/evidence}
S18=${CC13_S18_CMD:-node prototype/slice-18/tests/run.js}
S20B=${CC13_S20B_CMD:-node prototype/slice-20b/tests/run.js}
RAW18="$RAWDIR/cc13-raw-slice18.txt"
RAW20B="$RAWDIR/cc13-raw-slice20b.txt"

RC=0
CHECKS=""
fail() { RC=1; CHECKS="${CHECKS}FAIL  $1"$'\n'; echo "CC13-FAIL: $1" >&2; }
ok()   { CHECKS="${CHECKS}PASS  $1"$'\n'; }

if [ ! -f "$MAN" ]; then
  echo "CC13-FAIL: manifest not found: $MAN" >&2
  exit 3
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---------- ۱) اجرای واقعی هر دو نمونه ----------
run_suite() { # $1=id  $2=command  $3=rawfile
  local id="$1" cmd="$2" raw="$3" rc
  {
    echo "# شاهد خام نمونه — $id"
    echo "# تولید: bash docs/cloud/reports/evidence/gen-cc13-evidence.sh"
    echo "# فرمان: $cmd"
    echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# HEAD: $(git rev-parse HEAD)"
    echo "# node: $(node -v) · os: $(uname -srm)"
    echo
  } > "$raw"
  bash -c "$cmd" >"$TMP/$id.out" 2>&1
  rc=$?
  tee -a "$raw" < "$TMP/$id.out" >/dev/null
  printf 'EXIT=%s\n' "$rc" >> "$raw"
  return "$rc"
}

if run_suite s18 "$S18" "$RAW18"; then ok "slice-18 exited 0"; else fail "slice-18 exited non-zero"; fi
if run_suite s20b "$S20B" "$RAW20B"; then ok "slice-20b exited 0"; else fail "slice-20b exited non-zero"; fi

# ---------- ۲) سازگاری SUMMARY با شمارش واقعی ----------
summary_check() { # $1=id  $2=rawfile
  local id="$1" raw="$2" sum p f real
  sum=$(grep -o 'SUMMARY pass=[0-9]* fail=[0-9]*' "$raw" | tail -1)
  if [ -z "${sum:-}" ]; then fail "$id has no SUMMARY line"; return; fi
  p=$(echo "$sum" | sed -E 's/.*pass=([0-9]+).*/\1/')
  f=$(echo "$sum" | sed -E 's/.*fail=([0-9]+).*/\1/')
  real=$(grep -c '^✓' "$raw" || true)
  [ -z "${real:-}" ] && real=0
  if [ "$f" = "0" ]; then ok "$id: $sum"; else fail "$id reports fail=$f"; fi
  if [ "$p" = "$real" ]; then ok "$id: declared pass matches body ($p)"; else fail "$id: declared pass=$p ≠ body ✓=$real"; fi
  echo "$p" > "$TMP/$id.pass"
}
summary_check s18 "$RAW18"
summary_check s20b "$RAW20B"

# ---------- ۳) برچسب‌های هر شرط ----------
declare -A REQ FOUND
CONDS=$(awk -F'\t' '!/^#/ && NF>=3 {print $1}' "$MAN" | awk '!seen[$0]++')
for c in $CONDS; do REQ[$c]=0; FOUND[$c]=0; done

while IFS=$'\t' read -r cond runner label; do
  case "$cond" in \#*|"") continue;; esac
  [ -z "${label:-}" ] && continue
  raw="$RAW18"; [ "$runner" = "s20b" ] && raw="$RAW20B"
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

# ---------- ۴) شاهد تعلق: هش کد آزمون ----------
HASHES=$(sha256sum prototype/slice-18/tests/run.js prototype/slice-18/client-queue.js \
  prototype/slice-18/server-side.js prototype/slice-20b/platform.js prototype/slice-20b/tests/run.js \
  | awk '{print $2" = "$1}')

{
  echo "# دروازهٔ شرط‌های CC-13-1..4 (ردیف ۱۳ — کش امن و صف آفلاین)"
  echo "# تولید: bash docs/cloud/reports/evidence/gen-cc13-evidence.sh"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $(git rev-parse HEAD)"
  echo "# product_tree_sha256: $(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d' ' -f1)"
  echo "# شاهد خام: $RAW18 · $RAW20B"
  echo "# کد آزمون‌شده:"
  echo "$HASHES" | sed 's/^/#   /'
  echo
  printf '%s' "$CHECKS"
  echo
  for c in $CONDS; do
    echo "$c  required=${REQ[$c]:-0}  verified=${FOUND[$c]:-0}"
  done
  echo
  echo "slice-18: pass=$(cat "$TMP/s18.pass" 2>/dev/null || echo '?') fail=0"
  echo "slice-20b: pass=$(cat "$TMP/s20b.pass" 2>/dev/null || echo '?') fail=0"
  echo
  if [ "$RC" = "0" ]; then echo "CC13-OK"; else echo "CC13-FAIL"; fi
} > "$OUT"

if [ "$RC" = "0" ]; then
  echo "CC13-OK — همهٔ برچسب‌های لازم برای CC-13-1..4 با ✓ دیده شدند (slice-18=$(cat "$TMP/s18.pass") · slice-20b=$(cat "$TMP/s20b.pass"))"
  echo "→ $OUT"
  exit 0
fi
echo "CC13-FAIL — جزئیات در $OUT" >&2
exit 1
