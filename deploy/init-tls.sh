#!/bin/sh
# Run as root on Unraid. Generate PKI locally; never mount the CA private key.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run this script as root.' >&2; exit 1; }
[ "$#" -eq 2 ] || { echo "Usage: sh $0 /absolute/private/base IPv4" >&2; exit 1; }
base=$1
ip=$2
case "$base" in /*) ;; *) echo 'Use an absolute path.' >&2; exit 1;; esac
printf '%s\n' "$ip" | awk -F. 'NF != 4 {exit 1} {for (i=1;i<=4;i++) if ($i !~ /^(0|[1-9][0-9]?[0-9]?)$/ || $i > 255) exit 1}'
umask 077
install -d -m 0700 "$base" "$base/ca" "$base/tls-direct"
tmp=$(mktemp -d "$base/.tls-new.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
if [ ! -e "$base/ca/root.key" ] && [ ! -e "$base/ca/root.crt" ]; then
  openssl req -new -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
    -subj "/CN=Fieldnote Local CA $ip" \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -keyout "$tmp/root.key" -out "$tmp/root.crt"
  install -m 0600 "$tmp/root.key" "$base/ca/root.key"
  install -m 0644 "$tmp/root.crt" "$base/ca/root.crt"
fi
[ -f "$base/ca/root.key" ] && [ -f "$base/ca/root.crt" ] || { echo 'CA files must both exist; restore the missing file.' >&2; exit 1; }
if [ -e "$base/tls-direct/server.key" ] || [ -e "$base/tls-direct/server.crt" ]; then
  if [ -f "$base/tls-direct/server.key" ] && [ -f "$base/tls-direct/server.crt" ] && \
     openssl x509 -checkend 2592000 -noout -in "$base/tls-direct/server.crt" >/dev/null 2>&1 && \
     openssl verify -CAfile "$base/ca/root.crt" -purpose sslserver -verify_ip "$ip" "$base/tls-direct/server.crt" >/dev/null 2>&1; then
    printf '%s\n' 'Existing TLS certificate is valid for at least 30 days; not replacing it.'
    exit 0
  fi
fi
cat > "$tmp/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$ip
EOF
openssl req -new -newkey rsa:2048 -nodes -sha256 -subj "/CN=$ip" \
  -keyout "$tmp/server.key" -out "$tmp/server.csr"
openssl x509 -req -in "$tmp/server.csr" -CA "$base/ca/root.crt" -CAkey "$base/ca/root.key" \
  -set_serial "0x$(openssl rand -hex 16)" -days 365 -sha256 -extfile "$tmp/server.ext" -out "$tmp/server.crt"
openssl verify -CAfile "$base/ca/root.crt" -purpose sslserver -verify_ip "$ip" "$tmp/server.crt"
install -o 1000 -g 1000 -m 0600 "$tmp/server.key" "$tmp/ready.key"
install -o 1000 -g 1000 -m 0644 "$tmp/server.crt" "$tmp/ready.crt"
install -o 1000 -g 1000 -m 0644 "$base/ca/root.crt" "$tmp/ready-ca.crt"
mv -f "$tmp/ready.key" "$base/tls-direct/server.key"
mv -f "$tmp/ready.crt" "$base/tls-direct/server.crt"
mv -f "$tmp/ready-ca.crt" "$base/tls-direct/ca.crt"
chown 1000:1000 "$base/tls-direct"
chmod 0700 "$base/tls-direct"
printf '%s\n' "Install only this public CA certificate on your devices: $base/tls-direct/ca.crt"
openssl x509 -in "$base/tls-direct/ca.crt" -noout -fingerprint -sha256
