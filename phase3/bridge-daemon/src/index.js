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
