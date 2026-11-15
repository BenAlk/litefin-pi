import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRemoteKey } from '../src/remoteInputActions.js';

function fakeSession({ paused = true, time = 0, introWindowActive = false } = {}) {
    const calls = [];
    return {
        calls,
        stop: () => calls.push(['stop']),
        stopFromRemote: () => calls.push(['stopFromRemote']),
        pause: () => calls.push(['pause']),
        resume: () => calls.push(['resume']),
        seek: (ticks) => calls.push(['seek', ticks]),
        getCurrentState: () => ({ time, duration: 1000, paused }),
        isIntroWindowActive: () => introWindowActive,
        seekPastIntro: () => calls.push(['seekPastIntro'])
    };
}

test('KEY_ESC stops the current session via stopFromRemote, so Litefin learns the stop happened', () => {
    const session = fakeSession();
    handleRemoteKey('KEY_ESC', () => session);
    assert.deepEqual(session.calls, [['stopFromRemote']]);
});

test('KEY_INSERT (Home) also stops the current session via stopFromRemote', () => {
    const session = fakeSession();
    handleRemoteKey('KEY_INSERT', () => session);
    assert.deepEqual(session.calls, [['stopFromRemote']]);
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
