# Phase 1 test matrix

Fill in one Jellyfin item ID per row (from the dedicated test library), then record the result for each path after running `./run-test.sh <path-a|path-b> <item-id>`.

| Test file | What to check | Jellyfin item ID | Path A | Path B |
| --- | --- | --- | --- | --- |
| 4K HEVC 10-bit HDR10 remux | Smooth, no dropped frames; TV shows HDR | | | |
| 4K HEVC SDR | Smooth at full bitrate over the network | | | |
| 1080p H.264 high bitrate | Smooth; CPU stays low | | | |
| 23.976 fps film | Display switches to 23.976 / 24 Hz; no judder | | | |
| PGS subtitles (Blu-ray rip) | Render correctly, no server transcode | | | |
| Styled ASS subtitles (anime) | Fonts and positioning correct | | | |
| AC3 / EAC3 5.1 | Passthrough or clean PCM | | | |
| TrueHD / DTS-HD MA | N/A — no AVR in this setup | | | |
| VC-1 or MPEG-2 1080p | Software decode keeps up | | | |
| Transcoded stream (AV1 source) | HLS from Jellyfin starts and seeks quickly | | | |
| 1080i Freeview recording | N/A — Live TV out of scope | | | |

## Exit criteria

- [ ] 4K HEVC HDR10 plays smoothly on at least one path
- [ ] 1080p H.264 plays smoothly on at least one path
- [ ] Playback path decided (A, B, or a mix) — record in `../docs/tracking.md`
