#!/usr/bin/env bash
set -euo pipefail

# Force 1080p before Chromium starts, so the UI never renders at the TV's
# native 4K (cage defaults to the highest-resolution mode, which is far
# too heavy for compositing the browser UI - see docs/tracking.md).
wlr-randr --output HDMI-A-1 --mode 1920x1080@60.000000Hz

exec chromium \
  --kiosk \
  --ozone-platform=wayland \
  --no-first-run \
  --noerrdialogs \
  --disable-infobars \
  --disable-translate \
  --disable-features=TranslateUI \
  --disable-extensions \
  --check-for-update-interval=31536000 \
  http://127.0.0.1:8080
