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
            // A second, repeated --extraintf flag REPLACES this one rather
            // than adding to it (confirmed on real hardware - Task 10: the
            // HTTP interface silently stopped responding entirely once a
            // second --extraintf=luaintf flag was added this way). Both
            // interfaces must be comma-joined in a single flag instead.
            '--extraintf=http,luaintf',
            '--lua-intf=litefin',
            `--http-password=${password}`,
            '--http-host=127.0.0.1',
            `--http-port=${httpPort}`,
            // No mouse is ever attached to this device (TV/Fire TV remote
            // only) - VLC still renders a cursor sprite by default.
            '--mouse-hide-timeout=1',
            '--play-and-exit'
        ];
        if (startSeconds) {
            args.push(`--start-time=${startSeconds}`);
        }
        args.push(url);

        // Without this, cvlc's own stdout/stderr sit unread in default pipes
        // and are lost - inheriting the daemon's own streams means VLC's
        // diagnostics (e.g. a failed Wayland connection) land in the same
        // `journalctl -u litefin-bridge` output instead of vanishing silently.
        child = spawnFn('cvlc', args, { stdio: 'inherit' });
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
