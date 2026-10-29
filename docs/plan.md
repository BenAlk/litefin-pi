# Litefin Pi 4 Appliance Plan

Oct 29, 2026 · @Ben Alkureishi

## Goal and scope

v1 is a Raspberry Pi 4B that boots straight into Litefin, direct-plays 4K HEVC and 1080p H.264 through mpv, and is driven by the TV remote (HDMI-CEC) or a Fire TV remote. It is for personal use on one device, so polish for other hardware comes later.

**In v1**

- Litefin's existing UI running full-screen in a kiosk browser
- A new mpv playback backend, with mpv handling decode, subtitles and the in-player controls
- Seerr requests, intro skipping, ratings and trickplay, all through the server plugins Litefin already uses
- HDMI-CEC and Fire TV remote input, remapped to the keys Litefin expects
- Auto-start on boot, a read-only system, TV power-on and input switching

**Out of v1**

- Any hardware other than the Pi 4B
- Dolby Vision (falls back to the HDR10 layer or a server transcode)
- Voice search on the Fire TV remote
- Litefin's own player overlay floating over mpv video (mpv's overlay and scripts replace it in v1)
- Live TV deinterlacing on the Pi (the server does it if Live TV is used)

**Key v1 decision:** during playback, Litefin hands off completely to mpv. Everything outside playback stays in Litefin.

## Architecture

Litefin keeps doing everything it already does. You add three things: a small Linux adapter inside Litefin, a bridge to mpv, and a key-remapping layer.

&#91;embedded content: Pi 4B appliance architecture · Litefin, bridge, mpv, server plugins\]

Remote keys reach Litefin, Litefin asks the bridge to play, and mpv pulls the stream straight from Jellyfin. Seerr requests go through the Litefin server plugin, so the Pi never holds the Seerr API key.

## Phase 0: hardware and prerequisites

A few days. Get the kit and the server ready so later phases only test the client.

**On the Pi side**

- Pi 4B (2 GB works; 4 GB gives the browser comfortable headroom)
- Official 5 V 3 A power supply
- A case with a fan or a large heatsink, since 4K HEVC decode runs warm
- A fast A1/A2 microSD card, or a USB SSD for quicker boot
- A micro-HDMI to HDMI cable rated for 4K, in the HDMI0 port (next to the USB-C power socket)
- Ethernet at the TV if possible; Wi-Fi is fine for 1080p but marginal for 4K remuxes
- Your Fire TV remote

**On the server side**

- Jellyfin on a current release, with trickplay images enabled
- The Intro Skipper plugin
- The Litefin server plugin (needed for Seerr requests) and a Seerr instance
- Hardware transcoding (Quick Sync, NVENC or similar), because AV1, VP9 and 4K H.264 will always be transcoded for the Pi

**Test media set**

Pick one file per row of the Phase 1 test matrix and keep them in a dedicated Jellyfin library so they are easy to find.

## Phase 1: prove playback

1–2 weeks of evenings. This phase decides whether the whole plan works, and which of two playback paths to use.

**Setup:** Raspberry Pi OS Lite (64-bit) with its packaged mpv, which already includes the Raspberry Pi patches for hardware HEVC decoding. Play files straight from Jellyfin with a static stream URL (`http://<server>:8096/Videos/<itemId>/stream?static=true&api_key=<key>`).

**The two playback paths to compare**

- **Path A, mpv inside the kiosk compositor.** mpv runs as a full-screen window inside cage (`--vo=dmabuf-wayland --hwdec=drm`). Switching between Litefin and video is seamless, but HDR output and refresh-rate switching may not work through the compositor.
- **Path B, mpv directly on the display.** The kiosk steps aside (a console switch) and mpv drives the screen itself (`--vo=drm --hwdec=drm`, or `gpu-next` on DRM). HDR and refresh-rate switching are much more likely to work, at the cost of a roughly one-second black screen when playback starts and stops.

**Pi config to have ready:** `dtoverlay=vc4-kms-v3d` (default), a larger video memory pool if 4K fails to allocate buffers (for example `cma-512` on that overlay), and `hdmi_enable_4kp60=1` only if you need 4K at 50/60 Hz.

**Test matrix** (fill in the result for each path)

| Test file | What to check | Path A | Path B |
| --- | --- | --- | --- |
| 4K HEVC 10-bit HDR10 remux | Smooth, no dropped frames; TV shows HDR |  |  |
| 4K HEVC SDR | Smooth at full bitrate over the network |  |  |
| 1080p H.264 high bitrate | Smooth; CPU stays low |  |  |
| 23.976 fps film | Display switches to 23.976 / 24 Hz; no judder |  |  |
| PGS subtitles (Blu-ray rip) | Render correctly, no server transcode |  |  |
| Styled ASS subtitles (anime) | Fonts and positioning correct |  |  |
| AC3 / EAC3 5.1 | Passthrough or clean PCM |  |  |
| TrueHD / DTS-HD MA (only with an AVR) | Receiver shows the right format |  |  |
| VC-1 or MPEG-2 1080p | Software decode keeps up |  |  |
| Transcoded stream (AV1 source) | HLS from Jellyfin starts and seeks quickly |  |  |
| 1080i Freeview recording (only if Live TV matters) | Deinterlaced cleanly |  |  |

**Exit criteria:** 4K HEVC HDR and 1080p H.264 play smoothly on at least one path, and you have chosen Path A or B (or a mix: A for SDR, B for HDR).

## Phase 2: Litefin in a kiosk browser

2–4 weeks. Get Litefin's UI running full-screen on the Pi and fully navigable with arrow keys, before touching playback.

1. **Build Litefin for the browser.** Clone it, `npm install`, `npm run build`, and serve the build from the Pi itself (a tiny local web server on 127.0.0.1, or `file://` if it works).
2. **Run it in a kiosk.** Start cage (a single-app Wayland compositor) with the browser inside it, as a systemd service that auto-starts on boot.
3. **Compare two browsers and pick one.**
   - **Cog (WPE WebKit):** light, fast to start, built for embedded kiosks. Litefin was written for TV browser engines, so expect a few compatibility fixes.
   - **Chromium in kiosk mode:** heavier on memory and start-up, but its engine is close to what webOS and newer Tizen use, so fewer surprises.
4. **Add a Linux platform adapter to Litefin.** Read its Architecture and Plugins docs first to see where the Tizen and webOS adapters live, and keep yours in the same shape so upstream updates merge cleanly. It needs to handle:
   - Detecting that it is running on the Pi
   - Key mapping: Back as Escape or Backspace, Home, and media keys
   - Server discovery: Litefin's subnet scan should work as-is
   - Exit, reboot and shutdown actions (through the bridge from Phase 3)
5. **Check every integration works:** login and Quick Connect, library browsing, search, Seerr discover and requests, intro skip markers on episodes, MDBList ratings, theme settings.
6. **Try playback with the HTML5 player only as a smoke test.** It will probably struggle with HEVC; it just proves the playback flow reaches the player.

**Exit criteria:** you can use the whole UI with a keyboard, navigation feels smooth at 1080p, and a Seerr request goes through.

## Phase 3: mpv player backend and bridge

3–6 weeks, the biggest phase. Litefin asks a small local bridge to play something; the bridge drives mpv and reports back.

**The bridge daemon**

- A small always-running service on the Pi. Node.js is a natural fit since Litefin is JavaScript; Python or Rust work too.
- Litefin talks to it over a websocket on 127.0.0.1. It talks to mpv over mpv's JSON IPC socket (`--input-ipc-server`).
- Commands from Litefin: load (URL, start position, audio and subtitle track, external subtitle URLs), pause, resume, seek, change tracks, stop.
- Events back to Litefin: position, duration, paused, ended, errors, available tracks.
- Extras: reboot and shutdown, and the display handoff if Path B was chosen (switch console, start mpv, switch back when it exits).
- For Path B, the bridge also picks the display mode per file (for example 3840×2160 at 23.976 Hz) and passes it to mpv.

**The Litefin side**

- A new player backend that implements the same interface as Litefin's AVPlay, webOS and HTML5 backends (its Playback doc describes them).
- Litefin keeps doing what it already does around playback: asking Jellyfin for playback info, choosing direct play or transcode, and reporting start, progress and stop. It just takes positions from bridge events instead of a video element.
- Litefin's device profile is replaced with the Pi 4 profile below, so Jellyfin direct-plays everything mpv can handle.

**In-player controls (mpv)**

- A remote-friendly mpv on-screen controller script for seek bar, tracks and chapters.
- Small mpv Lua scripts for the Litefin features that matter during playback:
  - **Skip intro / recap:** the bridge passes Intro Skipper timestamps to mpv, and the script shows a skip prompt at the right time
  - **Up next:** near the end, the bridge tells Litefin, which queues the next episode
  - **Trickplay thumbnails:** optional for v1; uses the thumbnail tiles Jellyfin already generates
- Remote mapping in mpv's `input.conf`: Back stops playback and returns to Litefin.

**Exit criteria:** play, resume and watched status round-trip correctly with Jellyfin; subtitles and audio tracks switch; intro skip works; Back returns cleanly to Litefin.

## Phase 4: input — CEC and Fire TV remote

1–2 weeks. Both remotes end up as plain key presses, so Litefin and mpv never need to know which one was used.

**HDMI-CEC (TV remote)**

- A boot service registers the Pi with the TV as a playback device: `cec-ctl -d /dev/cec0 --playback --osd-name "<name>"`. It then appears in the TV's input list.
- The kernel turns CEC button presses into a normal input device. Check what each button sends with `evtest`.
- Wire up the appliance touches: wake the TV and switch to the Pi's input at boot, and optionally put the TV in standby on shutdown.

**Fire TV remote (Bluetooth)**

- Include BlueZ. Pair once over SSH with `bluetoothctl` (hold Home about 10 seconds to enter pairing mode), then mark it trusted so it reconnects on its own.
- D-pad, Select, Back, Menu, Home and media buttons arrive as keys. The mic button won't do voice; volume and power on newer remotes are infrared to the TV and keep working as they do now.

**One remapping layer for both**

Use `keyd` (or a short Python evdev script) with one config file:

| Remote button | Sends | Litefin / mpv action |
| --- | --- | --- |
| Back / Exit | Escape | Back in Litefin; stop playback in mpv |
| Home | A spare key (e.g. F1) | Litefin adapter jumps to Home |
| Menu | Context-menu key | Item options in Litefin |
| Play/pause, rewind, fast-forward | Media keys | Passed straight through |
| Arrows, OK | Arrows, Enter | Unchanged |

**Exit criteria:** with no keyboard attached, either remote can browse, play, pause, skip intro and get back to Home, and the TV wakes and switches input when the Pi boots.

## Phase 5: turning it into an OS image

2–6 weeks. Start with a hardened Raspberry Pi OS Lite for v1; move to Buildroot later only if you want a much faster boot and a true single-file image.

| Base | Pros | Cons | Fit |
| --- | --- | --- | --- |
| Raspberry Pi OS Lite, stripped down | Raspberry Pi's patched kernel, FFmpeg and mpv for free; Chromium and Cog both available; least work | Bigger and slower to boot (roughly 15–25 s); updates through apt | **v1** |
| Buildroot | Small, boots in a few seconds, one reproducible image; has WPE WebKit and Cog packages | You carry the FFmpeg/mpv Pi patches yourself; no Chromium package; builds take an hour or more | v2, if Cog was chosen in Phase 2 |
| LibreELEC fork | Best-tuned kernel and FFmpeg for media on Pi | Built around Kodi with no browser or Wayland kiosk stack, so adding Cog or Chromium is a big job | Not a good fit for the Litefin route |

**Making Raspberry Pi OS feel like an appliance**

- Remove everything not needed (desktop packages, unused services) and boot straight into the kiosk service
- Turn on the read-only root overlay (raspi-config's overlay file system option), so a power cut can't corrupt it
- Quiet boot: no rainbow screen or console text, and a simple splash image
- Keep settings (server, paired remotes, Litefin preferences) on a small writable partition

**First boot**

- A plain text config file on the SD card's boot partition for Wi-Fi and, optionally, the server address
- Otherwise Litefin's own server discovery and Quick Connect login handle setup

**Updates**

- v1: rebuild and reflash, or update over SSH with the overlay temporarily off
- v2: A/B updates using the Pi bootloader's `tryboot` feature, which boots a new image once and falls back if it doesn't confirm it's healthy

**Exit criteria:** power on to the Litefin home screen with no keyboard, and an unplug mid-use doesn't break the next boot.

## Jellyfin device profile for Pi 4

Direct-play HEVC up to 4K and H.264 up to 1080p; transcode everything else to HEVC. Confirm each line against your Phase 1 results.

| Media | Limit | Action |
| --- | --- | --- |
| HEVC (Main, Main 10) | Up to 3840×2160, 60 fps | Direct play (hardware decode) |
| H.264 | Up to 1920×1080, level 4.2 | Direct play (hardware decode) |
| H.264 | Above 1080p | Transcode to HEVC |
| AV1, VP9 | Any | Transcode to HEVC |
| MPEG-2, VC-1 | Up to 1080p | Direct play (software decode); transcode if Phase 1 shows stutter |
| Dolby Vision profile 7 / 8 | — | Direct play; mpv shows the HDR10 base layer |
| Dolby Vision profile 5 | — | Transcode with tone-mapping |
| Containers: MKV, MP4, M4V, TS | — | Direct play |
| Audio: AAC, MP3, FLAC, Opus, AC3, EAC3, DTS, TrueHD | — | Direct play (mpv decodes, or passes through to an AVR) |
| Subtitles: SRT, ASS/SSA, PGS, VobSub | — | Embedded or external, **never burned in** (mpv renders them all) |
| Transcode target | HLS, HEVC video | Max bitrate around 120 Mbps on Ethernet; lower it if on Wi-Fi |

## Risks, open questions and decisions

The biggest unknown is HDR output through mpv on the Pi 4; Phase 1 settles it before any real code is written.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| HDR10 not passed to the TV by mpv on Pi 4 | HDR films look washed out | Test in Phase 1 on both paths; fall back to tone-mapping HDR to SDR in mpv or on the server |
| Litefin assumes a TV browser engine | UI glitches in Cog | Try Chromium; fix in the Linux adapter |
| Browser UI too slow on the Pi 4 | Laggy navigation | Render at 1080p; Litefin already recycles cards to save memory; Chromium GPU flags |
| Black flash when switching to and from mpv (Path B) | Feels less polished | Accept for v1; revisit a transparent overlay later |
| Not enough video memory for 4K | Playback fails to start | Raise the CMA pool size |
| HD audio passthrough patchy on Pi 4 | Receiver gets PCM instead of Atmos | Test early if you have an AVR |
| TV forwards only some CEC buttons | Missing Back or Menu | Fire TV remote as the main remote |
| Litefin changes upstream | Merge conflicts | Keep all Pi code in one adapter module; consider upstreaming it |

**Open questions**

- [ ] Which TV do you have, and is there an AV receiver or soundbar?
- [ ] Which Fire TV remote model is it?
- [ ] Do you need Live TV and the EPG, or just libraries?
- [ ] Ethernet or Wi-Fi at the TV?
- [ ] Keep a private fork, or offer the Linux/Pi target back to Litefin? It is MPL-2.0, so modified Litefin files must stay MPL if you ever share the image.

**Decisions to record after each phase**

- [ ] Playback path: A, B or a mix (after Phase 1)
- [ ] Browser: Cog or Chromium (after Phase 2)
- [ ] OS base: stay on Raspberry Pi OS or move to Buildroot (after Phase 5)

## Milestone checklist

Roughly 3–5 months of evenings end to end. Each milestone is something you can see working on the TV.

**Phase 0 (a few days)**

- [ ] Pi 4B, cooling, cable and SD/SSD ready
- [ ] Intro Skipper, Litefin plugin and Seerr set up on the server
- [ ] Test media library created

**Phase 1 (1–2 weeks)**

- [ ] 4K HEVC HDR plays smoothly from Jellyfin via mpv
- [ ] Test matrix filled in for Path A and Path B
- [ ] Playback path chosen

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
