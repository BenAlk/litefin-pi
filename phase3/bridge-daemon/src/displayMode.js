export function createDisplayMode({ output, uiMode, playbackMode, execFileFn }) {
    function run(mode) {
        return new Promise((resolve) => {
            // Resolves even on failure - a display-mode switch failing should
            // never block playback (see spec's error handling section).
            execFileFn('wlr-randr', ['--output', output, '--mode', mode], () => resolve());
        });
    }

    return {
        setUiMode: () => run(uiMode),
        setPlaybackMode: () => run(playbackMode)
    };
}
