#!/bin/sh
# Starts as root only to give /config to the app's user (PUID:PGID, default 1000:1000),
# then runs the app as that user. Started with --user, it just runs the app.
set -e

if [ "$(id -u)" = "0" ]; then
    PUID="${PUID:-1000}"
    PGID="${PGID:-1000}"
    mkdir -p /config
    chown -R "$PUID:$PGID" /config
    chmod 700 /config
    exec su-exec "$PUID:$PGID" node server.js
fi

exec node server.js
