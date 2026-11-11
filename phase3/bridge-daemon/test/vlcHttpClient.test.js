import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createVlcHttpClient } from '../src/vlcHttpClient.js';

function startFakeVlc(statusJson) {
    let lastAuth = null;
    let lastUrl = null;
    const server = http.createServer((req, res) => {
        lastAuth = req.headers.authorization;
        lastUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(statusJson));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                server,
                port: server.address().port,
                getLastAuth: () => lastAuth,
                getLastUrl: () => lastUrl,
                close: () => new Promise((r) => server.close(r))
            });
        });
    });
}

test('getStatus sends basic auth with empty username and parses track lists', async () => {
    const fake = await startFakeVlc({
        state: 'playing',
        time: 42,
        length: 7199,
        information: {
            category: {
                'Stream 0': { Type: 'Video' },
                'Stream 1': { Type: 'Audio', Id: '1', Language: 'eng' },
                'Stream 2': { Type: 'Subtitle', Id: '2', Language: 'eng' },
                'Stream 3': { Type: 'Subtitle', Id: '3', Language: 'fre' }
            }
        }
    });
    const client = createVlcHttpClient({ host: '127.0.0.1', port: fake.port, password: 'sekrit' });

    const status = await client.getStatus();

    assert.equal(status.state, 'playing');
    assert.equal(status.time, 42);
    assert.equal(status.length, 7199);
    assert.deepEqual(status.audioTracks, [{ id: '1', name: 'eng' }]);
    assert.deepEqual(status.subtitleTracks, [
        { id: '2', name: 'eng' },
        { id: '3', name: 'fre' }
    ]);
    assert.equal(fake.getLastAuth(), 'Basic ' + Buffer.from(':sekrit').toString('base64'));

    await fake.close();
});

test('sendCommand encodes command and params as query string', async () => {
    const fake = await startFakeVlc({ state: 'playing', time: 0, length: 0, information: { category: {} } });
    const client = createVlcHttpClient({ host: '127.0.0.1', port: fake.port, password: 'sekrit' });

    await client.sendCommand('seek', { val: '30' });

    assert.equal(fake.getLastUrl(), '/requests/status.json?command=seek&val=30');

    await fake.close();
});

test('getStatus rejects on connection failure', async () => {
    const client = createVlcHttpClient({ host: '127.0.0.1', port: 1, password: 'x' });
    await assert.rejects(() => client.getStatus());
});
