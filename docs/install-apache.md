# Installing without Docker (Apache and systemd)

`deploy/install.sh` installs Entropicide on a Linux server that already runs Apache with an
HTTPS site (Fedora and RHEL lay it out as below; adjust the paths in `site.conf` for others).

```sh
cp deploy/site.conf.example deploy/site.conf    # then fill it in
sudo ./deploy/install.sh                         # safe to re-run after every change
```

It:

- copies the app to `/opt/entropicide`, which keeps its own `venv/`, `.env` (the secret key and
  other settings), `data/entropicide.db` and `backups/`;
- (re)starts `entropicide.service` (gunicorn on `127.0.0.1:APP_PORT`, run as `APP_USER`);
- installs `entropicide-backup.timer`, a nightly backup at about 03:30 (or at the next boot if
  the machine was off);
- keeps a marked *Entropicide* block in the Apache site (`APACHE_VHOST`) that forwards
  `SITE_PATH` (and the Android app's `/.well-known/assetlinks.json`) to the app, rewritten when
  `site.conf` changes. Apache's config is tested first, and put back if the test fails.

An install from before the app was renamed (`/opt/todo`, `todo.service`, `todo.db`) is moved
over the first time, after a backup.

Settings (see the README's table) go in `/opt/entropicide/.env`; `install.sh` keeps
`SCRIPT_NAME`, `APP_PORT` and `ENTROPICIDE_PUBLIC_URL` in step with `site.conf`. For Google
Calendar, `sudo ./deploy/google-setup.sh` asks for the client ID and secret.

## Moving it

Edit `SITE_HOST` / `SITE_PATH` / `APP_PORT` in `deploy/site.conf` and run `sudo ./deploy/install.sh`:
it moves Apache's forwarding and tells the app its new address. Then rebuild the Android app
(its address is built in) and deploy again, and add the new `…/google/callback` address to the
Google OAuth client.

## Day to day

```sh
M="sudo -u apache /opt/entropicide/venv/bin/python /opt/entropicide/manage.py"
$M list-users
$M create-user NAME [--admin]
$M set-password NAME
$M list-backups

systemctl list-timers entropicide-backup.timer
sudo systemctl start entropicide-backup.service      # back up now
journalctl -u entropicide -n 50                      # the app's log
journalctl -u entropicide-backup -n 20

sudo systemctl stop entropicide                      # restore a backup
$M restore /opt/entropicide/backups/entropicide-2026-10-28.db.gz
sudo systemctl start entropicide
```

The backups are on the same disk as the app: keep copies elsewhere too (Settings → Backups →
*Download a full backup now*, or set `ENTROPICIDE_BACKUP_DIR` to a mounted network share).
