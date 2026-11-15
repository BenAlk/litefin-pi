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
