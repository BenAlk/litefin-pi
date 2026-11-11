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
