# Phase 3 Bridge Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the always-running Node.js bridge daemon that lets Litefin hand off playback to VLC, plus the Litefin-side player backend and device profile that talk to it.

**Architecture:** The daemon spawns VLC fresh per playback (not kept running), controls it via VLC's HTTP interface (polled, since VLC has no event-push mechanism), and exposes a WebSocket server on `127.0.0.1:8082` that Litefin's new `VlcBridgePlayer.js` backend talks to. A VLC Lua interface script handles Back/Escape and skip-intro, since VLC has exclusive input focus during playback under `cage` (Path A).

**Tech Stack:** Node.js (bridge daemon), `ws` npm package (WebSocket server — Node has no built-in one), VLC's `--extraintf http`, VLC Lua scripting, vanilla JS (Litefin backend, no new deps there).

**Spec:** `docs/superpowers/specs/2026-11-09-phase3-bridge-daemon-design.md`

## Global Constraints

- VLC spawn flags must match what Phase 1 proved working: `--vout=wl_dmabuf --avcodec-hw=drm_avcodec --aout=alsa --alsa-audio-device=plughw:CARD=vc4hdmi0,DEV=0` (Path A, inside `cage`).
- WebSocket server binds `127.0.0.1:8082` only (never `0.0.0.0` — this project's established practice, see Phase 2's remote-debugging-port lesson).
- VLC's HTTP interface binds `127.0.0.1:9191` only, with a random password generated in memory per daemon run — never written to disk.
- Display mode toggle uses `wlr-randr --output HDMI-A-1`: `1920x1080@60.000000Hz` for the UI, `4096x2160@30.000000Hz` for playback (per Phase 1/2 findings — no per-file resolution matching needed, the minor judder is already accepted as fine).
- No comments explaining *what* code does; only comments explaining non-obvious *why*, matching this project's established style.
- Intro-skipper temp file: `/tmp/litefin-intro-skipper.json` (default; overridable via `introSkipperFilePath` so tests don't touch the real path). `Session` resets it to `{}` at the top of every `load()` (clears a previous episode's stale markers) and `Session.setIntroSkipperTimestamps()` rewrites it live. The VLC Lua script (Task 7) polls this file throughout playback rather than reading it once at startup, because the skip-intro plugin's segment fetch (`onPlayerStart`, Task 9) only runs *after* `backend.play()` has already resolved and VLC has already spawned — confirmed by reading `litefin/src/pages/PlayerPage.js`'s playback-start sequencing, not assumed from the original spec.

---

### Task 1: VLC HTTP client module

**Files:**
- Create: `phase3/bridge-daemon/package.json`
- Create: `phase3/bridge-daemon/src/vlcHttpClient.js`
- Test: `phase3/bridge-daemon/test/vlcHttpClient.test.js`

**Interfaces:**
- Produces: `createVlcHttpClient({ host, port, password })` returning `{ getStatus(), sendCommand(command, params) }`. `getStatus()` resolves to `{ state, time, length, audioTracks: [{id, name}], subtitleTracks: [{id, name}] }`. `sendCommand(command, params = {})` resolves to `undefined`, rejects on a non-2xx HTTP response.

- [ ] **Step 1: Create the bridge daemon's package.json**

```bash
mkdir -p /workspace/litefin-pi/phase3/bridge-daemon
```

```json
{
  "name": "litefin-bridge-daemon",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "node --test test/"
  },
  "dependencies": {
    "ws": "^8.18.0"
  }
}
```

Save as `/workspace/litefin-pi/phase3/bridge-daemon/package.json`.

- [ ] **Step 2: Install dependencies**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm install`
Expected: `node_modules/ws` installed, `package-lock.json` created.

- [ ] **Step 3: Write the failing test**

Create `/workspace/litefin-pi/phase3/bridge-daemon/test/vlcHttpClient.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createVlcHttpClient } from '../src/vlcHttpClient.js';

function startFakeVlc(statusJson) {
    let lastAuth = null;
    let lastUrl = null;
    const server = http.createServer((req, res) => {
        lastAuth = req.headers.authorization;
        lastUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(statusJson));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                server,
                port: server.address().port,
                getLastAuth: () => lastAuth,
                getLastUrl: () => lastUrl,
                close: () => new Promise((r) => server.close(r))
            });
        });
    });
}

test('getStatus sends basic auth with empty username and parses track lists', async () => {
    const fake = await startFakeVlc({
        state: 'playing',
        time: 42,
        length: 7199,
        information: {
            category: {
                'Stream 0': { Type: 'Video' },
                'Stream 1': { Type: 'Audio', Id: '1', Language: 'eng' },
                'Stream 2': { Type: 'Subtitle', Id: '2', Language: 'eng' },
                'Stream 3': { Type: 'Subtitle', Id: '3', Language: 'fre' }
            }
        }
    });
    const client = createVlcHttpClient({ host: '127.0.0.1', port: fake.port, password: 'sekrit' });

    const status = await client.getStatus();

    assert.equal(status.state, 'playing');
    assert.equal(status.time, 42);
    assert.equal(status.length, 7199);
    assert.deepEqual(status.audioTracks, [{ id: '1', name: 'eng' }]);
    assert.deepEqual(status.subtitleTracks, [
        { id: '2', name: 'eng' },
        { id: '3', name: 'fre' }
    ]);
    assert.equal(fake.getLastAuth(), 'Basic ' + Buffer.from(':sekrit').toString('base64'));

    await fake.close();
});

test('sendCommand encodes command and params as query string', async () => {
    const fake = await startFakeVlc({ state: 'playing', time: 0, length: 0, information: { category: {} } });
    const client = createVlcHttpClient({ host: '127.0.0.1', port: fake.port, password: 'sekrit' });

    await client.sendCommand('seek', { val: '30' });

    assert.equal(fake.getLastUrl(), '/requests/status.json?command=seek&val=30');

    await fake.close();
});

test('getStatus rejects on connection failure', async () => {
    const client = createVlcHttpClient({ host: '127.0.0.1', port: 1, password: 'x' });
    await assert.rejects(() => client.getStatus());
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: FAIL with "Cannot find module '../src/vlcHttpClient.js'"

- [ ] **Step 5: Write the implementation**

Create `/workspace/litefin-pi/phase3/bridge-daemon/src/vlcHttpClient.js`:

```javascript
import http from 'node:http';

function request(host, port, password, path) {
    return new Promise((resolve, reject) => {
        const auth = Buffer.from(':' + password).toString('base64');
        const req = http.request(
            { host, port, path, headers: { Authorization: 'Basic ' + auth } },
            (res) => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume();
                    reject(new Error(`VLC HTTP interface returned ${res.statusCode}`));
                    return;
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => resolve(body));
            }
        );
        req.on('error', reject);
        req.end();
    });
}

function parseTracks(category, type) {
    return Object.values(category || {})
        .filter((stream) => stream.Type === type)
        .map((stream) => ({ id: stream.Id, name: stream.Language || stream.Description || '' }));
}

export function createVlcHttpClient({ host, port, password }) {
    async function getStatus() {
        const body = await request(host, port, password, '/requests/status.json');
        const json = JSON.parse(body);
        const category = json.information && json.information.category;
        return {
            state: json.state,
            time: json.time,
            length: json.length,
            audioTracks: parseTracks(category, 'Audio'),
            subtitleTracks: parseTracks(category, 'Subtitle')
        };
    }

    async function sendCommand(command, params = {}) {
        const query = new URLSearchParams({ command, ...params }).toString();
        await request(host, port, password, '/requests/status.json?' + query);
    }

    return { getStatus, sendCommand };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: PASS (3 tests)

- [ ] **Step 7: Verify against real VLC output and adjust if needed**

This parsing is based on documented VLC HTTP JSON behavior, not yet checked against this project's actual VLC install. Once the Pi is reachable, confirm the real shape:

```
curl -u :<password> "http://127.0.0.1:9191/requests/status.json"
```

(start VLC manually with `--extraintf http --http-password=<password> --http-port=9191` first, matching Phase 1's other flags, playing any test file). Compare the real JSON's `information.category` entries against what `parseTracks` expects (`Type`, `Id`, `Language` fields) — if the real field names differ, update `parseTracks` and the test's fake JSON to match, then rerun Step 6.

- [ ] **Step 8: Commit**

```bash
cd /workspace/litefin-pi
git add phase3/bridge-daemon/package.json phase3/bridge-daemon/package-lock.json phase3/bridge-daemon/src/vlcHttpClient.js phase3/bridge-daemon/test/vlcHttpClient.test.js
git commit -m "Add VLC HTTP client module for the bridge daemon"
```

---

### Task 2: Display mode switcher

**Files:**
- Create: `phase3/bridge-daemon/src/displayMode.js`
- Test: `phase3/bridge-daemon/test/displayMode.test.js`

**Interfaces:**
- Produces: `createDisplayMode({ output, uiMode, playbackMode, execFileFn })` returning `{ setUiMode(), setPlaybackMode() }`, both async, both resolving to `undefined`.

- [ ] **Step 1: Write the failing test**

Create `/workspace/litefin-pi/phase3/bridge-daemon/test/displayMode.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisplayMode } from '../src/displayMode.js';

function fakeExecFile() {
    const calls = [];
    const fn = (cmd, args, callback) => {
        calls.push({ cmd, args });
        callback(null, '', '');
    };
    fn.calls = calls;
    return fn;
}

test('setUiMode runs wlr-randr with the configured UI mode', async () => {
    const execFileFn = fakeExecFile();
    const displayMode = createDisplayMode({
        output: 'HDMI-A-1',
        uiMode: '1920x1080@60.000000Hz',
        playbackMode: '4096x2160@30.000000Hz',
        execFileFn
    });

    await displayMode.setUiMode();

    assert.equal(execFileFn.calls.length, 1);
    assert.equal(execFileFn.calls[0].cmd, 'wlr-randr');
    assert.deepEqual(execFileFn.calls[0].args, ['--output', 'HDMI-A-1', '--mode', '1920x1080@60.000000Hz']);
});

test('setPlaybackMode runs wlr-randr with the configured playback mode', async () => {
    const execFileFn = fakeExecFile();
    const displayMode = createDisplayMode({
        output: 'HDMI-A-1',
        uiMode: '1920x1080@60.000000Hz',
        playbackMode: '4096x2160@30.000000Hz',
        execFileFn
    });

    await displayMode.setPlaybackMode();

    assert.deepEqual(execFileFn.calls[0].args, ['--output', 'HDMI-A-1', '--mode', '4096x2160@30.000000Hz']);
});

test('setUiMode resolves even if wlr-randr fails, rather than rejecting', async () => {
    const execFileFn = (cmd, args, callback) => callback(new Error('no compositor'), '', 'error');
    const displayMode = createDisplayMode({
        output: 'HDMI-A-1',
        uiMode: '1920x1080@60.000000Hz',
        playbackMode: '4096x2160@30.000000Hz',
        execFileFn
    });

    await assert.doesNotReject(() => displayMode.setUiMode());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: FAIL with "Cannot find module '../src/displayMode.js'"

- [ ] **Step 3: Write the implementation**

Create `/workspace/litefin-pi/phase3/bridge-daemon/src/displayMode.js`:

```javascript
export function createDisplayMode({ output, uiMode, playbackMode, execFileFn }) {
    function run(mode) {
        return new Promise((resolve) => {
            // Resolves even on failure - a display-mode switch failing should
            // never block playback (see spec's error handling section).
            execFileFn('wlr-randr', ['--output', output, '--mode', mode], () => resolve());
        });
    }

    return {
        setUiMode: () => run(uiMode),
        setPlaybackMode: () => run(playbackMode)
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: PASS (6 tests total)

- [ ] **Step 5: Commit**

```bash
cd /workspace/litefin-pi
git add phase3/bridge-daemon/src/displayMode.js phase3/bridge-daemon/test/displayMode.test.js
git commit -m "Add display mode switcher module for the bridge daemon"
```

---

### Task 3: VLC process lifecycle manager

**Files:**
- Create: `phase3/bridge-daemon/src/vlcProcess.js`
- Test: `phase3/bridge-daemon/test/vlcProcess.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createVlcProcess({ spawnFn, password, httpPort, audioDevice })` returning an `EventEmitter` with `start(url, { startSeconds })` and `stop()` methods. Emits `'exit'` with `(code)`, and `'spawned'` with no args when the child process is created.

- [ ] **Step 1: Write the failing test**

Create `/workspace/litefin-pi/phase3/bridge-daemon/test/vlcProcess.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createVlcProcess } from '../src/vlcProcess.js';

function fakeSpawn() {
    const child = new EventEmitter();
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    const fn = (cmd, args) => {
        fn.lastCall = { cmd, args };
        fn.lastChild = child;
        return child;
    };
    return fn;
}

test('start spawns vlc with the Phase 1 playback flags, http interface flags, and the url', () => {
    const spawnFn = fakeSpawn();
    const vlc = createVlcProcess({ spawnFn, password: 'sekrit', httpPort: 9191, audioDevice: 'plughw:CARD=vc4hdmi0,DEV=0' });

    vlc.start('http://server/stream.mkv', { startSeconds: 90 });

    assert.equal(spawnFn.lastCall.cmd, 'cvlc');
    const args = spawnFn.lastCall.args;
    assert.ok(args.includes('--vout=wl_dmabuf'));
    assert.ok(args.includes('--avcodec-hw=drm_avcodec'));
    assert.ok(args.includes('--aout=alsa'));
    assert.ok(args.includes('--alsa-audio-device=plughw:CARD=vc4hdmi0,DEV=0'));
    assert.ok(args.includes('--extraintf=http'));
    assert.ok(args.includes('--http-password=sekrit'));
    assert.ok(args.includes('--http-host=127.0.0.1'));
    assert.ok(args.includes('--http-port=9191'));
    assert.ok(args.includes('--play-and-exit'));
    assert.ok(args.includes('--start-time=90'));
    assert.ok(args.includes('http://server/stream.mkv'));
});

test('start emits spawned', () => {
    const spawnFn = fakeSpawn();
    const vlc = createVlcProcess({ spawnFn, password: 'x', httpPort: 9191, audioDevice: 'plughw:CARD=vc4hdmi0,DEV=0' });
    let spawned = false;
    vlc.on('spawned', () => { spawned = true; });

    vlc.start('http://server/stream.mkv', {});

    assert.equal(spawned, true);
});

test('child process exit is forwarded as exit event with the exit code', () => {
    const spawnFn = fakeSpawn();
    const vlc = createVlcProcess({ spawnFn, password: 'x', httpPort: 9191, audioDevice: 'plughw:CARD=vc4hdmi0,DEV=0' });
    let receivedCode = 'not called';
    vlc.on('exit', (code) => { receivedCode = code; });

    vlc.start('http://server/stream.mkv', {});
    spawnFn.lastChild.emit('exit', 0, null);

    assert.equal(receivedCode, 0);
});

test('stop kills the running child process', () => {
    const spawnFn = fakeSpawn();
    const vlc = createVlcProcess({ spawnFn, password: 'x', httpPort: 9191, audioDevice: 'plughw:CARD=vc4hdmi0,DEV=0' });
    let receivedCode = 'not called';
    vlc.on('exit', (code) => { receivedCode = code; });

    vlc.start('http://server/stream.mkv', {});
    vlc.stop();

    assert.equal(receivedCode, null);
});

test('start with no startSeconds omits --start-time', () => {
    const spawnFn = fakeSpawn();
    const vlc = createVlcProcess({ spawnFn, password: 'x', httpPort: 9191, audioDevice: 'plughw:CARD=vc4hdmi0,DEV=0' });

    vlc.start('http://server/stream.mkv', {});

    assert.ok(!spawnFn.lastCall.args.some((a) => a.startsWith('--start-time')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: FAIL with "Cannot find module '../src/vlcProcess.js'"

- [ ] **Step 3: Write the implementation**

Create `/workspace/litefin-pi/phase3/bridge-daemon/src/vlcProcess.js`:

```javascript
import { EventEmitter } from 'node:events';

export function createVlcProcess({ spawnFn, password, httpPort, audioDevice }) {
    const emitter = new EventEmitter();
    let child = null;

    emitter.start = (url, { startSeconds } = {}) => {
        const args = [
            '--vout=wl_dmabuf',
            '--avcodec-hw=drm_avcodec',
            '--aout=alsa',
            `--alsa-audio-device=${audioDevice}`,
            '--extraintf=http',
            `--http-password=${password}`,
            '--http-host=127.0.0.1',
            `--http-port=${httpPort}`,
            '--play-and-exit'
        ];
        if (startSeconds) {
            args.push(`--start-time=${startSeconds}`);
        }
        args.push(url);

        child = spawnFn('cvlc', args);
        child.on('exit', (code) => {
            child = null;
            emitter.emit('exit', code);
        });
        emitter.emit('spawned');
    };

    emitter.stop = () => {
        if (child) {
            child.kill();
        }
    };

    return emitter;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: PASS (11 tests total)

- [ ] **Step 5: Commit**

```bash
cd /workspace/litefin-pi
git add phase3/bridge-daemon/src/vlcProcess.js phase3/bridge-daemon/test/vlcProcess.test.js
git commit -m "Add VLC process lifecycle manager for the bridge daemon"
```

---

### Task 4: Session state machine

**Files:**
- Create: `phase3/bridge-daemon/src/session.js`
- Test: `phase3/bridge-daemon/test/session.test.js`

**Interfaces:**
- Consumes: a `createVlcProcess`-shaped factory (Task 3's `EventEmitter` interface: `start(url, {startSeconds})`, `stop()`, events `'spawned'`/`'exit'`), a `createVlcHttpClient`-shaped factory (Task 1's `{getStatus(), sendCommand()}`), a `createDisplayMode`-shaped instance (Task 2's `{setUiMode(), setPlaybackMode()}`).
- Produces: `class Session extends EventEmitter` with `async load({url, startPositionTicks, audioTrack, subtitleTrack})`, `async pause()`, `async resume()`, `async seek(ticks)`, `async setAudioTrack(index)`, `async setSubtitleTrack(index)`, `setIntroSkipperTimestamps({introStartTicks, introEndTicks})` (sync, writes the intro-skipper temp file), `async stop()`, `getCurrentState()` returning `{time, duration, paused}`. Emits `'playbackstart'`, `'playing'`, `'pause'`, `'timeupdate'` with `{time}`, `'ended'`, `'error'` with `{message}`, `'loadedmetadata'` with `{duration, audioTracks, subtitleTracks}`, `'upnext'`.

- [ ] **Step 1: Write the failing test**

Create `/workspace/litefin-pi/phase3/bridge-daemon/test/session.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Session } from '../src/session.js';

function fakeVlcProcess() {
    const emitter = new EventEmitter();
    emitter.start = (url, opts) => {
        emitter.startedWith = { url, opts };
        emitter.emit('spawned');
    };
    emitter.stop = () => {
        emitter.stopped = true;
        emitter.emit('exit', 0);
    };
    return emitter;
}

function fakeVlcHttpClient(statusQueue) {
    const sentCommands = [];
    return {
        sentCommands,
        async getStatus() {
            if (statusQueue.length === 0) throw new Error('connection refused');
            return statusQueue.shift();
        },
        async sendCommand(command, params) {
            sentCommands.push({ command, params });
        }
    };
}

function fakeDisplayMode() {
    const calls = [];
    return {
        calls,
        setUiMode: async () => { calls.push('ui'); },
        setPlaybackMode: async () => { calls.push('playback'); }
    };
}

function makeSession({ vlcProcess, httpClient, displayMode, pollIntervalMs = 5, upNextThresholdSeconds = 30, httpReadyAttempts = 3 } = {}) {
    vlcProcess = vlcProcess || fakeVlcProcess();
    httpClient = httpClient || fakeVlcHttpClient([{ state: 'playing', time: 0, length: 100, audioTracks: [], subtitleTracks: [] }]);
    displayMode = displayMode || fakeDisplayMode();
    const session = new Session({
        createVlcProcess: () => vlcProcess,
        createVlcHttpClient: () => httpClient,
        displayMode,
        pollIntervalMs,
        upNextThresholdSeconds,
        httpReadyAttempts,
        httpReadyRetryDelayMs: 1,
        generatePassword: () => 'fixed-test-password'
    });
    return { session, vlcProcess, httpClient, displayMode };
}

test('load switches to playback display mode, spawns vlc, and emits loadedmetadata + playbackstart once http is ready', async () => {
    const httpClient = fakeVlcHttpClient([
        { state: 'playing', time: 0, length: 7199, audioTracks: [{ id: '1', name: 'eng' }], subtitleTracks: [] }
    ]);
    const { session, vlcProcess, displayMode } = makeSession({ httpClient, pollIntervalMs: 100000 });
    const events = [];
    session.on('loadedmetadata', (data) => events.push(['loadedmetadata', data]));
    session.on('playbackstart', () => events.push(['playbackstart']));

    await session.load({ url: 'http://server/stream.mkv', startPositionTicks: 300000000 });

    assert.deepEqual(displayMode.calls, ['playback']);
    assert.equal(vlcProcess.startedWith.url, 'http://server/stream.mkv');
    assert.equal(vlcProcess.startedWith.opts.startSeconds, 30);
    assert.deepEqual(events[0], ['loadedmetadata', { duration: 7199, audioTracks: [{ id: '1', name: 'eng' }], subtitleTracks: [] }]);
    assert.deepEqual(events[1], ['playbackstart']);
});

test('load retries getStatus while the http interface is still starting', async () => {
    const httpClient = fakeVlcHttpClient([
        new Error('not ready yet'),
        { state: 'playing', time: 0, length: 100, audioTracks: [], subtitleTracks: [] }
    ].map((v) => v)); // first entry will throw when shifted and awaited below
    // Replace getStatus to throw on the first call specifically.
    let calls = 0;
    httpClient.getStatus = async () => {
        calls += 1;
        if (calls === 1) throw new Error('connection refused');
        return { state: 'playing', time: 0, length: 100, audioTracks: [], subtitleTracks: [] };
    };
    const { session } = makeSession({ httpClient, pollIntervalMs: 100000, httpReadyAttempts: 5 });

    await session.load({ url: 'http://server/stream.mkv' });

    assert.ok(calls >= 2);
});

test('load gives up and emits error if the http interface never comes up', async () => {
    const httpClient = { getStatus: async () => { throw new Error('connection refused'); }, sendCommand: async () => {} };
    const { session } = makeSession({ httpClient, httpReadyAttempts: 2, pollIntervalMs: 100000 });
    let error = null;
    session.on('error', (e) => { error = e; });

    await session.load({ url: 'http://server/stream.mkv' });

    assert.ok(error && /never became ready/.test(error.message));
});

test('polling emits timeupdate and upnext near the end', async () => {
    const httpClient = fakeVlcHttpClient([]);
    let call = 0;
    const statuses = [
        { state: 'playing', time: 0, length: 100, audioTracks: [], subtitleTracks: [] },
        { state: 'playing', time: 10, length: 100, audioTracks: [], subtitleTracks: [] },
        { state: 'playing', time: 80, length: 100, audioTracks: [], subtitleTracks: [] }
    ];
    httpClient.getStatus = async () => statuses[Math.min(call++, statuses.length - 1)];
    const { session } = makeSession({ httpClient, pollIntervalMs: 5, upNextThresholdSeconds: 30 });
    const timeupdates = [];
    let upnextFired = 0;
    session.on('timeupdate', (d) => timeupdates.push(d.time));
    session.on('upnext', () => { upnextFired += 1; });

    await session.load({ url: 'http://server/stream.mkv' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await session.stop();

    assert.ok(timeupdates.includes(10) || timeupdates.includes(80));
    assert.equal(upnextFired, 1);
});

test('stop sends pl_stop, kills vlc, and restores ui display mode', async () => {
    const { session, vlcProcess, httpClient, displayMode } = makeSession({ pollIntervalMs: 100000 });
    await session.load({ url: 'http://server/stream.mkv' });

    await session.stop();

    assert.equal(vlcProcess.stopped, true);
    assert.deepEqual(displayMode.calls, ['playback', 'ui']);
});

test('pause sends pl_pause command', async () => {
    const { session, httpClient } = makeSession({ pollIntervalMs: 100000 });
    await session.load({ url: 'http://server/stream.mkv' });

    await session.pause();

    assert.ok(httpClient.sentCommands.some((c) => c.command === 'pl_pause'));
});

test('seek converts jellyfin ticks to seconds and sends seek command', async () => {
    const { session, httpClient } = makeSession({ pollIntervalMs: 100000 });
    await session.load({ url: 'http://server/stream.mkv' });

    await session.seek(300000000);

    assert.deepEqual(httpClient.sentCommands.find((c) => c.command === 'seek'), { command: 'seek', params: { val: '30' } });
});

test('vlc exiting after reaching playing without an explicit stop emits ended and restores ui mode', async () => {
    const vlcProcess = fakeVlcProcess();
    const { session, displayMode } = makeSession({ vlcProcess, pollIntervalMs: 100000 });
    let ended = false;
    session.on('ended', () => { ended = true; });

    await session.load({ url: 'http://server/stream.mkv' });
    vlcProcess.emit('exit', 0);

    assert.equal(ended, true);
    assert.deepEqual(displayMode.calls, ['playback', 'ui']);
});

test('vlc exiting before ever reaching playing emits error instead of ended', async () => {
    const httpClient = { getStatus: async () => { throw new Error('connection refused'); }, sendCommand: async () => {} };
    const vlcProcess = fakeVlcProcess();
    const { session } = makeSession({ vlcProcess, httpClient, httpReadyAttempts: 1, pollIntervalMs: 100000 });
    let errorEmitted = false;
    let endedEmitted = false;
    session.on('error', () => { errorEmitted = true; });
    session.on('ended', () => { endedEmitted = true; });

    await session.load({ url: 'http://server/stream.mkv' });
    vlcProcess.emit('exit', 1);

    assert.equal(errorEmitted, true);
    assert.equal(endedEmitted, false);
});

test('getCurrentState reflects the last polled status', async () => {
    const httpClient = fakeVlcHttpClient([]);
    httpClient.getStatus = async () => ({ state: 'paused', time: 55, length: 100, audioTracks: [], subtitleTracks: [] });
    const { session } = makeSession({ httpClient, pollIntervalMs: 100000 });

    await session.load({ url: 'http://server/stream.mkv' });

    assert.deepEqual(session.getCurrentState(), { time: 55, duration: 100, paused: true });
});

test('stop called while load is still awaiting http-ready suppresses loadedmetadata/playbackstart', async () => {
    let resolveStatus;
    const httpClient = {
        getStatus: () => new Promise((resolve) => { resolveStatus = resolve; }),
        sendCommand: async () => {}
    };
    const { session } = makeSession({ httpClient, pollIntervalMs: 100000, httpReadyAttempts: 5 });
    const events = [];
    session.on('loadedmetadata', () => events.push('loadedmetadata'));
    session.on('playbackstart', () => events.push('playbackstart'));

    const loadPromise = session.load({ url: 'http://server/stream.mkv' });
    await session.stop();
    resolveStatus({ state: 'playing', time: 0, length: 100, audioTracks: [], subtitleTracks: [] });
    await loadPromise;

    assert.deepEqual(events, []);
});

test('load resets the intro-skipper file, and setIntroSkipperTimestamps writes converted seconds', async () => {
    const introSkipperFilePath = path.join(os.tmpdir(), `litefin-intro-skipper-test-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(introSkipperFilePath, JSON.stringify({ introStart: 999, introEnd: 1000 })); // stale leftover from a previous episode
    const { session } = makeSession({ pollIntervalMs: 100000 });
    session._introSkipperFilePath = introSkipperFilePath; // test-only override, see Session's constructor option of the same name

    await session.load({ url: 'http://server/stream.mkv' });
    assert.deepEqual(JSON.parse(fs.readFileSync(introSkipperFilePath, 'utf8')), {});

    session.setIntroSkipperTimestamps({ introStartTicks: 300000000, introEndTicks: 900000000 });
    assert.deepEqual(JSON.parse(fs.readFileSync(introSkipperFilePath, 'utf8')), { introStart: 30, introEnd: 90 });

    fs.unlinkSync(introSkipperFilePath);
});
```

This test sets `session._introSkipperFilePath` directly after construction rather than through `makeSession`'s options, because `makeSession` (defined above) doesn't thread an `introSkipperFilePath` option through to `new Session({...})` — reaching in directly is simpler than extending the shared test helper for one test. Add the following imports to the top of the test file, alongside the existing ones:

```javascript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: FAIL with "Cannot find module '../src/session.js'"

- [ ] **Step 3: Write the implementation**

Create `/workspace/litefin-pi/phase3/bridge-daemon/src/session.js`:

```javascript
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';

const TICKS_PER_SECOND = 10000000;

export class Session extends EventEmitter {
    constructor({
        createVlcProcess,
        createVlcHttpClient,
        displayMode,
        httpPort = 9191,
        pollIntervalMs = 250,
        upNextThresholdSeconds = 30,
        httpReadyAttempts = 25,
        httpReadyRetryDelayMs = 200,
        audioDevice = 'plughw:CARD=vc4hdmi0,DEV=0',
        introSkipperFilePath = '/tmp/litefin-intro-skipper.json',
        generatePassword = () => crypto.randomBytes(16).toString('hex')
    }) {
        super();
        this._createVlcProcess = createVlcProcess;
        this._createVlcHttpClient = createVlcHttpClient;
        this._displayMode = displayMode;
        this._httpPort = httpPort;
        this._pollIntervalMs = pollIntervalMs;
        this._upNextThresholdSeconds = upNextThresholdSeconds;
        this._httpReadyAttempts = httpReadyAttempts;
        this._httpReadyRetryDelayMs = httpReadyRetryDelayMs;
        this._audioDevice = audioDevice;
        this._introSkipperFilePath = introSkipperFilePath;
        this._generatePassword = generatePassword;

        this._vlcProcess = null;
        this._httpClient = null;
        this._pollTimer = null;
        this._stopping = false;
        this._everReachedPlaying = false;
        this._upNextFired = false;
        this._lastState = { time: 0, duration: 0, paused: true };
    }

    async load({ url, startPositionTicks = 0, audioTrack, subtitleTrack }) {
        // Clears any previous episode's markers immediately - skip-intro's own
        // segment fetch (Task 9) only resolves after this method returns, so
        // the Lua script polls this file throughout playback rather than
        // reading it once at VLC startup (see Global Constraints).
        this._writeIntroSkipperFile({});
        await this._displayMode.setPlaybackMode();
        if (this._stopping) return;

        const password = this._generatePassword();
        this._httpClient = this._createVlcHttpClient({ host: '127.0.0.1', port: this._httpPort, password });
        this._vlcProcess = this._createVlcProcess({ password, httpPort: this._httpPort, audioDevice: this._audioDevice });
        this._vlcProcess.on('exit', (code) => this._onVlcExit(code));

        const startSeconds = Math.floor(startPositionTicks / TICKS_PER_SECOND);
        this._vlcProcess.start(url, { startSeconds });

        const status = await this._waitForHttpReady();
        if (this._stopping) return;
        if (!status) {
            this.emit('error', { message: 'VLC HTTP interface never became ready' });
            return;
        }

        if (audioTrack !== undefined) {
            await this._httpClient.sendCommand('audio_track', { val: String(audioTrack) });
        }
        if (subtitleTrack !== undefined) {
            await this._httpClient.sendCommand('subtitle_track', { val: String(subtitleTrack) });
        }
        if (this._stopping) return;

        this._lastState = { time: status.time, duration: status.length, paused: status.state !== 'playing' };
        this.emit('loadedmetadata', { duration: status.length, audioTracks: status.audioTracks, subtitleTracks: status.subtitleTracks });
        this.emit('playbackstart');
        this._everReachedPlaying = true;

        this._startPolling();
    }

    async _waitForHttpReady() {
        for (let attempt = 0; attempt < this._httpReadyAttempts; attempt += 1) {
            try {
                return await this._httpClient.getStatus();
            } catch (err) {
                await new Promise((resolve) => setTimeout(resolve, this._httpReadyRetryDelayMs));
            }
        }
        return null;
    }

    _startPolling() {
        this._pollTimer = setInterval(() => this._poll(), this._pollIntervalMs);
    }

    async _poll() {
        let status;
        try {
            status = await this._httpClient.getStatus();
        } catch (err) {
            return;
        }

        this._lastState = { time: status.time, duration: status.length, paused: status.state !== 'playing' };

        if (status.state === 'playing') {
            this.emit('playing');
        } else if (status.state === 'paused') {
            this.emit('pause');
        }
        this.emit('timeupdate', { time: status.time });

        if (!this._upNextFired && status.length > 0 && status.length - status.time <= this._upNextThresholdSeconds) {
            this._upNextFired = true;
            this.emit('upnext');
        }
    }

    _stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    _onVlcExit(code) {
        this._stopPolling();
        const wasStopping = this._stopping;
        this._stopping = false;
        this._displayMode.setUiMode();
        if (wasStopping) return;
        if (this._everReachedPlaying && code === 0) {
            this.emit('ended');
        } else {
            this.emit('error', { message: `VLC exited unexpectedly (code ${code})` });
        }
    }

    async pause() {
        await this._httpClient.sendCommand('pl_pause');
    }

    async resume() {
        await this._httpClient.sendCommand('pl_play');
    }

    async seek(ticks) {
        const seconds = Math.floor(ticks / TICKS_PER_SECOND);
        await this._httpClient.sendCommand('seek', { val: String(seconds) });
    }

    async setAudioTrack(index) {
        await this._httpClient.sendCommand('audio_track', { val: String(index) });
    }

    async setSubtitleTrack(index) {
        await this._httpClient.sendCommand('subtitle_track', { val: String(index) });
    }

    async stop() {
        this._stopping = true;
        this._stopPolling();
        if (this._httpClient) {
            try { await this._httpClient.sendCommand('pl_stop'); } catch (err) { /* vlc may already be gone */ }
        }
        if (this._vlcProcess) {
            this._vlcProcess.stop();
        }
        await this._displayMode.setUiMode();
    }

    getCurrentState() {
        return this._lastState;
    }

    setIntroSkipperTimestamps({ introStartTicks, introEndTicks } = {}) {
        if (introStartTicks === undefined || introEndTicks === undefined) {
            this._writeIntroSkipperFile({});
            return;
        }
        this._writeIntroSkipperFile({
            introStart: introStartTicks / TICKS_PER_SECOND,
            introEnd: introEndTicks / TICKS_PER_SECOND
        });
    }

    _writeIntroSkipperFile(payload) {
        try {
            fs.writeFileSync(this._introSkipperFilePath, JSON.stringify(payload));
        } catch (err) {
            // Best-effort, matching this project's established "never block
            // playback over a display/side-channel failure" error handling.
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: PASS (23 tests total)

- [ ] **Step 5: Commit**

```bash
cd /workspace/litefin-pi
git add phase3/bridge-daemon/src/session.js phase3/bridge-daemon/test/session.test.js
git commit -m "Add session state machine tying VLC process, HTTP client, and display mode together"
```

---

### Task 5: WebSocket server

**Files:**
- Create: `phase3/bridge-daemon/src/server.js`
- Test: `phase3/bridge-daemon/test/server.test.js`

**Interfaces:**
- Consumes: a `Session`-shaped instance per connection (Task 4's `load/pause/resume/seek/setAudioTrack/setSubtitleTrack/setIntroSkipperTimestamps/stop` methods and events).
- Produces: `createServer({ port, createSession })` returning `{ close() }`. `createSession` is a factory called once per WebSocket connection, returning a fresh `Session`-shaped object.

- [ ] **Step 1: Write the failing test**

Create `/workspace/litefin-pi/phase3/bridge-daemon/test/server.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';

function fakeSession() {
    const session = new EventEmitter();
    session.calls = [];
    session.load = async (opts) => { session.calls.push(['load', opts]); };
    session.pause = async () => { session.calls.push(['pause']); };
    session.resume = async () => { session.calls.push(['resume']); };
    session.seek = async (ticks) => { session.calls.push(['seek', ticks]); };
    session.setAudioTrack = async (i) => { session.calls.push(['setAudioTrack', i]); };
    session.setSubtitleTrack = async (i) => { session.calls.push(['setSubtitleTrack', i]); };
    session.setIntroSkipperTimestamps = (ts) => { session.calls.push(['setIntroSkipperTimestamps', ts]); };
    session.stop = async () => { session.calls.push(['stop']); };
    return session;
}

function connect(port) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on('open', () => resolve(ws));
    });
}

function nextMessage(ws) {
    return new Promise((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
}

test('a load command is forwarded to a fresh session for the connection', async () => {
    let createdSession = null;
    const server = createServer({ port: 0, createSession: () => { createdSession = fakeSession(); return createdSession; } });
    const port = server.address().port;
    const ws = await connect(port);

    ws.send(JSON.stringify({ command: 'load', url: 'http://server/x.mkv', startPositionTicks: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(createdSession.calls[0], ['load', { url: 'http://server/x.mkv', startPositionTicks: 0 }]);

    ws.close();
    await server.close();
});

test('session events are forwarded to the client as json messages', async () => {
    let createdSession = null;
    const server = createServer({ port: 0, createSession: () => { createdSession = fakeSession(); return createdSession; } });
    const port = server.address().port;
    const ws = await connect(port);
    ws.send(JSON.stringify({ command: 'load', url: 'http://server/x.mkv' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const messagePromise = nextMessage(ws);
    createdSession.emit('timeupdate', { time: 42 });
    const message = await messagePromise;

    assert.deepEqual(message, { type: 'timeupdate', data: { time: 42 } });

    ws.close();
    await server.close();
});

test('pause, resume, seek, setAudioTrack, setSubtitleTrack, setIntroSkipperTimestamps, and stop commands reach the session', async () => {
    let createdSession = null;
    const server = createServer({ port: 0, createSession: () => { createdSession = fakeSession(); return createdSession; } });
    const port = server.address().port;
    const ws = await connect(port);
    ws.send(JSON.stringify({ command: 'load', url: 'http://server/x.mkv' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    ws.send(JSON.stringify({ command: 'pause' }));
    ws.send(JSON.stringify({ command: 'resume' }));
    ws.send(JSON.stringify({ command: 'seek', ticks: 300000000 }));
    ws.send(JSON.stringify({ command: 'setAudioTrack', index: 1 }));
    ws.send(JSON.stringify({ command: 'setSubtitleTrack', index: 2 }));
    ws.send(JSON.stringify({ command: 'setIntroSkipperTimestamps', introStartTicks: 300000000, introEndTicks: 900000000 }));
    ws.send(JSON.stringify({ command: 'stop' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(createdSession.calls.slice(1), [
        ['pause'],
        ['resume'],
        ['seek', 300000000],
        ['setAudioTrack', 1],
        ['setSubtitleTrack', 2],
        ['setIntroSkipperTimestamps', { introStartTicks: 300000000, introEndTicks: 900000000 }],
        ['stop']
    ]);

    ws.close();
    await server.close();
});

test('each connection gets its own session', async () => {
    const sessions = [];
    const server = createServer({ port: 0, createSession: () => { const s = fakeSession(); sessions.push(s); return s; } });
    const port = server.address().port;

    const ws1 = await connect(port);
    ws1.send(JSON.stringify({ command: 'load', url: 'a' }));
    const ws2 = await connect(port);
    ws2.send(JSON.stringify({ command: 'load', url: 'b' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sessions.length, 2);

    ws1.close();
    ws2.close();
    await server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: FAIL with "Cannot find module '../src/server.js'"

- [ ] **Step 3: Write the implementation**

Create `/workspace/litefin-pi/phase3/bridge-daemon/src/server.js`:

```javascript
import { WebSocketServer } from 'ws';

const EVENT_TYPES = ['playbackstart', 'playing', 'pause', 'timeupdate', 'ended', 'error', 'loadedmetadata', 'upnext'];

export function createServer({ port, createSession }) {
    const wss = new WebSocketServer({ host: '127.0.0.1', port });

    wss.on('connection', (ws) => {
        const session = createSession();

        for (const type of EVENT_TYPES) {
            session.on(type, (data) => {
                ws.send(JSON.stringify({ type, data }));
            });
        }

        ws.on('message', async (raw) => {
            const msg = JSON.parse(raw.toString());
            switch (msg.command) {
                case 'load':
                    await session.load({
                        url: msg.url,
                        startPositionTicks: msg.startPositionTicks,
                        audioTrack: msg.audioTrack,
                        subtitleTrack: msg.subtitleTrack
                    });
                    break;
                case 'pause':
                    await session.pause();
                    break;
                case 'resume':
                    await session.resume();
                    break;
                case 'seek':
                    await session.seek(msg.ticks);
                    break;
                case 'setAudioTrack':
                    await session.setAudioTrack(msg.index);
                    break;
                case 'setSubtitleTrack':
                    await session.setSubtitleTrack(msg.index);
                    break;
                case 'setIntroSkipperTimestamps':
                    session.setIntroSkipperTimestamps({ introStartTicks: msg.introStartTicks, introEndTicks: msg.introEndTicks });
                    break;
                case 'stop':
                    await session.stop();
                    break;
            }
        });

        ws.on('close', () => session.stop());
    });

    wss.address = () => wss.address();
    wss.close = () => new Promise((resolve) => wss.close(resolve));

    return wss;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && npm test`
Expected: PASS (27 tests total)

- [ ] **Step 5: Commit**

```bash
cd /workspace/litefin-pi
git add phase3/bridge-daemon/src/server.js phase3/bridge-daemon/test/server.test.js
git commit -m "Add WebSocket server wiring Litefin's commands/events to a Session per connection"
```

---

### Task 6: Daemon entry point and systemd packaging

**Files:**
- Create: `phase3/bridge-daemon/src/index.js`
- Create: `phase3/litefin-bridge.service`

**Interfaces:**
- Consumes: `createServer` (Task 5), `Session` (Task 4), `createVlcProcess` (Task 3), `createVlcHttpClient` (Task 1), `createDisplayMode` (Task 2).
- Produces: nothing consumed by later tasks — this is the real wiring, no mocks.

- [ ] **Step 1: Write the entry point**

Create `/workspace/litefin-pi/phase3/bridge-daemon/src/index.js`:

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

- [ ] **Step 2: Create the systemd unit**

Create `/workspace/litefin-pi/phase3/litefin-bridge.service`:

```ini
[Unit]
Description=Litefin VLC bridge daemon
After=network.target

[Service]
Type=simple
User=benalk
WorkingDirectory=/home/benalk/litefin-bridge
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Verify the entry point starts cleanly (manual, on the Pi)**

This can't be meaningfully tested without the real `wlr-randr`/`cvlc` binaries and a running `cage` session — defer to Task 10's end-to-end verification. For now, just confirm it starts without a syntax/import error:

Run: `cd /workspace/litefin-pi/phase3/bridge-daemon && node src/index.js &`
Expected: prints `litefin-bridge listening on ws://127.0.0.1:8082` and doesn't crash immediately (it's fine if `wlr-randr`/`pkill` aren't found in this sandbox — those failures are swallowed; the process should stay up). Then: `kill %1`

- [ ] **Step 4: Commit**

```bash
cd /workspace/litefin-pi
git add phase3/bridge-daemon/src/index.js phase3/litefin-bridge.service
git commit -m "Add bridge daemon entry point and systemd service"
```

---

### Task 7: VLC Lua interface script (skip-intro, Back/Escape)

**Files:**
- Create: `phase3/vlc-lua/intf/litefin.lua`

**Interfaces:**
- Consumes: a JSON file at a fixed path (`/tmp/litefin-intro-skipper.json`, reset to `{}` by the bridge daemon on every VLC spawn and rewritten live via `Session.setIntroSkipperTimestamps` once Task 9's skip-intro plugin resolves its segment fetch) with shape `{"introStart": <seconds>, "introEnd": <seconds>}` or `{}` if no intro markers exist for this item (or none have arrived yet). Polled every loop iteration, not read once at startup — see this task's Step 1 comment and the plan's Global Constraints for why.
- Produces: nothing consumed by other tasks — this runs inside VLC, not Node.

- [ ] **Step 1: Write the Lua script**

Create `/workspace/litefin-pi/phase3/vlc-lua/intf/litefin.lua`:

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
    elseif key == 'Enter' and prompt_shown then
        local input = vlc.object.input()
        if input then
            vlc.var.set(input, 'time', intro_end)
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
            if not prompt_shown then
                prompt_shown = true
            end
            vlc.osd.message('Skip Intro (press OK)', 1)
        elseif prompt_shown then
            prompt_shown = false
            vlc.osd.message('', 1)
        end
    end
    vlc.misc.mwait(vlc.misc.mdate() + 500000)
end
```

- [ ] **Step 2: Verify VLC's Lua interface API against this script (manual, on the Pi)**

VLC's Lua interface scripting API (`vlc.var`, `vlc.osd`, `activate`/`deactivate`, the `key-pressed` variable name, and how interface scripts actually get invoked — some VLC versions use a callback-registration model rather than a `while true do ... end` polling loop) is less commonly used/documented than mpv's, and this is the one part of the whole plan that couldn't be written against a confirmed-correct API surface (flagged as an open risk in the spec). Deploy and test on the Pi:

```
mkdir -p ~/.local/share/vlc/lua/intf
cp phase3/vlc-lua/intf/litefin.lua ~/.local/share/vlc/lua/intf/
cvlc --extraintf=luaintf --lua-intf=litefin <test-file-url>
```

Watch for: does the script load without a Lua error in VLC's console output? Does pressing Escape stop playback? With a test `/tmp/litefin-intro-skipper.json` containing plausible timestamps for the test file, does the "Skip Intro" OSD message appear in the right window? If the API calls don't match this VLC version's actual Lua interface (check VLC's own bundled Lua script examples, typically under `/usr/share/vlc/lua/intf/` on the Pi, for the real callback/registration pattern this VLC build expects), adjust the script's structure accordingly — this is expected iteration, not a sign the plan was wrong to attempt it.

- [ ] **Step 3: Commit**

```bash
cd /workspace/litefin-pi
git add phase3/vlc-lua/intf/litefin.lua
git commit -m "Add VLC Lua interface script for skip-intro and Back/Escape handling"
```

---

### Task 8: Litefin backend — `VlcBridgePlayer.js`

**Files:**
- Create: `litefin/src/player/core/VlcBridgePlayer.js`
- Test: `litefin/tests/VlcBridgePlayer.test.js`

**Interfaces:**
- Consumes: the WebSocket protocol from Task 5 (`{command, ...}` messages out, `{type, data}` messages in).
- Produces: `export class VlcBridgePlayer` with constructor `{container, settings, onEvent, wsUrl}`, `async play(options)` (where `options.url`, `options.playerStartPositionTicks`, `options.mediaSource`, `options.item` match the shape `HtmlVideoPlayer.js` already receives), `seek(positionTicks, options)` (called directly, not awaited, by `JellyfinPlayer.js` at `src/player/core/JellyfinPlayer.js:3315` — confirmed by reading that file, not assumed), `async stop()`, `destroy()`, `getCurrentTime()`, `getDuration()`, `isPaused()`, `isBuffering()`, `setMuted(muted)`, `isMuted()`, `setSubtitleStreamIndex(index)`, `setAudioStreamIndex(index)`, `supportsNativeAudioTracks()`, `setIntroSkipperTimestamps(introStartTicks, introEndTicks)` (sync, fire-and-forget over the WebSocket — called from Task 9's `JellyfinPlayer.setIntroSkipperTimestamps` forwarding method, itself called by the skip-intro plugin once its segment fetch resolves, which is after `play()` has already returned).

- [ ] **Step 1: Write the failing test**

Create `/workspace/litefin-pi/litefin/tests/VlcBridgePlayer.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket, WebSocketServer } from 'ws';

// Node 20 has no global WebSocket client without an experimental flag;
// Chromium (where VlcBridgePlayer.js actually runs in production) has one
// natively, so this polyfill is test-environment-only, verified against
// the real `ws` package rather than assumed.
globalThis.WebSocket = WebSocket;

import { VlcBridgePlayer } from '../src/player/core/VlcBridgePlayer.js';

function startFakeBridge() {
    const received = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    let socket = null;
    let connectionCount = 0;
    wss.on('connection', (ws) => {
        socket = ws;
        connectionCount += 1;
        ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    });
    return {
        port: wss.address().port,
        received,
        send: (type, data) => socket.send(JSON.stringify({ type, data })),
        disconnectClient: () => socket.close(),
        getConnectionCount: () => connectionCount,
        close: () => new Promise((resolve) => wss.close(resolve))
    };
}

function waitUntil(fn, timeoutMs = 1000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const check = () => {
            if (fn()) return resolve();
            if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting'));
            setTimeout(check, 5);
        };
        check();
    });
}

test('play sends a load command with url, start position in ticks, and tracks', async () => {
    const bridge = startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });

    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 300000000 });
    await waitUntil(() => bridge.received.length > 0);

    assert.deepEqual(bridge.received[0], { command: 'load', url: 'http://server/x.mkv', startPositionTicks: 300000000 });

    player.destroy();
    await bridge.close();
});

test('loadedmetadata event updates getDuration and fires onEvent', async () => {
    const bridge = startFakeBridge();
    const events = [];
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: (e) => events.push(e), wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    bridge.send('loadedmetadata', { duration: 7199, audioTracks: [], subtitleTracks: [] });
    await waitUntil(() => player.getDuration() === 7199);

    assert.ok(events.some((e) => e.type === 'loadedmetadata'));

    player.destroy();
    await bridge.close();
});

test('timeupdate event updates getCurrentTime', async () => {
    const bridge = startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    bridge.send('timeupdate', { time: 42 });
    await waitUntil(() => player.getCurrentTime() === 42);

    player.destroy();
    await bridge.close();
});

test('pause and playing events update isPaused', async () => {
    const bridge = startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    bridge.send('pause', {});
    await waitUntil(() => player.isPaused() === true);
    bridge.send('playing', {});
    await waitUntil(() => player.isPaused() === false);

    player.destroy();
    await bridge.close();
});

test('setSubtitleStreamIndex and setAudioStreamIndex send the right commands', async () => {
    const bridge = startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    player.setSubtitleStreamIndex(3);
    player.setAudioStreamIndex(2);
    await waitUntil(() => bridge.received.length >= 3);

    assert.deepEqual(bridge.received[1], { command: 'setSubtitleTrack', index: 3 });
    assert.deepEqual(bridge.received[2], { command: 'setAudioTrack', index: 2 });

    player.destroy();
    await bridge.close();
});

test('stop sends a stop command', async () => {
    const bridge = startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    await player.stop();
    await waitUntil(() => bridge.received.length >= 2);

    assert.deepEqual(bridge.received[1], { command: 'stop' });

    player.destroy();
    await bridge.close();
});

test('ended event forwards onEvent with type ended', async () => {
    const bridge = startFakeBridge();
    const events = [];
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: (e) => events.push(e), wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    bridge.send('ended', {});
    await waitUntil(() => events.some((e) => e.type === 'ended'));

    player.destroy();
    await bridge.close();
});

test('seek sends a seek command with the given ticks, matching how JellyfinPlayer.js calls it (not awaited)', async () => {
    const bridge = startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    player.seek(300000000, {});
    await waitUntil(() => bridge.received.length >= 2);

    assert.deepEqual(bridge.received[1], { command: 'seek', ticks: 300000000 });

    player.destroy();
    await bridge.close();
});

test('reconnects after the bridge connection drops, and re-sends the current load state', async () => {
    const bridge = startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}`, reconnectDelayMs: 5 });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    bridge.disconnectClient();
    await waitUntil(() => bridge.getConnectionCount() === 2, 2000);
    await waitUntil(() => bridge.received.length >= 2, 2000);

    assert.deepEqual(bridge.received[1], { command: 'load', url: 'http://server/x.mkv', startPositionTicks: 0 });

    player.destroy();
    await bridge.close();
});

test('surfaces an error event only after repeated reconnect failures, not on the first drop', async () => {
    const events = [];
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: (e) => events.push(e), wsUrl: 'ws://127.0.0.1:1', reconnectDelayMs: 5, maxReconnectAttempts: 3 });

    await assert.rejects(() => player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 }));
    await waitUntil(() => events.some((e) => e.type === 'error'), 2000);

    player.destroy();
});

test('setIntroSkipperTimestamps sends the ticks over the websocket', async () => {
    const bridge = startFakeBridge();
    const player = new VlcBridgePlayer({ container: null, settings: null, onEvent: () => {}, wsUrl: `ws://127.0.0.1:${bridge.port}` });
    await player.play({ url: 'http://server/x.mkv', playerStartPositionTicks: 0 });
    await waitUntil(() => bridge.received.length > 0);

    player.setIntroSkipperTimestamps(300000000, 900000000);
    await waitUntil(() => bridge.received.length >= 2);

    assert.deepEqual(bridge.received[1], { command: 'setIntroSkipperTimestamps', introStartTicks: 300000000, introEndTicks: 900000000 });

    player.destroy();
    await bridge.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/litefin-pi/litefin && node --test tests/VlcBridgePlayer.test.js`
Expected: FAIL with "Cannot find module '../src/player/core/VlcBridgePlayer.js'"

- [ ] **Step 3: Write the implementation**

Create `/workspace/litefin-pi/litefin/src/player/core/VlcBridgePlayer.js`:

```javascript
import { logger } from '../../utils/Logger.js';

const log = logger.create('VlcBridgePlayer');

export class VlcBridgePlayer {
    constructor(options) {
        this.container = options.container;
        this.settings = options.settings;
        this.onEvent = options.onEvent || (() => {});
        this._wsUrl = options.wsUrl || 'ws://127.0.0.1:8082';
        this._reconnectDelayMs = options.reconnectDelayMs || 1000;
        this._maxReconnectAttempts = options.maxReconnectAttempts || 5;

        this._ws = null;
        this._destroyed = false;
        this._reconnectAttempts = 0;
        this._currentPlayOptions = null;
        this._duration = 0;
        this._currentTime = 0;
        this._paused = true;
        this._muted = false;
        this._audioTracks = [];
        this._subtitleTracks = [];
    }

    async play(options) {
        this._currentPlayOptions = options;
        this._reconnectAttempts = 0;
        await this._connectWithRetry();
    }

    _connectWithRetry() {
        return new Promise((resolve, reject) => {
            const attempt = () => {
                if (this._destroyed) return;
                this._ws = new WebSocket(this._wsUrl);
                let settled = false;

                this._ws.addEventListener('open', () => {
                    settled = true;
                    this._reconnectAttempts = 0;
                    this._sendLoad();
                    resolve();
                }, { once: true });

                this._ws.addEventListener('message', (event) => this._handleMessage(event));

                this._ws.addEventListener('close', () => {
                    if (this._destroyed) return;
                    this._reconnectAttempts += 1;
                    if (this._reconnectAttempts > this._maxReconnectAttempts) {
                        const message = 'Bridge daemon connection lost after repeated reconnect attempts';
                        this.onEvent({ type: 'error', data: { message } });
                        if (!settled) reject(new Error(message));
                        return;
                    }
                    setTimeout(attempt, this._reconnectDelayMs);
                });
            };
            attempt();
        });
    }

    _sendLoad() {
        this._send({
            command: 'load',
            url: this._currentPlayOptions.url,
            startPositionTicks: this._currentPlayOptions.playerStartPositionTicks || 0,
            audioTrack: this._currentPlayOptions.audioStreamIndex,
            subtitleTrack: this._currentPlayOptions.subtitleStreamIndex
        });
    }

    seek(positionTicks, options) {
        this._send({ command: 'seek', ticks: positionTicks });
    }

    _send(message) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(message));
        }
    }

    _handleMessage(event) {
        const { type, data } = JSON.parse(event.data);

        switch (type) {
            case 'loadedmetadata':
                this._duration = data.duration;
                this._audioTracks = data.audioTracks;
                this._subtitleTracks = data.subtitleTracks;
                break;
            case 'timeupdate':
                this._currentTime = data.time;
                break;
            case 'pause':
                this._paused = true;
                break;
            case 'playing':
                this._paused = false;
                break;
        }

        log.debug(`Event: ${type}`);
        this.onEvent({ type, data });
    }

    async stop() {
        this._send({ command: 'stop' });
    }

    destroy() {
        this._destroyed = true;
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }
    }

    getCurrentTime() {
        return this._currentTime;
    }

    getDuration() {
        return this._duration;
    }

    isPaused() {
        return this._paused;
    }

    isBuffering() {
        return false;
    }

    setMuted(muted) {
        this._muted = muted;
    }

    isMuted() {
        return this._muted;
    }

    setSubtitleStreamIndex(index) {
        this._send({ command: 'setSubtitleTrack', index });
    }

    setAudioStreamIndex(index) {
        this._send({ command: 'setAudioTrack', index });
    }

    setIntroSkipperTimestamps(introStartTicks, introEndTicks) {
        this._send({ command: 'setIntroSkipperTimestamps', introStartTicks, introEndTicks });
    }

    supportsNativeAudioTracks() {
        return true;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Note: this test needs the `ws` package available to the Litefin project for the *test's own fake server* (production `VlcBridgePlayer.js` uses the browser's native global `WebSocket`, not `ws`). Add it as a dev dependency first:

Run: `cd /workspace/litefin-pi/litefin && npm install --save-dev ws`

Then: `cd /workspace/litefin-pi/litefin && node --test tests/VlcBridgePlayer.test.js`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
cd /workspace/litefin-pi/litefin
git add package.json package-lock.json src/player/core/VlcBridgePlayer.js tests/VlcBridgePlayer.test.js
git commit -m "Add VlcBridgePlayer backend talking to the bridge daemon over WebSocket"
```

---

### Task 9: Wire the backend into JellyfinPlayer, add the Linux device profile

**Files:**
- Modify: `litefin/src/player/core/JellyfinPlayer.js`
- Modify: `litefin/src/api/DeviceProfile.js`
- Modify: `litefin/src/plugins/installed/skip-intro/index.js`
- Create: `litefin/src/api/profiles/LinuxProfile.js`
- Test: `litefin/tests/SkipIntroBridgeForwarding.test.js`

**Interfaces:**
- Consumes: `VlcBridgePlayer` (Task 8, including `setIntroSkipperTimestamps`), `platformInfo.isLinuxKiosk` (Phase 2's `src/utils/PlatformInfo.js`), the existing `skip-intro` plugin's `_introSegment` array and `PlayerSettings.get('skipActionIntro')` (both already in `litefin/src/plugins/installed/skip-intro/index.js` — read, not newly invented).
- Produces: `JellyfinPlayer.prototype.setIntroSkipperTimestamps(introStartTicks, introEndTicks)`, a backend-agnostic forwarding method — nothing else in this plan consumes it, but it's the integration point this task wires the plugin to.

**Why this task also touches the skip-intro plugin:** the spec originally assumed the bridge daemon could just receive Intro Skipper timestamps as part of `play()`. Reading `litefin/src/pages/PlayerPage.js` during planning showed that's not how segment data actually becomes available — the existing `skip-intro` plugin fetches segments (3-tier fallback: modern `/MediaSegments` API, legacy intro-skipper endpoints, chapter markers; cached per-item; gated by the user's `skipActionIntro` setting) in its `onPlayerStart` hook, which only runs *after* `backend.play()` has already resolved. Reimplementing that fetch logic standalone would risk diverging from the real plugin (e.g. showing a VLC-side prompt even when the user set `skipActionIntro` to `'None'`). So this task extends the existing plugin to forward its already-fetched data through `JellyfinPlayer`, rather than duplicating the fetch. Only `'AskToSkip'` forwards anything — `'Skip'` already auto-skips on every platform today via the plugin's own `onTimeUpdate`/`player.seek()` polling, which needs no changes and keeps working for the VLC backend exactly as it does for every other backend.

- [ ] **Step 1: Read the existing WebProfile.js for the exact BaseProfile/capabilities pattern**

Run: `cat /workspace/litefin-pi/litefin/src/api/profiles/WebProfile.js`

Use this as the template for Step 2 — match its structure (cached capabilities, `getDeviceCapabilities()`, a function building the Jellyfin profile from `BaseProfile` helpers) rather than inventing a different shape.

- [ ] **Step 2: Create LinuxProfile.js**

Create `/workspace/litefin-pi/litefin/src/api/profiles/LinuxProfile.js`, following `WebProfile.js`'s structure but declaring VLC's actual tested capabilities (from `phase1/test-matrix.md` and the plan's device-profile table) instead of a generic browser's:

```javascript
import { BaseProfile } from './BaseProfile.js';

let _cachedCapabilities = null;

export function getDeviceCapabilities() {
    if (_cachedCapabilities) return _cachedCapabilities;

    _cachedCapabilities = {
        modelName: 'Litefin Linux Kiosk (Raspberry Pi)',
        deviceId: BaseProfile.getFallbackDeviceId('litefin_linux_'),
        screenWidth: 1920,
        screenHeight: 1080,
        uhd: true,
        uhd8K: false,
        hdr10: false,
        hdr10Plus: false,
        hlg: false,
        dolbyVision: true,
        hevc: true,
        av1: false,
        vp9: false,
        vp8: false,
        ac3: true,
        eac3: true,
        dts: true,
        truehd: true,
        mpeg2video: true,
        mpegts: true,
        mp2: true,
        maxAudioChannels: 8
    };
    return _cachedCapabilities;
}

export function clearCapabilitiesCache() {
    _cachedCapabilities = null;
}

export function buildJellyfinProfile(options = {}) {
    const caps = getDeviceCapabilities();
    return BaseProfile.buildProfile({
        ...options,
        capabilities: caps,
        maxVideoWidth: caps.uhd ? 3840 : 1920,
        maxVideoHeight: caps.uhd ? 2160 : 1080,
        videoCodecs: ['hevc', 'h264'],
        audioCodecs: ['aac', 'mp3', 'flac', 'opus', 'ac3', 'eac3', 'dts', 'truehd'],
        containers: ['mkv', 'mp4', 'm4v', 'ts'],
        subtitleFormats: ['srt', 'ass', 'ssa', 'pgs', 'vobsub']
    });
}

export function getDeviceId() {
    return getDeviceCapabilities().deviceId;
}

export function getDeviceName() {
    return getDeviceCapabilities().modelName;
}

export default {
    getDeviceCapabilities,
    clearCapabilitiesCache,
    buildJellyfinProfile,
    getDeviceId,
    getDeviceName
};
```

**Note:** `BaseProfile.buildProfile`'s exact parameter names need to be checked against `BaseProfile.js` and reconciled with this task's code before testing — this was written from `WebProfile.js`'s usage pattern, not a direct read of `BaseProfile.js` itself. Read `/workspace/litefin-pi/litefin/src/api/profiles/BaseProfile.js` and adjust the call in `buildJellyfinProfile` to match its actual accepted options if they differ.

- [ ] **Step 3: Wire LinuxProfile into DeviceProfile.js**

Read `/workspace/litefin-pi/litefin/src/api/DeviceProfile.js` and find `getActiveProfileModule()` (around line 19-25, per earlier exploration: `if (platformInfo.isAndroid) return AndroidProfile; if (platformInfo.isWebOS) return WebOSProfile; if (platformInfo.isTizen) return TizenProfile;` falling through to `WebProfile`). Add an import for `LinuxProfile` at the top of the file, and add `if (platformInfo.isLinuxKiosk) return LinuxProfile;` as a new branch, checked before the final fallthrough to `WebProfile` (matching the same ordering principle used in `App.js`'s adapter selection from Phase 2 — `isLinuxKiosk` must be checked, and must not accidentally fall through to the generic Web case).

- [ ] **Step 4: Wire VlcBridgePlayer into JellyfinPlayer.js's backend selection**

Read `/workspace/litefin-pi/litefin/src/player/core/JellyfinPlayer.js` around the two places identified during design: the "Fallback: HtmlVideoPlayer" block (~line 1418: `if (platformInfo.isDesktop || platformInfo.isWeb) { ... }`) and the "Auto-detect: Desktop platform or Web browser with WebCodecs support -> MoviVideoPlayer" block (~line 1557). Add an import for `VlcBridgePlayer` at the top of the file. In both blocks, add an explicit `if (platformInfo.isLinuxKiosk) { this._backend = new VlcBridgePlayer(sharedOptions); return; }`-style branch *before* the existing `isDesktop || isWeb` checks, so our platform never reaches the `MoviVideoPlayer` auto-detect or the `HtmlVideoPlayer` fallback (confirmed in Phase 2 that `isWeb` being true for us would wrongly select `MoviVideoPlayer`, which we already proved unusably slow on this hardware — this is why the explicit early branch matters, not just appending another `||` condition to the existing checks).

- [ ] **Step 5: Add the backend-agnostic forwarding method to JellyfinPlayer**

Add this method to the `JellyfinPlayer` class in `litefin/src/player/core/JellyfinPlayer.js` (near `seek`, which is the method this most resembles — fire-and-forget, delegates to whatever backend is active):

```javascript
    setIntroSkipperTimestamps(introStartTicks, introEndTicks) {
        if (typeof this._backend?.setIntroSkipperTimestamps === 'function') {
            this._backend.setIntroSkipperTimestamps(introStartTicks, introEndTicks);
        }
    }
```

No platform/`isLinuxKiosk` check needed here — it's plain duck typing. Today only `VlcBridgePlayer` implements `setIntroSkipperTimestamps`, so this is a no-op for every other backend without needing to know their types.

- [ ] **Step 6: Write the failing test for the forwarding decision**

Create `/workspace/litefin-pi/litefin/tests/SkipIntroBridgeForwarding.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldForwardIntroToBridge } from '../src/plugins/installed/skip-intro/index.js';

test('forwards when there is an intro segment and the action is AskToSkip', () => {
    assert.equal(shouldForwardIntroToBridge([{ start: 0, end: 900000000 }], 'AskToSkip'), true);
});

test('does not forward when the action is Skip (auto-skip already handles it with no UI)', () => {
    assert.equal(shouldForwardIntroToBridge([{ start: 0, end: 900000000 }], 'Skip'), false);
});

test('does not forward when the action is None', () => {
    assert.equal(shouldForwardIntroToBridge([{ start: 0, end: 900000000 }], 'None'), false);
});

test('does not forward when there is no intro segment for this item', () => {
    assert.equal(shouldForwardIntroToBridge([], 'AskToSkip'), false);
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd /workspace/litefin-pi/litefin && node --test tests/SkipIntroBridgeForwarding.test.js`
Expected: FAIL — `shouldForwardIntroToBridge` is not exported from `skip-intro/index.js` yet.

- [ ] **Step 8: Export the pure decision function and wire it into `onPlayerStart`**

In `litefin/src/plugins/installed/skip-intro/index.js`, add this exported function near the top of the file (after the existing imports, before `SEGMENT_TYPES`):

```javascript
export function shouldForwardIntroToBridge(introSegment, skipActionIntro) {
    return introSegment.length > 0 && skipActionIntro === 'AskToSkip';
}
```

Then, inside `onPlayerStart(item, api)`, immediately after the existing `await this._loadSegments(item, api);` line, add:

```javascript
        if (shouldForwardIntroToBridge(this._introSegment, PlayerSettings.get('skipActionIntro'))) {
            api.getPlayer()?.setIntroSkipperTimestamps?.(this._introSegment[0].start, this._introSegment[0].end);
        }
```

`this._introSegment[0]` is safe here because `shouldForwardIntroToBridge` already checked `introSegment.length > 0`. `api.getPlayer()` returns the active `JellyfinPlayer` (confirmed by reading `litefin/src/plugins/PluginAPI.js`'s `getPlayer()`); the `?.setIntroSkipperTimestamps?.()` optional chain means this is silently a no-op on every platform except the one with Step 5's new method — the plugin itself stays platform-agnostic, matching its existing style (it already doesn't check `platformInfo` anywhere).

- [ ] **Step 9: Run test to verify it passes**

Run: `cd /workspace/litefin-pi/litefin && node --test tests/SkipIntroBridgeForwarding.test.js`
Expected: PASS (4 tests)

- [ ] **Step 10: Verify the build succeeds**

Run: `cd /workspace/litefin-pi/litefin && npm run build:web`
Expected: builds without error. If `BaseProfile.buildProfile`'s signature didn't match what Step 2 assumed, this is where it'll surface — fix `LinuxProfile.js` to match and rerun.

- [ ] **Step 11: Commit**

```bash
cd /workspace/litefin-pi/litefin
git add src/player/core/JellyfinPlayer.js src/api/DeviceProfile.js src/api/profiles/LinuxProfile.js src/plugins/installed/skip-intro/index.js tests/SkipIntroBridgeForwarding.test.js
git commit -m "Wire VlcBridgePlayer and LinuxProfile into JellyfinPlayer/DeviceProfile selection, forward intro-skipper timestamps from the existing skip-intro plugin"
```

---

### Task 10: End-to-end verification on the Pi

**Files:** none (deployment + manual verification only)

**Interfaces:** none — this task verifies the whole system built in Tasks 1-9 together.

- [ ] **Step 1: Deploy the bridge daemon**

From your laptop:
```
scp -r ~/Documents/projects/litefin-pi/phase3/bridge-daemon benalk@litefin-pi.local:~/litefin-bridge
scp ~/Documents/projects/litefin-pi/phase3/litefin-bridge.service benalk@litefin-pi.local:/tmp/
```
On the Pi:
```
cd ~/litefin-bridge && npm install --omit=dev
sudo cp /tmp/litefin-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now litefin-bridge
systemctl status litefin-bridge --no-pager
```
Expected: `active (running)`, log line `litefin-bridge listening on ws://127.0.0.1:8082`.

- [ ] **Step 2: Deploy the Litefin-side changes and rebuild**

```
scp ~/Documents/projects/litefin-pi/litefin/src/player/core/VlcBridgePlayer.js benalk@litefin-pi.local:~/litefin/src/player/core/
scp ~/Documents/projects/litefin-pi/litefin/src/player/core/JellyfinPlayer.js benalk@litefin-pi.local:~/litefin/src/player/core/
scp ~/Documents/projects/litefin-pi/litefin/src/api/DeviceProfile.js benalk@litefin-pi.local:~/litefin/src/api/
scp ~/Documents/projects/litefin-pi/litefin/src/api/profiles/LinuxProfile.js benalk@litefin-pi.local:~/litefin/src/api/profiles/
```
On the Pi (clean rebuild, per the Phase 2 `runtimeChunk`/caching lesson — don't skip the cache clear):
```
cd ~/litefin
rm -rf node_modules/.cache dist
npm run build:web
sudo systemctl restart litefin-server litefin-kiosk
```

- [ ] **Step 3: Deploy the VLC Lua script**

```
scp -r ~/Documents/projects/litefin-pi/phase3/vlc-lua benalk@litefin-pi.local:/tmp/
ssh benalk@litefin-pi.local "mkdir -p ~/.local/share/vlc/lua/intf && cp /tmp/vlc-lua/intf/litefin.lua ~/.local/share/vlc/lua/intf/"
```

- [ ] **Step 4: Verify play/pause/resume/seek**

On the TV, pick a test file and press play. Confirm: video and audio play (not just a black screen — check against the Phase 1 test matrix files, start with the 1080p H.264 one, not the hardest 4K HDR10 file, to isolate bridge-specific bugs from decode-specific ones already solved in Phase 1). Pause and resume via the remote. Seek forward/back. Check `systemctl status litefin-bridge` and `journalctl -u litefin-bridge -f` for errors if anything doesn't respond.

- [ ] **Step 5: Verify resume/watched-status round-trip with Jellyfin**

Play a file partway, stop (Back button), check in Jellyfin's web UI or admin dashboard that the item shows a resume position matching where you stopped. Play it again from Litefin and confirm it resumes from that position (this exercises `playerStartPositionTicks` all the way through).

- [ ] **Step 6: Verify audio/subtitle track switching**

Using a file with multiple tracks (from the Phase 1 test library), switch audio and subtitle tracks via Litefin's UI during playback and confirm VLC actually switches (listen for a different audio track if there's a clear difference; check subtitles visually).

- [ ] **Step 7: Verify skip-intro**

First, in Litefin's settings, confirm `skipActionIntro` is set to `AskToSkip` (not `Skip` — auto-skip needs no VLC-side prompt and already worked before this phase). Using a file with Intro Skipper markers configured on the Jellyfin server, confirm `/tmp/litefin-intro-skipper.json` on the Pi starts as `{}` right after VLC spawns, then gets filled in with real `introStart`/`introEnd` seconds shortly after (`watch -n1 cat /tmp/litefin-intro-skipper.json` while starting playback is the quickest way to see this). Confirm the "Skip Intro" OSD prompt appears during the intro window once the file has real values, and that confirming it (OK/Enter) seeks past the intro.

- [ ] **Step 8: Verify Up Next**

Play an episode near its end and confirm Litefin receives the `upnext` event and shows its Up Next dialog (per the plan's existing `UpNextDialog.js`).

- [ ] **Step 9: Verify Back returns cleanly to Litefin**

Press Back/Escape during active playback and confirm: VLC stops, the display switches back to 1080p, and Litefin's UI is visible and responsive again (not stuck on a black screen or frozen).

- [ ] **Step 10: Record results in tracking.md**

Update `/workspace/litefin-pi/docs/tracking.md`'s Phase 3 checklist and add a session notes entry documenting what worked, what needed adjustment (especially the VLC HTTP JSON schema from Task 1 Step 7 and the Lua API from Task 7 Step 2, which were both flagged as needing empirical verification), following the same pattern as every other phase's notes in that file.

- [ ] **Step 11: Commit the tracking update**

```bash
cd /workspace/litefin-pi
git add docs/tracking.md
git commit -m "Record Phase 3 end-to-end verification results"
```
