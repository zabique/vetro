'use strict';
// TV Screen: see what the TV shows (a picture or a live view) and drive it with a full remote and this
// computer's keyboard, from a page inside Vetro Shards. Plain ES5.
//
// Picture: bin/TvCapture.dll (unpacked from capture.dll.b64 at start, a bundle holds text only) asks Samsung's
// scaler capture library for the post-scaler frame; protected video is refused by the TV and the visible
// windows are dumped instead. Live view: the same helper in --serve mode (MJPEG on loopback), started on demand.
// Keys: the compositor's test interface (org.enlightenment.wm Test.EventKey), down and up as separate events.
//
// Needs `exec`: the capture, the helper and the key events all run as root.

module.exports = function (ctx) {
    var fs = require('fs'), path = require('path'), http = require('http'), urlLib = require('url');

    var BIN = path.join(ctx.dir, 'bin');
    var DLL = path.join(BIN, 'TvCapture.dll');
    var SHOTS = '/opt/usr/home/owner/share/tv-screen-shard';
    var SCREEN_FILE = 'screen.png';
    var FILE_ID = /^(0x[0-9a-f]{1,12}|screen)$/;
    var KEEP_MIN = 10;
    // Not the port or the unit of Vetro's own Screen page, so both can run.
    var LIVE_PORT = 8096, LIVE_IDLE = 30, LIVE_UNIT = 'tv-screen-shard-live';
    var LIVE_QUERY = '/stream?fps=30&q=95&size=1920x1080';   // the helper caps each at what the source gives
    var FIFO = '/home/owner/tvlauncher.fifo';

    var page = '', last = null, pending = null, starting = null, held = null;

    function buffer(text, encoding) { return Buffer.from ? Buffer.from(text, encoding) : new Buffer(text, encoding); }
    function wrap(script) { return 'echo ' + buffer(script, 'utf8').toString('base64') + ' | base64 -d | sh'; }
    function json(res, body, code) {
        if (res.headersSent) return;
        res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    }
    function failure(res, code) { return function (e) { json(res, { ok: false, error: String(e && e.message || e) }, code || 503); }; }

    // ── the helper ──────────────────────────────────────────────────────────────────────────────────────
    // Written under a new name and renamed into place: a helper that is running keeps the file it loaded.
    function installHelper() {
        var want = buffer(fs.readFileSync(path.join(ctx.dir, 'capture.dll.b64'), 'utf8').replace(/\s+/g, ''), 'base64');
        var have = null;
        try { have = fs.readFileSync(DLL); } catch (e) { /* first start, or after an update */ }
        if (have && have.length === want.length && have.toString('base64') === want.toString('base64')) return false;
        try { fs.mkdirSync(BIN); } catch (e) { /* exists */ }
        fs.writeFileSync(DLL + '.new', want);
        fs.renameSync(DLL + '.new', DLL);
        fs.writeFileSync(path.join(BIN, 'TvCapture.runtimeconfig.json'), fs.readFileSync(path.join(ctx.dir, 'capture.runtimeconfig.json')));
        return true;
    }
    function stopLive() {
        return ctx.execute('systemctl stop ' + LIVE_UNIT + '.service >/dev/null 2>&1; true', 10000).catch(function () { /* the TV is away */ });
    }

    // ── one picture ─────────────────────────────────────────────────────────────────────────────────────
    function shotScript(dir) {
        // dir is made here from a timestamp, never from a request.
        return [
            'D=' + SHOTS,
            'mkdir -p "$D" && chmod 755 "$D"',
            'find "$D" -mindepth 1 -maxdepth 1 -name "tv-*" -mmin +' + KEEP_MIN + ' -exec rm -rf {} + 2>/dev/null',
            'T="$D/' + dir + '"; mkdir -p "$T"',
            'X="' + DLL + '"',
            'if [ -f "$X" ] && /usr/bin/dotnet "$X" "$T/' + SCREEN_FILE + '" 1920 1080 > "$T/screen.json" 2>/dev/null; then',
            '  echo "@@SCREEN"; cat "$T/screen.json"',
            'else',
            '  echo "@@SCREEN"; cat "$T/screen.json" 2>/dev/null; rm -f "$T/' + SCREEN_FILE + '"',
            '  echo "@@LIST"',
            '  enlightenment_info -topvwins 2>/dev/null',
            '  enlightenment_info -dump topvwins "$T" >/dev/null 2>&1',
            'fi',
            'chmod -R a+rX "$T"',
            'echo "@@FILES"',
            'find "$T" -name "*.png" 2>/dev/null',
            'true'
        ].join('\n');
    }

    // One row of "Top level windows in evas object list", top of the stack first:
    //   No Win_ID RcsID PID w h x y [Foc] [InReg] Dep Opaq Vsbt Icon Vis Map Frame HWC_ST Parent Title...
    // Foc and InReg are blank or a letter, so the numeric columns are counted from the first number after y.
    function parseWindows(text) {
        var out = [], inFirst = false, done = false;
        String(text || '').split('\n').forEach(function (line) {
            if (done) return;
            if (/Top level windows in evas object list/.test(line)) { inFirst = true; return; }
            if (/Top level windows in EC list/.test(line)) { if (inFirst) done = true; return; }
            if (!inFirst) return;
            var m = /^\s*(\d+)\s+(0x[0-9a-fA-F]+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(.*)$/.exec(line);
            if (!m) return;
            var rest = m[9].trim().split(/\s+/), i = 0;
            while (i < rest.length && !/^-?\d+$/.test(rest[i])) i++;
            if (rest.length < i + 9) return;
            out.push({
                id: m[2].toLowerCase(), w: Number(m[5]), h: Number(m[6]), x: Number(m[7]), y: Number(m[8]),
                vsbt: Number(rest[i + 2]), vis: Number(rest[i + 4]), map: rest[i + 5], hwc: rest[i + 7],
                title: rest.slice(i + 9).join(' ').slice(0, 120)
            });
        });
        return out;
    }

    function parseShot(text) {
        var screen = '', list = '', files = [], section = null;
        String(text || '').split('\n').forEach(function (line) {
            if (line === '@@SCREEN') { section = 'screen'; return; }
            if (line === '@@LIST') { section = 'list'; return; }
            if (line === '@@FILES') { section = 'files'; return; }
            if (section === 'screen') screen += line + '\n';
            else if (section === 'list') list += line + '\n';
            else if (section === 'files' && /\.png$/.test(line.trim())) files.push(line.trim());
        });
        function inDir(f) { return f.indexOf(SHOTS + '/') === 0 && f.indexOf('..') < 0; }
        var result = null;
        screen.split('\n').some(function (l) {
            if (!/^\{.*\}$/.test(l.trim())) return false;
            try { result = JSON.parse(l.trim()); } catch (e) { result = null; }
            return true;
        });
        var screenFile = files.filter(function (f) { return inDir(f) && path.basename(f) === SCREEN_FILE; })[0];
        if (result && result.ok === true && screenFile) {
            var sw = Number(result.width) || 0, sh = Number(result.height) || 0;
            // The scaler output is the whole panel; the page stretches it over the 1920x1080 canvas.
            return { source: 'scaler', protected: false, video: false, listed: 1, size: { w: sw, h: sh },
                windows: [{ id: 'screen', title: 'Screen', x: 0, y: 0, w: 1920, h: 1080, file: screenFile }] };
        }
        var byId = {};
        files.forEach(function (f) {
            var m = /^(0x[0-9a-f]+)_\d+\.png$/.exec(path.basename(f).toLowerCase());
            if (m && inDir(f)) byId[m[1]] = f;
        });
        var windows = parseWindows(list);
        // Drawn bottom first. A window counts when it is shown, mapped, not fully covered and has a buffer.
        var shown = windows.filter(function (w) {
            return w.vis === 1 && w.map === 'V' && w.vsbt !== 2 && w.w > 1 && w.h > 1 && byId[w.id];
        }).reverse();
        return {
            source: 'windows', protected: !!(result && result.protect === 1), listed: windows.length,
            video: windows.some(function (w) { return w.vis === 1 && w.hwc === 'VD'; }),
            windows: shown.map(function (w) { return { id: w.id, title: w.title, x: w.x, y: w.y, w: w.w, h: w.h, file: byId[w.id] }; })
        };
    }

    // A request that comes while a capture is running shares it.
    function take() {
        if (pending) return pending;
        var at = Date.now();
        function done() { pending = null; }
        pending = ctx.execute(wrap(shotScript('tv-' + at)), 20000).then(function (r) {
            if (r.timed_out) throw new Error('The TV took too long to capture the screen');
            var shot = parseShot(r.stdout || '');
            if (!shot.listed) throw new Error('The compositor did not list any windows');
            last = { at: at, files: {} };
            shot.windows.forEach(function (w) { last.files[w.id] = w.file; });
            return { at: at, source: shot.source, protected: shot.protected, size: shot.size, video: shot.video,
                windows: shot.windows.map(function (w) { return { id: w.id, title: w.title, x: w.x, y: w.y, w: w.w, h: w.h }; }) };
        });
        pending.then(done, done);
        return pending;
    }

    function shotFile(id, at) {
        if (!last || !FILE_ID.test(String(id || '')) || String(at) !== String(last.at)) return null;
        var f = last.files[id];
        if (!f) return null;
        try { return fs.readFileSync(f); } catch (e) { return null; }
    }

    // ── the live view ───────────────────────────────────────────────────────────────────────────────────
    function liveScript() {
        var cmd = 'exec /usr/bin/dotnet "' + DLL + '" --serve ' + LIVE_PORT + ' --fps 30 --size 1920x1080 --idle-exit ' + LIVE_IDLE;
        return [
            'if netstat -ltn 2>/dev/null | grep -q "127.0.0.1:' + LIVE_PORT + ' "; then echo running; exit 0; fi',
            '[ -f "' + DLL + '" ] || { echo missing; exit 0; }',
            'systemctl reset-failed ' + LIVE_UNIT + '.service >/dev/null 2>&1',
            'systemd-run --unit=' + LIVE_UNIT + ' --collect -p StandardOutput=null -p StandardError=null /bin/sh -c \'' + cmd + '\' >/dev/null 2>&1 || ' +
                'setsid nohup /bin/sh -c \'' + cmd + '\' </dev/null >/dev/null 2>&1 &',
            'echo started'
        ].join('\n');
    }
    function startLive() {
        if (starting) return starting;
        function done() { starting = null; }
        starting = ctx.execute(wrap(liveScript()), 15000).then(function (r) {
            if (/^missing$/m.test(r.stdout || '')) throw new Error('The live view helper is not installed');
        });
        starting.then(done, done);
        return starting;
    }
    // Passes one helper path through to res. With start, a helper that is not running is started and the
    // connection retried for a few seconds (dotnet takes about 2 s to come up).
    function live(sub, res, start) {
        var tries = 0, done = false, up = null;
        function reply(code, obj) { if (done) return; done = true; json(res, obj, code); }
        res.on('close', function () { done = true; if (up) up.destroy(); });
        if (start && typeof res.setTimeout === 'function') res.setTimeout(0);   // a stream runs as long as someone watches
        function attempt() {
            if (done) return;
            up = http.get({ host: '127.0.0.1', port: LIVE_PORT, path: sub }, function (r) {
                if (done) { r.destroy(); return; }
                done = true;
                res.writeHead(r.statusCode || 502, { 'content-type': r.headers['content-type'] || 'application/octet-stream',
                    'cache-control': 'no-store' });
                r.pipe(res);
            });
            up.on('error', function () {
                if (done) return;
                if (!start) return reply(200, { running: false });
                if (++tries > 20) return reply(503, { error: 'The live view did not start' });
                if (tries === 1) startLive().catch(function (e) { reply(503, { error: e.message }); });
                setTimeout(attempt, 500);
            });
        }
        attempt();
    }

    // ── keys ────────────────────────────────────────────────────────────────────────────────────────────
    // Names of the TV keymap: XF86* remote keys and the base keysym of every keyboard key. Shifted keysyms
    // (A, at) do not exist there: a capital is Shift_L down, a, Shift_L up, as on a keyboard.
    var KEYS = [
        'XF86AudioRaiseVolume', 'XF86AudioLowerVolume', 'XF86AudioMute', 'XF86PowerOff',
        'Up', 'Down', 'Left', 'Right', 'Return', 'XF86Back', 'XF86Home', 'XF86Menu', 'XF86Info', 'XF86Exit',
        'XF86ChannelList', 'XF86ChannelGuide', 'XF86DiscretSourceTV', 'XF86RaiseChannel', 'XF86LowerChannel',
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
        'XF86AudioPlay', 'XF86AudioPause', 'XF86AudioStop', 'XF86AudioNext', 'XF86AudioPrev', 'XF86AudioRewind',
        'XF86AudioForward', 'XF86AudioRecord', 'XF86AudioPlayPause',
        'XF86Red', 'XF86Green', 'XF86Yellow', 'XF86Blue',
        'XF86Display', 'XF86SysMenu', 'XF86SimpleMenu', 'XF86NumberPad', 'XF86More', 'XF86PreviousChannel',
        'XF86FavoriteChannel', 'XF86TTXMIX', 'XF86Caption', 'XF86Subtitle', 'XF86AudioDescription', 'XF86PictureSize',
        'XF86PictureMode', 'XF86SoundMode', 'XF86EManual', 'XF86Search', 'XF86Apps', 'XF86MultiView', 'XF86Ambient',
        'XF86Sleep', 'XF86MTS', 'XF86Hdmi', 'XF86QuickMenu', 'XF86Netflix', 'XF86Amazon', 'XF86KeyTVPlus',
        'XF86KeyYouTube', 'XF86WWW'
    ].concat('abcdefghijklmnopqrstuvwxyz'.split(''), [
        'minus', 'equal', 'bracketleft', 'bracketright', 'backslash', 'semicolon', 'apostrophe', 'grave', 'comma',
        'period', 'slash', 'space', 'BackSpace', 'Tab', 'Delete', 'Insert', 'Home', 'End', 'Prior', 'Next',
        'Shift_L', 'Shift_R', 'Control_L', 'Control_R', 'Alt_L', 'Alt_R', 'Caps_Lock',
        'KP_Enter', 'KP_Add', 'KP_Subtract', 'KP_Multiply', 'KP_Divide'
    ]);
    var KEY_SET = Object.create(null);
    KEYS.forEach(function (k) { KEY_SET[k] = true; });
    var DBUS = '/usr/bin/dbus-send --system --type=method_call --print-reply --dest=org.enlightenment.wm ' +
        '/org/enlightenment/wm org.enlightenment.wm.Test.EventKey';
    var MAX_EVENTS = 64, HOLD_MS = 20000;
    var STATES = { down: [1], up: [0], press: [1, 0] };

    // [{key, state}] -> a clean list, or null. Only whitelisted names reach the command line.
    function checkEvents(events) {
        if (!Array.isArray(events) || !events.length || events.length > MAX_EVENTS) return null;
        var out = [];
        for (var i = 0; i < events.length; i++) {
            var e = events[i] || {}, state = e.state === undefined ? 'press' : e.state;
            if (typeof e.key !== 'string' || !KEY_SET[e.key] || !Object.prototype.hasOwnProperty.call(STATES, state)) return null;
            out.push({ key: e.key, state: state });
        }
        return out;
    }
    // Each call waits for its reply, so the order is kept; `;` so a refused key never leaves the releases unsent.
    function eventsCommand(events) {
        var calls = [];
        events.forEach(function (e) {
            STATES[e.state].forEach(function (type) { calls.push(DBUS + ' uint32:' + type + ' string:' + e.key + ' >/dev/null 2>&1'); });
        });
        return calls.join('; ');
    }
    function sendKeys(events) { return ctx.execute(eventsCommand(events), 10000); }

    // Keys that are down. A page that closes mid-press never sends the release and the TV would repeat the
    // key for ever, so a key still down after HOLD_MS is released here.
    function Held() { this.down = Object.create(null); }
    Held.prototype.note = function (events) {
        var self = this;
        events.forEach(function (e) {
            if (self.down[e.key]) { clearTimeout(self.down[e.key]); delete self.down[e.key]; }
            if (e.state !== 'down') return;
            self.down[e.key] = setTimeout(function () {
                delete self.down[e.key];
                sendKeys([{ key: e.key, state: 'up' }]).catch(function () { /* the TV is away */ });
            }, HOLD_MS);
            if (self.down[e.key].unref) self.down[e.key].unref();
        });
    };
    Held.prototype.releaseAll = function () {
        var self = this, keys = Object.keys(this.down);
        keys.forEach(function (k) { clearTimeout(self.down[k]); delete self.down[k]; });
        if (keys.length) sendKeys(keys.map(function (k) { return { key: k, state: 'up' }; })).catch(function () { /* the TV is away */ });
        return keys;
    };

    function readBody(req, done) {
        var data = '', over = false;
        req.on('data', function (c) { if (over) return; data += c; if (data.length > 16384) { over = true; done(null); } });
        req.on('end', function () {
            if (over) return;
            var parsed = null;
            try { parsed = JSON.parse(data); } catch (e) { parsed = null; }
            done(parsed && typeof parsed === 'object' ? parsed : null);
        });
    }

    function control(req, res) {
        readBody(req, function (p) {
            if (!p) return json(res, { error: 'JSON body expected' }, 400);
            if (p.release === true) return json(res, { ok: true, released: held.releaseAll() });
            var events = checkEvents(p.events);
            if (!events) return json(res, { error: 'events: up to ' + MAX_EVENTS + ' of {key, state: down|up|press}' }, 400);
            held.note(events);
            sendKeys(events).then(function (r) { json(res, { ok: r.exit_code === 0, sent: events.length }); }).catch(failure(res));
        });
    }

    // What the page remembers (its frame has no storage): the picture size and whether the extra keys are shown.
    var ZOOMS = ['fit', '1', '1.5', '2'];
    function prefs() {
        var c = ctx.config.get() || {};
        return { zoom: ZOOMS.indexOf(c.zoom) >= 0 ? c.zoom : 'fit', keys: c.keys !== false };
    }
    function savePrefs(req, res) {
        readBody(req, function (p) {
            if (!p) return json(res, { error: 'JSON body expected' }, 400);
            var now = prefs();
            if (ZOOMS.indexOf(p.zoom) >= 0) now.zoom = p.zoom;
            if (typeof p.keys === 'boolean') now.keys = p.keys;
            try { ctx.config.set(now); } catch (e) { return json(res, { ok: false, error: String(e.message || e) }, 500); }
            json(res, now);
        });
    }

    function launcher(res) {
        ctx.execute(wrap('[ -p ' + FIFO + ' ] || { echo off; exit 0; }\nsetsid sh -c \'echo show > ' + FIFO + '\' >/dev/null 2>&1 &\necho shown'), 6000)
            .then(function (r) {
                if (/^off$/m.test(r.stdout || '')) return json(res, { ok: false, error: 'The Vetro launcher is not running on the TV' });
                json(res, { ok: true });
            }).catch(failure(res));
    }

    return {
        start: function () {
            held = new Held();
            page = fs.readFileSync(path.join(ctx.dir, 'page.html'), 'utf8');
            if (installHelper()) stopLive();   // a helper from the version before must not keep serving
        },
        stop: function () {
            if (held) held.releaseAll();
            stopLive();
        },
        status: function () {
            return { helper: fs.existsSync(DLL), keysHeld: held ? Object.keys(held.down).length : 0, lastPicture: last ? last.at : null };
        },
        route: function (req, res, sub) {
            if (req.method === 'GET') {
                if (sub === 'ui') {
                    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(page);
                    return true;
                }
                if (sub === 'shot') { take().then(function (d) { json(res, d); }).catch(failure(res)); return true; }
                if (sub === 'file') {
                    var q = urlLib.parse(req.url, true).query, png = shotFile(q.id, q.at);
                    if (!png) { json(res, { error: 'capture unavailable' }, 404); return true; }
                    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
                    res.end(png);
                    return true;
                }
                if (sub === 'stream') { live(LIVE_QUERY, res, true); return true; }
                if (sub === 'live') { live('/status', res, false); return true; }
                if (sub === 'prefs') { json(res, prefs()); return true; }
                return false;
            }
            if (req.method === 'POST') {
                if (sub === 'control') { control(req, res); return true; }
                if (sub === 'launcher') { launcher(res); return true; }
                if (sub === 'prefs') { savePrefs(req, res); return true; }
            }
            return false;
        },
        // For tests.
        _internals: { parseShot: parseShot, parseWindows: parseWindows, checkEvents: checkEvents, eventsCommand: eventsCommand, KEYS: KEYS }
    };
};
