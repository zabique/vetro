// Copy of app/service/home-order.js from zabique/vetro (branch extras-050), unchanged below this line: a Shard
// cannot reach Vetro's own modules, so it carries what it needs. Only add() and prune() are used here.
'use strict';

// Home app order: the ordered list stored in the CoBA ".appLayerCache" file
// under the csfs data dir (or the home.media one on TVs with the new Home). Each line is a section item:
//   s/livetv@<source>        live TV source (TV Plus, RF, ...)
//   d/webapp@<packageId|storeId>  web application
// The file shape is: <version>\n<entries...>\nEOFC OBA\n (some firmwares: EOFCOBA). The Home reads it to
// order the app row; reordering = rewriting the entries. A backup is kept and
// restore() puts it back. Applying a change needs the Home/CoBA host to reload.

var BASE = '/opt/usr/home/owner/apps_rw/com.samsung.tv.csfs/data';
var BASE_NEW_HOME = '/opt/usr/home/owner/apps_rw/com.samsung.tv.home.media/data';
// Shell prelude: D is the first data dir that holds a cache file, the csfs one when neither does.
var PICK_DIR = 'D=' + BASE + '\nfor c in ' + BASE + ' ' + BASE_NEW_HOME + '; do if [ -f "$c/.appLayerCache.1" ] || [ -f "$c/.appLayerCache.2" ]; then D=$c; break; fi; done\n';
var FILES = ['.appLayerCache.1', '.appLayerCache.2'];
var TERM = 'EOFC OBA';
// Some firmwares (e.g. T-PTMDDEUC-1400.1) write the terminator without the space.
var TERMS = ['EOFC OBA', 'EOFCOBA'];
var MAX = 300;
// Type part: letters, digits, "_" and "." (physical inputs use e.g. "source.layer.hdmi"). The "@id" part
// is absent on some source layers (QN85A, T-NKM2DEUC: "s/source.layer.remoteworkspace").
var ENTRY = /^[sd]\/[A-Za-z0-9_.]+(?:@[^\s]+)?$/;

var CLOSE_HOME = 'if app_launcher -r com.samsung.tv.csfs 2>/dev/null | grep -q "result: running"; then app_launcher -k com.samsung.tv.csfs >/dev/null 2>&1 || true; fi\n';

function wrap(script) { return 'echo ' + Buffer.from(script).toString('base64') + ' | base64 -d | sh'; }
function check(r) { if (r.exit_code || r.timed_out) throw Error(r.stderr || r.stdout || 'Home order unavailable'); return r.stdout || ''; }

function parse(text) {
    var lines = String(text || '').replace(/\r/g, '').split('\n');
    if (lines.length < 3) throw Error('Unrecognized Home order');
    var end = lines.findIndex(function (l) { return TERMS.indexOf(l.trim()) >= 0; });
    if (end < 0) throw Error('Home order terminator missing');
    var version = lines[0].trim();
    if (!/^\d+$/.test(version)) throw Error('Unrecognized Home order version');
    var entries = lines.slice(1, end).map(function (l) { return l.trim(); }).filter(Boolean);
    if (entries.length > MAX) throw Error('Too many Home order entries');
    validate(entries);
    return { version: version, entries: entries, term: lines[end].trim() };
}

function validate(entries) {
    if (!Array.isArray(entries) || entries.length > MAX) throw Error('Invalid order');
    entries.forEach(function (e) { if (!ENTRY.test(e)) throw Error('Invalid Home order entry: ' + e); });
}

function render(order) {
    validate(order.entries);
    return order.version + '\n' + order.entries.join('\n') + '\n' + (TERMS.indexOf(order.term) >= 0 ? order.term : TERM) + '\n';
}

function sameSet(a, b) {
    if (a.length !== b.length) return false;
    var x = a.slice().sort().join('\n'), y = b.slice().sort().join('\n');
    return x === y;
}

function Order(execute) { this.execute = execute; this.busy = false; }

Order.prototype.read = function () {
    var script = PICK_DIR + 'cat "$D/' + FILES[0] + '" 2>/dev/null || cat "$D/' + FILES[1] + '" 2>/dev/null';
    return this.execute(wrap(script), 8000).then(function (r) {
        var order = parse(check(r));
        order.file = null; // Fallback read does not identify the selected cache.
        return order;
    });
};

// entries must be a permutation of the current ones (reorder only, no add/remove).
Order.prototype.write = function (entries) {
    return this.commit(function (cur) {
        validate(entries);
        if (!sameSet(cur.entries, entries)) throw Error('Entries must be unchanged, only reordered');
        return entries;
    });
};

// Store apps appear in the row by store id (digits); webapps.txt maps each store id to the package and app ids
// that belong to it. Returns {storeId: [ids]}.
function parseWebapps(text) {
    var map = {}, cur = null;
    String(text || '').replace(/\r/g, '').split('\n').forEach(function (l) {
        l = l.trim();
        if (/^\d{8,}$/.test(l)) { cur = l; map[cur] = []; }
        else if (cur && l && TERMS.indexOf(l) < 0 && /^[A-Za-z0-9_.-]+$/.test(l)) map[cur].push(l);
    });
    return map;
}

// Installed package ids: names of the app folders and the package manager's lists.
function parseInstalled(text) {
    var set = {};
    String(text || '').replace(/\r/g, '').split('\n').forEach(function (l) {
        var m = /pkgid \[([^\]]+)\]/.exec(l);
        if (m) set[m[1]] = true;
        else if (/^[A-Za-z0-9_.-]+$/.test(l.trim())) set[l.trim()] = true;
    });
    return set;
}

// Row entries whose app is no longer installed. Only web app entries are judged, and only when every id they
// stand for is known and missing: a store id that webapps.txt does not resolve is kept.
function staleEntries(entries, webapps, installed) {
    var has = function (id) { return !!installed[id] || !!installed[id.split('.')[0]]; };
    return entries.filter(function (e) {
        var m = /^d\/webapp@([A-Za-z0-9_.-]+)$/.exec(e);
        if (!m) return false;
        var ids = /^\d{8,}$/.test(m[1]) ? webapps[m[1]] : [m[1]];
        return !!ids && ids.length > 0 && !ids.some(has);
    });
}

// Samsung Home drops an uninstalled app from its row only if it is running when the package manager says so;
// the dock closes the Home after every Home press, so it usually is not, and the tile stays. prune() removes
// those entries. The Home is closed first (when running) so it cannot write its old list back; it reads the
// file again at its next start.
Order.prototype.prune = function () {
    var removed = [];
    return this.commit(function (cur, facts) {
        removed = staleEntries(cur.entries, facts.webapps, facts.installed);
        return removed.length ? cur.entries.filter(function (e) { return removed.indexOf(e) < 0; }) : null;
    }, this.facts.bind(this), CLOSE_HOME)
        .then(function (o) { o.removed = removed; return o; });
};

// The store mapping and the installed packages, for prune() and add().
Order.prototype.facts = function () {
    var script = PICK_DIR + 'echo "--cache"; cat "$D/' + FILES[0] + '" 2>/dev/null || cat "$D/' + FILES[1] + '" 2>/dev/null\n' +
        'echo "--webapps"; cat "$D/webapps.txt.2" 2>/dev/null || cat "$D/webapps.txt.1" 2>/dev/null\n' +
        'echo "--installed"; ls /opt/usr/apps /opt/usr/globalapps /usr/apps /usr/globalapps 2>/dev/null; pkgcmd -l 2>/dev/null; pkgcmd -l --global 2>/dev/null; true';
    return this.execute(wrap(script), 20000).then(function (r) {
        var out = check(r), w = out.indexOf('--webapps\n'), i = out.indexOf('--installed\n');
        if (w < 0 || i < 0) throw Error('Home apps unavailable');
        var installed = parseInstalled(out.slice(i));
        // Never judge from a list that failed to load: the package manager knows hundreds of packages.
        if (Object.keys(installed).length < 20) throw Error('Installed package list unavailable; nothing changed');
        return { webapps: parseWebapps(out.slice(w, i)), installed: installed };
    });
};

// Samsung Home's "Add to Home": puts an installed web app on the row as d/webapp@<package id>, at index (default:
// the end). Nothing changes when the app is already there, under its package id or its store id. The Home is
// closed first, as for prune().
Order.prototype.add = function (packageId, index) {
    if (typeof packageId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(packageId)) return Promise.reject(Error('Invalid package id'));
    var entry = 'd/webapp@' + packageId, added = null;
    return this.commit(function (cur, facts) {
        var stores = Object.keys(facts.webapps).filter(function (s) {
            return facts.webapps[s].some(function (id) { return id === packageId || id.split('.')[0] === packageId; });
        });
        if (cur.entries.indexOf(entry) >= 0 || stores.some(function (s) { return cur.entries.indexOf('d/webapp@' + s) >= 0; })) return null;
        if (!facts.installed[packageId]) throw Error(packageId + ' is not installed');
        var at = typeof index === 'number' && index >= 0 && index <= cur.entries.length ? Math.floor(index) : cur.entries.length;
        var next = cur.entries.slice();
        next.splice(at, 0, entry);
        added = entry;
        return next;
    }, this.facts.bind(this), CLOSE_HOME).then(function (o) { o.added = added; return o; });
};

// Read the row, let change() compute the new entry list (null: nothing to do), write both caches as one
// transaction and confirm by reading back. facts() gathers extra input first; before runs ahead of the write.
Order.prototype.commit = function (change, facts, before) {
    var self = this;
    if (this.busy) return Promise.reject(Error('Home order change already in progress'));
    this.busy = true;
    return Promise.resolve(facts ? facts() : null).then(function (f) { return self.read().then(function (cur) { return [cur, f]; }); }).then(function (cf) {
        var cur = cf[0], entries = change(cur, cf[1]);
        if (!entries) { cur.saved = false; return cur; }
        validate(entries);
        var payload = Buffer.from(render({ version: cur.version, entries: entries, term: cur.term })).toString('base64');
        var script = (before || '') + transactionScript(payload, false);
        self.transactionStarted = true;
        return self.execute(wrap(script), 10000).then(function (r) {
            check(r);
            return self.read();
        }).then(function (o) { if (JSON.stringify(o.entries)!==JSON.stringify(entries)) throw Error('Written order not confirmed by readback'); o.saved = true; return o; });
    }).catch(function (e) {
        if (!self.transactionStarted) throw e;
        return self.execute(wrap(rollbackScript()), 10000).then(function (r) { check(r); throw Error(e.message + ' · previous caches restored'); }, function (restoreError) { throw Error(e.message + ' · restore failed: ' + restoreError.message); });
    }).finally(function () { self.busy = false; self.transactionStarted = false; });
};

function rollbackScript() {
    return 'set -e\n' + PICK_DIR + 'for f in ' + FILES.join(' ') + '; do if [ -f "$D/$f.vetro-txn" ]; then cp -p "$D/$f.vetro-txn" "$D/$f.vetro-tmp"; mv -f "$D/$f.vetro-tmp" "$D/$f"; elif [ -f "$D/$f.vetro-missing" ]; then rm -f "$D/$f"; fi; done';
}
function transactionScript(payload, restoring) {
    var prepare = 'set -e\n' + PICK_DIR + 'for f in ' + FILES.join(' ') + '; do rm -f "$D/$f.vetro-txn" "$D/$f.vetro-missing"; if [ -f "$D/$f" ]; then cp -p "$D/$f" "$D/$f.vetro-txn"; [ -f "$D/$f.vetro-bak" ] || cp -p "$D/$f" "$D/$f.vetro-bak"; else touch "$D/$f.vetro-missing"; fi; done\n';
    if (restoring) prepare += 'for f in ' + FILES.join(' ') + '; do [ -f "$D/$f.vetro-bak" ] || { echo "Backup Home incompleto" >&2; exit 1; }; done\n';
    var fill = restoring ? 'cp -p "$D/$f.vetro-bak" "$D/$f.vetro-tmp"' : 'if [ -f "$D/$f" ]; then cp -p "$D/$f" "$D/$f.vetro-tmp"; else touch "$D/$f.vetro-tmp"; fi; echo ' + payload + ' | base64 -d > "$D/$f.vetro-tmp"';
    return prepare + 'committed=0\ntrap \'if [ "$committed" != 1 ]; then for f in ' + FILES.join(' ') + '; do if [ -f "$D/$f.vetro-txn" ]; then cp -p "$D/$f.vetro-txn" "$D/$f"; elif [ -f "$D/$f.vetro-missing" ]; then rm -f "$D/$f"; fi; done; fi\' EXIT\nfor f in ' + FILES.join(' ') + '; do ' + fill + '; done\nfor f in ' + FILES.join(' ') + '; do mv -f "$D/$f.vetro-tmp" "$D/$f"; done\ncommitted=1\necho OK';
}
Order.prototype.restore = function () {
    var self = this;
    if (this.busy) return Promise.reject(Error('Home order change already in progress'));
    this.busy = true;
    return this.execute(wrap(transactionScript(null, true)), 10000).then(function (r) { check(r); return self.read(); }).finally(function () { self.busy = false; });
};

module.exports = { PICK_DIR: PICK_DIR, BASE_NEW_HOME: BASE_NEW_HOME, staleEntries: staleEntries, parseWebapps: parseWebapps, parseInstalled: parseInstalled, transactionScript: transactionScript, rollbackScript: rollbackScript, Order: Order, parse: parse, render: render, validate: validate, BASE: BASE, FILES: FILES, TERM: TERM };
