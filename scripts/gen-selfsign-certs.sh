#!/usr/bin/env bash
# Generate self-signed certificates for QuestDock build signing.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
cd certs

# macOS: .p12 for electron-builder mac.cscLink
openssl req -x509 -newkey rsa:2048 -keyout keychain.key -out mac.p12 \
  -days 3650 -nodes -subj "/CN=QuestDock (self-signed dev)" 2>/dev/null
echo "mac.p12 ready (set mac.cscLink + mac.cscKeyPassword, or unidSIGN identity)"

# Windows: .pfx for electron-builder win.certificateFile
openssl req -x509 -newkey rsa:2048 -keyout win.pfx -out win.cer \
  -days 3650 -nodes -subj "/CN=QuestDock Dev" 2>/dev/null
echo "win.pfx ready (set win.certificateFile + win.certificatePassword)"
