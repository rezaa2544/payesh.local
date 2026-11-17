#!/usr/bin/env bash
# Row 168: start the REAL release APKs on an old Android emulator (CI: API 21 = Android 5.0 and
# API 23 = Android 6.0, x86_64 — the 64-bit engine with libpayeshw21.so) and prove that they run:
#   · adb install succeeds (v1 signature, minSdk 21)
#   · the launcher activity starts and the process is still alive after the warm-up
#   · libflutter.so, libapp.so (the Dart AOT snapshot = Dart code running) and, on 64-bit,
#     libpayeshw21.so are mapped into the process
#   · logcat has no FATAL EXCEPTION / UnsatisfiedLinkError / "cannot locate symbol" / native crash
#   · the screen shows a rendered Flutter frame (not a blank launch window)
# usage: emulator-smoke.sh OUT_DIR APK PACKAGE [APK PACKAGE ...]
set -uo pipefail
OUT=$1; shift
mkdir -p "$OUT"
API=$(adb shell getprop ro.build.version.sdk | tr -d '\r')
ABI=$(adb shell getprop ro.product.cpu.abi | tr -d '\r')
echo "device: API $API, ABI $ABI, $(adb shell getprop ro.build.fingerprint | tr -d '\r')" | tee "$OUT/device.txt"
fail=0
while [ $# -ge 2 ]; do
  APK=$1 PKG=$2; shift 2
  tag="$PKG-api$API"
  echo "== $PKG ($APK)"
  adb logcat -c || true
  adb uninstall "$PKG" >/dev/null 2>&1 || true
  r=$(adb install -r "$APK" 2>&1 | tr -d '\r'); echo "$r" | tail -2
  if ! echo "$r" | grep -q '^Success'; then echo "SMOKE-FAIL $tag: install"; fail=1; continue; fi
  ACT=$(adb shell cmd package resolve-activity --brief "$PKG" 2>/dev/null | tr -d '\r' | tail -1)
  case "$ACT" in */*) ;; *) ACT="$PKG/.MainActivity" ;; esac
  adb shell am start -W -n "$ACT" 2>&1 | tr -d '\r' | tee "$OUT/$tag-start.txt"
  sleep 30
  # toolbox ps (API 21-23): USER PID PPID VSIZE RSS WCHAN PC S NAME
  PID=$(adb shell ps | tr -d '\r' | awk -v p="$PKG" '$NF==p {print $2}' | head -1)
  adb logcat -d > "$OUT/$tag-logcat.txt" 2>&1 || true
  adb exec-out screencap -p > "$OUT/$tag.png" 2>/dev/null || true
  ok=1
  if [ -z "$PID" ]; then echo "SMOKE-FAIL $tag: process not running after 30 s"; ok=0
  else
    adb shell cat /proc/$PID/maps 2>/dev/null | tr -d '\r' | grep -oE '[^/ ]+\.so$' | sort -u > "$OUT/$tag-libs.txt" || true
    want="libflutter.so libapp.so"
    case "$ABI" in arm64-v8a|x86_64) want="$want libpayeshw21.so" ;; esac
    for l in $want; do
      if ! grep -qx "$l" "$OUT/$tag-libs.txt"; then
        # release APKs are not debuggable: /proc/<pid>/maps of another uid may be unreadable on
        # some images — fall back to the linker's log of the loaded libraries
        if ! grep -q "$l" "$OUT/$tag-logcat.txt"; then echo "SMOKE-FAIL $tag: $l not loaded"; ok=0; fi
      fi
    done
  fi
  if grep -E "FATAL EXCEPTION|UnsatisfiedLinkError|cannot locate symbol|CANNOT LINK EXECUTABLE|dlopen failed|Fatal signal|\*\*\* \*\*\* \*\*\*|NoSuchMethodError|NoClassDefFoundError|VerifyError" "$OUT/$tag-logcat.txt" | grep -v "payeshw21.*No such file" | head -20 | tee "$OUT/$tag-errors.txt" | grep -q .; then
    echo "SMOKE-FAIL $tag: errors in logcat:"; cat "$OUT/$tag-errors.txt"; ok=0
  fi
  if ! python3 "$(dirname "$0")/png-rendered.py" "$OUT/$tag.png"; then echo "SMOKE-FAIL $tag: no rendered frame"; ok=0; fi
  if [ $ok = 1 ]; then echo "SMOKE-OK $tag pid=$PID libs=$(tr '\n' ' ' < "$OUT/$tag-libs.txt" | grep -oE 'lib(flutter|app|payeshw21|sqlite3)\.so' | tr '\n' ' ')"
  else fail=1; grep -iE "flutter|payesh|AndroidRuntime|linker|DEBUG" "$OUT/$tag-logcat.txt" | tail -60; fi
  adb shell am force-stop "$PKG" || true
done
[ $fail = 0 ] && echo "ANDROID-EMULATOR-SMOKE-OK api=$API abi=$ABI" || { echo "ANDROID-EMULATOR-SMOKE-FAILED api=$API"; exit 1; }
