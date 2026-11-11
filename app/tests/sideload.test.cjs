'use strict';
// Install apps (sideload.js): strict checks on everything that reaches a shell, ordered chunked uploads, the
// installed list, and the registry row and Home tile after an install (taken away again after an uninstall).
const assert = require('assert').strict, fs = require('fs');
const { Sideload, parseApps } = require('../service/sideload.js');

const PKG = [
    'user apps \tpkg_type [wgt]\tpkgid [TenStrmr10]\tname [TenStreamer]\tversion [0.2.1]\tstorage [internal]',
    'system apps\tpkg_type [tpk]\tpkgid [org.tizen.menu]\tname [Menu]\tversion [1.0]',
    'user apps \tpkg_type [wgt]\tpkgid [madebypatk]\tname [Tessel]\tversion [1.4.0]',
    '===LAUNCHER===',
    "\t'TenStreamer'\t 'TenStrmr10.TenStreamer'",
    "\t'smbproxy'\t 'TenStrmr10.smbproxy'",
    "\t'Tessel'\t 'madebypatk.vlcweb'"
].join('\n');

const apps = parseApps(PKG);
assert.deepEqual(apps.map(a => [a.packageId, a.appId, a.system]), [
    ['TenStrmr10', 'TenStrmr10.TenStreamer', false],
    ['madebypatk', 'madebypatk.vlcweb', false],
    ['org.tizen.menu', null, true]
]);

function make(results) {
    const calls = [], log = [];
    const s = new Sideload({
        execute: (cmd) => { calls.push(cmd); return Promise.resolve(results.shift() || { exit_code: 0, stdout: '' }); },
        registry: { register: id => { log.push('register ' + id); return Promise.resolve({ registered: true }); },
                    unregister: id => { log.push('unregister ' + id); return Promise.resolve({ removed: 1 }); } },
        homeOrder: { add: id => { log.push('home add ' + id); return Promise.resolve({ added: 'd/webapp@' + id }); },
                     prune: () => { log.push('home prune'); return Promise.resolve({ removed: ['d/webapp@X'] }); } },
        dock: { refresh: () => { log.push('dock refresh'); return Promise.resolve(); } }
    });
    return { s, calls, log };
}

(async function () {
    // Nothing unchecked reaches a command.
    const { s, calls } = make([]);
    for (const bad of ['x; reboot', '$(id)', 'a b', '', '../etc']) {
        await assert.rejects(s.launch({ appId: bad }), /invalid appId/);
        await assert.rejects(s.uninstall({ packageId: bad }), /invalid packageId/);
        await assert.rejects(s.clearData({ packageId: bad }), /invalid packageId/);
    }
    await assert.rejects(s.uninstall({ packageId: 'org.tizen.menu' }), /System packages/);
    await assert.rejects(s.install({ path: '/etc/passwd' }), /Upload the package first/);
    await assert.rejects(s.install({ path: '/tmp/sideload/../x.wgt' }), /Upload the package first/);
    assert.throws(() => s.upload({ filename: 'evil;rm.wgt', chunk: 0, totalChunks: 1, data: '' }), /Choose a .wgt/);
    assert.throws(() => s.upload({ filename: 'app.zip', chunk: 0, totalChunks: 1, data: '' }), /Choose a .wgt/);
    assert.equal(calls.length, 0, 'no command ran');

    // Chunks arrive in order or the upload starts again.
    let up;
    try { up = s.upload({ filename: 'tst.wgt', chunk: 0, totalChunks: 2, data: Buffer.from('ab').toString('base64') }); }
    catch (e) { if (e.code === 'EACCES' || e.code === 'ENOENT') { console.log('SKIP upload (no /tmp/sideload here)'); up = null; } else throw e; }
    if (up) {
        assert.throws(() => s.upload({ filename: 'tst.wgt', chunk: 0 + 5, totalChunks: 2, data: '' }), /Bad chunk|out of order/);
        const done = s.upload({ filename: 'tst.wgt', chunk: 1, totalChunks: 2, data: Buffer.from('cd').toString('base64') });
        assert.equal(done.done, true);
        assert.equal(fs.readFileSync(done.path, 'utf8'), 'abcd');

        // Install as it is: pkgcmd, then the registry row and the Home tile.
        const t = make([{ exit_code: 0, stdout: '__return_cb req_id[1] pkg_type[wgt] pkgid[TstApp1] key[end] val[ok]' }]);
        const r = await t.s.install({ path: done.path, sign: false });
        assert.equal(r.ok, true);
        assert.equal(r.packageId, 'TstApp1');
        assert.match(t.calls[0], /^pkgcmd -i -t wgt -p \/tmp\/sideload\/tst\.wgt/);
        assert.deepEqual(t.log, ['register TstApp1', 'home add TstApp1', 'dock refresh']);
        assert.equal(fs.existsSync(done.path), false, 'the upload is removed after the install');
    }

    // Uninstall takes the registry row and the Home tile away.
    const u = make([{ exit_code: 0, stdout: 'key[end] val[ok]' }]);
    const r2 = await u.s.uninstall({ packageId: 'TstApp1' });
    assert.equal(r2.ok, true);
    assert.equal(u.calls[0], 'pkgcmd -u -n TstApp1 2>&1');
    assert.deepEqual(u.log, ['unregister TstApp1', 'home prune', 'dock refresh']);
    console.log('PASS sideload: checked inputs, ordered uploads, installed list, registry and Home row after install/uninstall');
})().catch(e => { console.error(e); process.exit(1); });
