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
    assert.ok(args.includes('--extraintf=http,luaintf'));
    assert.ok(args.includes('--http-password=sekrit'));
    assert.ok(args.includes('--http-host=127.0.0.1'));
    assert.ok(args.includes('--http-port=9191'));
    assert.ok(args.includes('--lua-intf=litefin'));
    assert.ok(args.includes('--mouse-hide-timeout=1'));
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
