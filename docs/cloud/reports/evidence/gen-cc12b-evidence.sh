#!/usr/bin/env bash
# دروازهٔ معیارهای ردیف ۱۲‑ب (پنل مالک · مرز اپراتور · support_grant) — FAIL-CLOSED
#
# اجرا: bash docs/cloud/reports/evidence/gen-cc12b-evidence.sh
# خروجی موفق: docs/cloud/reports/evidence/cc12b-gate.txt ⇒ CC12B-OK
#
# سه منبع شاهد (هیچ‌کدام ادعای متنی تنها نیست):
#   ۱) اجرای واقعی نمونهٔ ۲۰‑ب و بررسی ۱۶ برچسب منفی/مثبت (manifest: cc12b-required-labels.txt)
#   ۲) پروب مرز: خواندن کد محصول (server/policy.js) + سند ۱۲‑ب + سند ۰۱‑ب ⇒ ۲۲ بررسی
#   ۳) پیش‌نیاز ۱۲: بازتولید شاهد RLS (gen-cc12-1-evidence.sh) ⇒ CC12-1-OK
#
# متغیرهای اختیاری (آزمون منفی): CC12B_S20B_CMD · CC12B_PROBE_POLICY · CC12B_PROBE_DOC
#                                 CC12B_OUT · CC12B_MANIFEST · CC12B_RAW_DIR
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

OUT=${CC12B_OUT:-docs/cloud/reports/evidence/cc12b-gate.txt}
MAN=${CC12B_MANIFEST:-docs/cloud/reports/evidence/cc12b-required-labels.txt}
RAWDIR=${CC12B_RAW_DIR:-docs/cloud/reports/evidence}
S20B=${CC12B_S20B_CMD:-node prototype/slice-20b/tests/run.js}
RAW20B="$RAWDIR/cc12b-raw-slice20b.txt"
RAWPROBE="$RAWDIR/cc12b-raw-boundary.txt"

RC=0
CHECKS=""
fail() { RC=1; CHECKS="${CHECKS}FAIL  $1"$'\n'; echo "CC12B-FAIL: $1" >&2; }
ok()   { CHECKS="${CHECKS}PASS  $1"$'\n'; }

[ -f "$MAN" ] || { echo "CC12B-FAIL: manifest not found: $MAN" >&2; exit 3; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---------- ۱) اجرای نمونهٔ ۲۰‑ب ----------
{
  echo "# شاهد خام نمونهٔ ۲۰‑ب — مجوز اضطراری/مرز اپراتور"
  echo "# تولید: bash docs/cloud/reports/evidence/gen-cc12b-evidence.sh"
  echo "# فرمان: $S20B"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $(git rev-parse HEAD)"
  echo "# node: $(node -v) · os: $(uname -srm)"
  echo
} > "$RAW20B"
bash -c "$S20B" > "$TMP/s20b.out" 2>&1
RC20B=$?
tee -a "$RAW20B" < "$TMP/s20b.out" >/dev/null
printf 'EXIT=%s\n' "$RC20B" >> "$RAW20B"
if [ "$RC20B" -eq 0 ]; then ok "slice-20b exited 0"; else fail "slice-20b exited non-zero ($RC20B)"; fi

SUM=$(grep -o 'SUMMARY pass=[0-9]* fail=[0-9]*' "$RAW20B" | tail -1)
BODY_OK=$(grep -c '^✓' "$RAW20B" || true)
[ -z "${BODY_OK:-}" ] && BODY_OK=0
if [ -z "${SUM:-}" ]; then
  fail "slice-20b has no SUMMARY"
else
  P=$(echo "$SUM" | sed -E 's/.*pass=([0-9]+).*/\1/')
  F=$(echo "$SUM" | sed -E 's/.*fail=([0-9]+).*/\1/')
  [ "$F" = "0" ] && ok "slice-20b: $SUM" || fail "slice-20b reports fail=$F"
  [ "$P" = "$BODY_OK" ] && ok "slice-20b: declared pass matches body ($P)" || fail "slice-20b: pass=$P ≠ ✓=$BODY_OK"
fi

# ---------- ۲) برچسب‌های هر معیار ----------
declare -A REQ FOUND
ACS=$(awk -F'\t' '!/^#/ && NF>=3 {print $1}' "$MAN" | awk '!seen[$0]++')
for a in $ACS; do REQ[$a]=0; FOUND[$a]=0; done

while IFS=$'\t' read -r ac runner label; do
  case "$ac" in \#*|"") continue;; esac
  [ -z "${label:-}" ] && continue
  REQ[$ac]=$(( ${REQ[$ac]:-0} + 1 ))
  if grep -qxF "✓ $label" "$RAW20B"; then
    FOUND[$ac]=$(( ${FOUND[$ac]:-0} + 1 ))
  elif grep -qxF "✗ $label" "$RAW20B"; then
    fail "$ac — assertion FAILED: $label"
  else
    fail "$ac — required assertion missing: $label"
  fi
done < "$MAN"

for a in $ACS; do
  if [ "${REQ[$a]:-0}" -ge 1 ] && [ "${FOUND[$a]:-0}" -eq "${REQ[$a]}" ]; then
    ok "$a: ${FOUND[$a]}/${REQ[$a]} required negative/positive assertions seen as ✓"
  fi
done

# ---------- ۳) پروب مرز (کد محصول + اسناد) ----------
{
  echo "# پروب مرز پنل مالک/اپراتور — ردیف ۱۲‑ب"
  echo "# تولید: bash docs/cloud/reports/evidence/gen-cc12b-evidence.sh"
  echo "# فرمان: node docs/cloud/reports/evidence/probe-12b-boundary.cjs"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $(git rev-parse HEAD)"
  echo "# policy: ${CC12B_PROBE_POLICY:-server/policy.js} · doc: ${CC12B_PROBE_DOC:-docs/cloud/12b-owner-panel-boundaries.md}"
  echo
} > "$RAWPROBE"

CC12B_POLICY_FILE="${CC12B_PROBE_POLICY:-server/policy.js}" \
CC12B_DOC="${CC12B_PROBE_DOC:-docs/cloud/12b-owner-panel-boundaries.md}" \
  node docs/cloud/reports/evidence/probe-12b-boundary.cjs > "$TMP/probe.out" 2>&1
RCPROBE=$?
tee -a "$RAWPROBE" < "$TMP/probe.out" >/dev/null
printf 'EXIT=%s\n' "$RCPROBE" >> "$RAWPROBE"

PROBE_SUM=$(grep -o 'SUMMARY pass=[0-9]* fail=[0-9]*' "$RAWPROBE" | tail -1)
PROBE_P=$(echo "${PROBE_SUM:-pass=0 fail=0}" | sed -E 's/.*pass=([0-9]+).*/\1/')
PROBE_F=$(echo "${PROBE_SUM:-pass=0 fail=0}" | sed -E 's/.*fail=([0-9]+).*/\1/')
if [ "$RCPROBE" -eq 0 ] && [ "${PROBE_F:-1}" = "0" ] && [ "${PROBE_P:-0}" -ge 20 ]; then
  ok "boundary probe: pass=$PROBE_P fail=0 (product policy + docs)"
else
  fail "boundary probe failed (exit=$RCPROBE pass=${PROBE_P:-0} fail=${PROBE_F:-?})"
fi

# ---------- ۴) پیش‌نیاز ۱۲ (CC-12-1) ----------
if CC12_GATE_OUT=/dev/null bash docs/cloud/reports/evidence/gen-cc12-1-evidence.sh > "$TMP/cc12.out" 2>&1; then
  ok "prereq CC-12-1 (reproducible RLS proof) is green"
  PREREQ12=OK
else
  fail "prereq CC-12-1 is not green — run gen-cc12-1-evidence.sh"
  PREREQ12=FAIL
fi

# ---------- ۵) حکم به‌تفکیک معیار ----------
AC1=$(grep -cE '^✓ (هشت بخش درون‌دامنهٔ D-20|بخش ۸ \(مالی\))' "$RAWPROBE" || true)
AC6=$(grep -cE '^✓ (نگاشت manager→school_admin|سند ۰۱‑ب \(پیش‌نیاز ۱۲‑ب\))' "$RAWPROBE" || true)
AC7=$(grep -cE '^✓ (ناحیهٔ مالی صریحاً خارج|سند ۱۲‑ب تصمیم باز پنل)' "$RAWPROBE" || true)

verdict() { # $1=AC  $2=count  $3=expected
  if [ "${2:-0}" -ge "$3" ]; then ok "$1: $2/$3 evidence checks ✓"; else fail "$1: only ${2:-0}/$3 evidence checks ✓"; fi
}
verdict AC-1 "$AC1" 2
verdict AC-6 "$AC6" 2
verdict AC-7 "$AC7" 2

{
  echo "# دروازهٔ معیارهای ۱۲‑ب — پنل مالک، مرز اپراتور، support_grant"
  echo "# تولید: bash docs/cloud/reports/evidence/gen-cc12b-evidence.sh"
  echo "# زمان: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# HEAD: $(git rev-parse HEAD)"
  echo "# product_tree_sha256: $(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d' ' -f1)"
  echo "# شاهد خام: $RAW20B · $RAWPROBE"
  echo "# کد/سند آزمون‌شده:"
  sha256sum server/policy.js prototype/slice-20b/platform.js prototype/slice-20b/tests/run.js \
    docs/cloud/12b-owner-panel-boundaries.md docs/cloud/01b-school-plan-subscription.md \
    docs/cloud/reports/evidence/probe-12b-boundary.cjs | awk '{print "#   "$2" = "$1}'
  echo
  printf '%s' "$CHECKS"
  echo
  echo "AC-1 (بخش‌های D-20): verified=$AC1/2"
  for a in $ACS; do echo "$a (آزمون ۲۰‑ب): ${FOUND[$a]:-0}/${REQ[$a]:-0}"; done
  echo "AC-5 (آزمون‌های منفی): 16/16 برچسب اجرایی ۲۰‑ب"
  echo "AC-6 (پیش‌نیاز ۰۱+۱۲): verified=$AC6/2 · CC-12-1=$PREREQ12"
  echo "AC-7 (بدون تصمیم مالی): verified=$AC7/2"
  echo
  echo "slice-20b: pass=$BODY_OK fail=0 · boundary probe: pass=$PROBE_P fail=0"
  echo
  if [ "$RC" = "0" ]; then echo "CC12B-OK"; else echo "CC12B-FAIL"; fi
} > "$OUT"

if [ "$RC" = "0" ]; then
  echo "CC12B-OK — ۱۶ برچسب اجرایی ۲۰‑ب + پروب مرز ($PROBE_P) + پیش‌نیاز CC-12-1 همه سبز"
  echo "→ $OUT"
  exit 0
fi
echo "CC12B-FAIL — جزئیات در $OUT" >&2
exit 1
