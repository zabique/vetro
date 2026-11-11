'use strict';
const assert=require('assert').strict;
const control=require('../service/control.js');

// The old one-press command is unchanged (the remapper uses it).
assert.equal(control.injectCommand('Return'),'/usr/bin/input_keyevent Return');
assert.equal(control.injectCommand('Return; reboot'),null);
assert.equal(control.nativeKey('KEY_ENTER'),'Return');

// Every name is safe on a command line as it stands.
control.KEYS.forEach(k=>assert.ok(/^[A-Za-z0-9_]+$/.test(k),k));
assert.equal(new Set(control.KEYS).size,control.KEYS.length,'no key listed twice');

// Events: whitelisted keys and states only.
assert.deepEqual(control.checkEvents([{key:'a'},{key:'Shift_L',state:'down'},{key:'Up',state:'up'}]),
    [{key:'a',state:'press'},{key:'Shift_L',state:'down'},{key:'Up',state:'up'}]);
assert.equal(control.checkEvents([]),null);
assert.equal(control.checkEvents('a'),null);
assert.equal(control.checkEvents([{key:'A'}]),null,'shifted keysyms are not keys');
assert.equal(control.checkEvents([{key:'a; reboot'}]),null);
assert.equal(control.checkEvents([{key:'a',state:'hold'}]),null);
assert.equal(control.checkEvents([{key:'a',state:'constructor'}]),null);
assert.equal(control.checkEvents([{key:'constructor'}]),null);
assert.equal(control.checkEvents([null]),null);
assert.equal(control.checkEvents(new Array(control.MAX_EVENTS+1).fill({key:'a'})),null);

// The command: down is 1, up is 0, a press is both, in order, and a failure does not stop the rest.
const cmd=control.eventsCommand([{key:'Shift_L',state:'down'},{key:'a',state:'press'},{key:'Shift_L',state:'up'}]);
assert.deepEqual(cmd.split('; ').map(c=>/uint32:(\d) string:(\S+)/.exec(c).slice(1).join(' ')),
    ['1 Shift_L','1 a','0 a','0 Shift_L']);
assert.ok(!/&&/.test(cmd));

// Held keys: a key left down is released after the limit; a release in time cancels that.
{
    const released=[],pending=[];
    const timers={set(fn,ms){const t={fn,ms,live:true};pending.push(t);return t;},clear(t){t.live=false;}};
    const held=new control.Held(e=>released.push(e),5000,timers);
    held.note([{key:'Up',state:'down'},{key:'a',state:'press'},{key:'Down',state:'down'},{key:'Down',state:'up'}]);
    assert.deepEqual(held.keys(),['Up']);
    assert.equal(pending[0].ms,5000);
    pending.filter(t=>t.live).forEach(t=>t.fn());
    assert.deepEqual(released,[[{key:'Up',state:'up'}]]);
    assert.deepEqual(held.keys(),[]);
    held.note([{key:'Left',state:'down'},{key:'Right',state:'down'}]);
    assert.deepEqual(held.releaseAll(),['Left','Right']);
    assert.deepEqual(released[1],[{key:'Left',state:'up'},{key:'Right',state:'up'}]);
    assert.deepEqual(held.releaseAll(),[]);
    assert.equal(released.length,2);
}
console.log('control: ok');
