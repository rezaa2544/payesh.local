#!/usr/bin/env bash
# آزمون منفی دروازهٔ CC‑16 — «شاهد ناقص/جعلی/کهنه نباید PASS بگیرد»
#
# اجرا: bash docs/cloud/reports/evidence/verify-cc16-negative.sh
# خروجی: docs/cloud/reports/evidence/cc16-negative.txt ⇒ NEGATIVE-OK (pass=N fail=0)
#
# هر سناریو یا باید با CC16-FAIL رد شود (کنترل منفی) یا نسخهٔ سالم باید قبول شود (کنترل مثبت).
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
GATE=$D/gen-cc16-evidence.sh
MAN=$D/cc16-required-labels.txt
DOC=docs/cloud/16-ha-observability-cost.md
EV=$D/mission-16-observability-probe.txt
OUT=$D/cc16-negative.txt

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LOG=$TMP/result.txt
: > "$LOG"
PASS=0
FAIL=0

# خروجی واقعی پروب یک بار گرفته می‌شود تا از آن نسخه‌های دستکار‌شده ساخته شود
node --experimental-sqlite --disable-warning=ExperimentalWarning "$D/probe-16-model.cjs" > "$TMP/model.real" 2>&1 || true
cp "$DOC" "$TMP/doc.bak"
cp "$EV" "$TMP/ev.bak"

reject_ok() { # $1=id  $2=desc  $3..=env assignments (KEY=VAL)
  local id="$1" desc="$2"; shift 2
  local err rc
  err=$(env "$@" CC16_OUT=/dev/null CC16_RAW_DIR="$TMP" CC16_MANIFEST="$MAN" \
        CC16_FAILDIR="$TMP" bash "$GATE" 2>&1 >/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$err" | grep -q 'CC16-FAIL'; then
    PASS=$((PASS+1)); echo "PASS  $id  gate rejected: $desc  → exit=$rc  $(printf '%s' "$err" | head -1 | cut -c1-90)" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $id  gate ACCEPTED invalid evidence: $desc  → exit=$rc" | tee -a "$LOG"
  fi
  cp "$TMP/doc.bak" "$DOC"; cp "$TMP/ev.bak" "$EV"
}

expect_ok() { # $1=id  $2=desc
  local id="$1" desc="$2" rc
  CC16_OUT="$TMP/pos-gate.txt" CC16_RAW_DIR="$TMP" CC16_MANIFEST="$MAN" CC16_FAILDIR="$TMP" \
    bash "$GATE" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ] && grep -qF 'CC16-OK' "$TMP/pos-gate.txt"; then
    PASS=$((PASS+1)); echo "PASS  $id  gate accepted clean evidence (control positive): $desc" | tee -a "$LOG"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $id  gate rejected CLEAN evidence — gate is broken: $desc  → exit=$rc" | tee -a "$LOG"
  fi
}

# ---------- کنترل مثبت ----------
expect_ok P0 "اجرای سالم: پروب ۴۰/۴۰ + شاهد رفتار امروز تازه + Manifest کامل"

# ---------- N1: حذف یک برچسب لازم از خروجی پروب ----------
LABEL=$(head -1 "$MAN")
python3 - "$TMP/model.real" "$TMP/n1.model" "$LABEL" <<'PYEOF'
import sys
src, dst, label = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(src, encoding='utf-8').read().splitlines()
kept = [l for l in lines if not l.startswith('✓ ' + label)]
assert len(kept) < len(lines), 'label not found in probe output'
open(dst, 'w', encoding='utf-8').write('\n'.join(kept) + '\n')
PYEOF
reject_ok N1 "یک برچسب لازم از بدنهٔ پروب حذف شد" CC16_PROBE_CMD="cat $TMP/n1.model"

# ---------- N2: همان برچسب با ✗ ----------
sed "s/^✓ $LABEL /✗ $LABEL /" "$TMP/model.real" > "$TMP/n2.model"
reject_ok N2 "برچسب لازم با علامت شکست (✗)" CC16_PROBE_CMD="cat $TMP/n2.model"

# ---------- N3: SUMMARY دست‌کاری‌شده (گذر اعلامی ≠ بدنه) ----------
sed 's/^SUMMARY pass=40 fail=0 total=40$/SUMMARY pass=39 fail=0 total=40/' "$TMP/model.real" > "$TMP/n3.model"
reject_ok N3 "SUMMARY ادعایی با شمارش بدنه نمی‌خواند" CC16_PROBE_CMD="cat $TMP/n3.model"

# ---------- N4: عدد سند دست‌کاری‌شده (پهنای باند میانه) ----------
python3 - "$DOC" <<'PY'
import sys
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
s = s.replace('| **۶٫۲۹ TB** |', '| **۴٫۰۰ TB** |', 1)
open(p, 'w', encoding='utf-8').write(s)
PY
reject_ok N4 "عدد پهنای باند سند با بازمحاسبهٔ مدل نمی‌خواند (۶٫۲۹→۴٫۰۰)"

# ---------- N5: حذف یک ردیف AC از سند ----------
python3 - "$DOC" <<'PY'
import sys, re
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
s2 = re.sub(r'^\| \*\*AC\u201114\*\* .*\n', '', s, flags=re.M)
assert s2 != s, 'AC-14 row not found'
open(p, 'w', encoding='utf-8').write(s2)
PY
reject_ok N5 "یک ردیف معیار از ماتریس سند حذف شد (۱۴ ← ۱۳)"

# ---------- N6: برگشت «جمع خودساختهٔ €۷۴» ----------
python3 - "$DOC" <<'PY'
import sys
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
anchor = '| **جمع شناخته‌شده**'
i = s.index(anchor)
s = s[:i] + '| **جمع (خودساخته)** | **€۷۴** | **€۷۴** | **€۷۴** | بدون منبع |\n' + s[i:]
open(p, 'w', encoding='utf-8').write(s)
PY
reject_ok N6 "جمع هزینهٔ خودساخته (€۷۴) به جدول برگشت"

# ---------- N7: پایهٔ ممیزی ناموجود (شبیه clone کم‌عمق) ----------
reject_ok N7 "پایهٔ ممیزی ناموجود ⇒ «۰ فایل تغییر» جعلی نباید PASS بگیرد" CC16_BASE=0000000

# ---------- N8: شاهد رفتار امروز کهنه (head ≠ HEAD) ----------
mkdir -p "$TMP/rt"
REPO=$(pwd)
{
  echo '#!/usr/bin/env bash'
  echo "cat > \"$REPO/$EV\" <<'EOF'"
  echo "head: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  echo "EXPECTATIONS=ALL-MET"
  echo "exit=0"
  echo "EOF"
} > "$TMP/rt/gen-stale.sh"
reject_ok N8 "شاهد رفتار امروز کهنه (head=deadbeef) نباید PASS بگیرد" CC16_RUNTIME_CMD="bash $TMP/rt/gen-stale.sh"

# ---------- حکم ----------
{
  echo "# آزمون منفی دروازهٔ CC‑16 — شاهد ناقص/جعلی/کهنه"
  echo "generated_by: docs/cloud/reports/evidence/verify-cc16-negative.sh"
  echo "head: $(git rev-parse HEAD)"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  cat "$LOG"
  echo
  if [ "$FAIL" -eq 0 ]; then
    echo "SUMMARY pass=$PASS fail=$FAIL"
    echo "NEGATIVE-OK"
  else
    echo "SUMMARY pass=$PASS fail=$FAIL"
    echo "NEGATIVE-FAILED"
  fi
} > "$OUT"
echo "→ $OUT"
tail -3 "$OUT"
[ "$FAIL" -eq 0 ] || exit 1
