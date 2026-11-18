#!/bin/sh
# Starts as root only to give serverconfig/ to the app's user (PUID:PGID, default 1000:1000),
# then runs the app as that user. Started with --user, it just runs the app.
set -e

if [ "$(id -u)" = "0" ]; then
    PUID="${PUID:-1000}"
    PGID="${PGID:-1000}"
    mkdir -p /app/serverconfig
    chown -R "$PUID:$PGID" /app/serverconfig
    chmod 700 /app/serverconfig
    exec su-exec "$PUID:$PGID" node server.js
fi

exec node server.js
