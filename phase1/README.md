# Phase 1: prove playback

Goal: decide whether mpv on the Pi 4B can direct-play 4K HEVC HDR10 and 1080p H.264 cleanly, and which of Path A or Path B to carry into later phases. See [`../docs/plan.md`](../docs/plan.md#phase-1-prove-playback) for the full context and [`test-matrix.md`](test-matrix.md) for results tracking.

## 1. Flash the SD card / SSD

Using Raspberry Pi Imager:

- OS: **Raspberry Pi OS Lite (64-bit)**
- In the advanced options (gear icon / Ctrl+Shift+X):
  - Set hostname, e.g. `litefin-pi`
  - Enable SSH, **public-key authentication** (use or generate an SSH key on your machine — don't use password auth)
  - Configure your Wi-Fi SSID and password (entered directly in the Imager; never stored in this repo)
  - Set locale/timezone as you prefer

Boot the Pi with the TV as its display (micro-HDMI into HDMI0, the port next to USB-C power).

## 2. First boot, over SSH

```
ssh <user>@litefin-pi.local
sudo apt update
sudo apt install -y mpv cage
```

## 3. Pi config

Edit `/boot/firmware/config.txt` and add:

```
dtoverlay=vc4-kms-v3d,cma-512
```

The `cma-512` bump gives 4K decode a bigger video memory pool — add it now rather than waiting for a buffer-allocation failure. Only add this line if you actually need 4K at 50/60 Hz (check your test files first):

```
hdmi_enable_4kp60=1
```

Reboot after editing:

```
sudo reboot
```

## 4. Jellyfin API key and item IDs

- API key: Jellyfin admin dashboard → **Advanced → API Keys** → create one for this testing.
- Item ID: open the item in Jellyfin's web UI → it's the `id=` value in the URL, or use the three-dot menu if your version exposes it directly.

Export both in your SSH session (not written to any file in the repo):

```
export JELLYFIN_SERVER="http://<server-ip>:8096"
export JELLYFIN_API_KEY="<your-api-key>"
```

## 5. Run a test

```
./run-test.sh path-a <item-id>
./run-test.sh path-b <item-id>
```

- **Path A** runs mpv inside `cage` (a Wayland kiosk compositor) — `--vo=dmabuf-wayland --hwdec=drm`.
- **Path B** runs mpv directly against the display, no compositor — `--vo=drm --hwdec=drm`.

Quit mpv with `q`. Record what you saw (smooth or dropped frames, HDR flag on the TV, audio passthrough, subtitle rendering, refresh-rate switch) in [`test-matrix.md`](test-matrix.md) for each file, for both paths.

## 6. Exit criteria

4K HEVC HDR and 1080p H.264 play smoothly on at least one path, and you've picked Path A, Path B, or a mix (e.g. A for SDR, B for HDR) — record the decision in `../docs/tracking.md`.
