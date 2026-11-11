import http from 'node:http';

function request(host, port, password, path) {
    return new Promise((resolve, reject) => {
        const auth = Buffer.from(':' + password).toString('base64');
        const req = http.request(
            { host, port, path, headers: { Authorization: 'Basic ' + auth } },
            (res) => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume();
                    reject(new Error(`VLC HTTP interface returned ${res.statusCode}`));
                    return;
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => resolve(body));
            }
        );
        req.on('error', reject);
        req.end();
    });
}

function parseTracks(category, type) {
    return Object.values(category || {})
        .filter((stream) => stream.Type === type)
        .map((stream) => ({ id: stream.Id, name: stream.Language || stream.Description || '' }));
}

export function createVlcHttpClient({ host, port, password }) {
    async function getStatus() {
        const body = await request(host, port, password, '/requests/status.json');
        const json = JSON.parse(body);
        const category = json.information && json.information.category;
        return {
            state: json.state,
            time: json.time,
            length: json.length,
            audioTracks: parseTracks(category, 'Audio'),
            subtitleTracks: parseTracks(category, 'Subtitle')
        };
    }

    async function sendCommand(command, params = {}) {
        const query = new URLSearchParams({ command, ...params }).toString();
        await request(host, port, password, '/requests/status.json?' + query);
    }

    return { getStatus, sendCommand };
}
