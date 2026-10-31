# Phase 1: prove playback

Goal: decide whether a native player on the Pi 4B can direct-play 4K HEVC HDR10 and 1080p H.264 cleanly, and which of Path A or Path B to carry into later phases. See [`../docs/plan.md`](../docs/plan.md#phase-1-prove-playback) for the full context and [`test-matrix.md`](test-matrix.md) for results tracking.

**Outcome: both paths work, using VLC (not mpv — see `test-matrix.md` for why).** Path A was chosen for the project; see `../docs/tracking.md` decisions log.

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
sudo apt install -y vlc cage seatd
sudo systemctl enable --now seatd
sudo usermod -aG seat,video,render <user>
```

Log out and reconnect for the group membership to take effect — `cage` needs `seatd` (and the `seat`/`video`/`render` groups) to acquire the display when launched over SSH, since there's no logind-managed local session.

Also update the Pi's EEPROM/bootloader firmware if it hasn't been updated recently — older firmware can misreport hardware codec availability:

```
sudo rpi-eeprom-update -a
sudo reboot
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
- Use your Jellyfin server's **local LAN IP**, not a public domain — a public domain may hairpin through your WAN connection even on the local network, skewing throughput tests.

Export both in your SSH session (not written to any file in the repo):

```
export JELLYFIN_SERVER="http://<local-lan-ip>:8096"
export JELLYFIN_API_KEY="<your-api-key>"
```

## 5. Audio device

The Pi 4B has two independent HDMI audio devices (one per HDMI port). ALSA's default output does **not** reliably pick the connected one. Find the right card:

```
aplay -l
```

Look for `vc4hdmi0` (HDMI0, next to USB-C power — the port you're using). `run-test.sh` targets `plughw:CARD=vc4hdmi0,DEV=0` by default; adjust it if your card name differs. Use `plughw:`, not `hw:` — the raw `hw:` device rejects the default sample format outright.

## 6. Run a test

```
./run-test.sh path-a <item-id>
./run-test.sh path-b <item-id>
```

- **Path A** runs VLC inside `cage` (a Wayland kiosk compositor) — `--vout=wl_dmabuf --avcodec-hw=drm_avcodec`.
- **Path B** runs VLC directly against the display, no compositor — `--vout=drm_vout --avcodec-hw=drm_avcodec`.

Both use VLC's dedicated Raspberry Pi DRM/avcodec integration (`--avcodec-hw=drm_avcodec`), which handled every test file significantly better than mpv's generic cross-platform decode path — see `test-matrix.md` for the full debugging trail that led to this.

`Ctrl+C` to stop. Record what you saw (smooth or dropped frames, HDR flag on the TV, audio, subtitle rendering, refresh-rate judder) in [`test-matrix.md`](test-matrix.md) for each file, for both paths.

## 7. Exit criteria — met

4K HEVC HDR and 1080p H.264 play smoothly on both paths with VLC. **Path A chosen** (seamless Litefin/video transitions, no black-screen flash) — see `../docs/tracking.md`.
