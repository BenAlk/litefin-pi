# Remote Input Bypass — Design

2026-11-12

## Context

This is a redesign of Phase 3's remote-control handling during VLC playback, triggered by real-hardware findings during Task 10 (end-to-end verification on the Pi). The original Phase 3 design (`docs/superpowers/specs/2026-11-09-phase3-bridge-daemon-design.md`) assumed `cage` would give VLC exclusive input focus during playback, with a VLC Lua interface script (`phase3/vlc-lua/intf/litefin.lua`) handling Back/Escape and the skip-intro confirmation via VLC's own key-press handling.

Real-hardware testing disproved this assumption. Debug instrumentation (a temporary log line inside the Lua script's main loop) confirmed `vlc.var.get(vlc.object.libvlc(), 'key-pressed')` never changes from its default value, no matter what's pressed on the remote — and VLC logs `main libvlc error: interface "globalhotkeys,none" initialization failed` on every launch. `globalhotkeys` is the VLC interface module responsible for populating that variable; under Wayland, there is no API for an arbitrary client to receive a system-wide keyboard grab the way X11 permitted. Follow-up testing confirmed this is total, not partial: *no* remote button (pause, seek, stop) does anything during VLC playback, not just Back/Home. This is an architectural dead end for the original design, not a Lua scripting bug — no restructuring of the Lua script's key-handling logic can fix it, since the underlying data source never receives real input regardless of script structure.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  bridge daemon (index.js)                                      │
│  ┌────────────────┐        ┌──────────────────────────────┐  │
│  │ remoteInput.js  │──keys─▶│ key→action dispatch (index.js)│  │
│  │ (reads evdev    │        │ - looks up "current session"  │  │
│  │  device, non-   │        │ - calls session.stop()/       │  │
│  │  exclusive)     │        │   pause()/resume()/seek()     │  │
│  └────────────────┘        └──────────────┬───────────────┘  │
│                                             │                  │
│                                    ┌────────▼────────┐         │
│                                    │ Session (Task 4) │         │
│                                    │ - already has     │         │
│                                    │   pause/resume/   │         │
│                                    │   seek/stop        │         │
│                                    │ - gains: is the    │         │
│                                    │   intro window     │         │
│                                    │   active right now? │        │
│                                    └────────┬────────┘         │
│                                             │ HTTP             │
└─────────────────────────────────────────────┼──────────────────┘
                                               ▼
                                     VLC (--extraintf=http,luaintf)
                                     litefin.lua: OSD display ONLY now
                                     (no key_pressed(), no playlist.stop())
```

Remote input is daemon-wide, not per-WebSocket-session: this is a single-client kiosk appliance with exactly one physical remote and, in practice, at most one active playback session at a time. `index.js` owns a single `RemoteInput` instance and a single "current session" reference, updated whenever `server.js` creates a new `Session`. Key events are dispatched against whatever that reference currently points to; with no active session, key events are simply ignored (Litefin's own UI continues handling its own navigation normally, via Chromium's independent, unaffected read of the same input device).

This sidesteps the Wayland input-routing problem entirely rather than attempting to fix or work around it: reading `/dev/input/eventN` directly is an OS-level file read, independent of whichever Wayland client the compositor currently considers focused.

## Device discovery

The keyd virtual keyboard's `/dev/input/eventN` number is not stable across reboots — it depends on enumeration order of whatever else is attached. `remoteInput.js` discovers the correct device at startup by reading `/proc/bus/input/devices` (a stable, plain-text format) and parsing for the device block whose `N: Name="..."` line matches `"keyd virtual keyboard"`, extracting the `eventN` number from that same block's `H: Handlers=` line. This matches how Phase 4's own setup README already describes finding this device manually (`cat /proc/bus/input/devices`, look for `"keyd virtual keyboard"`) — automated instead of manual.

If no matching device is found, `remoteInput.js` logs a clear warning and the daemon continues running without remote-input handling (see Error Handling below) — this must never block the daemon's core WebSocket/HTTP responsibilities.

## Event parsing

Linux's evdev format delivers events as a stream of fixed-size binary structs (`struct input_event`): a timestamp, then `type`, `code`, and `value`, each a fixed-width integer — 24 bytes per event on this 64-bit OS. This is parseable directly with Node's `fs.createReadStream` and `Buffer`, requiring no native addon — keeping the daemon's dependency footprint at just `ws`, as it is today.

Only `type === 1` (`EV_KEY`) events with `value === 1` (key *down*) are acted on; `value === 0` (release) and `value === 2` (autorepeat) are ignored, so a single physical press fires exactly one action.

Evdev devices support multiple independent readers by default — each open file descriptor receives its own independent copy of the event stream. The daemon reading this device does not interfere with Chromium's own independent read of the same device for Litefin's UI navigation, *as long as neither side calls the exclusive-grab ioctl (`EVIOCGRAB`)* — which this design does not use.

**Open risk, flagged explicitly**: the exact struct layout and the standard Linux key-code numbers (`KEY_ESC = 1`, `KEY_INSERT = 110`, `KEY_KPENTER = 96`, `KEY_PLAYPAUSE = 164`, `KEY_FASTFORWARD = 208`, `KEY_REWIND = 168`) are drawn from general knowledge of the stable Linux `input-event-codes.h` ABI, not verified against this specific kernel build. Consistent with every other hardware-dependent magic value in this project (VLC's HTTP JSON shape, the Lua scripting API, VLC's `--extraintf` flag-combination syntax — all of which needed real-hardware correction during this same build), this needs empirical verification once built: run the parser next to `evtest` on the real device and confirm parsed key codes match what's actually pressed, before trusting it for real control.

## Key mapping

Mapped actions, acted on only while a session is active:

| Remote button | keyd output | Action |
|---|---|---|
| Back | `KEY_ESC` | `session.stop()` |
| Home | `KEY_INSERT` | `session.stop()` (same as Back — see Explicitly Deferred below) |
| OK/Select | `KEY_KPENTER` | If the intro window is currently active (see Skip-Intro Redesign): seek past the intro. Otherwise: toggle pause/resume. |
| Play/Pause | `KEY_PLAYPAUSE` | Toggle pause/resume, using `session.getCurrentState().paused` (already tracked by `Session` from its own polling) to decide which to call |
| Fast-forward | `KEY_FASTFORWARD` | Seek forward a fixed +30s increment |
| Rewind | `KEY_REWIND` | Seek back a fixed −10s increment |

Unmapped keys (arrows, volume, menu) are ignored by `remoteInput.js`'s dispatch entirely — they either have no defined meaning during fullscreen video playback in this app, or are already handled elsewhere (volume via HDMI-CEC, outside this daemon's scope per the original Phase 3 design).

## Explicitly deferred (not in this pass)

- **Home vs. Back distinction.** Both currently just stop playback and let Litefin's existing `'ended'` event handling take over navigation — the same path that already fires when a video finishes naturally. This lands the user back wherever Litefin's own `'ended'` handling already goes (observed to behave like "back" in practice), not specifically the Home page. Making Home jump to the home route specifically would require a new, distinct event type forwarded through `VlcBridgePlayer.js` and new Litefin-side routing logic in `JellyfinPlayer.js` — real, but separate, future work.
- **Respecting the user's configured skip-forward/skip-back lengths.** Litefin has a user-facing setting for this (`skipForwardLength`/`skipBackLength` in `PlayerSettings`), but the bridge daemon has no existing path to read Litefin's settings. Fixed increments (+30s/−10s) are used for this pass.
- **Arrow keys during playback.** No defined semantic in this app for bare arrow presses during fullscreen video; left unhandled.

## Skip-intro redesign

`Session` already polls VLC's position every ~250ms (via `vlcHttpClient.getStatus()`) and already receives `introStartTicks`/`introEndTicks` via `setIntroSkipperTimestamps()` (added during the original Phase 3 build to support the Lua script's OSD prompt). It therefore already has everything needed to answer "is the intro window active right now" from its own internal state, without needing any signal from Lua. `Session` gains a small internal check — comparing its last-polled `time` against the stored intro bounds — that the OK-button dispatch calls directly before deciding whether to seek-past-intro or toggle pause/resume.

`litefin.lua` loses `key_pressed()` and its `vlc.playlist.stop()` call entirely. It keeps *only* its existing position-polling-and-OSD-message loop (unchanged), since drawing text over VLC's own video surface during playback is the one thing only VLC itself can do — Litefin's own UI is not visible/rendered while VLC owns the screen.

## Error handling

- **Device not found at startup**: log a warning, continue running without remote-input handling. The daemon's core responsibilities (WebSocket/HTTP control driven by Litefin's own commands) must never be blocked by this being unavailable — matches this project's established "a side-channel failing should never block playback" philosophy (the same reasoning already applied to `displayMode.js`'s non-rejecting `wlr-randr` calls).
- **Device read errors mid-stream** (e.g. device reset/unplugged): log, attempt one re-discovery-and-reopen; if that also fails, stop trying until the next daemon restart rather than retrying in a tight loop.
- **No active session when a key arrives**: silent no-op. This is the normal state whenever Litefin's own UI is on screen.
- **Session becomes inactive mid-dispatch** (e.g. Back arrives just as playback was already ending on its own): `Session.stop()` is already safe to call on a session mid-teardown — confirmed during the original Task 4 review, which found and fixed exactly this class of race (the orphaned-VLC-process fix).

## Testing

`remoteInput.js`'s evdev parsing is pure buffer arithmetic — fully unit-testable by feeding synthetic binary event buffers through a fake readable stream, no real device or elevated privileges needed. Device discovery is testable the same way, feeding a fake `/proc/bus/input/devices`-shaped string through the parser. The key→action dispatch logic (`index.js`'s wiring) is tested by injecting a fake "current session" object and asserting the correct method is called for each key code, with no active session resulting in no calls at all. None of this requires real hardware to verify — only the final "do these exact key codes match what the real device emits" step needs the real Pi, consistent with how every other hardware-dependent piece of this project was ultimately confirmed.

## Open questions / risks

- The evdev struct layout and standard key-code numbers are unverified against this specific kernel/hardware (see Event Parsing above) — expected to need empirical confirmation and possible correction during implementation, the same way VLC's HTTP JSON schema and Lua scripting API both needed correction earlier in this project.
- `Session`'s new "is the intro window active" check introduces a small new piece of logic not covered by the original Phase 3 design or its reviews — needs its own test coverage during implementation, not assumed correct by extension of existing polling logic.
