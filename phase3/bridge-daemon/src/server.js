import { WebSocketServer } from 'ws';

const EVENT_TYPES = ['playbackstart', 'playing', 'pause', 'timeupdate', 'ended', 'remotestop', 'error', 'loadedmetadata', 'upnext'];

export function createServer({ port, createSession }) {
    const wss = new WebSocketServer({ host: '127.0.0.1', port });

    wss.on('connection', (ws) => {
        const session = createSession();

        for (const type of EVENT_TYPES) {
            session.on(type, (data) => {
                ws.send(JSON.stringify({ type, data }));
            });
        }

        ws.on('message', async (raw) => {
            const msg = JSON.parse(raw.toString());
            switch (msg.command) {
                case 'load': {
                    const opts = { url: msg.url, startPositionTicks: msg.startPositionTicks };
                    if (msg.audioTrack !== undefined) opts.audioTrack = msg.audioTrack;
                    if (msg.subtitleTrack !== undefined) opts.subtitleTrack = msg.subtitleTrack;
                    await session.load(opts);
                    break;
                }
                case 'pause':
                    await session.pause();
                    break;
                case 'resume':
                    await session.resume();
                    break;
                case 'seek':
                    await session.seek(msg.ticks);
                    break;
                case 'setAudioTrack':
                    await session.setAudioTrack(msg.index);
                    break;
                case 'setSubtitleTrack':
                    await session.setSubtitleTrack(msg.index);
                    break;
                case 'setIntroSkipperTimestamps':
                    session.setIntroSkipperTimestamps({ introStartTicks: msg.introStartTicks, introEndTicks: msg.introEndTicks });
                    break;
                case 'stop':
                    await session.stop();
                    break;
            }
        });

        ws.on('close', () => session.stop());
    });

    const closeServer = wss.close.bind(wss);
    wss.close = () => new Promise((resolve) => closeServer(resolve));

    return wss;
}
