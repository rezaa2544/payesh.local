#!/usr/bin/env bash
# اجرای سریع در حالت توسعه/آزمایش
cd "$(dirname "$0")" || exit 1
mkdir -p data
exec node --experimental-sqlite --disable-warning=ExperimentalWarning server/index.js "$@"
