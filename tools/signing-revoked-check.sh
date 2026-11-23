#!/usr/bin/env bash
# Row 61 — refuse any Android signing keystore whose certificate is on the revoked list.
# usage: tools/signing-revoked-check.sh <keystore.p12> <NAME_OF_ENV_VAR_HOLDING_THE_STORE_PASSWORD>
# The password is read from the named environment variable (never from argv) and nothing secret is printed.
# Exit 0 = no revoked certificate in the store; 1 = revoked certificate found; 2 = usage/read error.
set -euo pipefail
KS="${1:-}"; PASSVAR="${2:-}"
LIST="${PAYESH_REVOKED_CERTS_FILE:-$(cd "$(dirname "$0")/.." && pwd)/docs/cloud/revoked-signing-certs.json}"
if [ -z "$KS" ] || [ -z "$PASSVAR" ] || [ ! -s "$KS" ]; then echo "SIGNING-REVOKED-USAGE: keystore missing or empty" >&2; exit 2; fi
if [ -z "${!PASSVAR:-}" ]; then echo "SIGNING-REVOKED-USAGE: \$$PASSVAR is empty" >&2; exit 2; fi
export SR_PASS="${!PASSVAR}"
PEM=$(openssl pkcs12 -in "$KS" -passin env:SR_PASS -nokeys 2>/dev/null || openssl pkcs12 -legacy -in "$KS" -passin env:SR_PASS -nokeys 2>/dev/null || true)
unset SR_PASS
if ! printf '%s' "$PEM" | grep -q 'BEGIN CERTIFICATE'; then echo "SIGNING-REVOKED-ERROR: no certificate could be read from the keystore" >&2; exit 2; fi
FPS=""
while IFS= read -r block; do
  [ -z "$block" ] && continue
  fp=$(printf '%b' "$block" | openssl x509 -noout -fingerprint -sha256 2>/dev/null | sed 's/.*=//; s/://g' | tr 'a-f' 'A-F')
  [ -n "$fp" ] && FPS="$FPS $fp"
done < <(printf '%s\n' "$PEM" | awk '/BEGIN CERTIFICATE/{c=""} {c=c $0 "\\n"} /END CERTIFICATE/{print c}')
REVOKED=$(grep -oE '"sha256"[[:space:]]*:[[:space:]]*"[0-9A-Fa-f]{64}"' "$LIST" | grep -oE '[0-9A-Fa-f]{64}' | tr 'a-f' 'A-F')
for fp in $FPS; do
  if printf '%s\n' "$REVOKED" | grep -qx "$fp"; then
    echo "::error::SIGNING-REVOKED: this keystore holds a revoked (leaked) signing certificate sha256=$fp — refusing to sign (row 61)"
    exit 1
  fi
done
echo "SIGNING-REVOKED-OK certs=$(echo $FPS | wc -w) revoked_list=$(printf '%s\n' "$REVOKED" | grep -c . || true)"
