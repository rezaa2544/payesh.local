#!/bin/sh
# Row 173 — simulation-only CA + one server certificate for the HTTPS front (central.sim, s3.sim).
# Runs once in the «certs» service (node:22-bookworm has openssl); output stays in the certs volume.
set -eu
D=${CERT_DIR:-/certs}
[ -s "$D/front.crt" ] && [ -s "$D/ca.crt" ] && { echo "certs exist"; exit 0; }
mkdir -p "$D"; cd "$D"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Payesh Simulation CA (row 173, throw-away)" \
  -keyout ca.key -out ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=central.sim" -keyout front.key -out front.csr 2>/dev/null
printf 'subjectAltName=DNS:central.sim,DNS:s3.sim,DNS:pub.sim\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' > ext.cnf
openssl x509 -req -in front.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 -extfile ext.cnf -out front.crt 2>/dev/null
rm -f front.csr ext.cnf ca.srl ca.key
chmod 644 ca.crt front.crt front.key
echo "certs made"
