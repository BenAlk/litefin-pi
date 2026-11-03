# Phase 2: Litefin in a kiosk browser

Goal: Litefin's UI auto-starts full-screen on boot, fully navigable with a keyboard, before touching playback. See [`../docs/plan.md`](../docs/plan.md#phase-2-litefin-in-a-kiosk-browser) for the full context.

**Outcome so far:** Chromium chosen over Cog (both were jerky at the TV's native 4K; forcing 1080p fixed both, Chromium felt smoother) — see `../docs/tracking.md` decisions log. This directory sets up the auto-start kiosk service.

## 1. Build Litefin's web target

On the Pi (or wherever you keep a checkout — `~/litefin` was used during testing):

```
cd ~/litefin
npm run build:web
```

Rebuild and restart `litefin-server` (below) whenever Litefin's source changes.

## 2. Install the systemd services

Copy the wrapper script and both unit files to the Pi:

```
mkdir -p ~/kiosk
scp phase2/kiosk-wrapper.sh benalk@litefin-pi.local:~/kiosk/
scp phase2/litefin-server.service phase2/litefin-kiosk.service benalk@litefin-pi.local:/tmp/
```

On the Pi, mask the default console login on tty1 first — `litefin-kiosk` uses `TTYPath=/dev/tty1` to get a real display session, and the default `getty@tty1.service` will otherwise compete for the same VT and win on cold boot (confirmed by testing: both show "active" in systemd, but the plain login prompt stays visible instead of Litefin):

```
sudo systemctl disable --now getty@tty1.service
sudo systemctl mask getty@tty1.service
```

Then install the services:

```
chmod +x ~/kiosk/kiosk-wrapper.sh
sudo mv /tmp/litefin-server.service /tmp/litefin-kiosk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now litefin-server
sudo systemctl enable --now litefin-kiosk
```

## 3. Check it worked

```
systemctl status litefin-server --no-pager
systemctl status litefin-kiosk --no-pager
```

The TV should show Litefin full-screen at 1080p, no visible console/login screen. If `litefin-kiosk` fails to start, check `journalctl -u litefin-kiosk --no-pager -n 50`.

Reboot to confirm it survives a cold start:

```
sudo reboot
```

## 4. Still to do in Phase 2

- Linux platform adapter in Litefin (key mapping, Pi detection) — reuse patterns from `litefin/src/desktop/DesktopAdapter.js`
- Integration checklist: login/Quick Connect, library browsing, search, Seerr requests, intro-skip markers, MDBList ratings, theme settings
- HTML5 player smoke test (expected to struggle with HEVC — just proves the flow reaches the player; VLC handoff is Phase 3)

## Exit criteria

Whole UI usable with a keyboard, navigation smooth at 1080p, a Seerr request goes through.
