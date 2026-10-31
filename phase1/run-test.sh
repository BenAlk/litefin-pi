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
ALSA_DEVICE="plughw:CARD=vc4hdmi0,DEV=0"

case "$PATH_MODE" in
  path-a)
    exec cage -- cvlc --vout=wl_dmabuf --avcodec-hw=drm_avcodec --aout=alsa --alsa-audio-device="$ALSA_DEVICE" --fullscreen "$STREAM_URL"
    ;;
  path-b)
    exec cvlc --vout=drm_vout --avcodec-hw=drm_avcodec --aout=alsa --alsa-audio-device="$ALSA_DEVICE" --fullscreen "$STREAM_URL"
    ;;
  *)
    echo "Usage: $0 <path-a|path-b> <jellyfin-item-id>" >&2
    exit 1
    ;;
esac
