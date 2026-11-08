# Tracking

Living status doc. Update this as phases complete — `docs/plan.md` stays as the static reference.

## Milestone checklist

**Phase 0 (a few days)** — ✅ complete

- [x] Pi 4B, cooling, cable and SD/SSD ready
- [x] Intro Skipper, Litefin plugin and Seerr set up on the server
- [x] Test media library created

**Phase 1 (1–2 weeks)** — ✅ complete, see [`../phase1/`](../phase1/)

- [x] 4K HEVC HDR plays smoothly from Jellyfin — via **VLC**, not mpv (see decisions log)
- [x] Test matrix filled in for Path A and Path B (core rows — some lighter rows still open, not blocking)
- [x] Playback path chosen — **Path A**

**Phase 2 (2–4 weeks)** — started, not complete, see [`../phase2/`](../phase2/)

- [x] Litefin auto-starts full-screen on boot — confirmed surviving a cold reboot, no console screen visible
- [x] Browser chosen — **Chromium**
- [x] Linux adapter: keys, discovery — `LinuxAdapter.js` confirmed working (Home/Insert, arrows, Escape/Backspace-as-back, media keys). Power actions (exit/reboot/shutdown) still deferred to Phase 3's bridge daemon, as planned.
- [ ] Seerr request made from the TV

**Session notes (movi-player/Tauri spike):**

- Litefin already has a built-in `DesktopAdapter.js` (full keyboard nav, media keys, fullscreen, exit) and a Tauri v2 desktop build (`npm run package:linux`) — worth reusing rather than writing a Linux adapter from scratch, regardless of final browser/runtime choice.
- Litefin's upstream Linux releases are **x86_64 only** (CI builds on `ubuntu-latest`) — no ARM64 build exists, so Tauri had to be compiled natively on the Pi. First build: ~40 min (24 min `npm install`, 3 min webpack, 36.5 min `cargo`/Rust). Rebuilds after are faster (~3-6 min).
- Investigated `movi-player` (Litefin's desktop WASM/WebCodecs video engine, used by `MoviVideoPlayer.js`) as a possible alternative to the mpv/VLC-handoff architecture — **ruled out**: played 4K HEVC HDR10 at ~1fps, indicating it fell back to WASM/FFmpeg software decode rather than hardware WebCodecs decode on this Pi's WebKitGTK. Same failure class as mpv's software fallback from Phase 1.
- Also found during this spike: WebKitGTK audio backend (OpenAL Soft) failed to open the ALSA device outright (`File descriptor in bad state`) — a separate, unresolved issue from the decode speed problem.
- General UI navigation/browsing inside the Tauri window was also reported laggy, not just video playback — so Tauri/WebKitGTK is not yet a clear win for the kiosk-browser choice either. The original Cog vs. Chromium comparison is still open.
- `cage` (the compositor) appears to lack Wayland text-input protocol support that WebKitGTK needs for text fields — typing into a focused input crashed the app outright in one test (resolved once by itself when "discovery" stopped, cause unconfirmed — revisit if reusing Tauri/WebKitGTK later).
- **Conclusion: keep the Phase 1 VLC/bridge-daemon handoff architecture for playback** (proven, fast, reliable). Phase 2's actual kiosk-browser decision (Cog vs. Chromium vs. Tauri) still needs doing from a fresh start.

**Session notes (Cog vs. Chromium comparison):** resolved above as a browser decision. One important forward-looking note for Phase 3: `cage` defaults to the TV's native 4K mode, which is wrong for the Litefin UI (1080p, set via `wlr-randr`) but *right* for actual 4K video playback (VLC needs the content-matched mode, e.g. `--drm-mode=9` for 3840x2160@23.976Hz, per Phase 1). The bridge daemon will need to explicitly switch the compositor's output mode down to 1080p when returning to Litefin and back up to the content-matched mode when handing off to VLC — this isn't automatic, and hasn't been built yet.

**Session notes (Linux platform adapter, `litefin/src/linux/LinuxAdapter.js`):** Litefin already had a generic `WebAdapter.js` (arrow keys, Enter, Escape/Backspace-as-back, media keys, all via plain HTML5 APIs) that was already active in our kiosk by default — turned out less new code was needed than planned. Added `LinuxAdapter.js` as its own platform (detected via a custom Chromium `--user-agent` token, not Tauri markers) specifically so `isWeb` stays false for us — `isWeb`/`isDesktop` with WebCodecs support auto-selects `MoviVideoPlayer` for playback, which we already proved unusably slow on this hardware (see Tauri/movi-player spike notes above); staying off that path keeps Phase 2's HTML5 smoke test meaningful. Real adapter work was small: Home-key mapping (missing from `WebAdapter`) and Pi-specific device naming. **Found the plan's suggested "F1 for Home" doesn't work on Chromium** — F1 (and F3/F5/F6/F10/F11/F12) are hardcoded to Chromium's own browser actions and can't be suppressed by page JS, even in `--kiosk` mode (confirmed: F1 opened Chrome's help page instead of triggering Home). Switched to **Insert** instead — Phase 4's `keyd` remap table should target Insert, not F1, for the remote's Home button. Also found `--kiosk` disables in-page DevTools entirely (unlike the Tauri spike, which had devtools explicitly enabled) — `--remote-debugging-port` would be needed for future remote debugging if required.

**Session notes (debugging why `LinuxAdapter` never loaded — long trail, real root cause found):** After deploying the adapter, `platformInfo.platform` stayed `"web"` no matter what — `WebAdapter` kept initializing instead of `LinuxAdapter`, despite the UA token being correct everywhere we checked. Chased several false leads before finding the real cause:
- Chromium's `--kiosk` disables in-page DevTools entirely; used Litefin's own debug-log-upload feature (Settings → uploads to the Jellyfin server, not a third party) to get visibility instead, then `--remote-debugging-port=9222` for full remote DevTools over an SSH tunnel (`ssh -L 9222:127.0.0.1:9222 ...` — Chromium hardcodes its debug port to `127.0.0.1` only regardless of `--remote-debugging-address`, by design, and separately needs `--remote-allow-origins=*` or it refuses connections from the DevTools frontend's origin).
- `dist/web` builds to ~39+ `main-*.js` chunks (webpack `splitChunks.maxSize: 250000` slicing the bundle), which made it easy to check the wrong/stale chunk when grepping for our changes by hand — wasted real time here. `output.clean: true` already cleans the dir on every build, so manual `rm -rf` wasn't actually the fix; a stale `node_modules/.cache` (babel-loader) was serving old compiled output for some modules despite correct source — clearing it forced a genuinely fresh build.
- **Actual root cause, confirmed:** the `web` config's `splitChunks.maxSize` has no `runtimeChunk: 'single'`. Without one shared runtime across split chunks, a singleton module (`export const platformInfo = new PlatformInfo()`) can get duplicated into multiple independent instances across chunks — different parts of the app end up holding different copies with different state. Confirmed by building with the `debug` config (no `maxSize` issue there) — `LinuxAdapter` loaded correctly immediately. **Fix applied:** added `runtimeChunk: 'single'` to the `web` config in `webpack.config.cjs`. **Verified working** — `LinuxAdapter` loads correctly in the real `web` build now; Home key (Insert) navigates home as expected. The `desktop` config (Tauri) has the identical `maxSize` setting without `runtimeChunk` too; not touched, but worth keeping in mind if anything there ever shows similarly inconsistent singleton state.
- Also along the way: fixed a stale NFS export on the TrueNAS server (laptop's DHCP-assigned IP wasn't in the authorized hosts list — widened to the whole `192.168.4.0/24` subnet) and found `wtype`/cage interactions need `WAYLAND_DISPLAY` explicitly exported per-shell-session (it's not inherited automatically into every new SSH session).
- **Next session: redeploy `webpack.config.cjs`, rebuild `dist/web` clean (clear `node_modules/.cache` too, to be safe), restart `litefin-server`/`litefin-kiosk`, and verify `window.linuxAdapter` is defined** before continuing with the Home-key test and the rest of Phase 2's integration checklist.

**Session notes (kiosk auto-start, `phase2/`):** built and verified. One real gotcha hit and fixed: the default `getty@tty1.service` (console login prompt) competes with `litefin-kiosk.service` for the same VT (`TTYPath=/dev/tty1`) — both report "active" in systemd with no error, but on a cold boot `getty` wins and the console login screen stays visible instead of Litefin. Fix: `sudo systemctl mask getty@tty1.service` (now documented in `phase2/README.md` and declared via `Conflicts=` in the unit file). Confirmed working through a full cold reboot: no console screen, straight to Litefin at 1080p.

**Phase 3 (3–6 weeks)**

- [ ] Bridge daemon controls mpv from Litefin
- [ ] Resume points and watched status sync with Jellyfin
- [ ] Pi 4 device profile in place; no unexpected transcodes
- [ ] Skip-intro prompt and up-next working in mpv

**Phase 4 (1–2 weeks)**

- [ ] TV remote works over CEC
- [ ] Fire TV remote paired and reconnects after reboot
- [ ] TV wakes and switches input on boot

**Phase 5 (2–6 weeks)**

- [ ] Stripped, read-only Raspberry Pi OS image
- [ ] Quiet boot with splash, straight into Litefin
- [ ] Survives being unplugged mid-use

## Decisions log

| Decision | Status | Notes |
| --- | --- | --- |
| Repo name | Decided | `litefin-pi` |
| Litefin source | Decided | Submodule at `litefin/`, tracking upstream `release` branch (github.com/MoazSalem/litefin), currently v2.0.20 |
| Playback path: A, B or a mix | Decided | **Path A** — VLC inside `cage` (`cvlc --vout=wl_dmabuf --avcodec-hw=drm_avcodec`), coexisting with the kiosk compositor. Seamless transitions, no black-flash switching to/from Litefin. Both 4K HEVC HDR10 and 1080p H.264 play smoothly (brief sub-second judder on the HDR10 file at playback start only, from the compositor's fixed 30Hz mode vs. the file's 23.976fps — judged acceptable/imperceptible in practice). Path B also works but was passed over for its ~1s black-screen flash each time playback starts/stops. |
| Browser: Cog or Chromium | Decided | **Chromium.** Both were initially jerky, but turned out to be rendering/compositing at the TV's full 4096x2160 mode — `cage` defaults to the first/highest-resolution DRM mode, and the plan's own risk table predicted exactly this ("Browser UI too slow on the Pi 4 → Render at 1080p"). Forcing 1080p via `wlr-randr --output HDMI-A-1 --mode 1920x1080@60.000000Hz` fixed both, but Chromium felt noticeably smoother than Cog in the resulting head-to-head. RAM was ruled out as a factor (`free -h` showed 2.8Gi available, ~7MB swap used during testing). |
| OS base: Raspberry Pi OS or Buildroot | Pending | After Phase 5 |
| Native player: mpv or VLC | Decided | **VLC.** mpv's generic cross-platform hwaccel/VO code hit multiple unresolved issues on this Pi 4 (Vulkan hwdec-interop segfault, intermittent HEVC decoder stalls regardless of path/flags, broken audio under `cage`/Wayland) despite ruling out thermal/power throttling and test-session resource leakage as causes. VLC has a dedicated Raspberry Pi DRM/avcodec integration (`drm_vout`, `drm_avcodec`) and played both the 4K HEVC HDR10 file and the 1080p H.264 file that defeated mpv perfectly on the first real attempt. See `../phase1/test-matrix.md` for the full debugging trail. mpv is no longer the assumed Phase 3 player backend — plan language referring to mpv should be read as "the native player (VLC)" going forward. |
| 4K HEVC HDR10 direct-play on the Pi | Decided | **Direct-plays fine via VLC** (`--avcodec-hw=drm_avcodec`) — no need to lean on the server's RTX 4070 for this after all. TV has no HDR support, so HDR10 content displays as tone-mapped SDR; looked correct, not washed out. |

## Open questions

- [x] Which TV do you have, and is there an AV receiver or soundbar? — **Panasonic UHD TV, Sharp soundbar, no AV receiver. TV has no HDR support** (confirmed during Phase 1 testing) — HDR10 content displays as tone-mapped SDR, not a passthrough target.
- [x] Which Fire TV remote model is it? — **2020 Fire TV Stick remote (3rd-gen Alexa Voice Remote, Bluetooth).**
- [x] Do you need Live TV and the EPG, or just libraries? — **No Live TV.** Drops Live TV deinterlacing concerns from scope.
- [x] Ethernet or Wi-Fi at the TV? — **Pi 4B will use its own Wi-Fi**, not the TV's.
- [ ] Keep a private fork, or offer the Linux/Pi target back to Litefin? It is MPL-2.0, so modified Litefin files must stay MPL if the image is ever shared.

### Risk flag: Wi-Fi instead of Ethernet

The plan recommends Ethernet at the TV because Wi-Fi is "marginal for 4K remuxes." This project will run on the Pi's own Wi-Fi. Watch this closely in the Phase 1 test matrix (4K HEVC rows) — if streaming is unreliable, options are a USB Ethernet adapter at the TV or capping the Jellyfin device profile's transcode bitrate lower on Wi-Fi.

### No AV receiver

No AVR means TrueHD/DTS-HD MA passthrough isn't in play — the player decodes to PCM for the Sharp soundbar over HDMI/ARC instead. Not expected to be a blocker; the plan's TrueHD/DTS-HD MA test row only matters "with an AVR," so it's not applicable here. Note: audio output requires explicitly targeting the `vc4hdmi0` ALSA card (`plughw:CARD=vc4hdmi0,DEV=0`) — the default ALSA device does not route to the TV's HDMI port correctly.
