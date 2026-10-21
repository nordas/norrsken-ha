#!/bin/sh
# Settings, lists and history live in /data, which Home Assistant keeps between updates and backups.
PIN="$(jq -r '.setup_pin // empty' /data/options.json 2>/dev/null)"
export DATA_DIR=/data PORT=8787
[ -n "$PIN" ] && export SETUP_PIN="$PIN"
exec node /app/server.js
