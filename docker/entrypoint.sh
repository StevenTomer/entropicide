#!/bin/sh
# Makes sure the app's account owns /data (Docker creates a mounted folder as root), then runs
# the command as that account rather than root.
set -e
if [ "$(id -u)" = 0 ]; then
    mkdir -p /data
    chown -R entropicide:entropicide /data
    exec setpriv --reuid=entropicide --regid=entropicide --init-groups "$@"
fi
exec "$@"
