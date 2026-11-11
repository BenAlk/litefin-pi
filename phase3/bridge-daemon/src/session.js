import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';

const TICKS_PER_SECOND = 10000000;

export class Session extends EventEmitter {
    constructor({
        createVlcProcess,
        createVlcHttpClient,
        displayMode,
        httpPort = 9191,
        pollIntervalMs = 250,
        upNextThresholdSeconds = 30,
        httpReadyAttempts = 25,
        httpReadyRetryDelayMs = 200,
        audioDevice = 'plughw:CARD=vc4hdmi0,DEV=0',
        introSkipperFilePath = '/tmp/litefin-intro-skipper.json',
        generatePassword = () => crypto.randomBytes(16).toString('hex')
    }) {
        super();
        this._createVlcProcess = createVlcProcess;
        this._createVlcHttpClient = createVlcHttpClient;
        this._displayMode = displayMode;
        this._httpPort = httpPort;
        this._pollIntervalMs = pollIntervalMs;
        this._upNextThresholdSeconds = upNextThresholdSeconds;
        this._httpReadyAttempts = httpReadyAttempts;
        this._httpReadyRetryDelayMs = httpReadyRetryDelayMs;
        this._audioDevice = audioDevice;
        this._introSkipperFilePath = introSkipperFilePath;
        this._generatePassword = generatePassword;

        this._vlcProcess = null;
        this._httpClient = null;
        this._pollTimer = null;
        this._stopping = false;
        this._everReachedPlaying = false;
        this._upNextFired = false;
        this._lastState = { time: 0, duration: 0, paused: true };
    }

    async load({ url, startPositionTicks = 0, audioTrack, subtitleTrack }) {
        // Clears any previous episode's markers immediately - skip-intro's own
        // segment fetch (Task 9) only resolves after this method returns, so
        // the Lua script polls this file throughout playback rather than
        // reading it once at VLC startup (see Global Constraints).
        this._writeIntroSkipperFile({});
        await this._displayMode.setPlaybackMode();

        const password = this._generatePassword();
        this._httpClient = this._createVlcHttpClient({ host: '127.0.0.1', port: this._httpPort, password });
        this._vlcProcess = this._createVlcProcess({ password, httpPort: this._httpPort, audioDevice: this._audioDevice });
        this._vlcProcess.on('exit', (code) => this._onVlcExit(code));

        const startSeconds = Math.floor(startPositionTicks / TICKS_PER_SECOND);
        this._vlcProcess.start(url, { startSeconds });

        const status = await this._waitForHttpReady();
        if (this._stopping) {
            this._vlcProcess.stop();
            return;
        }
        if (!status) {
            this.emit('error', { message: 'VLC HTTP interface never became ready' });
            return;
        }

        if (audioTrack !== undefined) {
            await this._httpClient.sendCommand('audio_track', { val: String(audioTrack) });
        }
        if (subtitleTrack !== undefined) {
            await this._httpClient.sendCommand('subtitle_track', { val: String(subtitleTrack) });
        }
        if (this._stopping) {
            this._vlcProcess.stop();
            return;
        }

        this._lastState = { time: status.time, duration: status.length, paused: status.state !== 'playing' };
        this.emit('loadedmetadata', { duration: status.length, audioTracks: status.audioTracks, subtitleTracks: status.subtitleTracks });
        this.emit('playbackstart');
        this._everReachedPlaying = true;

        this._startPolling();
    }

    async _waitForHttpReady() {
        for (let attempt = 0; attempt < this._httpReadyAttempts; attempt += 1) {
            try {
                return await this._httpClient.getStatus();
            } catch (err) {
                await new Promise((resolve) => setTimeout(resolve, this._httpReadyRetryDelayMs));
            }
        }
        return null;
    }

    _startPolling() {
        this._pollTimer = setInterval(() => this._poll(), this._pollIntervalMs);
    }

    async _poll() {
        let status;
        try {
            status = await this._httpClient.getStatus();
        } catch (err) {
            return;
        }

        this._lastState = { time: status.time, duration: status.length, paused: status.state !== 'playing' };

        if (status.state === 'playing') {
            this.emit('playing');
        } else if (status.state === 'paused') {
            this.emit('pause');
        }
        this.emit('timeupdate', { time: status.time });

        if (!this._upNextFired && status.length > 0 && status.length - status.time <= this._upNextThresholdSeconds) {
            this._upNextFired = true;
            this.emit('upnext');
        }
    }

    _stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    _onVlcExit(code) {
        this._stopPolling();
        const wasStopping = this._stopping;
        this._stopping = false;
        if (wasStopping) return;
        this._displayMode.setUiMode();
        if (this._everReachedPlaying && code === 0) {
            this.emit('ended');
        } else {
            this.emit('error', { message: `VLC exited unexpectedly (code ${code})` });
        }
    }

    async pause() {
        await this._httpClient.sendCommand('pl_pause');
    }

    async resume() {
        await this._httpClient.sendCommand('pl_play');
    }

    async seek(ticks) {
        const seconds = Math.floor(ticks / TICKS_PER_SECOND);
        await this._httpClient.sendCommand('seek', { val: String(seconds) });
    }

    async setAudioTrack(index) {
        await this._httpClient.sendCommand('audio_track', { val: String(index) });
    }

    async setSubtitleTrack(index) {
        await this._httpClient.sendCommand('subtitle_track', { val: String(index) });
    }

    async stop() {
        this._stopping = true;
        this._stopPolling();
        if (this._httpClient) {
            try { await this._httpClient.sendCommand('pl_stop'); } catch (err) { /* vlc may already be gone */ }
        }
        if (this._vlcProcess) {
            this._vlcProcess.stop();
        }
        await this._displayMode.setUiMode();
    }

    getCurrentState() {
        return this._lastState;
    }

    setIntroSkipperTimestamps({ introStartTicks, introEndTicks } = {}) {
        if (introStartTicks === undefined || introEndTicks === undefined) {
            this._writeIntroSkipperFile({});
            return;
        }
        this._writeIntroSkipperFile({
            introStart: introStartTicks / TICKS_PER_SECOND,
            introEnd: introEndTicks / TICKS_PER_SECOND
        });
    }

    _writeIntroSkipperFile(payload) {
        try {
            fs.writeFileSync(this._introSkipperFilePath, JSON.stringify(payload));
        } catch (err) {
            // Best-effort, matching this project's established "never block
            // playback over a display/side-channel failure" error handling.
        }
    }
}
