#!/usr/bin/env bash
# Rows 46/50/51/55/57: rerun every part that can run on a dev machine or CI runner, on the
# current tree. Real-world parts ([M] on real target, two physical hosts, managed PostgreSQL,
# a 7-day pilot in two real schools, a human pentest) are NOT here. They were handed to the owner
# (docs/cloud/reports/owner-handover-real-world.md · D-47).
# Usage: bash docs/cloud/reports/evidence/run-onsystem-46-57.sh  (Node 22)
set -u
cd "$(dirname "$0")/../../../.."
FLAGS="--experimental-sqlite --disable-warning=ExperimentalWarning"
TMP="$(mktemp -d)"
pass=0; fail=0; blocked=0
step() { # step <row> <label> <cmd...>
  local row="$1" label="$2"; shift 2
  local t0=$(date +%s)
  "$@" > "$TMP/out.txt" 2>&1
  local code=$?
  local dt=$(( $(date +%s) - t0 ))
  if [ $code -eq 0 ]; then echo "PASS row=$row $label (exit=0, ${dt}s)"; pass=$((pass+1));
  elif [ $code -eq 3 ]; then echo "BLOCKED row=$row $label (exit=3 — environment missing, not PASS, ${dt}s)"; blocked=$((blocked+1));
  else echo "FAIL row=$row $label (exit=$code, ${dt}s)"; fail=$((fail+1)); fi
  tail -n 6 "$TMP/out.txt" | sed 's/^/    | /'
}

# 46: fleet load needs a real PostgreSQL binary (embedded-postgres). Without it this is BLOCKED (exit 3), never PASS.
#     Provide it with: (mkdir -p /tmp/pgtest && cd /tmp/pgtest && npm i @embedded-postgres/linux-x64)
step 46 "fleet-load-46 [S] gateway + PostgreSQL, stages 50,100 x5s (single host)" \
  env FLEET_STAGES=50,100 FLEET_STAGE_SECONDS=5 FLEET_OUT="$TMP/fleet.txt" FLEET_JSON="$TMP/fleet.json" \
  bash docs/cloud/reports/evidence/run-46-fleet-load.sh
step 46 "connection budget formula + pgbouncer (row 45 input to 46)" node tools/conn-budget-45.mjs

# 50: PITR tool self-tests + local drill [S]
step 50 "tests/pitr-50.js (PT-01..PT-10)" node tests/pitr-50.js
step 50 "pitr-drill-50 --local-drill [S]" node tools/pitr-drill-50.mjs --local-drill

# 51: pilot watcher on a real local server, 3 cycles, plus the negative control (target down)
PORT51=18151
node $FLAGS server/seed.js --fresh > "$TMP/seed.txt" 2>&1 || true
PORT=$PORT51 HOST=127.0.0.1 node $FLAGS server/index.js > "$TMP/srv51.txt" 2>&1 &
SRV=$!
for i in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT51/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
timeout 9 node tools/pilot-watch.cjs --targets "http://127.0.0.1:$PORT51" --interval 3 --out "$TMP/watch.jsonl" > "$TMP/watch.txt" 2>&1
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
up=$(grep -c '"up":true' "$TMP/watch.jsonl" 2>/dev/null || echo 0)
timeout 5 node tools/pilot-watch.cjs --targets "http://127.0.0.1:$PORT51" --interval 2 --out "$TMP/watch-down.jsonl" > /dev/null 2>&1
down=$(grep -c '"up":false' "$TMP/watch-down.jsonl" 2>/dev/null || echo 0)
if [ "$up" -ge 2 ] && [ "$down" -ge 1 ]; then echo "PASS row=51 pilot-watch live cycles up=$up · negative control down=$down"; pass=$((pass+1));
else echo "FAIL row=51 pilot-watch up=$up down=$down"; fail=$((fail+1)); fi

# 55: local ceiling [S] (small levels, dev machine) + constitution labels gate
# the tool writes a fixed evidence path; keep the committed [S] file untouched
CEIL=docs/cloud/reports/evidence/load-55-ceiling.json
cp "$CEIL" "$TMP/ceil.keep"
step 55 "load-ceiling-55 [S] levels 10,25,50" node tools/load-ceiling-55.cjs --levels 10,25,50 --hold 4
cp "$TMP/ceil.keep" "$CEIL"
step 55 "labels-gate-55 ([M] never next to local numbers)" node tests/labels-gate-55.js

# 57: automated pentest sweep + leak regressions (not a human pentest)
# the sweep reads the default env file (data_dir of the live instance); restore it afterwards
PENV=docs/cloud/reports/evidence/pentest-57-env.json
cp "$PENV" "$TMP/penv.keep"
node tools/provision-pentest.cjs --port 18099 > "$TMP/prov.txt" 2>&1 &
PROV=$!
for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:18099/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
# provision writes the env sheet on a timer after the server is up: wait until data_dir is the live one
for i in $(seq 1 40); do
  d=$(node -e 'try{const e=require(process.argv[1]);process.stdout.write(e.data_dir||"")}catch(x){}' "$PWD/$PENV")
  [ -n "$d" ] && [ -f "$d/payesh.sqlite" ] && ! cmp -s "$PENV" "$TMP/penv.keep" && break; sleep 0.5
done
step 57 "pentest-sweep-57 automated (WSTG classes)" node tools/pentest-sweep-57.cjs --out "$TMP/57.txt"
pkill -P $PROV 2>/dev/null; kill $PROV 2>/dev/null; wait $PROV 2>/dev/null
cp "$TMP/penv.keep" "$PENV"
grep -E "^(FAIL|PENTEST-57-AUTOMATED)" "$TMP/57.txt" 2>/dev/null | sed 's/^/    | sweep: /' 
step 57 "pull-leak-57 regression" node $FLAGS tests/pull-leak-57.js
step 57 "leak-matrix-57 role x collection x field" node tests/leak-matrix-57.js

echo "SUMMARY pass=$pass fail=$fail blocked=$blocked"
rm -rf "$TMP"
[ $fail -eq 0 ] && echo "ONSYSTEM-46-57-OK" && exit 0
exit 1
