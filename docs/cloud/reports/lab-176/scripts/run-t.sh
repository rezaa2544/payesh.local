#!/bin/bash
# run-t.sh <ID> <purpose> -- <command...>   evidence wrapper: raw log + header + exit -> ~/lab176/raw (persistent)
ID=$1; PURPOSE=$2; shift 3
cd /work/repo; export PATH=/work/node22/bin:/usr/lib/postgresql/17/bin:/work/flutter/bin:$HOME/.local/bin:$PATH
R=$HOME/lab176/raw; F=$R/$ID.log; mkdir -p $R
{ echo "TEST_ID=$ID"; echo "PURPOSE=$PURPOSE"; echo "SHA=$(git rev-parse HEAD) (+ working-tree diff raw/FIX-D01-D02.diff: $(git diff --stat | tail -1))"; echo "ENV=sandbox $(uname -sr) node $(node -v) npm $(npm -v) pg $(postgres --version | awk '{print $3}')"; echo "CMD=$*"; echo "START=$(date -u +%FT%TZ)"; echo "----- RAW -----"; } > $F
s=$(date +%s); bash -c "$*" >> $F 2>&1; rc=$?; e=$(date +%s)
{ echo "----- END RAW -----"; echo "EXIT=$rc"; echo "END=$(date -u +%FT%TZ)"; echo "DURATION_S=$((e-s))"; } >> $F
echo "$ID EXIT=$rc DUR=$((e-s))s" | tee -a $R/SUMMARY.txt
