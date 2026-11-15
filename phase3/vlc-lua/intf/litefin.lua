-- Litefin VLC interface script: shows a skip-intro OSD prompt from Intro
-- Skipper timestamps written by the bridge daemon. This is drawing text
-- over VLC's own video surface, the one thing only VLC itself can do -
-- actually confirming the skip, and all other playback control (stop,
-- pause, seek), is handled by the bridge daemon directly over VLC's HTTP
-- interface, driven by its own read of the remote's input device. VLC's
-- own key handling (globalhotkeys) does not work under Wayland/cage - see
-- docs/superpowers/specs/2026-11-12-remote-input-bypass-design.md.

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
