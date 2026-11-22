#!/bin/sh
# ═══════════════════════════════════════════════════════════════════
# Row 171 — install / update the project's CENTRAL server on serv00.com (FreeBSD, no root).
#
#   On serv00, over SSH:    sh setup.sh [DOMAIN]
#   From GitHub Actions:    .github/workflows/serv00-central.yml pipes this file over SSH
#                           (keys come in as exported variables on stdin, never on a command line).
#
# DOMAIN defaults to <login>.serv00.net (works at once); later app.payeshschool.ir once its DNS
# points at this serv00 server (the script prints the address to use).
# Idempotent: run it again to update to the newest release (releases/manifest.json on GitHub).
# Optional variables: PAYESH_VERSION, PAYESH_S3_ACCESS_KEY, PAYESH_S3_SECRET, PAYESH_PUBLIC_URL,
#                     PAYESH_RAW (where releases/ and deploy/ are read; default: GitHub main).
# ═══════════════════════════════════════════════════════════════════
set -eu

RAW=${PAYESH_RAW:-https://raw.githubusercontent.com/rezaa2544/payesh.local/main}
ME=$(whoami | tr 'A-Z' 'a-z')
DOMAIN=$(printf '%s' "${1:-${PAYESH_DOMAIN:-$ME.serv00.net}}" | tr 'A-Z' 'a-z')
APPS=$HOME/payesh-apps
TMPD=$HOME/tmp/payesh-setup.$$
mkdir -p "$TMPD"
trap 'rm -rf "$TMPD"' EXIT

say() { printf 'payesh-setup: %s\n' "$*"; }
dl() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -m 300 -o "$2" "$1"
  else fetch -q -o "$2" "$1"; fi
}

# ── 1. a Node that has node:sqlite without flags (Passenger cannot pass node flags) ──
NODE=""
for n in node24 node22 node26 node; do
  p=$(command -v "$n" 2>/dev/null || true)
  [ -z "$p" ] && [ -x "/usr/local/bin/$n" ] && p=/usr/local/bin/$n
  if [ -n "$p" ] && "$p" -e "require('node:sqlite')" >/dev/null 2>&1; then NODE=$p; break; fi
done
if [ -z "$NODE" ]; then
  say "FAIL no Node with node:sqlite here (need node24, or node22 >= 22.13)"; exit 2
fi
say "node: $NODE $("$NODE" -v)"

# ── 2. the release (same source package as every school PC) ──
dl "$RAW/releases/manifest.json" "$TMPD/manifest.json"
VER=${PAYESH_VERSION:-$("$NODE" -e "process.stdout.write(String(require(process.argv[1]).version))" "$TMPD/manifest.json")}
case $VER in *[!0-9.]*|'') say "FAIL bad version '$VER'"; exit 3 ;; esac
mkdir -p "$APPS"
DIR=$APPS/$VER
if [ ! -f "$DIR/server/index.js" ]; then
  dl "$RAW/releases/payesh-local-src-$VER.tar.gz" "$TMPD/src.tgz"
  rm -rf "$DIR.new"; mkdir -p "$DIR.new"
  tar xzf "$TMPD/src.tgz" -C "$DIR.new"
  [ -f "$DIR.new/server/index.js" ] || { say "FAIL package has no server/index.js"; exit 4; }
  rm -rf "$DIR"; mv "$DIR.new" "$DIR"
fi
ln -sfn "$DIR" "$HOME/payesh-app"
# keep the newest three versions
ls -1t "$APPS" | grep -v '\.new$' | tail -n +4 | while read -r old; do rm -rf "${APPS:?}/$old"; done
say "release: $VER"

# ── 3. keys and settings: ~/.payesh.env (600), read by app.js ──
ENVF=$HOME/.payesh.env
umask 077
touch "$ENVF"; chmod 600 "$ENVF"
setkv() {
  grep -v "^$1=" "$ENVF" > "$TMPD/env" || true
  printf '%s=%s\n' "$1" "$2" >> "$TMPD/env"
  cat "$TMPD/env" > "$ENVF"
}
for k in PAYESH_S3_ACCESS_KEY PAYESH_S3_SECRET; do
  eval "v=\${$k:-}"
  [ -n "$v" ] && setkv "$k" "$v"
done
setkv PAYESH_PUBLIC_URL "${PAYESH_PUBLIC_URL:-https://$DOMAIN}"
grep -q '^PAYESH_S3_ACCESS_KEY=.' "$ENVF" || say "NOTE no database keys yet (PAYESH_S3_ACCESS_KEY / PAYESH_S3_SECRET): the list works, hosting schools waits for them"

# ── 4. the website (Passenger "nodejs" type) ──
if ! devil www list 2>/dev/null | awk '{print $1}' | grep -qx "$DOMAIN"; then
  devil www add "$DOMAIN" nodejs "$NODE" production
fi
WEB=$HOME/domains/$DOMAIN/public_nodejs
mkdir -p "$WEB/public"
if [ -f "$DIR/deploy/serv00/app.js" ]; then cp "$DIR/deploy/serv00/app.js" "$WEB/app.js"
else dl "$RAW/deploy/serv00/app.js" "$WEB/app.js"; fi
mkdir -p "$HOME/payesh-data"

# ── 5. https for an own domain (*.serv00.net already has it) ──
IP=$(devil vhost list public 2>/dev/null | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -n 1 || true)
case $DOMAIN in
  *.serv00.net) ;;
  *)
    if devil ssl www add "$IP" le le "$DOMAIN" >/dev/null 2>&1; then say "https: issued for $DOMAIN"
    else say "NOTE https for $DOMAIN not issued yet — its DNS A record must be $IP; run setup again after that"; fi ;;
esac

# ── 6. restart and check ──
devil www restart "$DOMAIN" >/dev/null 2>&1 || true
# the first request starts the app (Passenger cold start): ask a few times
CODE=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  CODE=$(curl -s -m 60 -o "$TMPD/h.json" -w '%{http_code}' "https://$DOMAIN/api/health" 2>/dev/null || true)
  [ "$CODE" = "200" ] && break
done
say "health https://$DOMAIN/api/health → ${CODE:-none} $(head -c 300 "$TMPD/h.json" 2>/dev/null || true)"
CODE2=$(curl -s -m 60 -o /dev/null -w '%{http_code}' "https://$DOMAIN/payesh/pub/school-servers.json" 2>/dev/null || true)
say "list   https://$DOMAIN/payesh/pub/school-servers.json → ${CODE2:-none}"

# ── 7. what this box allows (reported, not assumed) ──
"$NODE" -e "const s=require('net').createServer();s.on('error',e=>{console.log('payesh-setup: CHECK loopback ports for hosted schools: FAIL '+e.code)});s.listen(0,'127.0.0.1',()=>{console.log('payesh-setup: CHECK loopback ports for hosted schools: ok');s.close()})" || true
ST=$(curl -s -m 20 -o /dev/null -w '%{http_code}' https://s3.ir-central1.arvanstorage.ir/ 2>/dev/null || true)
say "CHECK database storage reachable from here: ${ST:-none} (any 2xx/4xx = reachable)"
say "DNS: point app.payeshschool.ir (A record) to ${IP:-<see: devil vhost list public>}"
if [ "$CODE" = "200" ]; then say "PAYESH-SETUP-OK $VER $DOMAIN"; else say "PAYESH-SETUP-UNHEALTHY $VER $DOMAIN (see ~/domains/$DOMAIN/logs/error.log)"; exit 5; fi
