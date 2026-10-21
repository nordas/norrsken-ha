#!/bin/sh
# Settings, lists and history live in /data, which Home Assistant keeps between updates and backups.
PIN="$(jq -r '.setup_pin // empty' /data/options.json 2>/dev/null)"
export DATA_DIR=/data PORT=8787
[ -n "$PIN" ] && export SETUP_PIN="$PIN"
# Ask the Supervisor for the host's real LAN address so the app shows a URL the TV and phone can reach.
if [ -n "$SUPERVISOR_TOKEN" ]; then
  IP="$(curl -fsS -m 5 -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/network/info 2>/dev/null \
    | jq -r '[.data.interfaces[] | select(.primary == true) | .ipv4.address[0]][0] // empty' | cut -d/ -f1)"
  [ -n "$IP" ] && export PUBLIC_URL="http://$IP:8787"
fi
exec node /app/server.js
