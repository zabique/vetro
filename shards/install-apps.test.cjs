'use strict';
// The Install apps Shard without a TV: lifecycle, routes, the zip signer, and (where sh and openssl exist) the
// whole certificate path with a throwaway certificate. Plain ES5, so it also runs on Node 4.4; the parts that
// need a newer Node or local tools say so and are skipped.
var assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib'),
    crypto = require('crypto'), cp = require('child_process'), EventEmitter = require('events').EventEmitter;

var src = path.join(__dirname, 'install-apps');
var dir = path.join(os.tmpdir(), 'install-apps-test-' + process.pid);
try { fs.mkdirSync(dir); } catch (e) { /* exists */ }
fs.readdirSync(src).forEach(function (f) { fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(src, f))); });
function text(s) { return typeof Buffer.alloc === 'function' ? Buffer.from(s, 'utf8') : new Buffer(s, 'utf8'); }

// ── the signer ──────────────────────────────────────────────────────────────────────────────────────────
var sign = require(path.join(dir, 'sign.js'));
assert.strictEqual(sign.crc32(text('123456789')), 0xCBF43926);

// A small archive made by hand: one stored and one deflated entry, a folder, and an old signature file.
function makeZip(files) {
    var parts = [], records = [], at = 0;
    files.forEach(function (f) {
        var name = text(f.name), data = f.data, packed = f.store ? data : zlib.deflateRawSync(data);
        var h = new Buffer(30); h.fill(0);
        h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(f.store ? 0 : 8, 8); h.writeUInt32LE(sign.crc32(data), 14);
        h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
        var c = new Buffer(46); c.fill(0);
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(f.store ? 0 : 8, 10);
        c.writeUInt32LE(sign.crc32(data), 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(data.length, 24);
        c.writeUInt16LE(name.length, 28); c.writeUInt32LE(at, 42);
        parts.push(h, name, packed); records.push(c, name);
        at += 30 + name.length + packed.length;
    });
    var cd = Buffer.concat(records), end = new Buffer(22); end.fill(0);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
    return Buffer.concat(parts.concat([cd, end]));
}
function readEntry(file, e) {
    var all = fs.readFileSync(file), start = e.offset + 30 + all.readUInt16LE(e.offset + 26) + all.readUInt16LE(e.offset + 28);
    var raw = all.slice(start, start + e.csize);
    return e.method === 8 ? zlib.inflateRawSync(raw) : raw;
}
var FILES = [
    { name: 'config.xml', data: text('<widget id="test"/>') },
    { name: 'img/', data: text(''), store: true },
    { name: 'img/a b.bin', data: text('binary é'), store: true },
    { name: 'author-signature.xml', data: text('old signature') },
    { name: 'index.html', data: text(new Array(400).join('<p>hello</p>')) }
];

function signerTest(keys, done) {
    var file = path.join(dir, 'test.wgt');
    fs.writeFileSync(file, makeZip(FILES));
    sign.signPackage(file, keys).then(function (r) {
        var fd = fs.openSync(file, 'r'), entries = sign.readDirectory(fd, fs.fstatSync(fd).size);
        fs.closeSync(fd);
        assert.deepEqual(entries.map(function (e) { return e.name; }),
            ['author-signature.xml', 'signature1.xml', 'config.xml', 'img/', 'img/a b.bin', 'index.html']);
        assert.strictEqual(r.files, 3); assert.strictEqual(r.distributor, true);
        assert.strictEqual(readEntry(file, entries[5]).toString(), FILES[4].data.toString(), 'entries are copied unchanged');
        assert.strictEqual(readEntry(file, entries[4]).toString(), FILES[2].data.toString());
        var author = readEntry(file, entries[0]).toString(), dist = readEntry(file, entries[1]).toString();
        assert.ok(author.indexOf('old signature') < 0);
        // every file is referenced with its SHA-512, a name with a space percent-encoded
        var digest = crypto.createHash('sha512').update(FILES[2].data).digest('base64').replace(/(.{76})/g, '$1\n');
        assert.ok(author.indexOf('<Reference URI="img/a%20b.bin">\n<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha512"></DigestMethod>\n<DigestValue>' + digest + '</DigestValue>') > 0);
        assert.ok(author.indexOf('URI="img/"') < 0, 'folders are not referenced');
        assert.ok(dist.indexOf('<Reference URI="author-signature.xml">') > 0, 'the distributor signs the author signature too');
        // the signature verifies over the canonical SignedInfo
        [[author, keys.author], [dist, keys.distributor]].forEach(function (pair) {
            var xml = pair[0], info = /<SignedInfo>([\s\S]*?<\/SignedInfo>)/.exec(xml)[1];
            var value = /<SignatureValue>\n([\s\S]*?)\n<\/SignatureValue>/.exec(xml)[1].replace(/\s+/g, '');
            var ok = crypto.createVerify('RSA-SHA512').update('<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">' + info).verify(pair[1].publicKey, value, 'base64');
            assert.ok(ok, 'signature verifies');
            assert.ok(xml.indexOf('<X509Certificate>\n' + pair[1].chain[0].replace(/(.{76})/g, '$1\n') + '\n</X509Certificate>') > 0);
        });
        // not a zip: the file is left alone
        fs.writeFileSync(file, text('this is not a zip archive at all'));
        return sign.signPackage(file, keys).then(function () { throw new Error('signed a non-zip'); }, function (e) {
            assert.ok(/zip/i.test(e.message));
            assert.strictEqual(fs.readFileSync(file).toString(), 'this is not a zip archive at all');
            assert.ok(!fs.existsSync(file + '.signing'));
            done();
        });
    }).catch(function (e) { console.error(e); process.exit(1); });
}

// ── the Shard ───────────────────────────────────────────────────────────────────────────────────────────
var saved = {}, commands = [], runReal = false;
var ctx = {
    id: 'install-apps', dir: dir,
    config: { get: function () { return saved; }, set: function (v) { saved = JSON.parse(JSON.stringify(v)); } },
    execute: function (cmd) {
        commands.push(cmd);
        if (!runReal) return Promise.resolve({ exit_code: 0, stdout: '', stderr: '' });
        var r = cp.spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });       // the certificate script, run here
        return Promise.resolve({ exit_code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' });
    }
};
var shard = require(path.join(dir, 'index.js'))(ctx);

function call(method, sub, body, done) {
    var req = new EventEmitter();
    req.method = method; req.url = '/plugins/install-apps/api/' + sub;
    var res = { headersSent: false, writeHead: function (code) { this.code = code; this.headersSent = true; },
        end: function (t) { done(this.code, String(t)); } };
    if (!shard.route(req, res, sub)) return done(null, null);
    if (body !== undefined) { req.emit('data', text(body)); req.emit('end'); }
}
function post(sub, body, done) { call('POST', sub, JSON.stringify(body), function (code, t) { done(code, JSON.parse(t)); }); }

function shardTest(done) {
    shard.start();
    assert.deepEqual(shard.status(), { certificate: false, installing: false });
    var I = shard._internals;
    var apps = I.parseApps("user apps\tpkg_type [wgt]\tpkgid [AbCdEf1234]\tname [My App]\tversion [1.0.0]\n" +
        "system apps\tpkg_type [rpm]\tpkgid [org.tizen.browser]\tname [Internet]\tversion [2]\n===LAUNCHER===\n\t'My App'\t 'AbCdEf1234.MyApp'\n");
    assert.deepEqual(apps[0], { name: 'My App', packageId: 'AbCdEf1234', type: 'wgt', version: '1.0.0', appId: 'AbCdEf1234.MyApp', system: false });
    assert.strictEqual(apps[1].system, true);
    // the password never appears in the script as text: it travels as base64 into a file openssl reads on stdin
    var script = I.convertScript('QUJD', 'pa ss"$(reboot)');
    assert.ok(script.indexOf('reboot') < 0 && script.indexOf('pa ss') < 0 && script.indexOf('-passin stdin < "$T/pw"') > 0);

    call('GET', 'ui', undefined, function (code, html) {
        assert.strictEqual(code, 200); assert.ok(html.indexOf('id="certSave"') > 0);
        call('GET', 'cert', undefined, function (code2, t) {
            assert.deepEqual(JSON.parse(t), { author: null, distributor: null });
            post('upload', { filename: '../evil.wgt', chunk: 0, totalChunks: 1, data: 'QQ==' }, function (c3, r3) {
                assert.strictEqual(c3, 400);
                post('upload', { filename: 'a.wgt', chunk: 1, totalChunks: 2, data: 'QQ==' }, function (c4) {
                    assert.strictEqual(c4, 409, 'chunks must come in order');
                    post('install', { file: 'missing.wgt', sign: false }, function (c5) {
                        assert.strictEqual(c5, 400);
                        post('install', { file: '../../etc/passwd', sign: false }, function (c6) {
                            assert.strictEqual(c6, 400);
                            post('uninstall', { packageId: 'org.tizen.browser' }, function (c7) {
                                assert.strictEqual(c7, 403, 'system packages stay');
                                post('uninstall', { packageId: 'x; reboot' }, function (c8) {
                                    assert.strictEqual(c8, 400);
                                    post('launch', { appId: 'a b' }, function (c9) {
                                        assert.strictEqual(c9, 400);
                                        post('cert', { author: { p12: 'not base64 !!', password: '' } }, function (c10) {
                                            assert.strictEqual(c10, 400);
                                            assert.strictEqual(commands.length, 0, 'nothing refused reached the TV');
                                            call('GET', 'nothing', undefined, function (c11) {
                                                assert.strictEqual(c11, null);
                                                shard.stop();
                                                done();
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

// ── the certificate path, for real, with a throwaway certificate ──────────────────────────────────────────
function haveTools() {
    try { return cp.spawnSync('sh', ['-c', 'openssl version && mktemp --version && base64 --version'], { encoding: 'utf8' }).status === 0; } catch (e) { return false; }
}
function certificateTest(done) {
    var work = path.join(dir, 'certs');
    try { fs.mkdirSync(work); } catch (e) { /* exists */ }
    function make(name, password) {
        var r = cp.spawnSync('sh', ['-c',
            'cd "$1" && MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -keyout $2.key -out $2.crt -days 2 -subj "/CN=test $2" 2>/dev/null && ' +
            'openssl pkcs12 -export -inkey $2.key -in $2.crt -out $2.p12 -passout "pass:$3" 2>/dev/null', 'sh', work, name, password], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, 'openssl made a test certificate: ' + r.stderr);
        return fs.readFileSync(path.join(work, name + '.p12')).toString('base64');
    }
    var author = make('author', 'pw one'), distributor = make('distributor', "p'w\"2");
    runReal = true; shard.start();
    post('cert', { author: { p12: author, password: 'wrong' } }, function (code, r) {
        assert.strictEqual(code, 400); assert.ok(/password/i.test(r.error), r.error);
        post('cert', { author: { p12: author, password: 'pw one' }, distributor: { p12: distributor, password: "p'w\"2" } }, function (code2, r2) {
            assert.strictEqual(code2, 200, JSON.stringify(r2));
            assert.ok(/test author/.test(r2.author.subject) && /test distributor/.test(r2.distributor.subject));
            assert.ok(!/PRIVATE/.test(JSON.stringify(r2)), 'the key is never sent back');
            assert.ok(/BEGIN (RSA )?PRIVATE KEY/.test(saved.certs.author.key) && saved.certs.author.chain.length === 1);
            assert.strictEqual(shard.status().certificate, true);
            commands.forEach(function (c) { assert.ok(c.indexOf('pw one') < 0, 'no password in a command'); });
            // an uploaded package is signed with that certificate before pkgcmd is called
            var zip = makeZip(FILES).toString('base64');
            post('upload', { filename: 'app.wgt', chunk: 0, totalChunks: 1, data: zip }, function (code3, r3) {
                if (code3 !== 200) { console.log('install-apps: upload folder ' + shard._internals.DIR + ' not writable here, signing through the Shard skipped'); return finish(); }
                var before = commands.length;
                runReal = false;                                     // pkgcmd does not exist here
                post('install', { file: r3.file, sign: true }, function (code4, r4) {
                    assert.strictEqual(r4.signed, true, JSON.stringify(r4));
                    assert.ok(/^pkgcmd -i -t wgt -p \S+app\.wgt 2>&1$/.test(commands[before]), commands[before]);
                    finish();
                });
            });
            function finish() {
                post('cert', { remove: true }, function (code5, r5) {
                    assert.deepEqual(r5, { author: null, distributor: null }); assert.strictEqual(saved.certs, undefined);
                    shard.stop(); done();
                });
            }
        });
    });
}

shardTest(function () {
    var notes = [];
    function end() { console.log('install-apps: ok on Node ' + process.version + (notes.length ? ' (' + notes.join('; ') + ')' : '')); }
    if (typeof crypto.generateKeyPairSync !== 'function') { notes.push('signer not run: this Node cannot make a test key'); return end(); }
    function testKey() {
        var k = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
        return { chain: [crypto.randomBytes(700).toString('base64')], key: k.privateKey, publicKey: k.publicKey };
    }
    signerTest({ author: testKey(), distributor: testKey() }, function () {
        if (!haveTools()) { notes.push('certificate path not run: no sh/openssl here'); return end(); }
        certificateTest(end);
    });
});
