# Phase 1 test matrix

Fill in one Jellyfin item ID per row (from the dedicated test library), then record the result for each path after running `./run-test.sh <path-a|path-b> <item-id>`.

| Test file | What to check | Jellyfin item ID | Path A | Path B |
| --- | --- | --- | --- | --- |
| 4K HEVC 10-bit HDR10 remux | Smooth, no dropped frames; TV shows HDR | 51207ed79d4260c8cedd5b1202de3d00 | **Pass with VLC** (`cage` + `cvlc --vout=wl_dmabuf`) — a few frames of judder at start (fixed 30Hz mode vs. 23.976fps content), then perfectly smooth; audio and video both fine | **Pass with VLC** (`cvlc --vout=drm_vout --avcodec-hw=drm_avcodec`) — "played perfectly," confirmed hardware decode (`Using DRM Video Accel for hardware decoding`). TV has no HDR support, so this plays as tone-mapped SDR — looked correct, not washed out. mpv failed on this file regardless of path/flags (see notes). |
| 4K HEVC SDR | Smooth at full bitrate over the network | | | |
| 1080p H.264 high bitrate | Smooth; CPU stays low | 115c95d4bbeb6c321a986952080273cd | **Pass with VLC** (`cage` + `cvlc --vout=wl_dmabuf --avcodec-hw=drm_avcodec`) — confirmed hardware decode, audio and video worked well | **Pass with VLC** (`cvlc --vout=drm_vout --avcodec-hw=drm_avcodec`) — mpv failed on this same file (502 dropped frames, no audio); VLC played it perfectly |
| 23.976 fps film | Display switches to 23.976 / 24 Hz; no judder | | | |
| PGS subtitles (Blu-ray rip) | Render correctly, no server transcode | | | |
| Styled ASS subtitles (anime) | Fonts and positioning correct | | | |
| AC3 / EAC3 5.1 | Passthrough or clean PCM | | | |
| TrueHD / DTS-HD MA | N/A — no AVR in this setup | | | |
| VC-1 or MPEG-2 1080p | Software decode keeps up | | | |
| Transcoded stream (AV1 source) | HLS from Jellyfin starts and seeks quickly | | | |
| 1080i Freeview recording | N/A — Live TV out of scope | | | |

## Notes

**4K HEVC HDR10 (The Creator, 2023) — extensive debugging session:**

- Path A (`cage` + `--vo=dmabuf-wayland`): mpv's Vulkan hwdec-interop probe segfaults unconditionally on this mpv build (exit code 139, ~1.4s, reproducible regardless of `--hwdec`/`--gpu-api`/`VK_ICD_FILENAMES` flags) — likely a packaged mpv/libplacebo/vulkan-loader bug, not fixable via CLI flags. Switching to `--vo=gpu-next` avoids the crash, but `cage` only sets the display mode once at startup (picked 4096x2160@30Hz, not matching this file's 23.976fps), causing visible judder — this is the Path A refresh-switching limitation the plan called out.
- Path B (`mpv --vo=gpu-next --gpu-context=drm` or `--vo=drm`, both with `--hwdec=drm --drm-mode=9` to force the correct 3840x2160@23.976Hz mode): hardware decode confirmed active (`Using hardware decoding (drm)`, CPU 82.8% idle, mpv ~38% of one core), dropped-frame count low (6-12) — but playback still stutters badly ("like a frame per second"). Root cause: demuxer packet queue backs up to 744 video packets (157MB) while the decoder intermittently stalls, independent of which VO is used. Ruled out: thermal/power throttling (`vcgencmd get_throttled` = `0x0`, 46.7°C).
- TrueHD Atmos 7.1 (default audio track) also independently too CPU-heavy to decode smoothly alongside HEVC; AC3 "Compatibility Track" (`--aid=2`) fixed that specific issue, but didn't fix the video stall.
- Same Pi 4 hardware reportedly played this kind of content fine under LibreELEC/Kodi previously — strongly suggests the issue is mpv/ffmpeg's V4L2-request-API HEVC hwaccel integration (shared generic code across Rockchip/Allwinner/Pi) being less mature than Kodi's purpose-built Pi decode path, not a hardware limit.
- Also tested 1080p H.264 (115c95d4bbeb6c321a986952080273cd) on mpv Path A: 502 dropped frames in 30s plus no audio at all (cage/Wayland has no working audio session for mpv — separate bug from the video stall). Confirmed the stall wasn't 4K/HDR-specific, and ruled out thermal/power throttling (`vcgencmd get_throttled` = `0x0`) and resource leakage from repeated test runs as causes.
- **Pivoted from mpv to VLC as the native player.** VLC has a purpose-built Raspberry Pi integration (`drm_vout` display module, `drm_avcodec` hardware decoder, `drm_conv_sand30`, `drm_av_deinterlace` — option help text literally says "Rpi"), unlike mpv's generic cross-platform hwaccel probing. Both the 4K HEVC HDR10 file and the 1080p H.264 file that defeated mpv entirely **played perfectly on the first real attempt with VLC**, audio included (once the same `plughw:CARD=vc4hdmi0,DEV=0` ALSA device fix mpv also needed was applied). **Decision: VLC replaces mpv as the Phase 3 player backend** — no need to lean on server-side transcode for 4K HEVC/HDR after all. See `../docs/tracking.md` decisions log.

## Exit criteria

- [x] 4K HEVC HDR10 plays smoothly on at least one path — **passes on both, with VLC**
- [x] 1080p H.264 plays smoothly on at least one path — **passes on both, with VLC**
- [x] Playback path decided (A, B, or a mix) — record in `../docs/tracking.md`
