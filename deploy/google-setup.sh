#!/bin/bash
# Store the Google OAuth client for Calendar sync in /opt/entropicide/.env and restart the app.
# Usage: sudo ./deploy/google-setup.sh      (see "Google Calendar" in README.md)
set -euo pipefail
ENV=/opt/entropicide/.env
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
[ -f "$ENV" ] || { echo "Run deploy/install.sh first." >&2; exit 1; }

read -rp "Google OAuth client ID: " id
read -rsp "Google OAuth client secret: " secret; echo
[[ "$id" =~ ^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$ ]] || { echo "That doesn't look like a client ID." >&2; exit 1; }
[[ "$secret" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "That doesn't look like a client secret." >&2; exit 1; }

sed -i '/^ENTROPICIDE_GOOGLE_CLIENT_\(ID\|SECRET\)=/d' "$ENV"
printf 'ENTROPICIDE_GOOGLE_CLIENT_ID=%s\nENTROPICIDE_GOOGLE_CLIENT_SECRET=%s\n' "$id" "$secret" >> "$ENV"
chmod 600 "$ENV"
systemctl restart entropicide.service
echo "Saved. Each user can now connect from Settings → Google Calendar."
