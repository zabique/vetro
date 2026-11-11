'use strict';
// Screen preview for the TV controls page.
//
// First choice: capture/TvCapture.dll (packaged as native/capture) asks Samsung's scaler capture library
// (libvideo-capture -> DRM_IOCTL_SDP_HW_CAPTURE) for the post-scaler picture: video and on-screen graphics in one
// frame, at up to the source resolution. The library refuses protected video (HDCP inputs, DRM streams); that
// path belongs to whitelisted Samsung processes and is left alone.
//
// Fallback: the compositor (Enlightenment) saves the buffer of every visible window
// (`enlightenment_info -dump topvwins`) and lists where each window sits (`enlightenment_info -topvwins`); the
// page stacks the window images on a canvas. Video is drawn by a hardware layer (HWC "VD") and never reaches a
// window buffer, so it shows as black there.

var fs = require('fs');
var path = require('path');

var DIR = '/opt/usr/home/owner/share/vetro-screen';
var ID = /^(0x[0-9a-f]{1,12}|screen)$/;
var SCREEN_FILE = 'screen.png';
var DLL = path.join(__dirname, '..', 'native', 'capture', 'TvCapture.dll');
var KEEP_MS = 10 * 60 * 1000;   // a capture's files are removed by the next capture after this long

function wrap(script) { return 'echo ' + Buffer.from(script).toString('base64') + ' | base64 -d | sh'; }

function script(dir, dll) {
    // dir is made here from a timestamp, never from a request; dll is the packaged helper's path.
    return [
        'D=' + DIR,
        'mkdir -p "$D" && chmod 755 "$D"',
        'find "$D" -mindepth 1 -maxdepth 1 -name "tv-*" -mmin +' + Math.ceil(KEEP_MS / 60000) + ' -exec rm -rf {} + 2>/dev/null',
        'T="$D/' + dir + '"; mkdir -p "$T"',
        'X="' + dll + '"',
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

// One row of the first table ("Top level windows in evas object list"), top of the stack first:
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
            id: m[2].toLowerCase(), pid: Number(m[4]),
            w: Number(m[5]), h: Number(m[6]), x: Number(m[7]), y: Number(m[8]),
            vsbt: Number(rest[i + 2]), vis: Number(rest[i + 4]), map: rest[i + 5], hwc: rest[i + 7],
            title: rest.slice(i + 9).join(' ').slice(0, 120)
        });
    });
    return out;
}

function parseScreen(text) {
    var line = String(text || '').split('\n').filter(function (l) { return /^\{.*\}$/.test(l.trim()); })[0];
    if (!line) return null;
    try { var j = JSON.parse(line.trim()); return j && typeof j === 'object' ? j : null; } catch (e) { return null; }
}

function parse(text) {
    var screen = '', list = '', files = [], section = null;
    String(text || '').split('\n').forEach(function (line) {
        if (line === '@@SCREEN') { section = 'screen'; return; }
        if (line === '@@LIST') { section = 'list'; return; }
        if (line === '@@FILES') { section = 'files'; return; }
        if (section === 'screen') screen += line + '\n';
        else if (section === 'list') list += line + '\n';
        else if (section === 'files' && /\.png$/.test(line.trim())) files.push(line.trim());
    });
    var inDir = function (f) { return f.indexOf(DIR + '/') === 0 && f.indexOf('..') < 0; };
    var result = parseScreen(screen);
    var screenFile = files.filter(function (f) { return inDir(f) && path.basename(f) === SCREEN_FILE; })[0];
    if (result && result.ok === true && screenFile) {
        var sw = Number(result.width) || 0, sh = Number(result.height) || 0;
        return {
            source: 'scaler', protected: false, video: false, listed: 1, size: {w: sw, h: sh},
            // The scaler output is the whole panel; the page stretches it over the 1920x1080 canvas.
            windows: [{id: 'screen', title: 'Screen ' + sw + 'x' + sh, x: 0, y: 0, w: 1920, h: 1080, file: screenFile}]
        };
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
        source: 'windows',
        protected: !!(result && result.protect === 1),
        windows: shown.map(function (w) { return {id: w.id, title: w.title, x: w.x, y: w.y, w: w.w, h: w.h, file: byId[w.id]}; }),
        video: windows.some(function (w) { return w.vis === 1 && w.hwc === 'VD'; }),
        listed: windows.length
    };
}

// Live view: the same helper in --serve mode (MJPEG on 127.0.0.1:LIVE_PORT, see capture/Live.cs). It is started
// on demand and exits by itself LIVE_IDLE seconds after the last viewer leaves.
var LIVE_PORT = 8097, LIVE_FPS = 15, LIVE_IDLE = 30, LIVE_UNIT = 'vetro-screen-live';

function liveScript(dll) {
    var cmd = 'exec /usr/bin/dotnet "' + dll + '" --serve ' + LIVE_PORT + ' --fps ' + LIVE_FPS + ' --size 1280x720 --idle-exit ' + LIVE_IDLE;
    return [
        'if netstat -ltn 2>/dev/null | grep -q "127.0.0.1:' + LIVE_PORT + ' "; then echo running; exit 0; fi',
        '[ -f "' + dll + '" ] || { echo missing; exit 0; }',
        'systemctl reset-failed ' + LIVE_UNIT + '.service >/dev/null 2>&1',
        'systemd-run --unit=' + LIVE_UNIT + ' --collect -p StandardOutput=null -p StandardError=null /bin/sh -c \'' + cmd + '\' >/dev/null 2>&1 || ' +
            'setsid nohup /bin/sh -c \'' + cmd + '\' </dev/null >/dev/null 2>&1 &',
        'echo started'
    ].join('\n');
}

function Capture(execute, now, dll, httpGet) {
    this.execute = execute;
    this.dll = dll || DLL;
    this.now = now || Date.now;
    this.httpGet = httpGet || require('http').get;
    this.last = null;
    this.pending = null;
    this.starting = null;
}

// Starts the live helper as root unless it already listens; concurrent callers share one start.
Capture.prototype.startLive = function () {
    var self = this;
    if (this.starting) return this.starting;
    this.starting = this.execute(wrap(liveScript(this.dll)), 15000).then(function (r) {
        if (/^missing$/m.test(r.stdout || '')) throw new Error('The live view helper is not installed');
        return (r.stdout || '').trim();
    }).finally(function () { self.starting = null; });
    return this.starting;
};

// Passes one helper path (/stream, /status) through to res. With start, a helper that is not running is
// started and the connection retried for a few seconds (dotnet takes ~2 s to come up); without, the caller
// gets {running:false}.
Capture.prototype.live = function (sub, res, start, query) {
    var self = this, tries = 0, done = false, up = null;
    // Forward only the known controls, rebuilt here so nothing from the request reaches the helper verbatim.
    if (query) {
        var q = require('url').parse('?' + String(query).replace(/^\?/, ''), true).query, keep = [];
        ['fps', 'q', 'w', 'h', 'size'].forEach(function (k) {
            if (q[k] != null && /^[0-9x]{1,9}$/.test(String(q[k]))) keep.push(k + '=' + encodeURIComponent(q[k]));
        });
        if (keep.length) sub += '?' + keep.join('&');
    }
    function reply(code, obj) {
        if (done) return; done = true;
        res.writeHead(code, {'content-type': 'application/json', 'cache-control': 'no-store'});
        res.end(JSON.stringify(obj));
    }
    res.on('close', function () { done = true; if (up) up.destroy(); });
    // A stream runs as long as someone watches; older Node servers drop idle sockets after 2 minutes.
    if (start && typeof res.setTimeout === 'function') res.setTimeout(0);
    function attempt() {
        if (done) return;
        up = self.httpGet({host: '127.0.0.1', port: LIVE_PORT, path: sub}, function (r) {
            if (done) { r.destroy(); return; }
            done = true;
            res.writeHead(r.statusCode || 502, {'content-type': r.headers['content-type'] || 'application/octet-stream',
                'cache-control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
            r.pipe(res);
        });
        up.on('error', function () {
            if (done) return;
            if (!start) return reply(200, {running: false});
            if (++tries > 20) return reply(503, {error: 'The live view did not start'});
            if (tries === 1) self.startLive().catch(function (e) { reply(503, {error: e.message}); });
            setTimeout(attempt, 500);
        });
    }
    attempt();
};

// Takes a new capture; a request that comes while one is running shares it.
Capture.prototype.take = function () {
    var self = this;
    if (this.pending) return this.pending;
    var at = this.now(), dir = 'tv-' + at;
    this.pending = this.execute(wrap(script(dir, self.dll)), 20000).then(function (r) {
        if (r.timed_out) throw new Error('The TV took too long to capture the screen');
        var shot = parse(r.stdout || '');
        if (!shot.listed) throw new Error('The compositor did not list any windows');
        self.last = {at: at, files: {}};
        shot.windows.forEach(function (w) { self.last.files[w.id] = w.file; });
        return {at: at, source: shot.source, protected: shot.protected, size: shot.size, video: shot.video, windows: shot.windows.map(function (w) {
            return {id: w.id, title: w.title, x: w.x, y: w.y, w: w.w, h: w.h};
        })};
    }).finally(function () { self.pending = null; });
    return this.pending;
};

// The PNG of one window of the latest capture, or null.
Capture.prototype.file = function (id, at) {
    if (!this.last || !ID.test(String(id || '')) || String(at) !== String(this.last.at)) return null;
    var f = this.last.files[id];
    if (!f) return null;
    try { return fs.readFileSync(f); } catch (e) { return null; }
};

module.exports = {Capture: Capture, parse: parse, parseWindows: parseWindows, liveScript: liveScript, DIR: DIR, DLL: DLL, LIVE_PORT: LIVE_PORT};
