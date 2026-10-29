#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <path-a|path-b> <jellyfin-item-id>" >&2
  exit 1
fi

PATH_MODE="$1"
ITEM_ID="$2"

: "${JELLYFIN_SERVER:?Set JELLYFIN_SERVER, e.g. http://192.168.1.50:8096}"
: "${JELLYFIN_API_KEY:?Set JELLYFIN_API_KEY}"

STREAM_URL="${JELLYFIN_SERVER}/Videos/${ITEM_ID}/stream?static=true&api_key=${JELLYFIN_API_KEY}"

case "$PATH_MODE" in
  path-a)
    exec cage -- mpv --vo=dmabuf-wayland --hwdec=drm --fullscreen "$STREAM_URL"
    ;;
  path-b)
    exec mpv --vo=drm --hwdec=drm --fullscreen "$STREAM_URL"
    ;;
  *)
    echo "Usage: $0 <path-a|path-b> <jellyfin-item-id>" >&2
    exit 1
    ;;
esac
