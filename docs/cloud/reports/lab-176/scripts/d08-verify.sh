#!/bin/bash
# D-08 AFTER: run suite while sampling every 1s for cloudflared processes / :7844 conns. CF_SEEN must be 0.
cd /work/repo
seen=0; samples=0
"$@" & pid=$!
while kill -0 $pid 2>/dev/null; do
  samples=$((samples+1))
  c=$(pgrep -fc "[b]in/cloudflared"); n=$(ss -tn 2>/dev/null | grep -c ":7844 ")
  [ "$c" -gt 0 -o "$n" -gt 0 ] && { seen=$((seen+1)); echo "SAMPLE $samples cloudflared=$c conn7844=$n"; }
  sleep 1
done
wait $pid; rc=$?
echo "MONITOR samples=$samples CF_SEEN=$seen suite_rc=$rc orphans_after=$(pgrep -fc '[b]in/cloudflared')"
