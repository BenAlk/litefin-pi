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

**Phase 2 (2–4 weeks)**

- [ ] Litefin auto-starts full-screen on boot
- [ ] Browser chosen (Cog or Chromium)
- [ ] Linux adapter: keys, discovery, power actions
- [ ] Seerr request made from the TV

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
| Browser: Cog or Chromium | Pending | After Phase 2 |
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
