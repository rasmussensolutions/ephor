#!/bin/sh
set -eu
mkdir -p /data/backups
chown bun:bun /data /data/backups
chmod 700 /data/backups
if [ "$1" = bun ]; then
  shift
  exec gosu bun bun --no-install "$@"
fi
exec gosu bun "$@"
