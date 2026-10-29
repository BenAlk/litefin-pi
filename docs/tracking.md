# Tracking

Living status doc. Update this as phases complete — `docs/plan.md` stays as the static reference.

## Milestone checklist

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

## Decisions log

| Decision | Status | Notes |
| --- | --- | --- |
| Repo name | Decided | `litefin-pi` |
| Litefin source | Decided | Submodule at `litefin/`, tracking upstream `release` branch (github.com/MoazSalem/litefin), currently v2.0.20 |
| Playback path: A, B or a mix | Pending | After Phase 1 |
| Browser: Cog or Chromium | Pending | After Phase 2 |
| OS base: Raspberry Pi OS or Buildroot | Pending | After Phase 5 |

## Open questions

- [x] Which TV do you have, and is there an AV receiver or soundbar? — **Panasonic UHD TV, Sharp soundbar, no AV receiver.**
- [x] Which Fire TV remote model is it? — **2020 Fire TV Stick remote (3rd-gen Alexa Voice Remote, Bluetooth).**
- [x] Do you need Live TV and the EPG, or just libraries? — **No Live TV.** Drops Live TV deinterlacing concerns from scope.
- [x] Ethernet or Wi-Fi at the TV? — **Pi 4B will use its own Wi-Fi**, not the TV's.
- [ ] Keep a private fork, or offer the Linux/Pi target back to Litefin? It is MPL-2.0, so modified Litefin files must stay MPL if the image is ever shared.

### Risk flag: Wi-Fi instead of Ethernet

The plan recommends Ethernet at the TV because Wi-Fi is "marginal for 4K remuxes." This project will run on the Pi's own Wi-Fi. Watch this closely in the Phase 1 test matrix (4K HEVC rows) — if streaming is unreliable, options are a USB Ethernet adapter at the TV or capping the Jellyfin device profile's transcode bitrate lower on Wi-Fi.

### No AV receiver

No AVR means TrueHD/DTS-HD MA passthrough isn't in play — mpv will decode to PCM for the Sharp soundbar (likely over HDMI/ARC). Not expected to be a blocker; the plan's TrueHD/DTS-HD MA test row only matters "with an AVR," so it's not applicable here.
