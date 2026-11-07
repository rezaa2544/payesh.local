#!/usr/bin/env bash
# شاهد ردیف ۵۳ — آرشیو دادهٔ سرد و سیاست نگه‌داشت
# اجرا: bash docs/cloud/reports/evidence/run-53-archive.sh
# خروجی سبز: docs/cloud/reports/evidence/archive-53.txt  (پایان: ARCHIVE-53-OK)
# هیچ سرویس بیرونی لازم نیست؛ صندوقچهٔ S3 محلی با بازبینی واقعی امضای SigV4 درون خود آزمون بالا می‌آید.
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
export LC_ALL=C.UTF-8

D=docs/cloud/reports/evidence
OUT=${AR53_OUT:-$D/archive-53.txt}
HEAD=$(git rev-parse HEAD)
BR=$(git rev-parse --abbrev-ref HEAD)
NODE=$(node -v)
VER=$(node -e "process.stdout.write(require('./package.json').version)")
FLAGS="--experimental-sqlite --disable-warning=ExperimentalWarning"

{
  echo "# شاهد ردیف ۵۳ — آرشیو دادهٔ سرد و سیاست نگه‌داشت"
  echo "# repo: https://github.com/rezaa2544/payesh.local"
  echo "# branch: $BR"
  echo "# head_sha: $HEAD"
  echo "# version: $VER"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $NODE"
  echo "# os: $(uname -srm)"
  echo "# command: bash docs/cloud/reports/evidence/run-53-archive.sh"
  echo "# policy_source: server/archive.js → POLICY (hot_months=12, cold_keep_years=7, signed_url_ttl=300s, max=900s)"
  echo "# storage: tests/lib/s3-stub.js — صندوقچهٔ S3 محلی که امضای SigV4 و هش بدنه را بازمحاسبه و مقایسه می‌کند"
  echo

  echo "## بخش ۱ — آزمون‌های آرشیو/نگه‌داشت روی لایهٔ ذخیره‌سازی واقعی محصول (AR-01..AR-15)"
  node $FLAGS tests/archive-53.js
  AR=$?

  echo
  echo "## بخش ۲ — اندازهٔ جدول‌ها پیش/پس از آرشیو و بازبینی آستانه (شبیه‌سازی ۱۲۰٬۰۰۰ ردیف)"
  node $FLAGS tools/archive-53-sizes.js
  SZ=$?

  echo
  echo "## بخش ۳ — شاهد خام: یک فایل بایگانی همان‌طور که در ذخیره‌ساز می‌نشیند"
  node $FLAGS -e '
    const fs = require("fs"), os = require("os"), path = require("path");
    const { openStore } = require("./server/db");
    const archive = require("./server/archive");
    const { startStub } = require("./tests/lib/s3-stub");
    const { seed } = require("./tests/lib/seed-53");
    (async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payesh-ar53-raw-"));
      const store = openStore(path.join(dir, "db.sqlite"));
      const stub = await startStub({ accessKey: "ak-raw", secret: "sk-raw", bucket: "payesh-raw" });
      seed(store, { totalRows: 3000, collections: archive.POLICY.collections.slice(0, 2), now: new Date("2026-11-07T00:00:00.000Z") });
      const run = await archive.archiveColdData(store, { cfg: stub.cfg, now: new Date("2026-11-07T00:00:00.000Z") });
      const key = run.objects[0].key;
      const text = stub.objects.get(key);
      const env = JSON.parse(text);
      const raw = require("zlib").gunzipSync(Buffer.from(env.data, "base64")).toString("utf8").split("\n").filter(Boolean);
      console.log("object_key            " + key);
      console.log("object_bytes          " + Buffer.byteLength(text, "utf8"));
      console.log("envelope_fields       " + Object.keys(env).join(","));
      console.log("rows_in_file          " + env.rows);
      console.log("sha256_of_ndjson      " + env.sha256);
      console.log("ndjson_first_row      " + raw[0]);
      console.log("ndjson_last_row       " + raw[raw.length - 1]);
      console.log("manifest_rows         " + JSON.stringify(archive.listArchive(store).map(m => ({ k: m.key, rows: m.rows, sha256: m.sha256.slice(0, 16) + "…" })).slice(0, 4)));
      console.log("sigv4_verified        " + stub.counters.verified);
      console.log("sigv4_rejected        " + stub.counters.rejected);
      console.log("body_hash_mismatch    " + stub.counters.body_hash_mismatch);
      /* شاهد خام آزمون منفی: امضای دستکاری‌شده */
      const url = archive.signedUrl(stub.cfg, key, { ttlSec: 300 });
      const tampered = url.replace(/X-Amz-Signature=[0-9a-f]+/, "X-Amz-Signature=" + "0".repeat(64));
      const r1 = await fetch(url), r2 = await fetch(tampered);
      console.log("signed_url_valid      " + r1.status);
      console.log("signed_url_tampered   " + r2.status);
      const restored = await archive.restoreArchive(store, { cfg: stub.cfg, key });
      console.log("restore_rows          " + restored.rows);
      await stub.close(); store.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    })().catch(e => { console.log("raw probe error: " + e.message); process.exit(1); });
  '
  RAW=$?

  echo
  echo "# ===== SUMMARY ====="
  echo "# checks_ar_exit: $AR"
  echo "# sizes_exit: $SZ"
  echo "# raw_probe_exit: $RAW"
  if [ "$AR" -eq 0 ] && [ "$SZ" -eq 0 ] && [ "$RAW" -eq 0 ]; then
    echo "# EXIT=0"
    echo "ARCHIVE-53-OK"
  else
    echo "# EXIT=1"
    echo "ARCHIVE-53-FAIL"
  fi
} > "$OUT" 2>&1

tail -20 "$OUT"
grep -q '^ARCHIVE-53-OK$' "$OUT"
