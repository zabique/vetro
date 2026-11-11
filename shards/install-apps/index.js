'use strict';
// Install apps: upload a .wgt or .tpk from the dashboard, sign it with your own developer certificate when
// asked, install it with pkgcmd, then make it show up the way a store install does: a row in Samsung's web app
// registry (registry.js) and a tile on the Samsung Home row (home-order.js). Also lists the installed
// packages, launches and uninstalls them (an uninstall takes the registry row and the Home tile away again).
//
// The certificate is yours: two .p12 files and their passwords, given once on the page. The TV's openssl turns
// them into PEM, which is kept in this Shard's config.json (readable by the service only) and never sent back.
//
// Every value that reaches a shell command is checked against a strict pattern first: package and app ids are
// [A-Za-z0-9_.-], and only files this Shard wrote under its upload folder can be installed.
// Needs `exec`: openssl, pkgcmd, app_launcher and the registry and Home row changes all run as root.

module.exports = function (ctx) {
    var fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
    var Registry = require('./registry.js').Registry, Order = require('./home-order.js').Order;

    var DIR = '/tmp/install-apps-shard';
    var MAX_PACKAGE = 400 * 1024 * 1024;
    var CHUNK_BODY = 4 * 1024 * 1024;          // one base64 chunk (the page sends 512 KB of file per chunk)
    var SMALL_BODY = 256 * 1024;
    var PACKAGE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
    var APP_ID = /^[A-Za-z0-9_.-]{1,128}$/;
    var FILE = /^[A-Za-z0-9._-]{1,120}\.(wgt|tpk)$/;
    var BASE64 = /^[A-Za-z0-9+\/=\s]{1,90000}$/;
    var VETRO_PORT = 8099;                       // Vetro's own port, for the launcher refresh below

    var page = '', uploads = {}, busy = false, registry = null, homeOrder = null;

    function buffer(text, encoding) { return typeof Buffer.alloc === 'function' ? Buffer.from(text, encoding) : new Buffer(text, encoding); }
    function wrap(script) { return 'echo ' + buffer(script, 'utf8').toString('base64') + ' | base64 -d | sh'; }
    function problem(message, code, step) { var e = new Error(message); e.statusCode = code; e.step = step || null; return e; }
    function json(res, body, code) {
        if (res.headersSent) return;
        res.writeHead(code || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    }
    function failure(res) {
        return function (e) { json(res, { ok: false, step: e.step || null, error: String(e && e.message || e) }, e.statusCode || (e.step ? 500 : 503)); };
    }
    function readBody(req, limit, done) {
        var parts = [], size = 0, over = false;
        req.on('data', function (c) { if (over) return; size += c.length; if (size > limit) { over = true; return done(null); } parts.push(c); });
        req.on('end', function () {
            if (over) return;
            var parsed = null;
            try { parsed = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch (e) { parsed = null; }
            done(parsed && typeof parsed === 'object' ? parsed : null);
        });
    }

    // ── the developer certificate ───────────────────────────────────────────────────────────────────────
    // One .p12 to PEM, as root with the TV's openssl. The password goes in through stdin, never on a command
    // line; the files live in a private folder for the length of the command.
    function convertScript(p12, password) {
        var pass = password === '' ? '-passin pass:' : '-passin stdin < "$T/pw"';
        return [
            'T=$(mktemp -d /tmp/install-apps-cert.XXXXXX) || exit 1',
            'trap \'rm -rf "$T"\' EXIT',
            'chmod 700 "$T"',
            'echo ' + p12 + ' | base64 -d > "$T/in.p12"',
            'echo ' + buffer(password, 'utf8').toString('base64') + ' | base64 -d > "$T/pw"',
            'if ! openssl pkcs12 -in "$T/in.p12" -nokeys ' + pass + ' > "$T/certs.pem" 2> "$T/err"; then echo "@@ERR"; cat "$T/err"; exit 0; fi',
            'openssl pkcs12 -in "$T/in.p12" -nocerts -nodes ' + pass + ' > "$T/key.pem" 2>> "$T/err" || { echo "@@ERR"; cat "$T/err"; exit 0; }',
            'echo "@@CERTS"; cat "$T/certs.pem"',
            'echo "@@KEY"; cat "$T/key.pem"',
            'echo "@@INFO"; openssl x509 -in "$T/certs.pem" -noout -subject -enddate 2>/dev/null',
            'true'
        ].join('\n');
    }
    function parseConverted(text) {
        text = String(text || '');
        if (text.indexOf('@@ERR') >= 0 || text.indexOf('@@KEY') < 0) {
            throw problem(/mac verify|invalid password/i.test(text) ? 'Wrong password for this certificate file.' : 'This file could not be read as a .p12 certificate.', 400);
        }
        var certs = text.slice(text.indexOf('@@CERTS'), text.indexOf('@@KEY')), rest = text.slice(text.indexOf('@@KEY'));
        var chain = [], re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g, m;
        while ((m = re.exec(certs))) chain.push(m[1].replace(/\s+/g, ''));
        var key = /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/.exec(rest);
        if (!chain.length || !key) throw problem('The certificate file holds no certificate with its private key.', 400);
        var info = rest.slice(rest.indexOf('@@INFO'));
        var subject = /subject\s*=\s*(.*)/.exec(info), end = /notAfter\s*=\s*(.*)/.exec(info);
        var out = { chain: chain, key: key[0] + '\n', subject: subject ? subject[1].trim().slice(0, 200) : '', notAfter: end ? end[1].trim().slice(0, 60) : '' };
        // The key must be the one of the first certificate.
        var probe = crypto.createSign('RSA-SHA256').update('install-apps').sign(out.key);
        // 64 characters a line and no empty line before END (a length that is a multiple of 64 must not leave one).
        var pem = '-----BEGIN CERTIFICATE-----\n' + chain[0].match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
        if (!crypto.createVerify('RSA-SHA256').update('install-apps').verify(pem, probe)) throw problem('The private key does not belong to the certificate.', 400);
        return out;
    }
    function convert(part, what) {
        if (!part || typeof part.p12 !== 'string' || !BASE64.test(part.p12)) return Promise.reject(problem('Choose the ' + what + ' .p12 file.', 400));
        var password = typeof part.password === 'string' ? part.password : '';
        if (password.length > 256) return Promise.reject(problem('That password is too long.', 400));
        return ctx.execute(wrap(convertScript(part.p12.replace(/\s+/g, ''), password)), 20000).then(function (r) {
            try { return parseConverted(r.stdout); } catch (e) { e.message = what.charAt(0).toUpperCase() + what.slice(1) + ': ' + e.message; throw e; }
        });
    }
    function certs() { var c = ctx.config.get() || {}; return c.certs && c.certs.author && c.certs.author.key ? c.certs : null; }
    function certSummary() {
        var c = certs();
        function one(x) { return x && x.key ? { subject: x.subject || '', notAfter: x.notAfter || '' } : null; }
        return { author: c ? one(c.author) : null, distributor: c ? one(c.distributor) : null };
    }
    function saveCerts(p) {
        var config = ctx.config.get() || {};
        if (p.remove === true) { delete config.certs; ctx.config.set(config); return Promise.resolve(certSummary()); }
        return convert(p.author, 'author').then(function (author) {
            return (p.distributor && p.distributor.p12 ? convert(p.distributor, 'distributor') : Promise.resolve(null)).then(function (distributor) {
                config.certs = { author: author };
                if (distributor) config.certs.distributor = distributor;
                ctx.config.set(config);
                return certSummary();
            });
        });
    }

    // ── packages ────────────────────────────────────────────────────────────────────────────────────────
    // Firmware parts (and Vetro itself) are listed but never uninstalled from here.
    function systemPackage(id, type) {
        return type === 'rpm' || id === 'vetrotvapp' || /^(com\.samsung\.|org\.tizen\.|dtv-|lib-)/.test(id);
    }

    // pkgcmd -l lines: "user apps  pkg_type [wgt]  pkgid [X]  name [Y]  version [Z] ..."; app_launcher -l: "'name' 'appid'".
    function parseApps(text) {
        var parts = String(text || '').split('===LAUNCHER===');
        var byPkg = {}, byName = {};
        String(parts[1] || '').split('\n').forEach(function (l) {
            var m = /'([^']+)'\s+'([^']+)'/.exec(l);
            if (!m) return;
            var appId = m[2].trim(), pkg = appId.split('.')[0];
            byName[m[1].trim()] = appId;
            if (!byPkg[pkg]) byPkg[pkg] = appId;
        });
        var apps = [];
        String(parts[0] || '').split('\n').forEach(function (line) {
            var m = /pkg_type\s*\[([^\]]+)\]\s*pkgid\s*\[([^\]]+)\]\s*name\s*\[([^\]]*)\]\s*version\s*\[([^\]]*)\]/.exec(line);
            if (!m) return;
            var pkgId = m[2], name = m[3] || pkgId;
            apps.push({
                name: name, packageId: pkgId, type: m[1], version: m[4] || '',
                appId: byName[name] && byName[name].split('.')[0] === pkgId ? byName[name] : byPkg[pkgId] || null,
                // pkgcmd calls everything installed by root "system apps", sideloads included: judge by the id.
                system: systemPackage(pkgId, m[1])
            });
        });
        apps.sort(function (a, b) { return (a.system - b.system) || a.name.localeCompare(b.name); });
        return apps;
    }

    // The Vetro launcher lists apps too. A Shard has no handle on it, so Vetro is asked over its own port to
    // read the list again; if that does not work the launcher simply shows the change later.
    function refreshLauncher() {
        try {
            var body = JSON.stringify({ action: 'refresh' });
            var req = http.request({ host: '127.0.0.1', port: VETRO_PORT, path: '/dock', method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, function (r) { r.resume(); });
            req.on('error', function () { /* best effort */ });
            req.setTimeout(8000, function () { req.abort(); });
            req.end(body);
        } catch (e) { /* best effort */ }
    }

    // After an install: Samsung's app registry first (without a row Samsung Home drops the tile), then the Home
    // row. Never fails the install; each step reports its own result.
    function show(packageId) {
        return registry.register(packageId).catch(function (e) { return { registered: false, error: e.message }; }).then(function (reg) {
            return homeOrder.add(packageId).then(function (o) {
                if (o.added) refreshLauncher();
                return { registry: reg, homeRow: { added: o.added } };
            }).catch(function (e) { return { registry: reg, homeRow: { added: null, error: e.message } }; });
        });
    }
    // After an uninstall: the registry row made here, and the Home tile, go too. Never fails the uninstall.
    function hide(packageId) {
        return registry.unregister(packageId).catch(function (e) { return { removed: 0, error: e.message }; }).then(function (reg) {
            return homeOrder.prune().then(function (o) {
                if (o.removed.length) refreshLauncher();
                return { removed: o.removed, registry: reg };
            }).catch(function (e) { return { removed: [], registry: reg, error: e.message }; });
        });
    }

    function apps() {
        return ctx.execute('pkgcmd -l 2>/dev/null; echo "===LAUNCHER==="; app_launcher -l 2>/dev/null', 30000).then(function (r) {
            return { ok: true, apps: parseApps(r.stdout) };
        });
    }

    function upload(p) {
        var name = String(p.filename || '');
        if (!FILE.test(name)) throw problem('Choose a .wgt or .tpk file (letters, digits, dot, dash and underscore in its name).', 400);
        var chunk = Number(p.chunk), total = Number(p.totalChunks);
        if (!(chunk >= 0 && chunk < total && total <= 4096 && Math.floor(chunk) === chunk)) throw problem('Bad chunk number', 400);
        if (typeof p.data !== 'string') throw problem('Missing data', 400);
        var u = uploads[name];
        if (chunk === 0) u = uploads[name] = { next: 0, size: 0 };
        if (!u || u.next !== chunk) throw problem('Upload out of order; start again', 409);
        var buf = buffer(p.data, 'base64');
        if (u.size + buf.length > MAX_PACKAGE) { delete uploads[name]; throw problem('The package is larger than 400 MB.', 413); }
        try { fs.mkdirSync(DIR); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        fs.writeFileSync(path.join(DIR, name), buf, { flag: chunk === 0 ? 'w' : 'a' });
        u.next++; u.size += buf.length;
        var done = u.next === total;
        if (done) delete uploads[name];
        return { ok: true, chunk: chunk, totalChunks: total, done: done, file: name, size: u.size };
    }

    function install(p) {
        var name = String(p.file || ''), file = path.join(DIR, name);
        if (!FILE.test(name) || !fs.existsSync(file)) return Promise.reject(problem('Upload the package first.', 400));
        if (busy) return Promise.reject(problem('Another install is running.', 409));
        var keys = p.sign ? certs() : null;
        if (p.sign && !keys) return Promise.reject(problem('Add your developer certificate first, or choose "Install as it is".', 400, 'sign'));
        busy = true;
        function done() { busy = false; fs.unlink(file, function () {}); }
        var type = /\.tpk$/.test(name) ? 'tpk' : 'wgt', cmd = 'pkgcmd -i -t ' + type + ' -p ' + file;
        var signed = !keys ? Promise.resolve(null)
            : require('./sign.js').signPackage(file, keys).catch(function (e) { e.step = 'sign'; throw e; });
        var result = signed.then(function (sig) {
            return ctx.execute(cmd + ' 2>&1', 110000).then(function (r) {
                var out = r.stdout || '', id = /pkgid\[([A-Za-z0-9_.-]+)\]/.exec(out);
                var ok = r.exit_code === 0 && /val\[ok\]/.test(out), packageId = id ? id[1] : null;
                var answer = { ok: ok, signed: !!sig, packageId: packageId, exit_code: r.exit_code,
                    output: out.split('\n').filter(function (l) { return !/install_percent/.test(l); }).join('\n').trim() };
                if (!ok || !packageId || !PACKAGE_ID.test(packageId)) return answer;
                return show(packageId).then(function (s) { answer.registry = s.registry; answer.homeRow = s.homeRow; return answer; });
            });
        });
        result.then(done, done);
        return result;
    }

    function launch(p) {
        if (!APP_ID.test(String(p.appId || ''))) return Promise.reject(problem('missing or invalid appId', 400));
        return ctx.execute('app_launcher -s ' + p.appId + ' 2>&1', 20000).then(function (r) {
            return { ok: r.exit_code === 0 && !/fail|error/i.test(r.stdout || ''), output: r.stdout };
        });
    }

    function uninstall(p) {
        var id = String(p.packageId || '');
        if (!PACKAGE_ID.test(id)) return Promise.reject(problem('missing or invalid packageId', 400));
        if (systemPackage(id)) return Promise.reject(problem('System packages are not uninstalled here.', 403));
        return ctx.execute('pkgcmd -u -n ' + id + ' 2>&1', 60000).then(function (r) {
            var ok = r.exit_code === 0 && /val\[ok\]/.test(r.stdout || '');
            return (ok ? hide(id) : Promise.resolve(null)).then(function (home) { return { ok: ok, output: r.stdout, homeRow: home }; });
        });
    }

    function register(p) {
        var id = String(p.packageId || '');
        if (!PACKAGE_ID.test(id)) return Promise.reject(problem('missing or invalid packageId', 400));
        return show(id).then(function (s) { return { ok: !!(s.registry && s.registry.registered), registry: s.registry, homeRow: s.homeRow }; });
    }

    var ACTIONS = { install: install, launch: launch, uninstall: uninstall, register: register, cert: saveCerts };

    return {
        start: function () {
            registry = new Registry(ctx.execute);
            homeOrder = new Order(ctx.execute);
            page = fs.readFileSync(path.join(ctx.dir, 'page.html'), 'utf8');
        },
        stop: function () { uploads = {}; },
        status: function () { return { certificate: !!certs(), installing: busy }; },
        route: function (req, res, sub) {
            if (req.method === 'GET') {
                if (sub === 'ui') {
                    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(page);
                    return true;
                }
                if (sub === 'apps') { apps().then(function (d) { json(res, d); }, failure(res)); return true; }
                if (sub === 'cert') { json(res, certSummary()); return true; }
                return false;
            }
            if (req.method !== 'POST') return false;
            if (sub === 'upload') {
                readBody(req, CHUNK_BODY, function (p) {
                    if (!p) return json(res, { ok: false, error: 'JSON body expected (up to 4 MB)' }, 400);
                    try { json(res, upload(p)); } catch (e) { failure(res)(e); }
                });
                return true;
            }
            if (!Object.prototype.hasOwnProperty.call(ACTIONS, sub)) return false;
            readBody(req, SMALL_BODY, function (p) {
                if (!p) return json(res, { ok: false, error: 'JSON body expected' }, 400);
                var out;
                try { out = ACTIONS[sub](p); } catch (e) { return failure(res)(e); }
                out.then(function (d) { json(res, d); }, failure(res));
            });
            return true;
        },
        // For tests.
        _internals: { parseApps: parseApps, parseConverted: parseConverted, convertScript: convertScript, DIR: DIR }
    };
};
