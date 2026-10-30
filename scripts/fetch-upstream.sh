#!/usr/bin/env bash
# دریافت مخزن مرجع پایش (rezaa2544/p2) برای مقایسه و استخراج کد.
# در .gitignore نادیده گرفته می‌شود؛ هرگز داخل این مخزن کامیت نمی‌شود.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${ROOT}/.upstream/p2"

if [ -d "${DEST}/.git" ]; then
  echo "به‌روزرسانی مخزن مرجع: ${DEST}"
  git -C "${DEST}" fetch --depth 1 origin main
  git -C "${DEST}" reset --hard origin/main
else
  echo "دریافت مخزن مرجع در ${DEST}"
  mkdir -p "$(dirname "${DEST}")"
  git clone --depth 1 https://github.com/rezaa2544/p2.git "${DEST}"
fi

echo
echo "آماده است: ${DEST}"
echo "ماژول‌های کلاینت : ${DEST}/src/js"
echo "سرور            : ${DEST}/server"
echo "مستندات         : ${DEST}/docs"
echo "قرارداد مجوز    : ${DEST}/authz/model.json"
