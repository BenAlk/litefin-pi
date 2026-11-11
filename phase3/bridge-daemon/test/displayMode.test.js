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
