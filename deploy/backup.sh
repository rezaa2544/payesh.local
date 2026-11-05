#!/usr/bin/env bash
# بکاپ امن پایگاه دادهٔ پایش (با VACUUM INTO — بدون خطر فایل نیمه‌کاره)
# استفاده: bash deploy/backup.sh   |   KEEP=60 bash deploy/backup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_DIR="${PAYESH_DATA:-$APP_DIR/data}"
DB="$DATA_DIR/payesh.sqlite"
OUT="$DATA_DIR/backups"
KEEP="${KEEP:-30}"

[ -f "$DB" ] || { echo "پایگاه داده پیدا نشد: $DB"; exit 1; }
mkdir -p "$OUT"

STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$OUT/payesh-$STAMP.sqlite"

node --experimental-sqlite --disable-warning=ExperimentalWarning -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
db.exec(\"VACUUM INTO '\" + process.argv[2].replace(/'/g, \"''\") + \"'\");
db.close();
" "$DB" "$TARGET"

SIZE="$(du -h "$TARGET" | cut -f1)"
echo "✓ بکاپ ساخته شد: $TARGET ($SIZE)"

# نگه‌داشتن فقط KEEP نسخهٔ آخر
ls -1t "$OUT"/payesh-*.sqlite 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old" && echo "  - پاک شد: $(basename "$old")"
done
