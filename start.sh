#!/usr/bin/env bash
# اجرای سریع سرور مدرسه در حالت توسعه/آزمایش
# ردیف ۱۲۷: پیش‌فرض «بی‌رابط» است (فقط API برای اپ بومی، بدون صفحهٔ وب).
cd "$(dirname "$0")" || exit 1
mkdir -p data
export PAYESH_HEADLESS="${PAYESH_HEADLESS:-1}"
exec node --experimental-sqlite --disable-warning=ExperimentalWarning server/index.js "$@"
