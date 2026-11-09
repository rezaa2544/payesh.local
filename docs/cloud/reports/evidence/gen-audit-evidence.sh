#!/usr/bin/env bash
# دروازهٔ شاهد ممیزی‌های ۰۵ تا ۱۱ — FAIL-CLOSED، مقاوم در برابر لاگ ساختگی
# اجرا: bash docs/cloud/reports/evidence/gen-audit-evidence.sh
# خروجی موفق: docs/cloud/reports/evidence/mission-05-11-structure.txt
# خروجی ناموفق: docs/cloud/reports/evidence/mission-05-11-structure.FAILED-<ts>.txt
#               (شاهد سالم قبلی بازنویسی نمی‌شود — C-04)
#
# قرارداد (سخت‌شده پس از پیدا شدن B-01):
#   1) لاگ خام باید وجود داشته باشد                                     (exit 3)
#   2) SUMMARY / EXIT باید موجود و سازگار باشند
#   3) تعداد ✓ و ✗ **از بدنهٔ خام** شمرده و با SUMMARY مقایسه می‌شود      (C-01)
#   4) بدنه نباید خالی باشد
#   5) هش SHA-256 بدنه بازمحاسبه و با سرصفحه مقایسه می‌شود               (C-02)
#   6) تعداد آزمون‌های ثبت‌شده در tests/run.js با تعداد ✓ مقایسه می‌شود  (C-01)
#   7) اثر انگشت درخت کامل منهای docs/ با HEAD مقایسه می‌شود            (C-03)
#   8) هیچ فایل کد محصولی نسبت به SHA پایهٔ ممیزی تغییر نکرده باشد
#   9) ادعای اسناد با عدد واقعی بخواند
# هیچ پیام «موفق» بدون بررسی واقعی چاپ نمی‌شود.
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }

EVID=docs/cloud/reports/evidence
LOG="$EVID/mission-05-tests-run.log"
OUT="$EVID/mission-05-11-structure.txt"
TSFILE=$(date -u +%Y-%m-%dT%H:%M:%SZ | tr -d ':-')
DOCS="docs/cloud/05-audit-sha-freeze.md docs/cloud/06-audit-auth-session.md docs/cloud/07-audit-roles-tenant.md docs/cloud/08-audit-source-of-truth.md docs/cloud/09-audit-cache-queue-sync.md docs/cloud/10-audit-crypto-backup-restore.md docs/cloud/11-gap-report.md"
FA=docs/cloud/0[6-9]*.md
FB=docs/cloud/10*.md
BASE=f2fc472

RC=0
fail() { echo "EVIDENCE-FAIL: $*" >&2; RC=1; }

# ---------- ۱) وجود لاگ خام ----------
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
LOGBODY=$(grep -m1 '^# raw_output_sha256:' "$LOG" | awk '{print $3}')
LOGREG=$(grep -m1 '^# tests_registered:' "$LOG" | awk '{print $3}')

HEADFP=$(git ls-tree -r HEAD | grep -v $'\tdocs/' | awk '{print $3"\t"$4}' | sha256sum | cut -d" " -f1)
REGISTERED_NOW=$(grep -c 'await test(' tests/run.js)

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

# ---------- ۲) بدنهٔ خام: استخراج، هش، شمارش واقعی (C-01/C-02) ----------
BODY_TMP=$(mktemp)
trap 'rm -f "${BODY_TMP:-}"' EXIT
awk '/^# ===== RAW OUTPUT =====$/{f=1;next} /^# ===== FOOTER =====$/{f=0} f' "$LOG" > "$BODY_TMP"
BODY_BYTES=$(wc -c < "$BODY_TMP" | tr -d ' ')
if [ "${BODY_BYTES:-0}" -lt 100 ]; then
  fail "raw output body is empty or truncated (${BODY_BYTES:-0} bytes)"
fi
BODY_PASS=$(grep -c '✓' "$BODY_TMP" || true)
BODY_FAIL=$(grep -c '✗' "$BODY_TMP" || true)
[ -z "$BODY_PASS" ] && BODY_PASS=0
[ -z "$BODY_FAIL" ] && BODY_FAIL=0

if [ "${BODY_PASS:-0}" -ne "$PASS" ]; then
  fail "SUMMARY claims pass=$PASS but the raw body contains $BODY_PASS ✓ (forged or truncated log)"
fi
if [ "${BODY_FAIL:-0}" -ne "$FAILS" ]; then
  fail "SUMMARY claims fail=$FAILS but the raw body contains $BODY_FAIL ✗"
fi

BODY_SHA_CALC=$(sha256sum "$BODY_TMP" | cut -d" " -f1)
if [ -z "${LOGBODY:-}" ]; then
  fail "raw log has no raw_output_sha256 (body cannot be authenticated)"
else
  if [ "$LOGBODY" != "$BODY_SHA_CALC" ]; then
    fail "raw body hash mismatch: log=$LOGBODY computed=$BODY_SHA_CALC (body was edited)"
  fi
fi

if [ -z "${LOGREG:-}" ]; then
  fail "raw log has no tests_registered count"
else
  if [ "$LOGREG" != "$REGISTERED_NOW" ]; then
    fail "test registry changed: log=$LOGREG tests/run.js=$REGISTERED_NOW"
  fi
  if [ "$PASS" != "$LOGREG" ]; then
    fail "pass count ($PASS) does not match registered tests ($LOGREG)"
  fi
fi

# ---------- ۳) اثر انگشت کد محصول (C-03) ----------
if [ -z "${LOGFP:-}" ]; then
  fail "raw log has no product_tree_sha256 (cannot attribute evidence to product code)"
elif [ "$LOGFP" != "$HEADFP" ]; then
  fail "product code differs from the tested tree: log=$LOGFP head=$HEADFP — rerun run-tests-evidence.sh"
fi

# ---------- ۳.۵) درخت کاری کد محصول باید پاک باشد (C-03) ----------
DIRTY_PROD=$(git status --porcelain -- server client tests installer scripts desktop deploy install .github package.json package-lock.json | wc -l | tr -d ' ')
if [ "${DIRTY_PROD:-0}" != "0" ]; then
  fail "working tree has $DIRTY_PROD uncommitted change(s) in product/CI paths — evidence cannot be attributed to HEAD"
fi

# ---------- ۴) شمارش واقعی احکام در اسناد (ردیف‌محور) ----------
# اصلاح C-05 (این دور): شمارش پیشین با `grep -o '| **PASS**'` انجام می‌شد و دو نقص داشت:
#   (۱) «وقوع» می‌شمرد نه «ردیف» — ردیف E‑8 در ۱۰ دو بار **FAIL داشت و دو بار شمرده شد؛
#   (۲) به پررنگ‌بودن (bold) وابسته بود — «PASS (با ایراد)» در A‑7 اصلاً شمرده نمی‌شد.
#   نتیجه: PASS=25/FAIL=41 منتشر شد در حالی که احکام خود اسناد 26/40 است (جمع هر دو ۷۳ ⇒
#   خطا خودش را پنهان می‌کرد). حالا ستون «حکم» هر ردیف A/B/C/D/E‑n جدا خوانده می‌شود.
COUNTS_PY=$(python3 - "$FA $FB" <<'PYEOF'
import re, sys, glob
files = []
for pat in sys.argv[1].split():
    files += sorted(glob.glob(pat))
files = sorted(set(files))
KEYS = ('PASS', 'FAIL', 'UNKNOWN', 'BLOCKED')
tot = dict.fromkeys(KEYS, 0)
per = {}
other = []
decl_mismatch = []
fa = lambda s: int(''.join(str(ord(ch) - 0x06f0) for ch in s))
for f in files:
    c = dict.fromkeys(KEYS, 0)
    text = open(f, encoding='utf-8').read()
    for ln in text.split('\n'):
        if not ln.startswith('|'):
            continue
        cells = [x.strip() for x in ln.strip().strip('|').split('|')]
        if not cells or not re.match(r'^[A-Z]\u2011\d+$', cells[0]):
            continue
        v = cells[-1].replace('*', '').strip()
        tok = v.split()[0].rstrip('\u2014:\u060c').upper() if v else ''
        if tok in c:
            c[tok] += 1
        else:
            other.append(f + ':' + cells[0] + '=' + v[:40])
    per[f] = c
    for k in KEYS:
        tot[k] += c[k]
    m = re.search(r'([\u06f0-\u06f9]+)\s*PASS\s*\u00b7\s*([\u06f0-\u06f9]+)\s*FAIL\s*\u00b7\s*([\u06f0-\u06f9]+)\s*UNKNOWN', text)
    if m:
        d = (fa(m.group(1)), fa(m.group(2)), fa(m.group(3)))
        got = (c['PASS'], c['FAIL'], c['UNKNOWN'])
        if d != got:
            decl_mismatch.append('%s: متن=%s محاسبه=%s' % (f.split('/')[-1], d, got))
print(tot['PASS'], tot['FAIL'], tot['UNKNOWN'], tot['BLOCKED'], sum(tot.values()))
print('PERDOC-OK' if not decl_mismatch else 'PERDOC-MISMATCH ' + ' | '.join(decl_mismatch))
print('UNCLASSIFIED ' + ('none' if not other else ' | '.join(other)))
PYEOF
)
COUNTS_LINE=$(printf '%s\n' "$COUNTS_PY" | sed -n 1p)
PERDOC_LINE=$(printf '%s\n' "$COUNTS_PY" | sed -n 2p)
UNCL_LINE=$(printf '%s\n' "$COUNTS_PY" | sed -n 3p)
read -r P F U B TOTAL <<<"$COUNTS_LINE"
[ -n "${TOTAL:-}" ] || fail "verdict counter produced no output (doc tables unreadable)"
[ "$PERDOC_LINE" = "PERDOC-OK" ] || fail "verdict count disagrees with a document's own declared tally — ${PERDOC_LINE}"
[ "$UNCL_LINE" = "UNCLASSIFIED none" ] || fail "row verdicts not classifiable — ${UNCL_LINE}"
[ "$TOTAL" = "73" ] || fail "control-item denominator changed: TOTAL=$TOTAL (expected 73: 16+15+11+14+17)"

# ---------- ۵) ادعاهای اسناد ----------
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
# بازتنظیم (D‑35 → F‑04): ردیف‌های بعدی آزمون اضافه می‌کنند، پس ادعای سند
# می‌تواند از لاگ «کمتر» باشد — ولی هرگز بیشتر. ادعای بیش از واقعیت = دروغ.
if [ -n "${CLAIM_TESTS:-}" ] && [ "$CLAIM_TESTS" -gt "$PASS" ]; then
  fail "docs claim ${CLAIM_TESTS} passing tests but raw log shows only ${PASS}"
fi
if [ -n "${CLAIM_TESTS:-}" ] && [ "$CLAIM_TESTS" -lt "$PASS" ]; then
  echo "note: docs claim ${CLAIM_TESTS} green tests; log shows ${PASS} (ادعای سند کمتر از واقعیت — مجاز)"
fi

# ۵.۱) ادعای توزیع احکام در سند ۱۱ باید با شمارش واقعی بخواند (ضدِرانش C-05)
if [ -z "${CLAIM_PASS:-}" ] || [ -z "${CLAIM_FAIL:-}" ] || [ -z "${CLAIM_UNK:-}" ]; then
  fail "docs 11 no longer state PASS/FAIL/UNKNOWN counts — claim and evidence are not linked"
else
  if [ "$CLAIM_PASS" != "$P" ]; then fail "doc 11 claims PASS=$CLAIM_PASS but documents contain $P"; fi
  if [ "$CLAIM_FAIL" != "$F" ]; then fail "doc 11 claims FAIL=$CLAIM_FAIL but documents contain $F"; fi
  if [ "$CLAIM_UNK"  != "$U" ]; then fail "doc 11 claims UNKNOWN=$CLAIM_UNK but documents contain $U"; fi
fi

# ---------- ۶) تغییر کد محصول ----------
# کد محصول = مسیرهایی که رفتار برنامه را تعیین می‌کنند؛ .github (CI) در اثر انگشت هست ولی
# تغییرش ممنوع نیست، چون خود شاهد را در CI بالا می‌آورد.
# D‑35: از باز شدن دروازهٔ فاز ۳، تغییر کد محصول در فایل‌های اعلام‌شده مجاز است؛
# هر فایل بیرون از این فهرست ⇒ شکست (بقیهٔ محصول باید نسبت به پایه دست‌نخورده بماند).
# بازدامنه‌سازی ردیف ۴۱ (همان الگوی ردیف‌های ۲۶/۲۷ و F‑01/F‑02): فایل‌های محصولی که
# در ردیف‌های پاس‌شدهٔ ۳۹ (engine-web)، ۴۰ (outbox-web/outbox-40)، ۴۱ (convergence)،
# ۴۴ (secure-web/revocation) و ۵۳ (archive/seed/s3-stub) اضافه شدند و همچنین فایل‌های
# پذیرفته‌شدهٔ چندمستأجری (directory/gateway/scope/healthcheck) به فهرست مجاز اضافه شدند.
# هیچ بررسی‌ای حذف نشد؛ فقط دامنهٔ فایل‌های مجاز با شاهد مشخص شد.
# موارد محصولی پذیرفته‌شده در ادغام‌های بعدی main به allow-list تاریخی D‑35 افزوده شده‌اند؛ هر مورد باید شاهد مستقل داشته باشد.
# فایل‌های به‌روزرسانی/آزمون و تمرین PITR که در PR ریسک‌های ۵۰/۵۱ پذیرفته شدند نیز در فهرست‌اند.
ALLOW="${AUDIT_ALLOW:-package.json package-lock.json server/index.js server/tenancy.js server/outbox.js server/cloud-defaults.js server/s3mem.js server/auth.js server/sync.js server/db.js server/mirror.js server/policy.js server/tenant-context.js server/live.js client/app.js client/pages.js client/lib/phone.js client/lib/s3mini.js client/lib/sigv4.js client/cloud-baked.js tests/run.js tests/restart.js desktop/PayeshApp.cs server/start.js install/windows/install.ps1 install/windows/start-hidden.vbs install/windows/start.bat install/windows/uninstall.ps1 installer/payesh.iss tests/tenancy-pg.js tests/phone-flow.js scripts/bake-cloud.mjs scripts/tenancy-migrate-product.js client/engine-web.js client/index.html client/outbox-web.js client/secure-web.js scripts/healthcheck.mjs scripts/pilot-tenant-report.mjs server/archive.js server/convergence.js server/directory.js server/gateway.js server/scope.js tests/archive-53.js tests/change-feed-pg.js tests/convergence-41.js tests/cost-model.js tests/directory-pg.js tests/engine-web.js tests/gateway-pg.js tests/lib/s3-stub.js tests/lib/seed-53.js tests/outbox-40.js tests/repo-boundary.js tests/revocation-44.js tests/scope-pg.js tests/secure-negative.js tests/secure-web.js tests/sync-client-contract.js tests/sync-contract.js tests/chaos-47.js tests/adr-ids-60.js server/metrics.js server/replica-policy.js server/transfer.js client/sync-schedule.js deploy/monitoring/alerts-49.yml deploy/pgbouncer/pgbouncer.ini tests/sync-cost-42.js tests/conn-budget-45.js tests/security-scan-48.js tests/observability-49.js tests/replica-52.js tests/cell-transfer-54.js server/alerts.js server/pitr.js tests/alerts.js tests/pitr-50.js tests/branch-policy-59.js client/diag.js client/schedule.js client/styles.css package.json tests/flow.js tests/labels-gate-55.js tests/pentest-57-sync-leak.js tests/pull-leak-57.js server/update.js tests/update.js tools/pitr-drill-50.mjs tests/evidence-base-check.js}"
PROD_DIFF=$(git diff --name-only "$BASE" HEAD -- server client tests installer scripts desktop deploy install package.json package-lock.json 2>/dev/null | wc -l | tr -d ' ')
OUTSIDE=$(git diff --name-only "$BASE" HEAD -- server client tests installer scripts desktop deploy install package.json package-lock.json 2>/dev/null | grep -vxF -f <(printf '%s\n' $ALLOW) | grep -c . || true)
[ "$OUTSIDE" = "0" ] || fail "product/CI files outside the D-35 allowlist changed vs audit base $BASE: $OUTSIDE file(s)"

# ---------- ۷) تولید شاهد (فقط در صورت موفقیت) ----------
if [ "$RC" -ne 0 ]; then
  BAD="$EVID/mission-05-11-structure.FAILED-$TSFILE.txt"
  {
    echo "# شاهد ساختاری ممیزی ۰۵–۱۱ — ناموفق"
    echo "# تولید: bash docs/cloud/reports/evidence/gen-audit-evidence.sh"
      echo "# نتیجه: EVIDENCE-FAIL (کد خروج غیرصفر)"
    echo "# فایل شاهد سالم قبلی بازنویسی نشد (append-only)"
  } > "$BAD"
  echo "EVIDENCE-FAIL: دروازه رد شد؛ جزئیات بالا. شاهد ناموفق: $BAD" >&2
  echo "body_sha256=${BODY_SHA_CALC:-none}"
  exit 1
fi

{
  echo "# شاهد ساختاری ممیزی ۰۵–۱۱"
  echo "# تولید: bash docs/cloud/reports/evidence/gen-audit-evidence.sh"
  echo "# تاریخ اجرای آزمون (از لاگ خام): ${LOGTIME:-?}"
  echo "# SHA اجرای آزمون (از لاگ خام): ${LOGSHA:-?}"
  echo "# اثر انگشت کد محصول (log / HEAD): ${LOGFP:-?} / ${HEADFP}"
  echo "# هش بدنهٔ خام (بازمحاسبه‌شده): ${BODY_SHA_CALC}"
  echo "# شمارش بدنه: ${BODY_PASS} ✓ / ${BODY_FAIL} ✗ — SUMMARY: ${SUMMARY}"
  echo "# آزمون‌های ثبت‌شده: ${REGISTERED_NOW} · گزارش‌شده: ${PASS}"
  echo "# branch: $(git rev-parse --abbrev-ref HEAD)"
  echo
  echo "## آزمون واقعی مخزن (از لاگ خام، بدون دست‌کاری)"
  echo "SUMMARY: ${SUMMARY:-MISSING}"
  echo "EXIT: ${EXITC:-MISSING}"
  echo "ادعای اسناد: ${CLAIM_TESTS:-?} آزمون موفق"
  echo "احکام اسناد ۰۶–۱۱: PASS=${P} FAIL=${F} UNKNOWN=${U} BLOCKED=${B} TOTAL=${TOTAL}"
  echo
  echo "## پروب‌های اجرایی ۰۶–۱۰ (خروجی خام: mission-06-10-probes.txt)"
  echo "تعداد خط شاهد: $(grep -c '^\[' "$EVID/mission-06-10-probes.txt" 2>/dev/null || echo MISSING)"
  grep -o 'F-0[0-9]' "$EVID/mission-06-10-probes.txt" 2>/dev/null | sort | uniq -c | sed 's/^/  /'
  echo
  echo "## وضعیت هر سند"
  for d in $DOCS; do
    echo "--- $d"
    if [ -f "$d" ]; then echo "  خطوط: $(wc -l < "$d")"; else echo "  MISSING"; fi
  done
} > "$OUT"

echo "→ $OUT (pass=$PASS fail=$FAILS measured P/F/U=${P}/${F}/${U})"
echo "EVIDENCE-OK"
echo "sha=$LOGSHA"
echo "body_sha256=$BODY_SHA_CALC"
echo "product_tree_sha256=$HEADFP"
exit 0
