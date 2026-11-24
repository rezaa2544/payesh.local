#!/bin/bash
# LAB-176 GRADLE-VERIFY: PC Gradle cache index (files-2.1/<group>/<artifact>/<ver>/<sha1>/<file>, sha1 = SHA-1 of file content)
# compared with the canonical upstream .sha1 (Maven Central, Google Maven, Gradle Plugin Portal). Source index: raw/pc/gradle-cache-index.txt
IDX=$HOME/lab176/raw/pc/gradle-cache-index.full.txt  # full PC index, sha256 007c7765...4f47 verified after transfer
ok=0; bad=0; nf=0
while IFS= read -r line; do
  line=$(echo "$line" | tr -d '\r\357\273\277'); [ -z "$line" ] && continue; case "$line" in \[*) continue;; esac
  IFS='\' read -r g a v h f <<< "$line"
  gp=${g//.//}; rel="$gp/$a/$v/$f"; hn=$(echo "$h" | sed 's/^0*//'); seen=""; hit=""
  for base in https://repo1.maven.org/maven2 https://dl.google.com/dl/android/maven2 https://plugins.gradle.org/m2; do
    s=$(curl -sfL -m 20 "$base/$rel.sha1" | tr -d ' \r\n' | cut -c1-40)
    [[ "$s" =~ ^[0-9a-f]{40}$ ]] || continue
    seen="$seen ${base#https://}=$s"
    # Gradle names the folder with the SHA-1 as an unpadded hex BigInteger => compare without leading zeros
    if [ "$(echo "$s" | sed 's/^0*//')" = "$hn" ]; then hit=${base#https://}; break; fi
  done
  if [ -n "$hit" ]; then ok=$((ok+1)); echo "MATCH    $rel $h $hit"
  elif [ -z "$seen" ]; then nf=$((nf+1)); echo "NOTFOUND $rel cache=$h"
  else bad=$((bad+1)); echo "MISMATCH $rel cache=$h upstream:$seen"; fi
done < "$IDX"
echo "GRADLE-VERIFY total=$((ok+bad+nf)) match=$ok mismatch=$bad notfound=$nf"
[ $bad -eq 0 ]
