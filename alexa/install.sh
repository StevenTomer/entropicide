#!/bin/bash
# Install or update Entropicide's Alexa skill on this server (see docs/alexa.md): the skill's
# code at /opt/entropicide-alexa, run by systemd (entropicide-alexa.service) on
# 127.0.0.1:ALEXA_PORT, and https://SITE_HOST/entropicide-alexa forwarded to it by Apache.
# It talks to Entropicide on this machine directly. Usage: sudo ./alexa/install.sh
# (asks for the skill ID and key the first time; safe to re-run after changes).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/entropicide-alexa
ALEXA_PORT=5004
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
[ -f "$SRC/../deploy/site.conf" ] || { echo "Set up Entropicide first (deploy/site.conf)." >&2; exit 1; }
# shellcheck source=../deploy/site.conf.example
source "$SRC/../deploy/site.conf"
SITE_PATH="/${SITE_PATH#/}"; SITE_PATH="${SITE_PATH%/}"

echo "== Copying the skill to $DEST"
mkdir -p "$DEST"
rsync -a --delete --exclude venv --exclude .env --exclude __pycache__ --exclude install.sh "$SRC/" "$DEST/"
if [ ! -x "$DEST/venv/bin/python" ]; then
    python3 -m venv "$DEST/venv"
fi
"$DEST/venv/bin/pip" install -q -r "$DEST/requirements.txt"

if [ ! -f "$DEST/.env" ]; then
    echo
    echo "The skill ID is in the Alexa developer console, under the skill's name in the list"
    echo "(amzn1.ask.skill.…). The key: Entropicide → Settings → Add from other apps, with"
    echo "'Can also read my lists' and 'Can also complete tasks' ticked."
    read -rp "Skill ID: " skill_id
    read -rsp "Key (not shown): " key; echo
    [[ "$skill_id" == amzn1.ask.skill.* ]] || { echo "That isn't a skill ID (amzn1.ask.skill.…)." >&2; exit 1; }
    [ -n "$key" ] || { echo "No key." >&2; exit 1; }
    umask 077
    cat > "$DEST/.env" <<EOF
ALEXA_SKILL_ID=$skill_id
ENTROPICIDE_KEY=$key
ENTROPICIDE_SITE=http://127.0.0.1:$APP_PORT$SITE_PATH
EOF
fi
chown -R "$APP_USER:$APP_USER" "$DEST"
chmod 600 "$DEST/.env"

echo "== Installing the systemd service"
sed -e "s/^User=.*/User=$APP_USER/" -e "s/^Group=.*/Group=$APP_USER/" -e "s/127.0.0.1:5004/127.0.0.1:$ALEXA_PORT/" \
    "$SRC/entropicide-alexa.service" > /etc/systemd/system/entropicide-alexa.service
chmod 644 /etc/systemd/system/entropicide-alexa.service
systemctl daemon-reload
systemctl enable entropicide-alexa.service >/dev/null
systemctl restart entropicide-alexa.service

# Apache: /entropicide-alexa to the skill, in a marked block of its own (before Entropicide's,
# so a site served at "/" doesn't take it first). Entropicide's install.sh leaves it alone.
BLOCK="    # BEGIN Alexa skill for Entropicide (written by alexa/install.sh)
    ProxyPass /entropicide-alexa http://127.0.0.1:$ALEXA_PORT/
    ProxyPassReverse /entropicide-alexa http://127.0.0.1:$ALEXA_PORT/
    # END Alexa skill for Entropicide"
NEW_VHOST=$(BLOCK="$BLOCK" awk '
    /# BEGIN Alexa skill for Entropicide/ { skip = 1 }
    skip { if (/# END Alexa skill for Entropicide/) skip = 0; next }
    !done && (/# BEGIN Entropicide/ || /^[[:space:]]*SSLCertificateFile/) { print ENVIRON["BLOCK"]; done = 1 }
    { print }' "$APACHE_VHOST")
if [ "$NEW_VHOST" != "$(cat "$APACHE_VHOST")" ]; then
    echo "== Updating $APACHE_VHOST (backup: $APACHE_VHOST.bak-alexa)"
    cp -p "$APACHE_VHOST" "$APACHE_VHOST.bak-alexa"
    printf '%s\n' "$NEW_VHOST" > "$APACHE_VHOST"
    if ! apachectl configtest; then
        echo "Apache config test failed; restoring backup." >&2
        cp -p "$APACHE_VHOST.bak-alexa" "$APACHE_VHOST"
        exit 1
    fi
    systemctl reload httpd
fi

sleep 1
# A request that isn't from Amazon must be refused (400): that shows it's up, and checking.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' \
    "https://$SITE_HOST/entropicide-alexa" || true)
if [ "$code" = 400 ]; then
    echo "== Running. In the Alexa developer console, set the skill's endpoint to:"
    echo "   https://$SITE_HOST/entropicide-alexa"
else
    echo "The skill didn't answer as expected (HTTP $code); check: journalctl -u entropicide-alexa -n 50" >&2
    exit 1
fi
