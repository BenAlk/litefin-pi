import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';

function fakeSession() {
    const session = new EventEmitter();
    session.calls = [];
    session.load = async (opts) => { session.calls.push(['load', opts]); };
    session.pause = async () => { session.calls.push(['pause']); };
    session.resume = async () => { session.calls.push(['resume']); };
    session.seek = async (ticks) => { session.calls.push(['seek', ticks]); };
    session.setAudioTrack = async (i) => { session.calls.push(['setAudioTrack', i]); };
    session.setSubtitleTrack = async (i) => { session.calls.push(['setSubtitleTrack', i]); };
    session.setIntroSkipperTimestamps = (ts) => { session.calls.push(['setIntroSkipperTimestamps', ts]); };
    session.stop = async () => { session.calls.push(['stop']); };
    return session;
}

function connect(port) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on('open', () => resolve(ws));
    });
}

function nextMessage(ws) {
    return new Promise((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
}

test('a load command is forwarded to a fresh session for the connection', async () => {
    let createdSession = null;
    const server = createServer({ port: 0, createSession: () => { createdSession = fakeSession(); return createdSession; } });
    await new Promise((resolve) => server.on('listening', resolve));
    const port = server.address().port;
    const ws = await connect(port);

    ws.send(JSON.stringify({ command: 'load', url: 'http://server/x.mkv', startPositionTicks: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(createdSession.calls[0], ['load', { url: 'http://server/x.mkv', startPositionTicks: 0 }]);

    ws.close();
    await server.close();
});

test('session events are forwarded to the client as json messages', async () => {
    let createdSession = null;
    const server = createServer({ port: 0, createSession: () => { createdSession = fakeSession(); return createdSession; } });
    await new Promise((resolve) => server.on('listening', resolve));
    const port = server.address().port;
    const ws = await connect(port);
    ws.send(JSON.stringify({ command: 'load', url: 'http://server/x.mkv' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const messagePromise = nextMessage(ws);
    createdSession.emit('timeupdate', { time: 42 });
    const message = await messagePromise;

    assert.deepEqual(message, { type: 'timeupdate', data: { time: 42 } });

    ws.close();
    await server.close();
});

test('pause, resume, seek, setAudioTrack, setSubtitleTrack, setIntroSkipperTimestamps, and stop commands reach the session', async () => {
    let createdSession = null;
    const server = createServer({ port: 0, createSession: () => { createdSession = fakeSession(); return createdSession; } });
    await new Promise((resolve) => server.on('listening', resolve));
    const port = server.address().port;
    const ws = await connect(port);
    ws.send(JSON.stringify({ command: 'load', url: 'http://server/x.mkv' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    ws.send(JSON.stringify({ command: 'pause' }));
    ws.send(JSON.stringify({ command: 'resume' }));
    ws.send(JSON.stringify({ command: 'seek', ticks: 300000000 }));
    ws.send(JSON.stringify({ command: 'setAudioTrack', index: 1 }));
    ws.send(JSON.stringify({ command: 'setSubtitleTrack', index: 2 }));
    ws.send(JSON.stringify({ command: 'setIntroSkipperTimestamps', introStartTicks: 300000000, introEndTicks: 900000000 }));
    ws.send(JSON.stringify({ command: 'stop' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(createdSession.calls.slice(1), [
        ['pause'],
        ['resume'],
        ['seek', 300000000],
        ['setAudioTrack', 1],
        ['setSubtitleTrack', 2],
        ['setIntroSkipperTimestamps', { introStartTicks: 300000000, introEndTicks: 900000000 }],
        ['stop']
    ]);

    ws.close();
    await server.close();
});

test('each connection gets its own session', async () => {
    const sessions = [];
    const server = createServer({ port: 0, createSession: () => { const s = fakeSession(); sessions.push(s); return s; } });
    await new Promise((resolve) => server.on('listening', resolve));
    const port = server.address().port;

    const ws1 = await connect(port);
    ws1.send(JSON.stringify({ command: 'load', url: 'a' }));
    const ws2 = await connect(port);
    ws2.send(JSON.stringify({ command: 'load', url: 'b' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sessions.length, 2);

    ws1.close();
    ws2.close();
    await server.close();
});
