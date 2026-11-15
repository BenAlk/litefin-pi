import { TICKS_PER_SECOND } from './session.js';

const FAST_FORWARD_SECONDS = 30;
const REWIND_SECONDS = 10;

export function handleRemoteKey(keyName, getCurrentSession) {
    const session = getCurrentSession();
    if (!session) return;

    switch (keyName) {
        case 'KEY_ESC':
        case 'KEY_INSERT':
            session.stopFromRemote();
            break;
        case 'KEY_KPENTER':
            if (session.isIntroWindowActive()) {
                session.seekPastIntro();
            } else {
                togglePause(session);
            }
            break;
        case 'KEY_PLAYPAUSE':
            togglePause(session);
            break;
        case 'KEY_FASTFORWARD':
            session.seek((session.getCurrentState().time + FAST_FORWARD_SECONDS) * TICKS_PER_SECOND);
            break;
        case 'KEY_REWIND':
            session.seek(Math.max(0, session.getCurrentState().time - REWIND_SECONDS) * TICKS_PER_SECOND);
            break;
    }
}

function togglePause(session) {
    if (session.getCurrentState().paused) {
        session.resume();
    } else {
        session.pause();
    }
}
