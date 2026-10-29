# Litefin Pi 4 Appliance

A Raspberry Pi 4B that boots straight into [Litefin](litefin/) full-screen, hands off to mpv for 4K HEVC / 1080p H.264 direct-play, and is driven entirely by the TV remote (HDMI-CEC) or a Fire TV remote.

v1 targets a single Pi 4B for personal use. See [`docs/plan.md`](docs/plan.md) for the full brief and [`docs/tracking.md`](docs/tracking.md) for current status, decisions and open questions.

## Layout

- `litefin/` — upstream Litefin UI, as a submodule tracking its `release` branch. Untouched until Phase 2 (Linux platform adapter).
- `docs/plan.md` — the original project brief (static reference).
- `docs/tracking.md` — living milestone checklist, decisions log, and open questions.

## Status

Phase 0 (hardware & prerequisites) in progress. See `docs/tracking.md`.
