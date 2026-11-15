# Remote Input Bypass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TV/Fire TV remote actually control VLC playback (stop, pause/resume, seek, skip-intro confirm) by having the bridge daemon read the remote's input device directly and drive VLC over its existing HTTP interface, bypassing VLC's own broken Wayland key handling entirely.

**Architecture:** A new `remoteInput.js` module discovers the keyd-remapped input device via `/proc/bus/input/devices` and parses its raw evdev event stream (pure Node `fs`/`Buffer`, no native addon) into named key events. A separate `remoteInputActions.js` module holds the pure key→action dispatch logic (testable with a fake session, no hardware involved). `index.js` wires these together, tracking a single "current session" reference updated whenever a new `Session` is created. `Session` gains a small intro-window check so the OK button can decide between "confirm skip-intro" and "toggle pause" without needing any signal from Lua. `litefin.lua` loses all key-handling code, keeping only its existing OSD-display responsibility.

**Tech Stack:** Node.js (bridge daemon, same package as the rest of Phase 3 — no new dependencies), plain Linux evdev binary format, VLC Lua interface (OSD-only now).

**Spec:** `docs/superpowers/specs/2026-11-12-remote-input-bypass-design.md`

## Global Constraints

- Device discovery must parse `/proc/bus/input/devices` to find the device by name (`"keyd virtual keyboard"`), never a hardcoded `/dev/input/eventN` path — the number isn't stable across reboots.
- Only `EV_KEY` (`type === 1`) events with `value === 1` (key-down) are acted on; `value === 0` (release) and `value === 2` (autorepeat) are ignored.
- No new npm dependencies — evdev parsing uses only Node's built-in `fs`/`Buffer`.
- Key codes (verbatim from the spec, standard Linux `input-event-codes.h` values — flagged as needing empirical confirmation against real hardware in Task 5): `KEY_ESC = 1`, `KEY_INSERT = 110`, `KEY_KPENTER = 96`, `KEY_PLAYPAUSE = 164`, `KEY_REWIND = 168`, `KEY_FASTFORWARD = 208`.
- Key mapping (verbatim from the spec): Back (`KEY_ESC`) and Home (`KEY_INSERT`) both call `session.stop()`. OK (`KEY_KPENTER`) seeks past the intro if the intro window is active, otherwise toggles pause/resume. Play/Pause (`KEY_PLAYPAUSE`) always toggles pause/resume. Fast-forward (`KEY_FASTFORWARD`) seeks +30s. Rewind (`KEY_REWIND`) seeks −10s, clamped to not go below 0.
- A device-not-found or device-read error must never block the daemon's core WebSocket/HTTP responsibilities — log and continue, matching this project's established "a side-channel failing should never block playback" philosophy.
- No comments explaining *what* code does; only comments explaining non-obvious *why*, matching this project's established style.

---

### Task 1: Remote input device — discovery and evdev parsing

**Files:**
- Create: `phase3/bridge-daemon/src/remoteInput.js`
- Test: `phase3/bridge-daemon/test/remoteInput.test.js`

**Interfaces:**
- Produces: `findRemoteInputDevice(procInputDevicesText, targetName = 'keyd virtual keyboard')` returning the device path string (e.g. `'/dev/input/event5'`) or `null` if not found. `createRemoteInput({ devicePath, onKeyDown, onError, createReadStreamFn })` returning `{ close() }`; calls `onKeyDown(keyName)` for each recognized key-down event (`keyName` one of `'KEY_ESC'`, `'KEY_INSERT'`, `'KEY_KPENTER'`, `'KEY_PLAYPAUSE'`, `'KEY_REWIND'`, `'KEY_FASTFORWARD'`), calls `onError(err)` on a stream error. `createReadStreamFn` defaults to `fs.createReadStream` but is injectable for testing.

- [ ] **Step 1: Write the failing tests**

Create `/workspace/litefin-pi/phase3/bridge-daemon/test/remoteInput.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { findRemoteInputDevice, createRemoteInput } from '../src/remoteInput.js';

function procInputDevicesFixture(blocks) {
    return blocks.join('\n\n');
}

test('findRemoteInputDevice finds the keyd virtual keyboard by name and extracts its event number', () => {
    const text = procInputDevicesFixture([
        'I: Bus=0003 Vendor=046d Product=c52b Version=0111\nN: Name="Some Other Device"\nP: Phys=usb-0000:00:14.0-1/input0\nS: Sysfs=/devices/platform/something\nU: Uniq=\nH: Handlers=sysrq kbd event3 leds\nB: PROP=0',
        'I: Bus=0000 Vendor=0000 Product=0000 Version=0000\nN: Name="keyd virtual keyboard"\nP: Phys=\nS: Sysfs=/devices/virtual/input/input7\nU: Uniq=\nH: Handlers=sysrq kbd event5\nB: PROP=0'
    ]);

    assert.equal(findRemoteInputDevice(text), '/dev/input/event5');
});

test('findRemoteInputDevice returns null when no matching device exists', () => {
    const text = procInputDevicesFixture([
        'I: Bus=0003 Vendor=046d Product=c52b Version=0111\nN: Name="Some Other Device"\nH: Handlers=sysrq kbd event3 leds'
    ]);

    assert.equal(findRemoteInputDevice(text), null);
});

test('findRemoteInputDevice picks the matching block among several', () => {
    const text = procInputDevicesFixture([
        'N: Name="AR Keyboard"\nH: Handlers=kbd event2',
        'N: Name="keyd virtual keyboard"\nH: Handlers=kbd event9',
        'N: Name="Power Button"\nH: Handlers=kbd event1'
    ]);

    assert.equal(findRemoteInputDevice(text), '/dev/input/event9');
});

function makeEventBuffer(type, code, value) {
    const buf = Buffer.alloc(24);
    buf.writeUInt16LE(type, 16);
    buf.writeUInt16LE(code, 18);
    buf.writeInt32LE(value, 20);
    return buf;
}

function fakeReadStream(chunks) {
    const stream = new EventEmitter();
    stream.destroy = () => { stream.destroyed = true; };
    stream._chunks = chunks;
    stream._emitChunks = () => {
        for (const chunk of stream._chunks) {
            stream.emit('data', chunk);
        }
    };
    return stream;
}

test('createRemoteInput fires onKeyDown for a recognized key-down event', () => {
    const EV_KEY = 1;
    const KEY_ESC = 1;
    const events = [];
    const stream = fakeReadStream([makeEventBuffer(EV_KEY, KEY_ESC, 1)]);

    createRemoteInput({
        devicePath: '/dev/input/event5',
        onKeyDown: (keyName) => events.push(keyName),
        createReadStreamFn: () => stream
    });
    stream._emitChunks();

    assert.deepEqual(events, ['KEY_ESC']);
});

test('createRemoteInput ignores key-up and autorepeat events', () => {
    const EV_KEY = 1;
    const KEY_ESC = 1;
    const events = [];
    const stream = fakeReadStream([
        makeEventBuffer(EV_KEY, KEY_ESC, 0),
        makeEventBuffer(EV_KEY, KEY_ESC, 2)
    ]);

    createRemoteInput({
        devicePath: '/dev/input/event5',
        onKeyDown: (keyName) => events.push(keyName),
        createReadStreamFn: () => stream
    });
    stream._emitChunks();

    assert.deepEqual(events, []);
});

test('createRemoteInput ignores non-EV_KEY event types', () => {
    const EV_SYN = 0;
    const events = [];
    const stream = fakeReadStream([makeEventBuffer(EV_SYN, 0, 1)]);

    createRemoteInput({
        devicePath: '/dev/input/event5',
        onKeyDown: (keyName) => events.push(keyName),
        createReadStreamFn: () => stream
    });
    stream._emitChunks();

    assert.deepEqual(events, []);
});

test('createRemoteInput ignores unmapped key codes', () => {
    const EV_KEY = 1;
    const UNMAPPED_CODE = 999;
    const events = [];
    const stream = fakeReadStream([makeEventBuffer(EV_KEY, UNMAPPED_CODE, 1)]);

    createRemoteInput({
        devicePath: '/dev/input/event5',
        onKeyDown: (keyName) => events.push(keyName),
        createReadStreamFn: () => stream
    });
    stream._emitChunks();

    assert.deepEqual(events, []);
});

test('createRemoteInput parses multiple events delivered in one chunk', () => {
    const EV_KEY = 1;
    const KEY_PLAYPAUSE = 164;
    const KEY_FASTFORWARD = 208;
    const events = [];
    const combined = Buffer.concat([
        makeEventBuffer(EV_KEY, KEY_PLAYPAUSE, 1),
        makeEventBuffer(EV_KEY, KEY_FASTFORWARD, 1)
    ]);
    const stream = fakeReadStream([combined]);

    createRemoteInput({
        devicePath: '/dev/input/event5',
        onKeyDown: (keyName) => events.push(keyName),
        createReadStreamFn: () => stream
    });
    stream._emitChunks();

    assert.deepEqual(events, ['KEY_PLAYPAUSE', 'KEY_FASTFORWARD']);
});

test('createRemoteInput parses a single event split across two chunks', () => {
    const EV_KEY = 1;
    const KEY_KPENTER = 96;
    const events = [];
    const full = makeEventBuffer(EV_KEY, KEY_KPENTER, 1);
    const stream = fakeReadStream([full.subarray(0, 10), full.subarray(10)]);

    createRemoteInput({
        devicePath: '/dev/input/event5',
        onKeyDown: (keyName) => events.push(keyName),
        createReadStreamFn: () => stream
    });
    stream._emitChunks();

    assert.deepEqual(events, ['KEY_KPENTER']);
});

test('createRemoteInput forwards stream errors to onError', () => {
    const errors = [];
    const stream = fakeReadStream([]);

    createRemoteInput({
        devicePath: '/dev/input/event5',
        onKeyDown: () => {},
        onError: (err) => errors.push(err),
        createReadStreamFn: () => stream
    });
    stream.emit('error', new Error('device vanished'));

    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'device vanished');
});

test('createRemoteInput close() destroys the underlying stream', () => {
    const stream = fakeReadStream([]);
    const remoteInput = createRemoteInput({
        devicePath: '/dev/input/event5',
        onKeyDown: () => {},
        createReadStreamFn: () => stream
    });

    remoteInput.close();

    assert.equal(stream.destroyed, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: FAIL with "Cannot find module '../src/remoteInput.js'"

- [ ] **Step 3: Write the implementation**

Create `/workspace/litefin-pi/phase3/bridge-daemon/src/remoteInput.js`:

```javascript
import fs from 'node:fs';

const EVENT_SIZE = 24;
const EV_KEY = 1;

const KEY_CODES = {
    1: 'KEY_ESC',
    96: 'KEY_KPENTER',
    110: 'KEY_INSERT',
    164: 'KEY_PLAYPAUSE',
    168: 'KEY_REWIND',
    208: 'KEY_FASTFORWARD'
};

export function findRemoteInputDevice(procInputDevicesText, targetName = 'keyd virtual keyboard') {
    const blocks = procInputDevicesText.split(/\n\n+/);
    for (const block of blocks) {
        const nameMatch = block.match(/^N: Name="([^"]*)"/m);
        if (!nameMatch || nameMatch[1] !== targetName) continue;
        const handlersMatch = block.match(/^H: Handlers=.*?event(\d+)/m);
        if (handlersMatch) {
            return `/dev/input/event${handlersMatch[1]}`;
        }
    }
    return null;
}

export function createRemoteInput({ devicePath, onKeyDown, onError, createReadStreamFn = fs.createReadStream }) {
    const stream = createReadStreamFn(devicePath);
    // evdev delivers a stream of fixed-size structs, but Node's read chunks
    // are not guaranteed to align with event boundaries - buffer any partial
    // trailing bytes across chunks rather than assuming each 'data' event is
    // a whole number of events.
    let pending = Buffer.alloc(0);

    stream.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= EVENT_SIZE) {
            const event = pending.subarray(0, EVENT_SIZE);
            pending = pending.subarray(EVENT_SIZE);
            const type = event.readUInt16LE(16);
            const code = event.readUInt16LE(18);
            const value = event.readInt32LE(20);
            if (type === EV_KEY && value === 1) {
                const keyName = KEY_CODES[code];
                if (keyName) onKeyDown(keyName);
            }
        }
    });

    if (onError) {
        stream.on('error', onError);
    }

    return {
        close: () => stream.destroy()
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: PASS (39 tests total — 28 existing + 11 new)

- [ ] **Step 5: Commit**

```bash
cd /workspace/litefin-pi
git add phase3/bridge-daemon/src/remoteInput.js phase3/bridge-daemon/test/remoteInput.test.js
git commit -m "Add remote input device discovery and evdev event parsing"
```

---

### Task 2: Session gains an intro-window check

**Files:**
- Modify: `phase3/bridge-daemon/src/session.js`
- Test: `phase3/bridge-daemon/test/session.test.js`

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `Session.isIntroWindowActive()` returning a boolean. `Session.seekPastIntro()` (sync, calls the existing `seek()` internally). `export const TICKS_PER_SECOND` from `session.js` (previously a local, unexported constant — Task 3 needs this exact value and should import it rather than redefining it).

- [ ] **Step 1: Write the failing tests**

Add to `/workspace/litefin-pi/phase3/bridge-daemon/test/session.test.js`, after the existing `'load resets the intro-skipper file...'` test:

```javascript
test('isIntroWindowActive is false before any intro timestamps are set', async () => {
    const { session } = makeSession({ pollIntervalMs: 100000 });

    await session.load({ url: 'http://server/stream.mkv' });

    assert.equal(session.isIntroWindowActive(), false);
});

test('isIntroWindowActive reflects the last polled time against the stored intro bounds', async () => {
    const httpClient = fakeVlcHttpClient([]);
    let time = 10;
    httpClient.getStatus = async () => ({ state: 'playing', time, length: 1000, audioTracks: [], subtitleTracks: [] });
    const { session } = makeSession({ httpClient, pollIntervalMs: 5 });

    await session.load({ url: 'http://server/stream.mkv' });
    session.setIntroSkipperTimestamps({ introStartTicks: 300000000, introEndTicks: 900000000 }); // 30s-90s

    time = 10;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(session.isIntroWindowActive(), false);

    time = 45;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(session.isIntroWindowActive(), true);

    time = 95;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(session.isIntroWindowActive(), false);

    await session.stop();
});

test('isIntroWindowActive is false again after setIntroSkipperTimestamps is cleared', async () => {
    const { session } = makeSession({ pollIntervalMs: 100000 });

    await session.load({ url: 'http://server/stream.mkv' });
    session.setIntroSkipperTimestamps({ introStartTicks: 0, introEndTicks: 900000000 });
    assert.equal(session.isIntroWindowActive(), true); // time=0 from load's initial status, within 0-90s

    session.setIntroSkipperTimestamps({});
    assert.equal(session.isIntroWindowActive(), false);
});

test('load() clears intro bounds left over from a previous episode', async () => {
    const { session } = makeSession({ pollIntervalMs: 100000 });

    await session.load({ url: 'http://server/episode1.mkv' });
    session.setIntroSkipperTimestamps({ introStartTicks: 0, introEndTicks: 900000000 });
    assert.equal(session.isIntroWindowActive(), true);

    await session.load({ url: 'http://server/episode2.mkv' });

    assert.equal(session.isIntroWindowActive(), false);
});

test('seekPastIntro seeks to the stored intro end', async () => {
    const { session, httpClient } = makeSession({ pollIntervalMs: 100000 });

    await session.load({ url: 'http://server/stream.mkv' });
    session.setIntroSkipperTimestamps({ introStartTicks: 300000000, introEndTicks: 900000000 });
    await session.seekPastIntro();

    assert.deepEqual(httpClient.sentCommands.find((c) => c.command === 'seek'), { command: 'seek', params: { val: '90' } });
});

test('seekPastIntro does nothing if no intro bounds are set', async () => {
    const { session, httpClient } = makeSession({ pollIntervalMs: 100000 });

    await session.load({ url: 'http://server/stream.mkv' });
    await session.seekPastIntro();

    assert.equal(httpClient.sentCommands.find((c) => c.command === 'seek'), undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: FAIL — `session.isIntroWindowActive is not a function`

- [ ] **Step 3: Write the implementation**

In `/workspace/litefin-pi/phase3/bridge-daemon/src/session.js`, change the module-level constant to be exported:

```javascript
export const TICKS_PER_SECOND = 10000000;
```

In the constructor, after `this._everReachedPlaying = false;`, add:

```javascript
        this._introStartSeconds = undefined;
        this._introEndSeconds = undefined;
```

In `load()`, change the first line from `this._writeIntroSkipperFile({});` to also clear the new instance fields:

```javascript
    async load({ url, startPositionTicks = 0, audioTrack, subtitleTrack }) {
        // Clears any previous episode's markers immediately - skip-intro's own
        // segment fetch (Task 9) only resolves after this method returns, so
        // the Lua script polls this file throughout playback rather than
        // reading it once at VLC startup (see Global Constraints).
        this._introStartSeconds = undefined;
        this._introEndSeconds = undefined;
        this._writeIntroSkipperFile({});
```

(The rest of `load()` is unchanged.)

Replace `setIntroSkipperTimestamps` and add the two new methods right after it:

```javascript
    setIntroSkipperTimestamps({ introStartTicks, introEndTicks } = {}) {
        if (introStartTicks === undefined || introEndTicks === undefined) {
            this._introStartSeconds = undefined;
            this._introEndSeconds = undefined;
            this._writeIntroSkipperFile({});
            return;
        }
        this._introStartSeconds = introStartTicks / TICKS_PER_SECOND;
        this._introEndSeconds = introEndTicks / TICKS_PER_SECOND;
        this._writeIntroSkipperFile({
            introStart: this._introStartSeconds,
            introEnd: this._introEndSeconds
        });
    }

    isIntroWindowActive() {
        if (this._introStartSeconds === undefined || this._introEndSeconds === undefined) return false;
        const t = this._lastState.time;
        return t >= this._introStartSeconds && t < this._introEndSeconds;
    }

    async seekPastIntro() {
        if (this._introEndSeconds === undefined) return;
        await this.seek(this._introEndSeconds * TICKS_PER_SECOND);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: PASS (45 tests total — 39 from Task 1 + 6 new)

- [ ] **Step 5: Commit**

```bash
cd /workspace/litefin-pi
git add phase3/bridge-daemon/src/session.js phase3/bridge-daemon/test/session.test.js
git commit -m "Add Session.isIntroWindowActive/seekPastIntro for remote-driven skip-intro"
```

---

### Task 3: Key-to-action dispatch logic

**Files:**
- Create: `phase3/bridge-daemon/src/remoteInputActions.js`
- Test: `phase3/bridge-daemon/test/remoteInputActions.test.js`

**Interfaces:**
- Consumes: `TICKS_PER_SECOND` (exported from `session.js`, Task 2). A `Session`-shaped object with `stop()`, `pause()`, `resume()`, `seek(ticks)`, `getCurrentState()` returning `{time, duration, paused}`, `isIntroWindowActive()`, `seekPastIntro()` (all from Task 2 and the pre-existing `Session` class).
- Produces: `handleRemoteKey(keyName, getCurrentSession)` where `getCurrentSession` is a zero-arg function returning the current `Session` instance or `null`/`undefined`. No return value.

- [ ] **Step 1: Write the failing tests**

Create `/workspace/litefin-pi/phase3/bridge-daemon/test/remoteInputActions.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRemoteKey } from '../src/remoteInputActions.js';

function fakeSession({ paused = true, time = 0, introWindowActive = false } = {}) {
    const calls = [];
    return {
        calls,
        stop: () => calls.push(['stop']),
        pause: () => calls.push(['pause']),
        resume: () => calls.push(['resume']),
        seek: (ticks) => calls.push(['seek', ticks]),
        getCurrentState: () => ({ time, duration: 1000, paused }),
        isIntroWindowActive: () => introWindowActive,
        seekPastIntro: () => calls.push(['seekPastIntro'])
    };
}

test('KEY_ESC stops the current session', () => {
    const session = fakeSession();
    handleRemoteKey('KEY_ESC', () => session);
    assert.deepEqual(session.calls, [['stop']]);
});

test('KEY_INSERT (Home) also stops the current session', () => {
    const session = fakeSession();
    handleRemoteKey('KEY_INSERT', () => session);
    assert.deepEqual(session.calls, [['stop']]);
});

test('KEY_KPENTER seeks past the intro when the intro window is active', () => {
    const session = fakeSession({ introWindowActive: true });
    handleRemoteKey('KEY_KPENTER', () => session);
    assert.deepEqual(session.calls, [['seekPastIntro']]);
});

test('KEY_KPENTER toggles pause when the intro window is not active and playback is playing', () => {
    const session = fakeSession({ introWindowActive: false, paused: false });
    handleRemoteKey('KEY_KPENTER', () => session);
    assert.deepEqual(session.calls, [['pause']]);
});

test('KEY_KPENTER toggles resume when the intro window is not active and playback is paused', () => {
    const session = fakeSession({ introWindowActive: false, paused: true });
    handleRemoteKey('KEY_KPENTER', () => session);
    assert.deepEqual(session.calls, [['resume']]);
});

test('KEY_PLAYPAUSE pauses when currently playing', () => {
    const session = fakeSession({ paused: false });
    handleRemoteKey('KEY_PLAYPAUSE', () => session);
    assert.deepEqual(session.calls, [['pause']]);
});

test('KEY_PLAYPAUSE resumes when currently paused', () => {
    const session = fakeSession({ paused: true });
    handleRemoteKey('KEY_PLAYPAUSE', () => session);
    assert.deepEqual(session.calls, [['resume']]);
});

test('KEY_FASTFORWARD seeks forward 30 seconds from the current position', () => {
    const session = fakeSession({ time: 100 });
    handleRemoteKey('KEY_FASTFORWARD', () => session);
    assert.deepEqual(session.calls, [['seek', 130 * 10000000]]);
});

test('KEY_REWIND seeks back 10 seconds from the current position', () => {
    const session = fakeSession({ time: 100 });
    handleRemoteKey('KEY_REWIND', () => session);
    assert.deepEqual(session.calls, [['seek', 90 * 10000000]]);
});

test('KEY_REWIND clamps to 0 rather than seeking negative', () => {
    const session = fakeSession({ time: 5 });
    handleRemoteKey('KEY_REWIND', () => session);
    assert.deepEqual(session.calls, [['seek', 0]]);
});

test('an unmapped key name is a no-op', () => {
    const session = fakeSession();
    handleRemoteKey('KEY_UP', () => session);
    assert.deepEqual(session.calls, []);
});

test('any key is a no-op when there is no current session', () => {
    assert.doesNotThrow(() => handleRemoteKey('KEY_ESC', () => null));
    assert.doesNotThrow(() => handleRemoteKey('KEY_ESC', () => undefined));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: FAIL with "Cannot find module '../src/remoteInputActions.js'"

- [ ] **Step 3: Write the implementation**

Create `/workspace/litefin-pi/phase3/bridge-daemon/src/remoteInputActions.js`:

```javascript
import { TICKS_PER_SECOND } from './session.js';

const FAST_FORWARD_SECONDS = 30;
const REWIND_SECONDS = 10;

export function handleRemoteKey(keyName, getCurrentSession) {
    const session = getCurrentSession();
    if (!session) return;

    switch (keyName) {
        case 'KEY_ESC':
        case 'KEY_INSERT':
            session.stop();
            break;
        case 'KEY_KPENTER':
            if (session.isIntroWindowActive()) {
                session.seekPastIntro();
            } else {
                togglePause(session);
            }
            break;
        case 'KEY_PLAYPAUSE':
            togglePause(session);
            break;
        case 'KEY_FASTFORWARD':
            session.seek((session.getCurrentState().time + FAST_FORWARD_SECONDS) * TICKS_PER_SECOND);
            break;
        case 'KEY_REWIND':
            session.seek(Math.max(0, session.getCurrentState().time - REWIND_SECONDS) * TICKS_PER_SECOND);
            break;
    }
}

function togglePause(session) {
    if (session.getCurrentState().paused) {
        session.resume();
    } else {
        session.pause();
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: PASS (57 tests total — 45 from Task 2 + 12 new)

- [ ] **Step 5: Commit**

```bash
cd /workspace/litefin-pi
git add phase3/bridge-daemon/src/remoteInputActions.js phase3/bridge-daemon/test/remoteInputActions.test.js
git commit -m "Add key-to-action dispatch logic for remote-driven playback control"
```

---

### Task 4: Wire remote input into the daemon; simplify the Lua script to OSD-only

**Files:**
- Modify: `phase3/bridge-daemon/src/index.js`
- Modify: `phase3/vlc-lua/intf/litefin.lua`

**Interfaces:**
- Consumes: `findRemoteInputDevice`, `createRemoteInput` (Task 1), `handleRemoteKey` (Task 3), `Session` (pre-existing, extended in Task 2).
- Produces: nothing consumed by later tasks — this is the real wiring, no mocks, matching this project's established pattern for `index.js` (see the original Task 6).

- [ ] **Step 1: Wire remote input and session tracking into index.js**

Read the current `/workspace/litefin-pi/phase3/bridge-daemon/src/index.js` first to confirm it still matches this shape (it was last touched during the original Phase 3 build and the `spawnFn` wiring fix — nothing since should have changed it, but confirm before editing):

```javascript
import { execFile, execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createServer } from './server.js';
import { Session } from './session.js';
import { createVlcProcess } from './vlcProcess.js';
import { createVlcHttpClient } from './vlcHttpClient.js';
import { createDisplayMode } from './displayMode.js';

function killOrphanedVlc() {
    try {
        execFileSync('pkill', ['-f', 'cvlc.*--extraintf=http']);
    } catch (err) {
        // pkill exits non-zero when nothing matched - not an error for us.
    }
}

const displayMode = createDisplayMode({
    output: 'HDMI-A-1',
    uiMode: '1920x1080@60.000000Hz',
    playbackMode: '4096x2160@30.000000Hz',
    execFileFn: execFile
});

killOrphanedVlc();

createServer({
    port: 8082,
    createSession: () => new Session({
        // Session calls this with { password, httpPort, audioDevice } only -
        // bind the real spawnFn here since createVlcProcess requires it.
        createVlcProcess: (opts) => createVlcProcess({ ...opts, spawnFn: spawn }),
        createVlcHttpClient,
        displayMode
    })
});

console.log('litefin-bridge listening on ws://127.0.0.1:8082');
```

Replace its full contents with:

```javascript
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createServer } from './server.js';
import { Session } from './session.js';
import { createVlcProcess } from './vlcProcess.js';
import { createVlcHttpClient } from './vlcHttpClient.js';
import { createDisplayMode } from './displayMode.js';
import { findRemoteInputDevice, createRemoteInput } from './remoteInput.js';
import { handleRemoteKey } from './remoteInputActions.js';

function killOrphanedVlc() {
    try {
        execFileSync('pkill', ['-f', 'cvlc.*--extraintf=http']);
    } catch (err) {
        // pkill exits non-zero when nothing matched - not an error for us.
    }
}

const displayMode = createDisplayMode({
    output: 'HDMI-A-1',
    uiMode: '1920x1080@60.000000Hz',
    playbackMode: '4096x2160@30.000000Hz',
    execFileFn: execFile
});

killOrphanedVlc();

// Single shared reference, not per-connection: this is a single-client kiosk
// appliance with one physical remote and at most one active session at a
// time (see docs/superpowers/specs/2026-11-12-remote-input-bypass-design.md).
let currentSession = null;

try {
    const devicePath = findRemoteInputDevice(fs.readFileSync('/proc/bus/input/devices', 'utf8'));
    if (devicePath) {
        createRemoteInput({
            devicePath,
            onKeyDown: (keyName) => handleRemoteKey(keyName, () => currentSession),
            onError: (err) => console.error('remote input device error:', err.message)
        });
    } else {
        console.error('remote input device ("keyd virtual keyboard") not found - remote control during playback will not work');
    }
} catch (err) {
    // Never let a remote-input setup failure block the daemon's core
    // WebSocket/HTTP responsibilities.
    console.error('remote input setup failed:', err.message);
}

createServer({
    port: 8082,
    createSession: () => {
        const session = new Session({
            createVlcProcess: (opts) => createVlcProcess({ ...opts, spawnFn: spawn }),
            createVlcHttpClient,
            displayMode
        });
        currentSession = session;
        return session;
    }
});

console.log('litefin-bridge listening on ws://127.0.0.1:8082');
```

- [ ] **Step 2: Verify the entry point still starts cleanly (manual, no automated test — matches this project's established precedent for index.js)**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && node src/index.js &`
Expected: prints `litefin-bridge listening on ws://127.0.0.1:8082` and stays up (it's fine if `/proc/bus/input/devices` doesn't contain a matching device in this sandbox — that path should log the "not found" message and continue, not crash). Then: `kill %1`

- [ ] **Step 3: Simplify litefin.lua to OSD-only**

Read the current `/workspace/litefin-pi/phase3/vlc-lua/intf/litefin.lua` first to confirm it still matches this shape:

```lua
-- Litefin VLC interface script: Back/Escape stops playback (cage gives VLC
-- exclusive input focus during playback, so Litefin's own key handler never
-- sees this key - see docs/superpowers/specs/2026-11-09-phase3-bridge-daemon-design.md),
-- and shows a skip-intro prompt from Intro Skipper timestamps written by the
-- bridge daemon. The file is re-read on every loop iteration, not just once
-- at startup: the daemon resets it to {} when VLC spawns and only fills in
-- real timestamps later, once Litefin's skip-intro plugin resolves its own
-- segment fetch (which happens after playback has already started - see
-- Global Constraints in the plan this script was built from).

local intro_start = nil
local intro_end = nil
local prompt_shown = false

local function load_intro_timestamps()
    local f = io.open('/tmp/litefin-intro-skipper.json', 'r')
    if not f then
        intro_start = nil
        intro_end = nil
        return
    end
    local content = f:read('*all')
    f:close()
    local s = content:match('"introStart"%s*:%s*([%d%.]+)')
    local e = content:match('"introEnd"%s*:%s*([%d%.]+)')
    if s and e then
        intro_start = tonumber(s)
        intro_end = tonumber(e)
    else
        -- File exists but is {} (no markers yet, or none for this item).
        intro_start = nil
        intro_end = nil
    end
end

function activate()
    return true
end

function deactivate()
end

function input_changed()
end

function key_pressed()
    local key = vlc.var.get(vlc.object.libvlc(), 'key-pressed')
    if key == 'Esc' then
        vlc.playlist.stop()
    elseif key == 'Enter' and prompt_shown and intro_end then
        local input = vlc.object.input()
        if input then
            -- 'time' is in microseconds (same unit the read side divides
            -- by 1000000 for, just below), but intro_end is in seconds -
            -- convert back or this seeks to roughly time-zero instead of
            -- past the intro.
            vlc.var.set(input, 'time', intro_end * 1000000)
        end
        prompt_shown = false
        vlc.osd.message('', 1)
    end
end

while true do
    load_intro_timestamps()
    local input = vlc.object.input()
    if input and intro_start and intro_end then
        local t = vlc.var.get(input, 'time') / 1000000
        if t >= intro_start and t < intro_end then
            prompt_shown = true
            vlc.osd.message('Skip Intro (press OK)', 1)
        elseif prompt_shown then
            prompt_shown = false
            vlc.osd.message('', 1)
        end
    elseif prompt_shown then
        -- Markers disappeared (e.g. the daemon reset the file for a new
        -- episode) while the prompt was showing - clear it instead of
        -- leaving it stuck with no way to clear itself.
        prompt_shown = false
        vlc.osd.message('', 1)
    end
    vlc.misc.mwait(vlc.misc.mdate() + 500000)
end
```

Replace its full contents with:

```lua
-- Litefin VLC interface script: shows a skip-intro OSD prompt from Intro
-- Skipper timestamps written by the bridge daemon. This is drawing text
-- over VLC's own video surface, the one thing only VLC itself can do -
-- actually confirming the skip, and all other playback control (stop,
-- pause, seek), is handled by the bridge daemon directly over VLC's HTTP
-- interface, driven by its own read of the remote's input device. VLC's
-- own key handling (globalhotkeys) does not work under Wayland/cage - see
-- docs/superpowers/specs/2026-11-12-remote-input-bypass-design.md.

local intro_start = nil
local intro_end = nil
local prompt_shown = false

local function load_intro_timestamps()
    local f = io.open('/tmp/litefin-intro-skipper.json', 'r')
    if not f then
        intro_start = nil
        intro_end = nil
        return
    end
    local content = f:read('*all')
    f:close()
    local s = content:match('"introStart"%s*:%s*([%d%.]+)')
    local e = content:match('"introEnd"%s*:%s*([%d%.]+)')
    if s and e then
        intro_start = tonumber(s)
        intro_end = tonumber(e)
    else
        -- File exists but is {} (no markers yet, or none for this item).
        intro_start = nil
        intro_end = nil
    end
end

function activate()
    return true
end

function deactivate()
end

function input_changed()
end

while true do
    load_intro_timestamps()
    local input = vlc.object.input()
    if input and intro_start and intro_end then
        local t = vlc.var.get(input, 'time') / 1000000
        if t >= intro_start and t < intro_end then
            prompt_shown = true
            vlc.osd.message('Skip Intro (press OK)', 1)
        elseif prompt_shown then
            prompt_shown = false
            vlc.osd.message('', 1)
        end
    elseif prompt_shown then
        -- Markers disappeared (e.g. the daemon reset the file for a new
        -- episode) while the prompt was showing - clear it instead of
        -- leaving it stuck with no way to clear itself.
        prompt_shown = false
        vlc.osd.message('', 1)
    end
    vlc.misc.mwait(vlc.misc.mdate() + 500000)
end
```

- [ ] **Step 4: Commit**

```bash
cd /workspace/litefin-pi
git add phase3/bridge-daemon/src/index.js phase3/vlc-lua/intf/litefin.lua
git commit -m "Wire remote input handling into the bridge daemon, simplify litefin.lua to OSD-only"
```

---

### Task 5: End-to-end verification on the Pi

**Files:** none (deployment + manual verification only)

**Interfaces:** none — this task verifies the whole system built in Tasks 1-4 together, on real hardware.

- [ ] **Step 1: Deploy**

From your laptop:
```
scp ~/Documents/projects/litefin-pi/phase3/bridge-daemon/src/remoteInput.js benalk@litefin-pi.local:~/litefin-bridge/src/
scp ~/Documents/projects/litefin-pi/phase3/bridge-daemon/src/remoteInputActions.js benalk@litefin-pi.local:~/litefin-bridge/src/
scp ~/Documents/projects/litefin-pi/phase3/bridge-daemon/src/session.js benalk@litefin-pi.local:~/litefin-bridge/src/
scp ~/Documents/projects/litefin-pi/phase3/bridge-daemon/src/index.js benalk@litefin-pi.local:~/litefin-bridge/src/
scp ~/Documents/projects/litefin-pi/phase3/vlc-lua/intf/litefin.lua benalk@litefin-pi.local:/tmp/
ssh benalk@litefin-pi.local "cp /tmp/litefin.lua ~/.local/share/vlc/lua/intf/litefin.lua && sudo systemctl restart litefin-bridge"
```

- [ ] **Step 2: Confirm the daemon found the remote input device**

```
ssh benalk@litefin-pi.local "journalctl -u litefin-bridge -n 20 --no-pager"
```
Expected: `litefin-bridge listening on ws://127.0.0.1:8082`, and no `remote input device ("keyd virtual keyboard") not found` warning. If that warning appears, run `cat /proc/bus/input/devices` on the Pi directly and confirm the exact `N: Name="..."` string for the keyd device matches `'keyd virtual keyboard'` exactly (case and spacing) — adjust `findRemoteInputDevice`'s default `targetName` in `remoteInput.js` if it differs, re-test, and re-deploy.

- [ ] **Step 3: Verify the real key codes against `evtest`, side by side**

On the Pi, in one terminal:
```
sudo evtest /dev/input/eventN   # the device number found in Step 2's journal, or re-derive via cat /proc/bus/input/devices
```
In another terminal, start playback from Litefin, then press each remote button one at a time while watching `evtest`'s output for the `code` value it reports. Compare against this plan's Global Constraints table (`KEY_ESC = 1`, `KEY_INSERT = 110`, `KEY_KPENTER = 96`, `KEY_PLAYPAUSE = 164`, `KEY_REWIND = 168`, `KEY_FASTFORWARD = 208`). If any button reports a different code than expected, update the `KEY_CODES` map in `remoteInput.js` to match the real value, re-run Task 1's tests, and re-deploy before continuing.

- [ ] **Step 4: Verify each mapped action during real playback**

Using the same 1080p H.264 test file from earlier Task 10 testing: confirm Back stops playback and returns to Litefin; confirm Home does the same; confirm Play/Pause toggles playback; confirm OK toggles pause/resume outside the intro window; confirm Fast-forward/Rewind seek by roughly 30s/10s (exact seconds don't need to be pixel-precise, just directionally and roughly-magnitude correct),

- [ ] **Step 5: Verify skip-intro end-to-end with the new flow**

Using a file with Intro Skipper markers (same as the original Task 10 verification), confirm the "Skip Intro" OSD prompt still appears during the intro window (unchanged Lua behavior), and that pressing OK while it's showing seeks past the intro via the daemon's `seekPastIntro()` path rather than the old (removed) Lua key handler.

- [ ] **Step 6: Record results in tracking.md**

Update `/workspace/litefin-pi/docs/tracking.md`'s Phase 3 section with a session notes entry covering: the `globalhotkeys`-under-Wayland root cause, the redesign, and the actual real-hardware key codes confirmed in Step 3 (especially if any differed from this plan's assumed values) — following the same pattern as every other phase's notes in that file.

- [ ] **Step 7: Commit the tracking update**

```bash
cd /workspace/litefin-pi
git add docs/tracking.md
git commit -m "Record remote input bypass verification results"
```
