import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('stop racing load before vlcProcess is assigned still kills the vlcProcess once load creates it', async () => {
    // Unlike fakeVlcProcess(), this fake does not synchronously self-emit
    // 'exit' from stop() - it just records the call, matching the real
    // vlcProcess.js module's actual async-kill semantics (sends a kill
    // signal, waits for the OS process to exit on its own).
    const vlcProcess = new EventEmitter();
    vlcProcess.start = (url, opts) => { vlcProcess.startedWith = { url, opts }; };
    vlcProcess.stop = () => { vlcProcess.stopped = true; };

    let resolveStatus;
    const httpClient = {
        getStatus: () => new Promise((resolve) => { resolveStatus = resolve; }),
        sendCommand: async () => {}
    };
    const { session } = makeSession({ vlcProcess, httpClient, pollIntervalMs: 100000, httpReadyAttempts: 5 });

    const loadPromise = session.load({ url: 'http://server/stream.mkv' });
    await session.stop();
    resolveStatus({ state: 'playing', time: 0, length: 100, audioTracks: [], subtitleTracks: [] });
    await loadPromise;

    assert.equal(vlcProcess.stopped, true);
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
