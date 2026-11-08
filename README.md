# Litefin Pi 4 Appliance

A Raspberry Pi 4B that boots straight into [Litefin](litefin/) full-screen, hands off to VLC for 4K HEVC / 1080p H.264 direct-play, and is driven entirely by the TV remote (HDMI-CEC) or a Fire TV remote.

v1 targets a single Pi 4B for personal use. See [`docs/plan.md`](docs/plan.md) for the full brief and [`docs/tracking.md`](docs/tracking.md) for current status, decisions and open questions.

## Layout

- `litefin/` — upstream Litefin UI, as a submodule tracking its `release` branch. Now carries Pi-specific changes: `src/linux/LinuxAdapter.js` and small edits to `PlatformInfo.js`, `App.js`, and `webpack.config.cjs` (see `docs/tracking.md`).
- `docs/plan.md` — the original project brief (static reference).
- `docs/tracking.md` — living milestone checklist, decisions log, and open questions.
- `phase1/` — Pi setup instructions, the VLC test-path script, and the test matrix for Phase 1 (prove playback).
- `phase2/` — kiosk auto-start setup (systemd services, wrapper script, Linux platform adapter) for Phase 2 (Litefin in a kiosk browser).
- `phase4/` — Fire TV remote pairing and `keyd` remap config for Phase 4 (input). Reordered ahead of Phase 3.

## Status

Phase 0, Phase 1, and Phase 2 complete. Phase 4's Fire TV remote working (HDMI-CEC not yet started); Phase 3 (bridge daemon) up next. See `docs/tracking.md`.
