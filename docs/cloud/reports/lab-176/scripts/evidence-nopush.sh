#!/bin/bash
# = /work/bin/_evidence.sh  _evidence main ""  WITHOUT the final git push (owner approval pending). Run in /work/repo.
set -o pipefail
E=docs/cloud/reports/evidence
bash $E/run-tests-evidence.sh > /tmp/tests-ev.log 2>&1 || { tail -20 /tmp/tests-ev.log; echo "TESTS-EVIDENCE FAILED"; exit 5; }
tail -5 /tmp/tests-ev.log
LINE=$(grep -E "^pass=" /tmp/tests-ev.log | tail -1); echo "LINE: $LINE"
bash $E/gen-audit-evidence.sh > /tmp/audit-ev.log 2>&1 || { tail -20 /tmp/audit-ev.log; echo "GEN-AUDIT FAILED"; exit 6; }
tail -5 /tmp/audit-ev.log
git add $E/mission-05-11-structure.txt $E/mission-05-tests-run.log $E/tests-run-*.log
P=$(echo "$LINE" | sed -E 's/.*pass=([0-9]+).*/\1/'); F=$(echo "$LINE" | sed -E 's/.*registered=([0-9]+).*/\1/')
git -c user.name=arena-agent -c user.email=arena-agent@users.noreply.github.com commit -q -m "evidence: main — tests-run $P/$F, EVIDENCE-OK" || { echo "COMMIT FAILED/NOTHING"; exit 9; }
node tools/evidence-sha-89.mjs --check | tail -3 || exit 7
git log --oneline -1
echo "NO PUSH (pending owner approval)"
