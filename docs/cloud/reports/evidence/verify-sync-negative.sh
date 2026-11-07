#!/usr/bin/env bash
# آزمون‌های منفیِ ردیف ۲۷ (همگام‌سازی/آفلاین) — هر حفاظ اگر برداشته شود، آزمون باید شکست بخورد.
# اجرا: bash docs/cloud/reports/evidence/verify-sync-negative.sh
# خروجی سبز: docs/cloud/reports/evidence/sync-negative.txt ⇒ SYNC-NEGATIVE-OK checks=5
set -u
export LC_ALL=C.UTF-8
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

D=docs/cloud/reports/evidence
OUT="$D/sync-negative.txt"
CHECKS=0
TMPLOG=$(mktemp)
PRIS=""
cleanup() {
  for f in $PRIS; do
    [ -f "$f.pristine" ] && mv -f "$f.pristine" "$f"
  done
  rm -f "$TMPLOG"
}
trap cleanup EXIT

mutate() { # $1=file $2=grep-pattern-that-must-appear  $3..=sed args
  local f="$1" pat="$2"; shift 2
  if [ ! -f "$f.pristine" ]; then cp "$f" "$f.pristine"; PRIS="$PRIS $f"; else cp "$f.pristine" "$f"; fi
  sed -i "$@" "$f"
  grep -q "$pat" "$f" || { echo "SYNC-NEGATIVE-FAIL: mutation did not apply: $f :: $*"; exit 1; }
}

restore_all() {
  for f in $PRIS; do cp "$f.pristine" "$f"; done
}

run_suite() {
  node --experimental-sqlite --disable-warning=ExperimentalWarning tests/run.js > "$TMPLOG" 2>&1
  echo $?
}

expect_fail() { # $1=name
  local code
  code=$(run_suite)
  restore_all
  if [ "$code" -eq 0 ]; then
    echo "SYNC-NEGATIVE-FAIL: $1 — آزمون با وجود حذف حفاظ سبز ماند"
    exit 1
  fi
  CHECKS=$((CHECKS + 1))
  echo "  ✓ $1 (exit=$code)"
}

echo "SYNC-NEGATIVE: ۵ حفاظ، هر یک باید آزمون را بشکند"

# N1 — بدون ثبت تعارض (D‑28): نسخهٔ محلی دور ریخته می‌شود
mutate server/sync.js 'const rec = { id: null };' \
  's/const rec = openConflict(store, actor, ctx, { collection, record_id: Number(id), local: incoming, server: existing, base_version: base });/const rec = { id: null };/'
expect_fail "N1 حذف ثبت تعارض (هر دو نسخه)"

# N2 — حل تعارض بدون بررسی نقش
mutate server/sync.js 'if (false) return { ok: false' \
  -e "s/if (!actor || actor.role !== 'manager') return { ok: false, error: 'forbidden' };/if (false) return { ok: false, error: 'forbidden' };/" \
  -e "s/ || !policy.canWrite(actor.role, rec.collection)//"
expect_fail "N2 حل تعارض بدون نقش مجاز"

# N3 — خاموش‌کردن ایندمپوتنسی
mutate server/sync.js 'if (false) {' \
  's/if (store.syncSeen(uid)) {/if (false) {/'
expect_fail "N3 تکرار/retry بدون ایندمپوتنسی"

# N4 — بازکردن دور زدن OCC با base=0
mutate server/sync.js 'every(k => true)' \
  's/k => k === .__password_verifier./k => true/'
expect_fail "N4 دور زدن OCC با base=0"

# N5 — نشانه‌گذاری uid در پایگاه‌داده (دوام پس از ری‌استارت)
mutate server/db.js 'syncMark(uid, userId, result) { return;' \
  's/^  syncMark(uid, userId, result) {/  syncMark(uid, userId, result) { return;/'
expect_fail "N5 دوام uid پس از ری‌استارت"

{
  echo "# آزمون‌های منفیِ ردیف ۲۷ — همگام‌سازی/آفلاین"
  echo "generated_by: docs/cloud/reports/evidence/verify-sync-negative.sh"
  echo "head: $(git rev-parse HEAD)"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "mutations: N1 conflict-record, N2 resolve-role, N3 idempotency, N4 base=0-OCC, N5 restart-durability"
  echo
  echo "SYNC-NEGATIVE-OK checks=$CHECKS"
} > "$OUT"
echo "→ $OUT"
echo "SYNC-NEGATIVE-OK checks=$CHECKS"
