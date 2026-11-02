#!/bin/bash
# Install or update Entropicide at /opt/entropicide on a server with Apache and systemd, and
# serve it where deploy/site.conf says. Usage: sudo ./deploy/install.sh   (safe to re-run
# after every change). For other setups, see "Running it" in README.md (Docker).
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/entropicide
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
[ -f "$SRC/deploy/site.conf" ] || {
    echo "Copy deploy/site.conf.example to deploy/site.conf and fill it in first." >&2; exit 1; }
# shellcheck source=site.conf.example
source "$SRC/deploy/site.conf"
for key in SITE_HOST SITE_PATH APP_PORT APP_USER APACHE_VHOST; do
    [ -n "${!key:-}" ] || { echo "deploy/site.conf needs $key (see site.conf.example)." >&2; exit 1; }
done
SITE_PATH="/${SITE_PATH#/}"; SITE_PATH="${SITE_PATH%/}"  # "/todo", or "" for the whole site
URL="https://$SITE_HOST$SITE_PATH/"
VHOST=$APACHE_VHOST

# An install from before the rename (Todo: /opt/todo, todo.service, todo.db, TODO_ settings)
# moves over once, after a backup; its data, settings and backups come along.
OLD=/opt/todo
if [ -d "$OLD" ] && [ ! -e "$DEST" ]; then
    echo "== Moving the Todo install at $OLD to $DEST"
    systemctl disable --now todo-backup.timer todo.service >/dev/null 2>&1 || true
    if [ -f "$OLD/data/todo.db" ]; then
        echo "   Backing it up first (into $OLD/backups, which moves too)"
        (set -a; source "$OLD/.env"; set +a; cd "$OLD"
         runuser -u "$APP_USER" -- "$OLD/venv/bin/python" manage.py backup)
    fi
    mv "$OLD" "$DEST"
    for ext in "" -wal -shm; do
        if [ -e "$DEST/data/todo.db$ext" ]; then mv "$DEST/data/todo.db$ext" "$DEST/data/entropicide.db$ext"; fi
    done
    sed -i -e 's/^TODO_/ENTROPICIDE_/' -e "s|$OLD/|$DEST/|g" -e 's|/data/todo\.db$|/data/entropicide.db|' "$DEST/.env"
    rm -rf "$DEST/venv"  # (its scripts name the old folder; it's made again below)
    rm -f /etc/systemd/system/todo.service /etc/systemd/system/todo-backup.service \
        /etc/systemd/system/todo-backup.timer
    systemctl daemon-reload
fi

echo "== Copying the app to $DEST"
mkdir -p "$DEST/data" "$DEST/backups"
# (Development-only files stay behind: the tests, CI settings and the ideas backlog; and the
# Alexa skill, which alexa/install.sh installs on its own.)
rsync -a --delete --exclude venv --exclude data --exclude backups --exclude .env \
    --exclude __pycache__ --exclude .git --exclude android --exclude tests \
    --exclude .pytest_cache --exclude .github --exclude IDEAS.md --exclude alexa "$SRC/" "$DEST/"

if [ ! -x "$DEST/venv/bin/python" ]; then
    echo "== Creating virtualenv"
    python3 -m venv "$DEST/venv"
fi
"$DEST/venv/bin/pip" install -q -r "$DEST/requirements.txt"

if [ ! -f "$DEST/.env" ]; then
    echo "== Generating $DEST/.env"
    cat > "$DEST/.env" <<EOF
ENTROPICIDE_SECRET_KEY=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
ENTROPICIDE_DATABASE=$DEST/data/entropicide.db
EOF
fi
# Where it's served, for the service (see entropicide.service) and the app.
set_env() {
    if grep -q "^$1=" "$DEST/.env"; then sed -i "s|^$1=.*|$1=$2|" "$DEST/.env"; else echo "$1=$2" >> "$DEST/.env"; fi
}
set_env SCRIPT_NAME "$SITE_PATH"
set_env APP_PORT "$APP_PORT"
set_env ENTROPICIDE_PUBLIC_URL "$URL"
chown -R "$APP_USER:$APP_USER" "$DEST"
chmod 600 "$DEST/.env"
chmod 700 "$DEST/data" "$DEST/backups"

# The systemd units, run as site.conf's APP_USER.
install_unit() {
    sed -e "s/^User=.*/User=$APP_USER/" -e "s/^Group=.*/Group=$APP_USER/" "$SRC/deploy/$1" > "/etc/systemd/system/$1"
    chmod 644 "/etc/systemd/system/$1"
}
echo "== Installing the systemd service"
install_unit entropicide.service
systemctl daemon-reload
systemctl enable entropicide.service >/dev/null
systemctl restart entropicide.service

echo "== Installing nightly backups (entropicide-backup.timer)"
install_unit entropicide-backup.service
install_unit entropicide-backup.timer
systemctl daemon-reload
systemctl enable --now entropicide-backup.timer >/dev/null
if [ -z "$(ls -A "$DEST/backups")" ]; then
    echo "== Making the first backup"
    systemctl start entropicide-backup.service
fi

# Apache: forward SITE_PATH (and the Android app's link file) to the app, in a marked block
# that's rewritten whenever site.conf changes. (Older installs had the same lines unmarked.)
TARGET="http://127.0.0.1:$APP_PORT${SITE_PATH:-/}"
BLOCK="    # BEGIN Entropicide (written by deploy/install.sh from deploy/site.conf)
    RequestHeader set X-Forwarded-Proto \"https\"
    ProxyPass /.well-known/assetlinks.json http://127.0.0.1:$APP_PORT$SITE_PATH/assetlinks.json
    ProxyPass ${SITE_PATH:-/} $TARGET
    ProxyPassReverse ${SITE_PATH:-/} $TARGET
    # END Entropicide"
NEW_VHOST=$(BLOCK="$BLOCK" awk '
    /# BEGIN Entropicide/ { skip = 1 }
    skip { if (/# END Entropicide/) skip = 0; next }
    /^[[:space:]]*# Todo app \(\/opt\/todo\)/ { old = 1; next }
    old && /^[[:space:]]*RequestHeader set X-Forwarded-Proto/ { next }
    /^[[:space:]]*ProxyPass(Reverse)? \/todo / || /^[[:space:]]*ProxyPass \/\.well-known\/assetlinks\.json / { next }
    { old = 0 }
    !done && /^[[:space:]]*SSLCertificateFile/ { print ENVIRON["BLOCK"]; done = 1 }
    { print }' "$VHOST")
if [ "$NEW_VHOST" != "$(cat "$VHOST")" ]; then
    echo "== Serving $URL: updating $VHOST (backup: $VHOST.bak-entropicide)"
    cp -p "$VHOST" "$VHOST.bak-entropicide"
    printf '%s\n' "$NEW_VHOST" > "$VHOST"
    if ! apachectl configtest; then
        echo "Apache config test failed; restoring backup." >&2
        cp -p "$VHOST.bak-entropicide" "$VHOST"
        exit 1
    fi
    systemctl reload httpd
fi

sleep 1
if curl -fsS -o /dev/null "http://127.0.0.1:$APP_PORT$SITE_PATH/login"; then
    echo "== Running. Open $URL"
else
    echo "Service didn't answer; check: journalctl -u entropicide -n 50" >&2
    exit 1
fi

if [ -z "$(runuser -u "$APP_USER" -- "$DEST/venv/bin/python" "$DEST/manage.py" list-users)" ]; then
    echo
    echo "No users yet. Create your admin account with:"
    echo "  sudo -u $APP_USER $DEST/venv/bin/python $DEST/manage.py create-user ${SUDO_USER:-you} --admin"
fi
