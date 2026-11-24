#!/bin/bash
# kills the guarded run if MemAvailable < 150 MB (prevents sandbox freeze); logs to raw/WATCHDOG.log
PAT="${1:-[r]un-t.sh REG-03}"
while pgrep -f "$PAT" >/dev/null; do
  a=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  echo "$(date -u +%TZ) avail=${a}MB" >> $HOME/lab176/raw/WATCHDOG.log
  if [ "$a" -lt 150 ]; then echo "$(date -u +%TZ) KILL (avail ${a}MB)" >> $HOME/lab176/raw/WATCHDOG.log; pkill -9 -f "[t]ests/run.js"; pkill -9 -f "[s]erver/index.js"; fi
  sleep 10
done
