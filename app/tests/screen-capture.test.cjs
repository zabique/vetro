'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Capture, parse, parseWindows, liveScript, DIR } = require('../service/screen-capture.js');

// `enlightenment_info -topvwins` as printed by the Q80A (first table, trimmed), then the same windows again
// in the second table, which must be ignored.
const LIST = [
    'GL :  on',
    '15 Top level windows in evas object list',
    '--------------------------------------[ topvwins ]----------',
    ' No   Win_ID    RcsID    PID     w     h       x      y  Foc InReg Dep Opaq Vsbt Icon Vis Map  Frame  HWC_ST  Parent     Title',
    '-----------------------------------------------------------------',
    '  2 0x0093f2b0     66   6965   1920   376      0      0             32  -1    2    2   1   V     0      NO     0          Guide-Win',
    '  3 0x00a36ea0     99  23982      0     0    154    810             32  -1    2    0   0   N     0      NO     0          tvlauncher',
    '  4 0x008afff8     16   1523   1920   360      0    720             32  -1   -1    0   0   V     0      NO     0          Keyboard',
    '  6 0x009739d8     19   2132   1920  1080      0      0   O         32  -1    0    0   1   V     1      CL     6dc0d8     hbbtv-app',
    '  7 0x006dc0d8      4    482   1920  1080      0      0             24  -1    0    0   1   V     1      CL     0          tv-viewer',
    '  9 0x0075a6c8     11    695   4096  4096      0      0        C    32  -1    0    0   1   V     1      VD     0          tvvideosink-video',
    ' 11 0x00000002      2      0   1920  1080      0      0        C    32  -1   -1    0   1   N     1      NO     0          ( vs-0,1 )',
    '15 Top level windows in EC list',
    '  3 0x00a36ea0     99  23982     1612   270    154    810             32  -1    2    0   1   V     0      NO     0          tvlauncher',
].join('\n');

const windows = parseWindows(LIST);
assert.equal(windows.length, 7, 'only the first table');
const hbb = windows.find(w => w.id === '0x009739d8');
assert.deepEqual([hbb.w, hbb.h, hbb.x, hbb.y, hbb.vis, hbb.map, hbb.hwc, hbb.title], [1920, 1080, 0, 0, 1, 'V', 'CL', 'hbbtv-app'], 'a letter in the Foc/InReg columns');
assert.equal(windows.find(w => w.id === '0x0075a6c8').hwc, 'VD', 'a letter one column further right');
assert.equal(windows.find(w => w.id === '0x00000002').title, '( vs-0,1 )', 'titles with spaces');

const T = DIR + '/tv-1';
const out = ['@@LIST', LIST, '@@FILES',
    T + '/topvwins-x/0x006dc0d8_0.png', T + '/topvwins-x/0x009739d8_0.png', T + '/topvwins-x/0x008afff8_0.png',
    T + '/topvwins-x/0x0093f2b0_0.png', '/etc/0x00000002_0.png'].join('\n');
const shot = parse(out);
assert.deepEqual(shot.windows.map(w => w.title), ['tv-viewer', 'hbbtv-app'],
    'bottom first; hidden windows (Keyboard, launcher), the fully covered Guide-Win and files outside the folder are left out');
assert.equal(shot.video, true, 'a visible hardware video layer is reported');
assert.equal(shot.windows[1].file, T + '/topvwins-x/0x009739d8_0.png');


    // The scaler helper succeeded: one full-screen image, no window list.
    const S = DIR + '/tv-2';
    const scaler = parse(['@@SCREEN', '{"ok":true,"width":720,"height":576,"format":0,"protect":0,"ms":30}', '@@FILES', S + '/screen.png', '/tmp/screen.png'].join('\n'));
    assert.equal(scaler.source, 'scaler');
    assert.equal(scaler.video, false, 'video is in the picture');
    assert.deepEqual(scaler.size, {w: 720, h: 576});
    assert.deepEqual(scaler.windows.map(w => [w.id, w.x, w.y, w.w, w.h, w.file]), [['screen', 0, 0, 1920, 1080, S + '/screen.png']], 'stretched over the canvas');
    // The helper refused protected video: the window list is used and the page is told why video is missing.
    const refused = parse(['@@SCREEN', '{"ok":false,"protect":1,"ms":12,"error":"protected content"}', out].join('\n'));
    assert.equal(refused.source, 'windows');
    assert.equal(refused.protected, true);
    assert.equal(refused.windows.length, 2);
    assert.equal(parse(['@@SCREEN', '{"ok":true,"width":1,"height":1}', '@@FILES', '/etc/screen.png'].join('\n')).source, 'windows', 'a screen file outside the folder is ignored');

(async () => {
    // The capture serves only the latest capture's files, by id and capture time.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vetro-shot-'));
    const png = path.join(tmp, 'w.png');
    fs.writeFileSync(png, Buffer.from([137, 80, 78, 71]));
    let calls = 0, script = '';
    const cap = new Capture(async cmd => {
        calls++;
        script = Buffer.from(cmd.split(' ')[1], 'base64').toString();
        return { exit_code: 0, stdout: out };
    }, () => 1000);
    const [a, b] = await Promise.all([cap.take(), cap.take()]);
    assert.equal(calls, 1, 'two requests at once share one capture');
    assert.equal(a, b);
    assert.match(script, /enlightenment_info -dump topvwins "\$T"/);
    assert.match(script, /native[\/\\]capture[\/\\]TvCapture\.dll"$/m, 'the packaged helper is tried first');
    assert.match(script, /\/usr\/bin\/dotnet "\$X" "\$T\/screen\.png" 1920 1080/);
    assert.match(script, /^D=\/opt\/usr\/home\/owner\/share\/vetro-screen$/m);
    assert.match(script, /T="\$D\/tv-1000"/, 'the folder name comes from the clock');
    assert.equal(a.windows.length, 2);
    assert.equal(a.windows[0].file, undefined, 'file paths stay on the TV');
    cap.last.files['0x006dc0d8'] = png;
    cap.last.files.screen = png;
    assert.deepEqual([...cap.file('screen', 1000)], [137, 80, 78, 71], 'the full-screen image');
    assert.deepEqual([...cap.file('0x006dc0d8', 1000)], [137, 80, 78, 71]);
    assert.equal(cap.file('0x006dc0d8', 999), null, 'an older capture time');
    assert.equal(cap.file('../../etc/passwd', 1000), null, 'not an id');
    assert.equal(cap.file('0x00000002', 1000), null, 'not in this capture');

    const empty = new Capture(async () => ({ exit_code: 0, stdout: '@@LIST\n@@FILES\n' }));
    await assert.rejects(empty.take(), /did not list any windows/);
    fs.rmSync(tmp, { recursive: true, force: true });

    // Live view. The start script runs the packaged helper once, as a transient unit or detached.
    const ls = liveScript('/opt/x/TvCapture.dll');
    assert.match(ls, /grep -q "127\.0\.0\.1:8097 "; then echo running; exit 0; fi/, 'a running helper is reused');
    assert.match(ls, /exec \/usr\/bin\/dotnet "\/opt\/x\/TvCapture\.dll" --serve 8097 --fps 15 --size 1280x720 --idle-exit 30/);
    assert.match(ls, /systemd-run --unit=vetro-screen-live .*\|\| setsid nohup/);

    const { EventEmitter } = require('events');
    const fakeRes = () => {
        const r = new EventEmitter();
        r.head = null; r.body = ''; r.timeout = null;
        r.writeHead = (code, h) => { r.head = [code, h]; };
        r.write = c => { r.body += c; return true; };
        r.end = c => { if (c) r.body += c; r.emit('finish'); };
        r.setTimeout = ms => { r.timeout = ms; };
        r.on('unpipe', () => {});
        r.removeListener = EventEmitter.prototype.removeListener;
        return r;
    };
    // httpGet that refuses `refuse` times, then answers with an upstream stream.
    const fakeGet = (refuse, paths) => (opts, cb) => {
        paths.push(opts.host + ':' + opts.port + opts.path);
        const req = new EventEmitter();
        req.destroy = () => { req.destroyed = true; };
        setImmediate(() => {
            if (refuse-- > 0) return req.emit('error', new Error('ECONNREFUSED'));
            const { PassThrough } = require('stream');
            const up = new PassThrough();
            up.statusCode = 200; up.headers = { 'content-type': 'multipart/x-mixed-replace; boundary=frame' };
            cb(up); up.end('--frame');
        });
        return req;
    };

    let execs = 0, paths = [];
    const live = new Capture(async () => { execs++; return { stdout: 'started\n' }; }, () => 1, '/x.dll', fakeGet(2, paths));
    const res1 = fakeRes();
    live.live('/stream', res1, true);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(execs, 1, 'a refused connection starts the helper once');
    assert.deepEqual(paths, ['127.0.0.1:8097/stream', '127.0.0.1:8097/stream', '127.0.0.1:8097/stream'], 'retried until it listens');
    assert.equal(res1.head[0], 200);
    assert.match(res1.head[1]['content-type'], /multipart\/x-mixed-replace/);
    assert.equal(res1.head[1]['cache-control'], 'no-store');
    assert.equal(res1.timeout, 0, 'a stream is not cut by the server timeout');

    const quiet = new Capture(async () => { execs++; return { stdout: '' }; }, () => 1, '/x.dll', fakeGet(1, []));
    const res2 = fakeRes();
    quiet.live('/status', res2, false);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(execs, 1, 'a status request never starts the helper');
    assert.deepEqual(JSON.parse(res2.body), { running: false });

    const missing = new Capture(async () => ({ stdout: 'missing\n' }), () => 1, '/x.dll', fakeGet(99, []));
    const res3 = fakeRes();
    missing.live('/stream', res3, true);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(res3.head[0], 503);
    assert.match(res3.body, /not installed/);
    console.log('PASS screen capture: window list, stacking order, file access, live view');
})().catch(e => { console.error(e); process.exit(1); });
