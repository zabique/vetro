'use strict';
// Install apps from the dashboard (TV › Install apps): upload a .wgt or .tpk in chunks, sign it with the developer
// certificate when asked (signer.js, kept out of git), install it with pkgcmd, then make it show up the way a store
// install does: a row in Samsung's web app registry (webapp-registry.js) and a tile on the Samsung Home row
// (home-order.js add). Also lists installed packages, launches, clears data and uninstalls (the uninstall takes the
// registry row and the Home tile away again).
//
// Every value that reaches a shell command is checked against a strict pattern first: package and app ids are
// [A-Za-z0-9_.-], and only files this module wrote under /tmp/sideload can be installed.
//
//   GET  /sideload/apps                           installed packages
//   POST /sideload/upload    {filename, chunk, totalChunks, data(base64)}
//   POST /sideload/install   {path, type?, sign?}
//   POST /sideload/launch    {appId}
//   POST /sideload/uninstall {packageId}
//   POST /sideload/cleardata {packageId, type?}
//   POST /sideload/register  {packageId}         registry row and Home tile for an app installed some other way

var fs = require('fs');
var path = require('path');

var DIR = '/tmp/sideload';
var MAX_PACKAGE = 400 * 1024 * 1024;
var CHUNK_BODY = 4 * 1024 * 1024;          // one base64 chunk (the page sends 512 KB of file per chunk)
var PACKAGE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
var APP_ID = /^[A-Za-z0-9_.-]{1,128}$/;
var FILE = /^[A-Za-z0-9._-]{1,120}\.(wgt|tpk)$/;

var signer = null;
try { signer = require('./signer.js'); } catch (e) { /* not in this package: "sign" is refused */ }

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

function Sideload(deps) {
    this.execute = deps.execute;
    this.registry = deps.registry;
    this.homeOrder = deps.homeOrder;
    this.dock = deps.dock;
    this.uploads = {};     // file name -> {next chunk, size}
    this.busy = false;
}

// After an install: Samsung's app registry first (without a row Samsung Home drops the tile and the dock skips it),
// then the Home row. Never fails the install; each step reports its own result.
Sideload.prototype.show = function (packageId) {
    var self = this;
    return this.registry.register(packageId).catch(function (e) { return { registered: false, error: e.message }; }).then(function (reg) {
        return self.homeOrder.add(packageId).then(function (o) {
            if (o.added) self.dock.refresh().catch(function () {});
            return { registry: reg, homeRow: { added: o.added } };
        }).catch(function (e) { return { registry: reg, homeRow: { added: null, error: e.message } }; });
    });
};

// After an uninstall: the registry row Vetro made, and the Home tile, go too. Never fails the uninstall.
Sideload.prototype.hide = function (packageId) {
    var self = this;
    return this.registry.unregister(packageId).catch(function (e) { return { removed: 0, error: e.message }; }).then(function (registry) {
        return self.homeOrder.prune().then(function (o) {
            if (o.removed.length) self.dock.refresh().catch(function () {});
            return { removed: o.removed, registry: registry };
        }).catch(function (e) { return { removed: [], registry: registry, error: e.message }; });
    });
};

Sideload.prototype.apps = function () {
    return this.execute('pkgcmd -l 2>/dev/null; echo "===LAUNCHER==="; app_launcher -l 2>/dev/null', 30000).then(function (r) {
        return { ok: true, apps: parseApps(r.stdout) };
    });
};

Sideload.prototype.upload = function (p) {
    var name = String(p.filename || '');
    if (!FILE.test(name)) throw Object.assign(Error('Choose a .wgt or .tpk file (letters, digits, dot, dash and underscore in its name).'), { statusCode: 400 });
    var chunk = Number(p.chunk), total = Number(p.totalChunks);
    if (!(chunk >= 0 && chunk < total && total <= 4096 && Math.floor(chunk) === chunk)) throw Object.assign(Error('Bad chunk number'), { statusCode: 400 });
    var u = this.uploads[name];
    if (chunk === 0) u = this.uploads[name] = { next: 0, size: 0 };
    if (!u || u.next !== chunk) throw Object.assign(Error('Upload out of order; start again'), { statusCode: 409 });
    var buf = Buffer.from(String(p.data || ''), 'base64');
    if (u.size + buf.length > MAX_PACKAGE) { delete this.uploads[name]; throw Object.assign(Error('The package is larger than 400 MB.'), { statusCode: 413 }); }
    try { fs.mkdirSync(DIR); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    var file = path.join(DIR, name);
    fs.writeFileSync(file, buf, { flag: chunk === 0 ? 'w' : 'a' });
    u.next++; u.size += buf.length;
    var done = u.next === total;
    if (done) delete this.uploads[name];
    return { ok: true, chunk: chunk, totalChunks: total, done: done, path: file, size: u.size };
};

Sideload.prototype.install = function (p) {
    var self = this, file = String(p.path || '');
    if (path.dirname(file) !== DIR || !FILE.test(path.basename(file)) || !fs.existsSync(file)) {
        return Promise.reject(Object.assign(Error('Upload the package first.'), { statusCode: 400 }));
    }
    var type = /\.tpk$/.test(file) ? 'tpk' : 'wgt';
    if (this.busy) return Promise.reject(Object.assign(Error('Another install is running.'), { statusCode: 409 }));
    this.busy = true;
    var signed = !p.sign ? Promise.resolve(null)
        : !signer || typeof signer.signPackage !== 'function'
            ? Promise.reject(Object.assign(Error('This Vetro package has no signer; choose "Install as it is".'), { step: 'sign' }))
            : signer.signPackage(file, {}).catch(function (e) { throw Object.assign(e, { step: 'sign' }); });
    var cmd = 'pkgcmd -i -t ' + type + ' -p ' + file;
    return signed.then(function (sig) {
        return self.execute(cmd + ' 2>&1', 110000).then(function (r) {
            var out = r.stdout || '', id = /pkgid\[([A-Za-z0-9_.-]+)\]/.exec(out);
            var ok = r.exit_code === 0 && /val\[ok\]/.test(out);
            var packageId = id ? id[1] : null;
            var result = { ok: ok, signed: !!sig, packageId: packageId, exit_code: r.exit_code, output: out.split('\n').filter(function (l) { return !/install_percent/.test(l); }).join('\n').trim(), command: cmd };
            if (!ok || !packageId || !PACKAGE_ID.test(packageId)) return result;
            return self.show(packageId).then(function (s) { result.registry = s.registry; result.homeRow = s.homeRow; return result; });
        });
    }).finally(function () {
        self.busy = false;
        fs.unlink(file, function () {});
    });
};

Sideload.prototype.launch = function (p) {
    if (!APP_ID.test(String(p.appId || ''))) return Promise.reject(Object.assign(Error('missing or invalid appId'), { statusCode: 400 }));
    return this.execute('app_launcher -s ' + p.appId + ' 2>&1', 20000).then(function (r) {
        return { ok: r.exit_code === 0 && !/fail|error/i.test(r.stdout || ''), output: r.stdout };
    });
};

Sideload.prototype.uninstall = function (p) {
    var self = this, id = String(p.packageId || '');
    if (!PACKAGE_ID.test(id)) return Promise.reject(Object.assign(Error('missing or invalid packageId'), { statusCode: 400 }));
    if (systemPackage(id)) return Promise.reject(Object.assign(Error('System packages are not uninstalled here.'), { statusCode: 403 }));
    return this.execute('pkgcmd -u -n ' + id + ' 2>&1', 60000).then(function (r) {
        var ok = r.exit_code === 0 && /val\[ok\]/.test(r.stdout || '');
        return (ok ? self.hide(id) : Promise.resolve(null)).then(function (home) {
            return { ok: ok, output: r.stdout, homeRow: home };
        });
    });
};

Sideload.prototype.clearData = function (p) {
    var id = String(p.packageId || ''), type = p.type === 'tpk' ? 'tpk' : 'wgt';
    if (!PACKAGE_ID.test(id)) return Promise.reject(Object.assign(Error('missing or invalid packageId'), { statusCode: 400 }));
    return this.execute('pkgcmd -c -t ' + type + ' -n ' + id + ' 2>&1', 30000).then(function (r) {
        return { ok: r.exit_code === 0, output: r.stdout };
    });
};

Sideload.prototype.register = function (p) {
    var id = String(p.packageId || '');
    if (!PACKAGE_ID.test(id)) return Promise.reject(Object.assign(Error('missing or invalid packageId'), { statusCode: 400 }));
    return this.show(id).then(function (s) { return { ok: !!(s.registry && s.registry.registered), registry: s.registry, homeRow: s.homeRow }; });
};

// Returns true when the request was a /sideload route.
Sideload.prototype.handle = function (url, req, res, readJsonBody, serveJson) {
    if (url.indexOf('/sideload/') !== 0) return false;
    var self = this;
    var fail = function (e) { serveJson(res, { ok: false, step: e.step || null, error: e.message }, e.statusCode || (e.step ? 500 : 503)); };
    if (url === '/sideload/apps' && req.method === 'GET') { this.apps().then(function (d) { serveJson(res, d); }, fail); return true; }
    var actions = { '/sideload/install': 'install', '/sideload/launch': 'launch', '/sideload/uninstall': 'uninstall',
        '/sideload/cleardata': 'clearData', '/sideload/register': 'register' };
    if (req.method !== 'POST') { serveJson(res, { error: 'Use POST' }, 405); return true; }
    if (url === '/sideload/upload') {
        readJsonBody(req, res, function (p) {
            try { serveJson(res, self.upload(p)); } catch (e) { fail(e); }
        }, CHUNK_BODY);
        return true;
    }
    if (!actions[url]) { serveJson(res, { error: 'Unknown install route' }, 404); return true; }
    readJsonBody(req, res, function (p) { self[actions[url]](p).then(function (d) { serveJson(res, d); }, fail); });
    return true;
};

module.exports = { Sideload: Sideload, parseApps: parseApps, PACKAGE_ID: PACKAGE_ID, FILE: FILE };
