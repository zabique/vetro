'use strict';

// Remote control for Vetro: key injection through the compositor's test interface
// (org.enlightenment.wm Test.EventKey, the call /usr/bin/input_keyevent wraps). A key is a NAME from the TV's
// keymap: XF86* names from the keyrouter layout (/usr/share/X11/xkb/tizen_key_layout.txt.tv) plus the base
// keysym of every keyboard key (a, 1, space, Shift_L ...). KEY_* input-code names and shifted keysyms (A, at)
// are refused by the TV: a capital is Shift_L down, a, Shift_L up, exactly as on a keyboard.
//
// Down and up are separate events, so a held button is a real long press and a PC keyboard can be passed
// through key by key.

var REMOTE_KEYS = [
    // volume & mute
    'XF86AudioRaiseVolume', 'XF86AudioLowerVolume', 'XF86AudioMute',
    // power
    'XF86PowerOff',
    // navigation (standard X keysyms)
    'Up', 'Down', 'Left', 'Right', 'Return',
    // TV keys (keyrouter names)
    'XF86Back', 'XF86Home', 'XF86Menu', 'XF86Info', 'XF86Exit',
    // channels / guide
    'XF86ChannelList', 'XF86ChannelGuide', 'XF86DiscretSourceTV', 'XF86RaiseChannel', 'XF86LowerChannel',
    // digits (standard X keysyms)
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    // playback
    'XF86AudioPlay', 'XF86AudioPause', 'XF86AudioStop',
    'XF86AudioNext', 'XF86AudioPrev', 'XF86AudioRewind', 'XF86AudioForward',
    'XF86AudioRecord', 'XF86AudioPlayPause',
    // the rest of a full remote
    'XF86Red', 'XF86Green', 'XF86Yellow', 'XF86Blue',
    'XF86Display', 'XF86SysMenu', 'XF86SimpleMenu', 'XF86NumberPad', 'XF86More', 'XF86PreviousChannel',
    'XF86FavoriteChannel', 'XF86TTXMIX', 'XF86Caption', 'XF86Subtitle', 'XF86AudioDescription', 'XF86PictureSize',
    'XF86PictureMode', 'XF86SoundMode', 'XF86EManual', 'XF86Search', 'XF86Apps', 'XF86MultiView', 'XF86Ambient',
    'XF86Sleep', 'XF86MTS', 'XF86Hdmi', 'XF86QuickMenu', 'XF86Netflix', 'XF86Amazon', 'XF86KeyTVPlus',
    'XF86KeyYouTube', 'XF86WWW'
];

// A PC keyboard, as base keysyms of the TV keymap (checked on the QN85A: Escape and the F keys do not exist
// there, the remote's keys sit on those codes).
var KEYBOARD_KEYS = 'abcdefghijklmnopqrstuvwxyz'.split('').concat([
    'minus', 'equal', 'bracketleft', 'bracketright', 'backslash', 'semicolon', 'apostrophe', 'grave', 'comma',
    'period', 'slash', 'space', 'BackSpace', 'Tab', 'Delete', 'Insert', 'Home', 'End', 'Prior', 'Next',
    'Shift_L', 'Shift_R', 'Control_L', 'Control_R', 'Alt_L', 'Alt_R', 'Caps_Lock',
    'KP_Enter', 'KP_Add', 'KP_Subtract', 'KP_Multiply', 'KP_Divide'
]);

var KEYS = REMOTE_KEYS.concat(KEYBOARD_KEYS);

var KEY_SET = Object.create(null);
KEYS.forEach(function (k) { KEY_SET[k] = true; });

function injectCommand(key) {
    if (!KEY_SET[key]) return null;
    return '/usr/bin/input_keyevent ' + key;
}

var DBUS = '/usr/bin/dbus-send --system --type=method_call --print-reply --dest=org.enlightenment.wm ' +
    '/org/enlightenment/wm org.enlightenment.wm.Test.EventKey';
var MAX_EVENTS = 64;
var STATES = {down: [1], up: [0], press: [1, 0]};

// [{key, state}] with state down | up | press (default) -> a clean list, or null when anything is not on the
// whitelist. Nothing from the request reaches the command line except whitelisted names.
function checkEvents(events) {
    if (!Array.isArray(events) || !events.length || events.length > MAX_EVENTS) return null;
    var out = [];
    for (var i = 0; i < events.length; i++) {
        var e = events[i] || {}, state = e.state === undefined ? 'press' : e.state;
        if (typeof e.key !== 'string' || !KEY_SET[e.key] || !STATES.hasOwnProperty(state)) return null;
        out.push({key: e.key, state: state});
    }
    return out;
}

// One shell line for a checked list. Each call waits for its reply, so the order is kept; `;` and not `&&`,
// so a refused key never leaves the ones after it (the releases) unsent.
function eventsCommand(events) {
    var calls = [];
    events.forEach(function (e) {
        STATES[e.state].forEach(function (type) {
            calls.push(DBUS + ' uint32:' + type + ' string:' + e.key + ' >/dev/null 2>&1');
        });
    });
    return calls.join('; ');
}

// Keys that went down and have not come up. A browser that closes, sleeps or loses the network mid-press
// never sends the release, and the TV would repeat the key for ever: every key still down after `ms` is
// released here. A late release from the page is harmless.
function Held(release, ms, timers) {
    this.release = release;
    this.ms = ms || 20000;
    this.down = Object.create(null);
    this.set = (timers && timers.set) || setTimeout;
    this.clear = (timers && timers.clear) || clearTimeout;
}
Held.prototype.note = function (events) {
    var self = this;
    events.forEach(function (e) {
        if (self.down[e.key]) { self.clear(self.down[e.key]); delete self.down[e.key]; }
        if (e.state !== 'down') return;
        self.down[e.key] = self.set(function () {
            delete self.down[e.key];
            self.release([{key: e.key, state: 'up'}]);
        }, self.ms);
        if (self.down[e.key] && self.down[e.key].unref) self.down[e.key].unref();
    });
};
Held.prototype.keys = function () { return Object.keys(this.down); };
// Releases everything now (the page asks for this when it loses focus).
Held.prototype.releaseAll = function () {
    var self = this, keys = this.keys();
    keys.forEach(function (k) { self.clear(self.down[k]); delete self.down[k]; });
    if (keys.length) this.release(keys.map(function (k) { return {key: k, state: 'up'}; }));
    return keys;
};

var LAN_KEYS = {KEY_TV:'XF86DiscretSourceTV',KEY_HOME:'XF86Home',KEY_RETURN:'XF86Back',KEY_EXIT:'XF86Exit',KEY_UP:'Up',KEY_DOWN:'Down',KEY_LEFT:'Left',KEY_RIGHT:'Right',KEY_ENTER:'Return',KEY_VOLUP:'XF86AudioRaiseVolume',KEY_VOLUMEUP:'XF86AudioRaiseVolume',KEY_VOLDOWN:'XF86AudioLowerVolume',KEY_VOLUMEDOWN:'XF86AudioLowerVolume',KEY_MUTE:'XF86AudioMute',KEY_PLAY:'XF86AudioPlay',KEY_PAUSE:'XF86AudioPause',KEY_STOP:'XF86AudioStop'};
function nativeKey(key) {return KEY_SET[key] ? key : LAN_KEYS[key] || null;}
module.exports = { nativeKey:nativeKey, KEYS: KEYS, REMOTE_KEYS: REMOTE_KEYS, KEYBOARD_KEYS: KEYBOARD_KEYS, injectCommand: injectCommand,
    checkEvents: checkEvents, eventsCommand: eventsCommand, Held: Held, MAX_EVENTS: MAX_EVENTS };
