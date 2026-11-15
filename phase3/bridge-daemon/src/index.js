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
