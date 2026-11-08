# Phase 2: Litefin in a kiosk browser

Goal: Litefin's UI auto-starts full-screen on boot, fully navigable with a keyboard, before touching playback. See [`../docs/plan.md`](../docs/plan.md#phase-2-litefin-in-a-kiosk-browser) for the full context.

**Outcome: Phase 2 complete.** Chromium chosen over Cog (both were jerky at the TV's native 4K; forcing 1080p fixed both, Chromium felt smoother). Kiosk auto-starts on boot, `LinuxAdapter.js` handles keyboard/Home navigation, and a Seerr request from the TV works end to end. See `../docs/tracking.md` decisions log and session notes for the full trail (including a webpack `runtimeChunk` bug that blocked the adapter for a while).

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

## 4. The Linux platform adapter

`litefin/src/linux/LinuxAdapter.js` handles key mapping (arrows, Enter, Escape/Backspace-as-back, Home via Insert, media keys) and Pi-specific device identification. Detected via a custom Chromium `--user-agent` token, not Tauri markers — see `PlatformInfo.js`. Exit/reboot/shutdown actions are still deferred to Phase 3's bridge daemon, as planned.

If you rebuild Litefin and the adapter mysteriously stops working (platform detection reverting to generic "web"), check `webpack.config.cjs`'s `web` target has `optimization.runtimeChunk: 'single'` — without it, `splitChunks.maxSize` can duplicate singleton modules like `platformInfo` across chunks. See `../docs/tracking.md` for the full debugging trail.

## Exit criteria — met

Whole UI usable with a keyboard, navigation smooth at 1080p, and a Seerr request goes through — all confirmed.

Not yet spot-checked but not blocking: login/Quick Connect, library browsing, search, intro-skip markers, MDBList ratings, theme settings, and the HTML5 player smoke test (expected to struggle with HEVC — just proves the flow reaches the player; VLC handoff is Phase 3).
