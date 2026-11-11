'use strict';
// Sideloaded web apps get a row in Samsung's registry (widgetinfo), so the Home keeps their tile and the dock lists them.
const assert = require('assert').strict;
const { Registry, parseInspect, registerScript, unregisterScript, sqlText } = require('../service/webapp-registry.js');
const hex = s => Buffer.from(s, 'utf8').toString('hex').toUpperCase();

// What the TV answers for ReoLnkVwr1: its UI app and its relay service, one locale, not registered yet.
const INSPECT = ['W|0', 'T|SM64Tizen0',
    'A|' + hex('ReoLnkVwr1.ReolinkViewer') + '|uiapp|false|' + hex('No Locale') + '|' + hex('Reolink "Viewer" $(id)') + '|' + hex('/opt/usr/apps/ReoLnkVwr1/shared/res/ReoLnkVwr1.ReolinkViewer.png'),
    'A|' + hex('ReoLnkVwr1.relay') + '|svcapp|true|' + hex('No Locale') + '|' + hex('relay') + '|' + hex('/opt/usr/apps/ReoLnkVwr1/shared/res/ReoLnkVwr1.relay.png'),
    'V|' + hex('1.0.0') + '|wgt', 'S|180'].join('\n');

const f = parseInspect(INSPECT);
assert.equal(f.registered, false);
assert.equal(f.template, 'SM64Tizen0');
assert.deepEqual([f.version, f.type, f.sizeKb], ['1.0.0', 'wgt', 180]);
assert.equal(f.app.appId, 'ReoLnkVwr1.ReolinkViewer', 'the visible UI app, not the relay service');
assert.equal(f.app.label, 'Reolink "Viewer" $(id)');

// The generated script: names travel as hex, so quotes and $(...) in a title never reach the shell or SQL.
const script = registerScript('ReoLnkVwr1', f);
assert.ok(!script.includes('$(id)') && !script.includes('Reolink "'), 'the title is hex-encoded');
assert.ok(script.includes(sqlText('Reolink "Viewer" $(id)')));
assert.ok(script.indexOf('vetro-webappservice.db.bak') < script.indexOf('sqlite3 /opt/dbspace'), 'backup before the write');
assert.ok(script.includes('/opt/share/webappservice/apps_icon/all/ReoLnkVwr1/icon.png'), 'icon in the registry folder');
assert.ok(script.includes('chown -R 5001:users /opt/share/webappservice/apps_icon/all/ReoLnkVwr1'));
// The Home cannot read files with the agent's own SMACK label ("User") and drops the tile: the icon gets "_".
assert.ok(script.includes('chsmack -a _ /opt/share/webappservice/apps_icon/all/ReoLnkVwr1;') &&
    script.includes('chsmack -a _ /opt/share/webappservice/apps_icon/all/ReoLnkVwr1/icon.png'), 'icon folder and file labelled for the Home');
assert.ok(script.indexOf('chsmack') > script.indexOf('cp "') && script.indexOf('chsmack') < script.indexOf('systemctl restart'), 'labelled after the copy');
assert.ok(/command -v chsmack/.test(script), 'a TV without chsmack still registers');
assert.ok(script.indexOf('systemctl restart org.tizen.webappservice.service') > script.indexOf('INSERT INTO widgetinfo'), 'webappservice reads it again');
assert.throws(() => registerScript('X1', Object.assign({}, f, { template: 'a" ; rm -rf /' })), /Unsafe/, 'nothing unsafe reaches the sh line');

// The SQL itself, on a small widgetinfo table: the new row copies the template and carries this app's values.
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (e) { /* older Node: the SQL check is skipped */ }
if (sqlite) {
    const db = new sqlite.DatabaseSync(':memory:');
    db.exec("CREATE TABLE widgetinfo (id TEXT PRIMARY KEY, app_index INT, title TEXT, install_path TEXT, icon_path TEXT, version TEXT, size INT, install_date TEXT, tizen_id TEXT, pkgname TEXT, use_count INT, launch_date TEXT, resources_path TEXT, use_gamepad INT, is_hidden INT, is_display INT, icon_updated_date TEXT, install_type TEXT, pkg_type TEXT, duid TEXT);" +
        "INSERT INTO widgetinfo VALUES ('SM64Tizen0',300,'Super Mario 64','/a/','/i/','1.1.0',1,'x','SM64Tizen0.SM64','SM64Tizen0',218,'y','/a/',1,0,1,'z','user','wgt','EXCNLQ722GA3E');");
    const sql = /sqlite3 \/opt\/dbspace\/\.webappservice\.db "([^"]+)"/.exec(script)[1];
    db.exec(sql);
    const row = db.prepare("SELECT * FROM widgetinfo WHERE id='ReoLnkVwr1'").get();
    assert.equal(row.title, 'Reolink "Viewer" $(id)');
    assert.equal(row.tizen_id, 'ReoLnkVwr1.ReolinkViewer');
    assert.equal(row.icon_path, '/opt/share/webappservice/apps_icon/all/ReoLnkVwr1/');
    assert.equal(row.install_path, '/opt/usr/home/owner/apps_rw/ReoLnkVwr1/');
    assert.deepEqual([row.app_index, row.size, row.use_count, row.use_gamepad, row.is_hidden, row.is_display], [301, 180 * 1024, 0, 0, 0, 1]);
    assert.deepEqual([row.install_type, row.pkg_type, row.duid], ['user', 'wgt', 'EXCNLQ722GA3E'], 'the rest is the template\'s');
    db.exec(sql);
    assert.equal(db.prepare("SELECT count(*) AS n FROM widgetinfo WHERE id='ReoLnkVwr1'").get().n, 1, 'running it twice keeps one row');
}

(async function () {
    const tv = (inspect, after) => {
        const s = { scripts: [] };
        s.execute = async cmd => {
            const sh = Buffer.from(cmd.split(' ')[1], 'base64').toString();
            s.scripts.push(sh);
            if (sh.includes('INSERT INTO widgetinfo')) return { exit_code: 0, stdout: after };
            return { exit_code: 0, stdout: inspect };
        };
        return s;
    };
    let t = tv(INSPECT, 'W|1\n');
    let r = await new Registry(t.execute).register('ReoLnkVwr1');
    assert.deepEqual([r.registered, r.added, r.appId], [true, true, 'ReoLnkVwr1.ReolinkViewer']);

    t = tv(INSPECT.replace('W|0', 'W|1'), '');
    r = await new Registry(t.execute).register('ReoLnkVwr1');
    assert.deepEqual([r.registered, r.added], [true, false], 'already registered: nothing written');
    assert.ok(!t.scripts.some(s => s.includes('INSERT')));
    assert.ok(t.scripts.some(s => s.includes('chsmack -a _ /opt/share/webappservice/apps_icon/all/ReoLnkVwr1')), 'but its icon label is repaired');

    t = tv(INSPECT, 'W|0\n');
    await assert.rejects(new Registry(t.execute).register('ReoLnkVwr1'), /did not keep/, 'the row must still be there after the restart');
    await assert.rejects(new Registry(tv('W|0\nT|SM64Tizen0\n', '').execute).register('Gone00001'), /not installed/);
    r = await new Registry(tv(INSPECT.replace('|wgt', '|tpk'), '').execute).register('ReoLnkVwr1');
    assert.equal(r.registered, false, 'native apps are left alone');
    await assert.rejects(new Registry(tv(INSPECT.replace('T|SM64Tizen0', 'T|'), '').execute).register('ReoLnkVwr1'), /model/);
    await assert.rejects(new Registry(t.execute).register("x'; DROP TABLE widgetinfo;--"), /Invalid package id/);
    // unregister(): after an uninstall the row and icon folder Vetro made go, but only once the package is gone.
    const un = unregisterScript('VtroTest01');
    assert.ok(un.indexOf('echo "U|installed"') < un.indexOf('DELETE FROM widgetinfo'), 'an installed package is never touched');
    assert.ok(un.includes("DELETE FROM widgetinfo WHERE id='VtroTest01';") && un.includes('rm -rf /opt/share/webappservice/apps_icon/all/VtroTest01\n'));
    assert.ok(un.indexOf('vetro-webappservice.db.bak') < un.indexOf('DELETE'), 'backup before the delete');
    assert.ok(un.indexOf('systemctl restart org.tizen.webappservice.service') > un.indexOf('DELETE'), 'webappservice reads it again');
    const answer = out => async () => ({ exit_code: 0, stdout: out });
    assert.deepEqual(await new Registry(answer('U|1\n')).unregister('VtroTest01'), { removed: 1 });
    assert.deepEqual(await new Registry(answer('U|0\n')).unregister('VtroTest01'), { removed: 0 });
    assert.equal((await new Registry(answer('U|installed\n')).unregister('ReoLnkVwr1')).removed, 0, 'still installed: kept');
    await assert.rejects(new Registry(answer('')).unregister('VtroTest01'), /did not answer/);
    await assert.rejects(new Registry(answer('U|1')).unregister('x; rm -rf /'), /Invalid package id/);
    console.log('PASS webapp registry: sideloaded web apps get a widgetinfo row (hex-safe names, icon, backup, webappservice re-read)');
})().catch(e => { console.error(e); process.exit(1); });
