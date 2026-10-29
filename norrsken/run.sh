#!/bin/sh
# Settings, lists and history live in /data, which Home Assistant keeps between updates and backups.
PIN="$(jq -r '.setup_pin // empty' /data/options.json 2>/dev/null)"
export DATA_DIR=/data PORT=8787 NSK_SECRETS_FILE=/homeassistant/secrets.yaml
[ -n "$PIN" ] && export SETUP_PIN="$PIN"
# Pause buffer, match recordings and downloads can live on a network disk (e.g. the AirPort's): "airport" = /media/airport
STORAGE="$(jq -r '.storage_dir // empty' /data/options.json 2>/dev/null)"
if [ -n "$STORAGE" ]; then
  case "$STORAGE" in /*) ;; *) STORAGE="/media/$STORAGE" ;; esac
  export NSK_STORAGE_DIR="$STORAGE"
fi
# TV-guide times that are an hour (or more) off at the provider: shift them by this many minutes
EPGOFF="$(jq -r '.epg_offset // empty' /data/options.json 2>/dev/null)"
[ -n "$EPGOFF" ] && export NSK_EPG_OFFSET_MIN="$EPGOFF"
# Ask the Supervisor for the host's real LAN address so the app shows a URL the TV and phone can reach.
if [ -n "$SUPERVISOR_TOKEN" ]; then
  IP="$(curl -fsS -m 5 -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/network/info 2>/dev/null \
    | jq -r '[.data.interfaces[] | select(.primary == true) | .ipv4.address[0]][0] // empty' | cut -d/ -f1)"
  [ -n "$IP" ] && export PUBLIC_URL="http://$IP:8787"
fi
exec node /app/server.js
