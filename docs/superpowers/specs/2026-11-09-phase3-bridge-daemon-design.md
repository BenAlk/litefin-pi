# Phase 3: VLC Bridge Daemon — Design

2026-11-09

## Context

This covers the plan's Phase 3 ("mpv player backend and bridge" — see `docs/plan.md`), updated for the Phase 1 pivot from mpv to VLC. Litefin hands off completely to a native player during playback; this phase builds the bridge daemon that connects Litefin's UI to VLC, and the Litefin-side player backend that talks to that bridge.

Prerequisites already in place from earlier phases:
- **Phase 1**: VLC proven to direct-play 4K HEVC HDR10 and 1080p H.264 cleanly on this Pi, via `cvlc --vout=wl_dmabuf --avcodec-hw=drm_avcodec --aout=alsa --alsa-audio-device=plughw:CARD=vc4hdmi0,DEV=0`, running inside `cage` (**Path A**, chosen over Path B for seamless Litefin/video transitions).
- **Phase 2**: Chromium kiosk auto-starts on boot at 1080p (forced via `wlr-randr`, since `cage` defaults to the TV's native 4K, which is too heavy for UI compositing). `LinuxAdapter.js` handles keyboard/remote input, detected via a custom Chromium `--user-agent` token.
- **Phase 4**: Fire TV remote and HDMI-CEC both working, remapped via `keyd` to standard keys (`Escape`=Back, `Insert`=Home, media keys pass through).

Key architectural note: **VLC has no event-push mechanism** like mpv's `observe-property` over JSON IPC. Its control surfaces (HTTP interface, RC interface, D-Bus) are all request/response. The bridge polls VLC rather than receiving pushed events — this works fine because Litefin's own backend interface (see below) is itself primarily pull-based.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Chromium (kiosk, port 8080)                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Litefin                                                    │   │
│  │  JellyfinPlayer.js ──selects──> VlcBridgePlayer.js backend │   │
│  └───────────────────────────────────┼─────────────────────────┘   │
└──────────────────────────────────────┼─────────────────────────────┘
                                        │ WebSocket ws://127.0.0.1:8082
                                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  bridge daemon (Node.js, systemd service, always running)         │
│  - owns VLC's lifecycle (spawn on "load", kill on "stop"/end)      │
│  - sets display mode via wlr-randr before/after VLC runs           │
│  - polls VLC's HTTP interface (~250ms) for position/state/tracks   │
│  - translates Litefin commands -> VLC HTTP requests                │
│  - translates polled VLC state -> events pushed to Litefin         │
└──────────────────────────────────────┬─────────────────────────────┘
                                        │ HTTP 127.0.0.1:9191 (Basic Auth)
                                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  VLC (spawned per-playback inside `cage`, Path A)                  │
│  --extraintf http --http-password=<random, in-memory>              │
│  --http-host=127.0.0.1 --http-port=9191                            │
└─────────────────────────────────────────────────────────────────┘
```

VLC is **not** always running — the daemon spawns it fresh per "load" (matching Phase 1's proven flags exactly) and kills it on stop/end. The daemon itself is the always-running systemd service.

**Display mode switching**: Phase 1 already validated that Path A's minor per-file judder (fixed compositor mode vs. exact content fps, at playback start only) is acceptable. So the daemon doesn't need per-file resolution/fps detection — just a binary toggle: **1080p** (`wlr-randr`, Chromium/Litefin's UI mode) before/after VLC, **native 4K** (cage's default) while VLC runs.

## Bridge daemon

**VLC HTTP interface:**
- Daemon generates a random password in memory at its own startup (`crypto.randomBytes`), passes it to VLC via the spawn command, uses it for its own HTTP calls. No persistent secret storage.
- `--http-host=127.0.0.1 --http-port=9191` (9191 chosen to avoid `litefin-server`'s 8080 and anything else already in use).
- Status: `GET /requests/status.json` (Basic Auth, empty username) → `state`, `time`, `length`, track lists under `information.category`. Polled every ~250ms while a session is active.
- Commands via the same endpoint's query params: `command=pl_pause`, `command=seek&val=<secs>`, `command=audio_track&val=<id>`, `command=subtitle_track&val=<id>`, etc.
- Loading a new file spawns VLC fresh with the URL as an argument (matching Phase 1), rather than reusing a running instance — simpler lifecycle, and VLC isn't meant to stay running between plays.

**WebSocket protocol** (`ws://127.0.0.1:8082`), shaped to match what `JellyfinPlayer.js` already expects from a backend (see `HtmlVideoPlayer.js` as reference):

Commands (Litefin → daemon):
```
load { url, startPositionTicks, audioTrack, subtitleTrack, introSkipperTimestamps? }
pause
resume
seek { ticks }
setAudioTrack { index }
setSubtitleTrack { index }
stop
```

Events (daemon → Litefin), mapped onto the `onEvent({type, data})` shapes `HtmlVideoPlayer.js` already fires:
```
playbackstart
playing
pause
timeupdate { time }
ended
error { message }
loadedmetadata { duration, audioTracks, subtitleTracks }
upnext   (computed by the daemon from its own position/duration polling - see below)
```

## Litefin-side changes

1. **`src/player/core/VlcBridgePlayer.js`** — new backend class, same shape as `HtmlVideoPlayer.js`: constructor `{container, settings, onEvent}`, methods `play(options)`, `stop()`, `destroy()`, `getCurrentTime()`, `getDuration()`, `isPaused()`, `setSubtitleStreamIndex()`, etc. Internally opens the WebSocket, translates method calls to commands, caches the latest polled state so synchronous getters have something to return, forwards transitions through `onEvent`.

2. **`src/core/App.js` / `JellyfinPlayer.js` wiring** — add an explicit `if (platformInfo.isLinuxKiosk)` branch in the backend-selection logic, checked *before* the generic `isDesktop || isWeb` fallback that currently applies to us (confirmed in Phase 2 that this fallback would otherwise select `MoviVideoPlayer`/WebCodecs, which we already proved unusably slow on this hardware).

3. **`src/api/profiles/LinuxProfile.js`** — new device profile (same template as `WebProfile.js`) declaring VLC's actual tested capabilities instead of generic-browser ones: HEVC direct-play to 4K60, H.264 direct-play to 1080p (transcode above), AV1/VP9 transcode, MPEG-2/VC-1 direct-play (software), Dolby Vision 7/8 direct-play with HDR10 fallback (profile 5 transcodes), MKV/MP4/M4V/TS containers, AAC/MP3/FLAC/Opus/AC3/EAC3/DTS/TrueHD audio, SRT/ASS/PGS/VobSub subtitles never burned in. Wired into `src/api/DeviceProfile.js`'s `getActiveProfileModule()` alongside the Tizen/WebOS/Android checks.

## In-player controls

Important constraint: **`cage` gives VLC exclusive input focus during playback** — `LinuxAdapter.js`'s keydown handler won't fire while VLC is the active client. So:

- **Back/Escape must be handled VLC-side**, not by Litefin. A VLC Lua interface script intercepts Escape, stops playback; the bridge's process-exit detection handles the display-mode switch back and hands focus to Litefin.
- **Skip intro** needs the same VLC Lua interface script (it's the only thing visibly rendering during playback, so only VLC can draw an on-screen prompt). The bridge writes Intro Skipper timestamps to a small temp JSON file right before spawning VLC; the script reads it at startup, polls position, shows a prompt via `vlc.osd.message()` during the window, seeks past it on confirm.
- **Up Next needs no VLC script at all** — the bridge is already polling position/duration every ~250ms; it computes "near the end" from that alone and fires an `upnext` event straight to Litefin, matching the plan's own description.
- **Trickplay thumbnails** — explicitly optional for v1 per the plan; out of scope for this pass.

## Error handling

- VLC fails to start/crashes immediately → bridge detects child-process exit (especially within a short window of spawning) → fires `error` to Litefin, rather than leaving it waiting forever for `playing`.
- Bridge daemon itself restarts → `VlcBridgePlayer.js` handles WebSocket `close`/`error` with reconnect-with-backoff; surfaces an error only after repeated failures.
- VLC's HTTP interface not up yet → polling loop tolerates connection-refused during the startup window (retry/backoff), not fatal — this exact race showed up in Phase 1 testing already.
- `stop` arrives mid-load → bridge kills the VLC process cleanly regardless of its current state.
- `wlr-randr` display-mode switch fails → log it, don't block playback; better to play at the "wrong" resolution than fail outright (we've hit real `WAYLAND_DISPLAY` flakiness before).
- Orphaned VLC process on bridge restart → daemon checks for and cleans up any leftover VLC process before accepting a new `load`, so two instances never fight over the display.
- Resume/watched-status reporting needs no new mechanism — Litefin already polls `getCurrentTime()` itself today; as long as our getters return accurate data, this works via Litefin's existing reporting path.

## Exit criteria (from the plan)

Play, resume, and watched status round-trip correctly with Jellyfin; subtitles and audio tracks switch; intro skip works; Back returns cleanly to Litefin.

## Open questions / risks

- VLC's Lua interface scripting is less commonly used/documented than mpv's — the skip-intro script may need more iteration than estimated here.
- Whether VLC's default global hotkeys (e.g. Escape → exit fullscreen) need explicit overriding, or whether the Lua script's own key interception takes priority, needs confirming empirically once built.
- Device profile capabilities (`LinuxProfile.js`) are based on the plan's original table plus Phase 1 findings, but haven't been exhaustively re-verified against every codec/container combination - worth spot-checking against the Phase 1 test matrix once the profile is live.
