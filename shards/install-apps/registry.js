// Copy of app/service/webapp-registry.js from zabique/vetro (branch extras-050), unchanged below this line: a Shard
// cannot reach Vetro's own modules, so it carries what it needs.
'use strict';

// Samsung's web app registry: /opt/dbspace/.webappservice.db, table widgetinfo, kept by org.tizen.webappservice.
// Samsung Home and the APPS panel only show web apps that have a row there, and the Home drops a row entry
// whose app has none. Store installs get a row; on some TVs (QN85A, Tizen 6) a sideloaded .wgt installed with
// pkgcmd never does, not even after a restart of webappservice. register() adds the row the way the store's
// rows look: a copy of another user-installed web app's row with this app's id, name, paths and app id, plus
// the icon in the registry's icon folder, then restarts webappservice so it reads the table again.

var DB = '/opt/dbspace/.webappservice.db';
var PKG_DB = '/opt/dbspace/.pkgmgr_parser.db';
var ICONS = '/opt/share/webappservice/apps_icon/all/';
var BACKUP = '/opt/usr/home/owner/share/vetro-webappservice.db.bak';
var ID = /^[A-Za-z0-9_.-]{1,64}$/;
var PATH = /^\/[A-Za-z0-9_.\/-]{1,200}$/;

function wrap(s) { return 'echo ' + Buffer.from(s).toString('base64') + ' | base64 -d | sh'; }
function check(r) { if (r.exit_code || r.timed_out) throw Error(r.stderr || r.stdout || 'App registry unavailable'); return r.stdout || ''; }
function unhex(v) { return /^(?:[0-9a-fA-F]{2})*$/.test(v || '') ? Buffer.from(v || '', 'hex').toString('utf8') : ''; }
// Text goes into SQL as a hex blob: no quoting, whatever the app's name holds.
function sqlText(s) { return "CAST(X'" + Buffer.from(String(s), 'utf8').toString('hex') + "' AS TEXT)"; }

function inspectScript(pkg) {
    return [
        'echo "W|$(sqlite3 -readonly ' + DB + ' "SELECT count(*) FROM widgetinfo WHERE id=\'' + pkg + '\';" 2>/dev/null)"',
        'echo "T|$(sqlite3 -readonly ' + DB + ' "SELECT id FROM widgetinfo WHERE install_type=\'user\' AND pkg_type=\'wgt\' AND id!=\'' + pkg + '\' ORDER BY app_index LIMIT 1;" 2>/dev/null)"',
        'sqlite3 -readonly ' + PKG_DB + ' "SELECT \'A|\'||hex(a.app_id)||\'|\'||a.app_component||\'|\'||a.app_nodisplay||\'|\'||hex(ifnull(l.app_locale,\'\'))||\'|\'||hex(ifnull(l.app_label,\'\'))||\'|\'||hex(ifnull(l.app_icon,\'\')) FROM package_app_info a LEFT JOIN package_app_localized_info l ON l.app_id=a.app_id WHERE a.package=\'' + pkg + '\';" 2>/dev/null',
        'sqlite3 -readonly ' + PKG_DB + ' "SELECT \'V|\'||hex(package_version)||\'|\'||package_type FROM package_info WHERE package=\'' + pkg + '\';" 2>/dev/null',
        'echo "S|$(du -sk /opt/usr/apps/' + pkg + ' 2>/dev/null | cut -f1)"',
        'true'
    ].join('\n');
}

// What the TV knows about a package: {registered, template, version, type, sizeKb, app: {appId, label, icon}}.
function parseInspect(text) {
    var o = { registered: false, template: null, version: null, type: null, sizeKb: 0, app: null };
    var apps = {};
    String(text || '').replace(/\r/g, '').split('\n').forEach(function (l) {
        var f = l.split('|');
        if (f[0] === 'W') o.registered = Number(f[1]) > 0;
        else if (f[0] === 'T') o.template = ID.test(f[1] || '') ? f[1] : null;
        else if (f[0] === 'V') { o.version = unhex(f[1]); o.type = f[2] || null; }
        else if (f[0] === 'S') o.sizeKb = Number(f[1]) || 0;
        else if (f[0] === 'A' && f.length >= 7) {
            var id = unhex(f[1]);
            if (!ID.test(id) || f[2] !== 'uiapp' || f[3] === 'true') return;   // the visible UI app, not its service
            var cur = apps[id] || (apps[id] = { appId: id, label: '', icon: '' });
            var locale = unhex(f[4]);
            if (!cur.label || locale === 'No Locale') cur.label = unhex(f[5]) || cur.label;
            if (!cur.icon || locale === 'No Locale') cur.icon = unhex(f[6]) || cur.icon;
        }
    });
    var ids = Object.keys(apps);
    if (ids.length) o.app = apps[ids[0]];
    return o;
}

// Files this agent creates carry its SMACK label ("User"), which the Home (User::Pkg::com.samsung.tv.csfs) may not
// read: it then logs the icon as missing and leaves the tile out. The registry's own icons are labelled "_".
function labelScript(pkg) {
    var dir = ICONS + pkg;
    return 'if command -v chsmack >/dev/null 2>&1 && [ -d ' + dir + ' ]; then chsmack -a _ ' + dir +
        '; [ -f ' + dir + '/icon.png ] && chsmack -a _ ' + dir + '/icon.png; fi; true';
}

function registerScript(pkg, facts) {
    var app = facts.app, icon = PATH.test(app.icon || '') ? app.icon : '', dir = ICONS + pkg;
    var home = '/opt/usr/home/owner/apps_rw/' + pkg + '/';
    var set = [
        'id=' + sqlText(pkg), 'title=' + sqlText(app.label || pkg), 'install_path=' + sqlText(home), 'resources_path=' + sqlText(home),
        'icon_path=' + sqlText(dir + '/'), 'version=' + sqlText(facts.version || '1.0.0'), 'size=' + (facts.sizeKb * 1024),
        "install_date=datetime('now','localtime')", 'tizen_id=' + sqlText(app.appId), 'pkgname=' + sqlText(pkg),
        'use_count=0', "launch_date=''", 'use_gamepad=0', 'is_hidden=0', 'is_display=1',
        'app_index=(SELECT ifnull(max(app_index),0)+1 FROM widgetinfo)', "icon_updated_date=strftime('%Y-%m-%dT%H:%M:%S+00:00','now')"
    ].join(', ');
    var sql = 'BEGIN; DROP TABLE IF EXISTS temp.t; CREATE TEMP TABLE t AS SELECT * FROM widgetinfo WHERE id=\'' + facts.template + '\'; UPDATE t SET ' + set +
        "; DELETE FROM widgetinfo WHERE id='" + pkg + "'; INSERT INTO widgetinfo SELECT * FROM t; COMMIT;";
    // The statement sits in double quotes on an sh line: names arrive as hex, so none of these can be in it.
    if (/["$`\\]/.test(sql)) throw Error('Unsafe registry statement');
    return [
        'set -e',
        '[ -f ' + BACKUP + ' ] || cp -p ' + DB + ' ' + BACKUP,
        'mkdir -p ' + dir,
        icon ? '[ -f "' + icon + '" ] && cp "' + icon + '" ' + dir + '/icon.png || true' : 'true',
        'chown -R 5001:users ' + dir + '; chmod 755 ' + dir + '; [ -f ' + dir + '/icon.png ] && chmod 644 ' + dir + '/icon.png || true',
        labelScript(pkg),
        'sqlite3 ' + DB + ' "' + sql + '"',
        'chown 5001:users ' + DB + ' ' + DB + '-journal 2>/dev/null || true',
        'systemctl restart org.tizen.webappservice.service',
        'sleep 5',
        'echo "W|$(sqlite3 -readonly ' + DB + ' "SELECT count(*) FROM widgetinfo WHERE id=\'' + pkg + '\';")"'
    ].join('\n');
}

// After an uninstall. webappservice never knew the sideloaded app, so it leaves the row register() made (a ghost
// tile in Samsung's Apps panel) and the icon folder. Only once the package is really gone; echoes U|<rows removed>.
function unregisterScript(pkg) {
    var dir = ICONS + pkg;
    return [
        'if [ -d /opt/usr/apps/' + pkg + ' ] || [ -n "$(sqlite3 -readonly ' + PKG_DB + ' "SELECT 1 FROM package_info WHERE package=\'' + pkg + '\';" 2>/dev/null)" ]; then echo "U|installed"; exit 0; fi',
        'n=$(sqlite3 -readonly ' + DB + ' "SELECT count(*) FROM widgetinfo WHERE id=\'' + pkg + '\';" 2>/dev/null)',
        'if [ "${n:-0}" -gt 0 ]; then',
        '  [ -f ' + BACKUP + ' ] || cp -p ' + DB + ' ' + BACKUP,
        '  sqlite3 ' + DB + ' "DELETE FROM widgetinfo WHERE id=\'' + pkg + '\';" || exit 1',
        '  chown 5001:users ' + DB + ' ' + DB + '-journal 2>/dev/null',
        '  rm -rf ' + dir,
        '  systemctl restart org.tizen.webappservice.service',
        'fi',
        'echo "U|${n:-0}"'
    ].join('\n');
}

function Registry(execute) { this.execute = execute; }

// Resolves {removed: rows deleted} or {removed: 0, reason} when the package is still installed.
Registry.prototype.unregister = function (pkg) {
    if (typeof pkg !== 'string' || !ID.test(pkg)) return Promise.reject(Error('Invalid package id'));
    return this.execute(wrap(unregisterScript(pkg)), 30000).then(function (r) {
        var m = /U\|(\w+)/.exec(check(r));
        if (!m) throw Error('App registry did not answer');
        if (m[1] === 'installed') return { removed: 0, reason: pkg + ' is still installed' };
        return { removed: Number(m[1]) || 0 };
    });
};

Registry.prototype.inspect = function (pkg) {
    if (typeof pkg !== 'string' || !ID.test(pkg)) return Promise.reject(Error('Invalid package id'));
    return this.execute(wrap(inspectScript(pkg)), 15000).then(function (r) { return parseInspect(check(r)); });
};

// Adds the package's web app to the registry unless it has a row. Resolves {registered, added, reason?}.
Registry.prototype.register = function (pkg) {
    var self = this;
    return this.inspect(pkg).then(function (f) {
        if (!f.type) throw Error(pkg + ' is not installed');
        if (f.type !== 'wgt') return { registered: false, added: false, reason: 'Only web apps (.wgt) use this registry' };
        // Registered already: still give its icon the label the Home can read (rows made before this fix).
        if (f.registered) return self.execute(wrap(labelScript(pkg)), 10000).then(function () { return { registered: true, added: false }; });
        if (!f.app) throw Error(pkg + ' has no visible app');
        if (!f.template) throw Error('No installed web app to model the registry row on');
        return self.execute(wrap(registerScript(pkg, f)), 40000).then(function (r) {
            var ok = /W\|[1-9]/.test(check(r));
            if (!ok) throw Error('Samsung\'s app registry did not keep the new row');
            return { registered: true, added: true, appId: f.app.appId, title: f.app.label };
        });
    });
};

module.exports = { Registry: Registry, parseInspect: parseInspect, inspectScript: inspectScript, registerScript: registerScript, labelScript: labelScript, unregisterScript: unregisterScript, sqlText: sqlText, DB: DB };
