#!/usr/bin/env bash
# شاهد ردیف ۴۴ — امنیت دادهٔ روی دستگاه (رمزنگاری در حالت سکون، قفل برنامه، ابطال/پاک‌سازی)
# اجرا: bash docs/cloud/reports/evidence/run-44-security.sh
# خروجی سبز: docs/cloud/reports/evidence/device-security-44.txt
# هیچ سرویس بیرونی لازم نیست؛ فقط Node و WebCrypto درون Node.
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8

D=docs/cloud/reports/evidence
OUT=${SEC44_OUT:-$D/device-security-44.txt}
HEAD=$(git rev-parse HEAD)
BR=$(git rev-parse --abbrev-ref HEAD)
NODE=$(node -v)
VER=$(node -e "process.stdout.write(require('./package.json').version)")

{
  echo "# شاهد ردیف ۴۴ — امنیت دادهٔ روی دستگاه"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# version: $VER"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $NODE"
  echo "# os: $(uname -srm)"
  echo "# command: bash docs/cloud/reports/evidence/run-44-security.sh"
  echo "# primitives: PBKDF2-SHA256(210000) → AES-GCM-256 · کلید non-extractable · WebCrypto + IndexedDB استاندارد"
  echo

  echo "## بخش ۱ — لایهٔ امن دادهٔ دستگاه (SE-01..SE-12)"
  node tests/secure-web.js
  SE=$?

  echo
  echo "## بخش ۲ — ابطال دستگاه سمت سرور، روی لایهٔ ذخیره‌سازی واقعی محصول (RV-01..RV-06)"
  node --experimental-sqlite --disable-warning=ExperimentalWarning tests/revocation-44.js
  RV=$?

  echo
  echo "## شاهد خام: یک رکورد در حالت سکون، همان‌طور که روی دیسک می‌نشیند"
  node -e '
  require("fake-indexeddb/auto");
  const secure = require("./client/secure-web");
  const SENT = "نشت-نباید-دیده-شود-۴۴-حضور";
  (async () => {
    const s = await secure.SecureStore.open({ name: "payesh_evidence_44", secret: "evidence-44-راز-۸۸۸" });
    await s.put("attendance", 1, { note: SENT, class_id: 9, student_id: 4 });
    const dump = await new Promise((res, rej) => {
      const r = indexedDB.open("payesh_evidence_44");
      r.onsuccess = () => {
        const db = r.result;
        const q = db.transaction(secure.STORE, "readonly").objectStore(secure.STORE).getAll();
        q.onsuccess = () => { db.close(); res(q.result); };
        q.onerror = () => rej(q.error);
      };
      r.onerror = () => rej(r.error);
    });
    const rec = dump[0];
    const ct = new Uint8Array(rec.ct);
    const iv = new Uint8Array(rec.iv);
    const hex = [...ct.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("");
    console.log("record.key            = " + rec.k);
    console.log("record.collection     = " + rec.collection + "   (روشن، برای پرس‌وجو — ریسک باقی‌ماندهٔ ثبت‌شده)");
    console.log("record.updated_at     = " + rec.updated_at + "   (روشن، برای since)");
    console.log("record.iv_bytes       = " + iv.length + "   hex=" + [...iv].map(b => b.toString(16).padStart(2, "0")).join(""));
    console.log("record.ct_bytes       = " + ct.length);
    console.log("record.ct_first16_hex = " + hex);
    const all = JSON.stringify(dump.map(r => ({ k: r.k, c: Array.from(new Uint8Array(r.ct)) })));
    const leaked = all.indexOf("نشت") !== -1;
    console.log("plaintext_present     = " + (leaked ? "YES" : "NO"));
    console.log("AT-REST plaintext=" + (leaked ? "LEAKED" : "absent") + " ct_bytes=" + ct.length + " iv_bytes=" + iv.length);
    s.close();
    process.exit(leaked ? 1 : 0);
  })().catch(e => { console.log("raw dump error: " + e.message); process.exit(2); });
  '
  RAW=$?

  echo
  echo "## کنترل منفی — هر سه محافظ باید واقعاً ببندند"
  node tests/secure-negative.js
  NEG=$?

  echo
  echo "## اتصال به مسیر محصول (بررسی سیم‌کشی؛ ثابت ایستا، نه اجرای مرورگر)"
  for pat in "async function cacheRead" "async function cacheWrite" "await handleDeviceRevoked('device_revoked')" "await sc.handleRevocation({ reason })" "_secure.lock()"; do
    if grep -qF "$pat" client/app.js; then echo "WIRED ✓  $pat"; else echo "WIRED ✗  $pat"; WIRE=1; fi
  done
  if grep -qF 'src="/secure-web.js"' client/index.html; then echo "WIRED ✓  index.html بارگذاری secure-web.js"; else echo "WIRED ✗  index.html"; WIRE=1; fi
  echo "WIRING-44-OK"

  echo
  echo "## عدم رگرسیون ۱: موتور دادهٔ مرورگری (ردیف ۳۹) — ۱۰ بررسی"
  node tests/engine-web.js | tail -3
  ENG=${PIPESTATUS[0]}

  echo
  echo "## عدم رگرسیون ۲: آزمون اصلی محصول"
  npm test 2>&1 | tail -4
  MAIN=${PIPESTATUS[0]}

  echo
  echo "خلاصهٔ اجرا: se=$SE rv=$RV raw=$RAW neg=$NEG engine=$ENG suite=$MAIN"
  if [ "$SE" -eq 0 ] && [ "$RV" -eq 0 ] && [ "$RAW" -eq 0 ] && [ "$NEG" -eq 0 ] && [ "$ENG" -eq 0 ] && [ "$MAIN" -eq 0 ]; then
    echo
    echo "DEVICE-SECURITY-44-OK"
  else
    echo
    echo "DEVICE-SECURITY-44-FAIL"
  fi
} > "$OUT" 2>&1

if grep -q "DEVICE-SECURITY-44-OK" "$OUT"; then
  echo "→ $OUT"
  grep -E "^SE checks|^RV checks|^NEG checks|^AT-REST|^خلاصهٔ اجرا" "$OUT"
else
  echo "FAIL — جزئیات در $OUT" >&2
  tail -20 "$OUT" >&2
  exit 1
fi
