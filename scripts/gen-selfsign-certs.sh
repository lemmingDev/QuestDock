#!/usr/bin/env bash
# Generate self-signed certificates for QuestDock build signing.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
cd certs

for platform in mac win; do
  openssl req -x509 -newkey rsa:2048 -keyout "$platform.key" -out "$platform.cer" \
    -days 365 -nodes -subj "/CN=QuestDock Dev" \
    -addext "extendedKeyUsage=codeSigning" -addext "keyUsage=digitalSignature"
  openssl pkcs12 -export -legacy -in "$platform.cer" -inkey "$platform.key" \
    -out "$platform.p12" -passout pass:questdock-dev
done
echo "Development certificates generated in certs/ (password: questdock-dev)."
