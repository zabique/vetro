'use strict';
// Lifecycle of the TV Screen Shard without a TV: factory, start, status, page, routes, stop, start again.
// Plain ES5 so the same file runs on Node 4.4 (the oldest runtime Vetro supports) and on current Node.
var assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), EventEmitter = require('events').EventEmitter;

var src = path.join(__dirname, 'tv-screen');
var dir = path.join(os.tmpdir(), 'tv-screen-lifecycle-' + process.pid);
try { fs.mkdirSync(dir); } catch (e) { /* exists */ }
fs.readdirSync(src).forEach(function (f) {
    if (fs.statSync(path.join(src, f)).isFile()) fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(src, f)));
});

var saved = {}, commands = [];
var ctx = {
    id: 'tv-screen', dir: dir,
    config: { get: function () { return saved; }, set: function (v) { saved = v; } },
    execute: function (cmd) { commands.push(cmd); return Promise.resolve({ exit_code: 0, stdout: '', stderr: '' }); }
};
var shard = require(path.join(dir, 'index.js'))(ctx);

function call(method, sub, body, done) {
    var req = new EventEmitter();
    req.method = method; req.url = '/plugins/tv-screen/api/' + sub;
    var res = { headersSent: false, on: function () {}, setTimeout: function () {},
        writeHead: function (code) { this.code = code; this.headersSent = true; },
        end: function (text) { done(this.code, String(text)); } };
    var handled = shard.route(req, res, sub.split('?')[0]);
    if (!handled) return done(null, null);
    if (body !== undefined) { req.emit('data', body); req.emit('end'); }
}

shard.start();
var dll = fs.readFileSync(path.join(dir, 'bin', 'TvCapture.dll'));
var want = fs.readFileSync(path.join(dir, 'capture.dll.b64'), 'utf8').replace(/\s+/g, '');
assert.strictEqual(dll.toString('base64'), want, 'the helper is unpacked byte for byte');
assert.strictEqual(dll[0], 0x4d); assert.strictEqual(dll[1], 0x5a);
assert.strictEqual(commands.length, 1, 'a new helper stops the old live view');
assert.strictEqual(shard.status().helper, true);

call('GET', 'ui', undefined, function (code, html) {
    assert.strictEqual(code, 200); assert.ok(html.indexOf('id="screenKeys"') > 0);
    call('GET', 'prefs', undefined, function (code2, text) {
        assert.deepEqual(JSON.parse(text), { keys: true });
        call('POST', 'control', JSON.stringify({ events: [{ key: 'Shift_L', state: 'down' }, { key: 'a' }] }), function (code3, text3) {
            assert.strictEqual(code3, 200);
            // the key command is base-64 free and holds only whitelisted names
            var cmd = commands[commands.length - 1];
            assert.ok(/uint32:1 string:Shift_L .*uint32:1 string:a .*uint32:0 string:a /.test(cmd), cmd);
            setTimeout(function () {
                assert.deepEqual(JSON.parse(text3), { ok: true, sent: 2 });
                assert.strictEqual(shard.status().keysHeld, 1);
                call('POST', 'control', '{"events":[{"key":"a; reboot"}]}', function (code4) {
                    assert.strictEqual(code4, 400);
                    call('GET', 'no-such-route', undefined, function (code5) {
                        assert.strictEqual(code5, null);
                        shard.stop();
                        assert.strictEqual(shard.status().keysHeld, 0, 'stop releases held keys');
                        var n = commands.length;
                        shard.start();
                        assert.strictEqual(commands.length, n, 'an unchanged helper is left alone on restart');
                        shard.stop();
                        console.log('tv-screen lifecycle: ok on Node ' + process.version);
                    });
                });
            }, 20);
        });
    });
});
