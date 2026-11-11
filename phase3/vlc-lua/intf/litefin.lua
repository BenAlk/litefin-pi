-- Litefin VLC interface script: Back/Escape stops playback (cage gives VLC
-- exclusive input focus during playback, so Litefin's own key handler never
-- sees this key - see docs/superpowers/specs/2026-11-09-phase3-bridge-daemon-design.md),
-- and shows a skip-intro prompt from Intro Skipper timestamps written by the
-- bridge daemon. The file is re-read on every loop iteration, not just once
-- at startup: the daemon resets it to {} when VLC spawns and only fills in
-- real timestamps later, once Litefin's skip-intro plugin resolves its own
-- segment fetch (which happens after playback has already started - see
-- Global Constraints in the plan this script was built from).

local intro_start = nil
local intro_end = nil
local prompt_shown = false

local function load_intro_timestamps()
    local f = io.open('/tmp/litefin-intro-skipper.json', 'r')
    if not f then
        intro_start = nil
        intro_end = nil
        return
    end
    local content = f:read('*all')
    f:close()
    local s = content:match('"introStart"%s*:%s*([%d%.]+)')
    local e = content:match('"introEnd"%s*:%s*([%d%.]+)')
    if s and e then
        intro_start = tonumber(s)
        intro_end = tonumber(e)
    else
        -- File exists but is {} (no markers yet, or none for this item).
        intro_start = nil
        intro_end = nil
    end
end

function activate()
    return true
end

function deactivate()
end

function input_changed()
end

function key_pressed()
    local key = vlc.var.get(vlc.object.libvlc(), 'key-pressed')
    if key == 'Esc' then
        vlc.playlist.stop()
    elseif key == 'Enter' and prompt_shown and intro_end then
        local input = vlc.object.input()
        if input then
            -- 'time' is in microseconds (same unit the read side divides
            -- by 1000000 for, just below), but intro_end is in seconds -
            -- convert back or this seeks to roughly time-zero instead of
            -- past the intro.
            vlc.var.set(input, 'time', intro_end * 1000000)
        end
        prompt_shown = false
        vlc.osd.message('', 1)
    end
end

while true do
    load_intro_timestamps()
    local input = vlc.object.input()
    if input and intro_start and intro_end then
        local t = vlc.var.get(input, 'time') / 1000000
        if t >= intro_start and t < intro_end then
            prompt_shown = true
            vlc.osd.message('Skip Intro (press OK)', 1)
        elseif prompt_shown then
            prompt_shown = false
            vlc.osd.message('', 1)
        end
    elseif prompt_shown then
        -- Markers disappeared (e.g. the daemon reset the file for a new
        -- episode) while the prompt was showing - clear it instead of
        -- leaving it stuck with no way to clear itself.
        prompt_shown = false
        vlc.osd.message('', 1)
    end
    vlc.misc.mwait(vlc.misc.mdate() + 500000)
end
