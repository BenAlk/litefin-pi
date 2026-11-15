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
