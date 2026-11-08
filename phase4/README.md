# Phase 4: input — Fire TV remote (CEC not yet done)

Goal: both the TV remote (via HDMI-CEC) and the Fire TV remote arrive as plain key presses, so Litefin and the player never need to know which one was used. See [`../docs/plan.md`](../docs/plan.md#phase-4-input--cec-and-fire-tv-remote) for the full context.

**Reordered ahead of Phase 3** — doesn't depend on the bridge daemon, and real remote input makes every other phase's testing far less painful than `wtype`.

**Status: Fire TV remote done. HDMI-CEC not started.**

## 1. Pair the Fire TV remote

```
rfkill list bluetooth
```
If soft-blocked, `sudo rfkill unblock bluetooth` first.

Put the remote in pairing mode (hold **Home** ~10s until it flashes), then:

```
bluetoothctl
power on
agent on
default-agent
scan on
```

Find it in the scan output (ours showed up as device name `"AR"`), then:

```
scan off
pair <mac>
trust <mac>
connect <mac>
```

It should register as an input device once connected — check:

```
cat /proc/bus/input/devices
```

Look for an entry with `Uniq=` matching the remote's MAC (ours was `"AR Keyboard"`). Note: it does **not** show up in `evtest`'s device list until actively connected — BLE remotes disconnect when idle and need reconnecting.

## 2. Check actual button codes

Don't assume standard key codes — check with `evtest` first:

```
sudo evtest /dev/input/eventN   # the device from step 1
```

Press every button and note the `code (KEY_NAME)` for each. Ours (3rd-gen Alexa Voice Remote):

| Button | Sends | Needs remap |
| --- | --- | --- |
| Arrows | `KEY_UP/DOWN/LEFT/RIGHT` | No |
| OK/Select | `KEY_KPENTER` | No |
| Back | `KEY_BACK` | **Yes → Escape** |
| Home | `KEY_HOMEPAGE` | **Yes → Insert** (not F1 — Chromium hardcodes F1 to its own Help action, see Phase 2) |
| Menu | `KEY_MENU` | No (does nothing in Litefin yet — no existing keyboard binding for item options, not a remapping problem) |
| Rewind / Fast-forward / Play-Pause | `KEY_REWIND` / `KEY_FASTFORWARD` / `KEY_PLAYPAUSE` | No |
| Volume / Mute | `KEY_VOLUMEUP/DOWN/MUTE` | No (nothing currently listens for these specially) |

If your remote/model sends different codes, update [`firetv-remote.keyd.conf`](firetv-remote.keyd.conf) accordingly.

## 3. Reconnect reliability

BLE remotes disconnect when idle and can be flaky reconnecting. If yours is very unreliable (not just slow):

- Rule out a competing bond — is the remote still paired to an original Fire TV Stick that's powered on? If so, unpair it there first (**Settings → Remotes & Bluetooth Devices → [remote] → Unpair**), or just unplug the stick.
- Factory-reset the remote (hold **Home + Back** ~12s) and re-pair fresh on the Pi (`bluetoothctl remove <mac>` first).

Ours settled at a consistent ~15s wake-from-idle delay after this — a known BLE HID-over-GATT quirk (BlueZ logs `hog-lib.c:report_reference_cb()` errors during reconnect), accepted rather than chased further since it only affects picking the remote back up after a pause, not individual button presses during active use.

## 4. Install `keyd`

```
sudo apt install -y keyd
```

Deploy the config:

```
sudo cp firetv-remote.keyd.conf /etc/keyd/firetv-remote.conf
sudo systemctl enable --now keyd
```

**Important:** scope the `[ids]` section to `*` (all keyboards), not a specific vendor:product ID — a specific-ID config silently left `keyd` ignoring the device with no parse error logged (cause not identified). `*` is safe here since normal keyboards don't send `KEY_BACK`/`KEY_HOMEPAGE` anyway.

Verify the remap:

```
sudo journalctl -u keyd --no-pager -l | tail -5
```

Should show `DEVICE: match ... (AR Keyboard)`. Find `keyd`'s virtual output device (`cat /proc/bus/input/devices`, look for `"keyd virtual keyboard"`) and `evtest` *that* device — Back should now show `KEY_ESC`, Home should show `KEY_INSERT`.

## 5. Exit criteria

- [x] With no keyboard attached, the Fire TV remote can browse, play, pause, and get back to Home
- [ ] HDMI-CEC (TV remote) — not started
- [ ] TV wakes and switches input on boot — not started
