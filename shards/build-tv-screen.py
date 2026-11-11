"""Builds the generated files of the TV Screen Shard (shards/tv-screen): page.html from the remote that the
dashboard patches draw (so the two stay the same remote), and capture.dll.b64 + capture.runtimeconfig.json from
app/native/capture. Then `node app/scripts/vetro-plugin.cjs pack shards/tv-screen`."""
import base64, io, os, re, textwrap

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'shards', 'tv-screen')
dash = io.open(os.path.join(ROOT, 'app', 'service', 'dashboard.js'), encoding='utf-8').read()

# ── the remote: markup and every .rc rule, as the dashboard has them ──
m = re.search(r'<div class="rc rc-full" id="screenKeys".*?<div class="rc-brand" aria-hidden="true">SAMSUNG</div></div>', dash)
assert m, 'remote not found in app/service/dashboard.js'
remote = m.group(0)
icon = '<img src="/icon.png" alt="" width="18" height="18">Vetro'
assert remote.count(icon) == 1
remote = remote.replace(icon, 'Launcher')          # the page is sandboxed: Vetro's own files are out of reach

# In the Shard the right half (number pad, colours, playback, extras) folds away, so what must stay reachable
# sits under the left half: Launcher, Keyboard and the switch that folds the keys.
a = remote.index('<div class="rc-apps">')
b = remote.index('</div>', remote.index('id="screenKbd"')) + len('</div>')
apps = remote[a:b]
assert apps.count('<button') == 2 and 'screenLauncher' in apps, apps[:200]
remote = remote[:a] + remote[b:]
COL = '<div class="rc-col">'
assert remote.count(COL) == 2
second = remote.rindex(COL)
assert remote[second - 6:second] == '</div>'
MORE = ('<button id="rcMore" class="rc-txt rc-more" aria-expanded="true" aria-controls="rcKeys" '
        'title="Show or hide the number pad and the extra keys">‹ HIDE KEYS</button>')
remote = (remote[:second - 6] + apps + MORE + '</div>'
          + '<div class="rc-col rc-keys" id="rcKeys">' + remote[second + len(COL):])

flat = re.sub(r'@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}', '', dash)       # rules inside @media are added by hand below
rules = [r.group(0) for r in re.finditer(r'[^{}]+\{[^{}]*\}', flat) if re.search(r'\.rc(?:[-\s.,:>\[]|$)', r.group(0).split('{')[0])]
rules = [r[r.rfind('>') + 1:] if r.startswith('<') else r for r in rules]
assert len(rules) > 40, len(rules)
rc_css = ''.join(rules) + '@media (max-width:560px){.rc.rc-full{grid-template-columns:200px}}'
for bad in ('<', 'url('):
    assert bad not in rc_css, bad

CSS = """
:root{--vetro-action:#3b6cf6;--s3:12px;--edge:rgba(128,128,128,.4);--zoom:1.5}
*{box-sizing:border-box}
body{font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;margin:16px;color:CanvasText;background:Canvas}
.layout{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}
.view{flex:0 0 auto;max-width:100%;min-width:0;width:fit-content}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 8px;width:0;min-width:100%}
.bar h2{font-size:17px;margin:0 auto 0 0}
.ui{font:inherit;height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--edge);background:transparent;color:inherit;cursor:pointer}
.ui:hover{background:rgba(128,128,128,.15)}.ui:disabled{opacity:.5;cursor:default}
.ui:focus-visible{outline:2px solid var(--vetro-action);outline-offset:2px}
.ui.primary{background:var(--vetro-action);border-color:var(--vetro-action);color:#fff}
.zoom{display:flex;border:1px solid var(--edge);border-radius:8px;overflow:hidden}
.zoom .ui{border:0;border-radius:0;padding:0 11px}.zoom .ui[aria-pressed=true]{background:var(--vetro-action);color:#fff}
.frame{position:relative;width:calc(640px*var(--zoom));max-width:100%;border:1px solid var(--edge);border-radius:8px;overflow:hidden;background:#000}
.frame canvas{display:block;width:100%;height:auto}
.frame img{position:absolute;top:0;left:0;width:100%;height:100%;display:block;background:#000;object-fit:fill}
.frame img[hidden]{display:none}
.status{font-size:13px;opacity:.75;margin:0 0 8px;min-height:1.45em;width:0;min-width:100%}
.remote{flex:0 0 auto;display:grid;justify-items:center;max-width:100%}
/* Fit: the picture takes the room the remote leaves (a Shard page cannot widen the dashboard) */
@media (min-width:900px){.layout.fit{flex-wrap:nowrap}.layout.fit .view{flex:1 1 0;width:auto}}
.layout.fit .frame{width:100%}
.rc-note{opacity:.75}
"""

# after the remote's own rules, so these win
CSS_AFTER = """
.rc .rc-app{padding:0 10px}
.rc .rc-more{width:100%;height:26px}
.rc.rc-full.rc-collapsed{grid-template-columns:200px}
.rc-collapsed .rc-keys{display:none}
"""

JS = """
function $(id){return document.getElementById(id)}
function api(url,body){var o=body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
  return fetch(url,o).then(function(r){return r.json().catch(function(){return {}}).then(function(d){if(!r.ok)throw new Error(d.error||('The TV answered '+r.status));return d})})}
function say(t){$('status').textContent=t}

/* picture and live view */
var busy=false,liveOn=false,liveTimer=0;
function shape(w,h){return 'captured at '+w+'×'+h+(Math.abs(w/h-16/9)>0.05?', shown at 16:9':'')}
function liveStatus(){api('live').then(function(d){if(!liveOn)return;if(d.running===false){say('Starting the live view…');return}
  say(d.protect===1?'Live · protected video (DRM/HDCP): the TV refuses to capture it':'Live · '+d.fps+' fps · '+shape(d.width,d.height))}).catch(function(){})}
function liveStart(){var i=$('stream');liveOn=true;i.hidden=false;i.src='stream?t='+Date.now();$('live').textContent='Stop live';
  say('Starting the live view…');liveTimer=setInterval(liveStatus,2000)}
function liveStop(text){if(!liveOn)return;liveOn=false;clearInterval(liveTimer);var i=$('stream');i.removeAttribute('src');i.hidden=true;
  $('live').textContent='Watch live';say(text||'Live view stopped.')}
/* a picture is saved the way the browser saves a download; the images are asked for with CORS so the canvas can be read back */
function stamp(){var d=new Date();function p(n){return (n<10?'0':'')+n}return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds())}
function savePng(c){try{c.toBlob(function(b){if(!b){say('Could not save the picture.');return}var a=document.createElement('a'),u=URL.createObjectURL(b);
    a.href=u;a.download='tv-screen-'+stamp()+'.png';document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u)},10000)},'image/png')}
  catch(e){say('Could not save the picture: '+e.message)}}
function saveLiveFrame(){var c=document.createElement('canvas');c.width=1920;c.height=1080;
  try{c.getContext('2d').drawImage($('stream'),0,0,1920,1080)}catch(e){say('No live frame yet.');return}savePng(c)}
function takeShot(save){if(busy)return;busy=true;$('shot').disabled=true;say('Capturing the screen…');
  api('shot').then(function(d){return Promise.all(d.windows.map(function(w){return new Promise(function(done){var img=new Image();img.crossOrigin='anonymous';
      img.onload=function(){done({w:w,img:img})};img.onerror=function(){done(null)};img.src='file?id='+encodeURIComponent(w.id)+'&at='+d.at})})).then(function(list){
    var c=$('canvas'),g=c.getContext('2d'),n=0;g.fillStyle='#000';g.fillRect(0,0,c.width,c.height);
    if(d.video&&d.source!=='scaler'){g.fillStyle='#3a4560';g.font='600 46px system-ui,sans-serif';g.textAlign='center';g.textBaseline='middle';
      g.fillText(d.protected?'Protected video (DRM/HDCP) is playing here, not captured':'Video is playing here (hardware layer, not captured)',960,540)}
    list.forEach(function(x){if(!x)return;g.drawImage(x.img,x.w.x,x.w.y,x.w.w,x.w.h);n++});
    say('Captured '+new Date(d.at).toLocaleTimeString()+' · '+(d.source==='scaler'?'full picture'+(d.size?' · '+shape(d.size.w,d.size.h):''):
      n+' window'+(n===1?'':'s')+(d.video?(d.protected?' · protected video is not captured':' · video is not captured'):''))+(save?' · saved':''));
    if(save)savePng(c)})})
  .catch(function(e){say(e.message)}).then(function(){busy=false;$('shot').disabled=false})}
$('shot').onclick=function(){if(liveOn)saveLiveFrame();else takeShot(true)};
$('live').onclick=function(){if(liveOn)liveStop();else liveStart()};
$('stream').onerror=function(){if(liveOn)liveStop('The live view could not start.')};
document.addEventListener('visibilitychange',function(){if(document.hidden)liveStop()});

/* picture size */
function zoom(z,quiet){if(z!=='fit'&&z!=='1'&&z!=='1.5'&&z!=='2')return;$('layout').classList.toggle('fit',z==='fit');if(z!=='fit')document.documentElement.style.setProperty('--zoom',z);
  Array.prototype.forEach.call($('zoom').querySelectorAll('[data-zoom]'),function(b){b.setAttribute('aria-pressed',b.dataset.zoom===z?'true':'false')});
  if(!quiet)api('prefs',{zoom:z}).catch(function(){})}
$('zoom').onclick=function(e){var b=e.target.closest('[data-zoom]');if(b)zoom(b.dataset.zoom)};
/* the right half of the remote folds away */
function rcMore(open,quiet){$('screenKeys').classList.toggle('rc-collapsed',!open);var b=$('rcMore');b.setAttribute('aria-expanded',open?'true':'false');
  b.textContent=open?'‹ HIDE KEYS':'MORE KEYS ›';if(!quiet)api('prefs',{keys:open}).catch(function(){})}
$('rcMore').onclick=function(){rcMore(this.getAttribute('aria-expanded')!=='true')};
/* the page is sandboxed and has no storage of its own: the Shard keeps the two choices */
api('prefs').then(function(p){zoom(p.zoom,true);if(p.keys===false)rcMore(false,true)}).catch(function(){});

/* remote: a button is down while it is held; events go out in order, batched while a request is in flight */
var rcQueue=[],rcBusy=false,rcDown={},kbdOn=false,kbdHeld={};
var NOTE='Hold a button for a long press.',KBD_NOTE='Keyboard goes to the TV. Open the text field on the TV first. Esc is Back, F1 to F4 are the colour keys. Click Keyboard again to stop.';
var KBD_MAP={Space:'space',Enter:'Return',NumpadEnter:'KP_Enter',Backspace:'BackSpace',Tab:'Tab',Escape:'XF86Back',Delete:'Delete',Insert:'Insert',Home:'Home',End:'End',
  PageUp:'Prior',PageDown:'Next',ArrowUp:'Up',ArrowDown:'Down',ArrowLeft:'Left',ArrowRight:'Right',ShiftLeft:'Shift_L',ShiftRight:'Shift_R',ControlLeft:'Control_L',
  ControlRight:'Control_R',AltLeft:'Alt_L',AltRight:'Alt_R',CapsLock:'Caps_Lock',Minus:'minus',Equal:'equal',BracketLeft:'bracketleft',BracketRight:'bracketright',
  Backslash:'backslash',Semicolon:'semicolon',Quote:'apostrophe',Backquote:'grave',Comma:'comma',Period:'period',Slash:'slash',NumpadAdd:'KP_Add',
  NumpadSubtract:'KP_Subtract',NumpadMultiply:'KP_Multiply',NumpadDivide:'KP_Divide',NumpadDecimal:'period',F1:'XF86Red',F2:'XF86Green',F3:'XF86Yellow',
  F4:'XF86Blue',F5:'XF86Home',F8:'XF86AudioMute',F9:'XF86AudioLowerVolume',F10:'XF86AudioRaiseVolume'};
function rcFlush(){if(rcBusy||!rcQueue.length)return;rcBusy=true;
  api('control',{events:rcQueue.splice(0,40)}).then(function(d){if(d&&d.ok===false&&d.error)say(d.error)}).catch(function(x){say(x.message)})
  .then(function(){rcBusy=false;rcFlush()})}
function rcSend(key,state){rcQueue.push({key:key,state:state});rcFlush()}
function rcPress(e){var b=e.target.closest('[data-key]');if(!b||e.button)return;var k=b.dataset.key;try{b.setPointerCapture(e.pointerId)}catch(x){}
  b.classList.add('rc-held');if(!rcDown[k]){rcDown[k]=b;rcSend(k,'down')}}
function rcLift(e){var b=e.target.closest('[data-key]');if(!b)return;var k=b.dataset.key;b.classList.remove('rc-held');if(rcDown[k]){delete rcDown[k];rcSend(k,'up')}}
function rcLiftAll(){Object.keys(rcDown).forEach(function(k){rcDown[k].classList.remove('rc-held');delete rcDown[k];rcSend(k,'up')});
  Object.keys(kbdHeld).forEach(function(c){var k=kbdHeld[c];delete kbdHeld[c];rcSend(k,'up')})}
var rc=$('screenKeys');rc.onpointerdown=rcPress;rc.onpointerup=rcLift;rc.onpointercancel=rcLift;rc.onlostpointercapture=rcLift;
/* a button worked from the keyboard (Enter, Space) has no pointer: one press */
rc.onclick=function(e){if(e.detail!==0)return;var b=e.target.closest('[data-key]');if(b)rcSend(b.dataset.key,'press')};
rc.oncontextmenu=function(e){if(e.target.closest('[data-key]'))e.preventDefault()};
$('screenLauncher').onclick=function(){var b=this;b.disabled=true;api('launcher',{}).then(function(d){say(d.ok===false?d.error:'Vetro launcher opened on the TV.')})
  .catch(function(x){say(x.message)}).then(function(){b.disabled=false})};

/* this computer's keyboard: physical keys (e.code) as the TV's key names; the TV's own layout makes the characters */
function kbdName(e){var c=e.code||'';if(c.length===4&&c.indexOf('Key')===0)return c.charAt(3).toLowerCase();
  if(c.length===6&&c.indexOf('Digit')===0)return c.charAt(5);
  if(c.length===7&&c.indexOf('Numpad')===0&&c.charAt(6)>='0'&&c.charAt(6)<='9')return c.charAt(6);
  if(c==='Minus'&&!e.shiftKey)return 'KP_Subtract';   /* TV text fields ignore the plain minus key: it is the remote's dash */
  return KBD_MAP.hasOwnProperty(c)?KBD_MAP[c]:null}
function kbdSet(on){kbdOn=on;$('screenKbd').setAttribute('aria-pressed',on?'true':'false');$('screenKbdNote').textContent=on?KBD_NOTE:NOTE;
  if(!on){rcLiftAll();api('control',{release:true}).catch(function(){})}}
function kbdDown(e){if(!kbdOn)return;var k=kbdName(e);if(!k)return;e.preventDefault();e.stopPropagation();if(e.repeat||kbdHeld[e.code])return;
  /* Windows sends AltGr as Control + Alt: drop the Control it made up */
  if(e.code==='AltRight'&&e.key==='AltGraph'&&kbdHeld.ControlLeft){delete kbdHeld.ControlLeft;rcSend('Control_L','up')}
  kbdHeld[e.code]=k;rcSend(k,'down')}
function kbdUp(e){if(!kbdOn)return;var k=kbdHeld[e.code];if(!k)return;e.preventDefault();e.stopPropagation();delete kbdHeld[e.code];rcSend(k,'up')}
document.addEventListener('keydown',kbdDown,true);document.addEventListener('keyup',kbdUp,true);
/* this page is a frame: once the focus leaves it no key arrives here, so the keyboard is handed back */
window.addEventListener('blur',function(){if(kbdOn)kbdSet(false);else rcLiftAll()});
window.addEventListener('pagehide',function(){try{navigator.sendBeacon('control',JSON.stringify({release:true}))}catch(e){}});
$('screenKbd').onclick=function(){kbdSet(!kbdOn);this.blur()};

takeShot(false);
"""

PAGE = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    '<meta name="color-scheme" content="dark light"><title>TV Screen</title><style>' + CSS.strip() + rc_css + CSS_AFTER.strip() + '</style></head><body>'
    '<div class="layout fit" id="layout"><div class="view">'
    '<div class="bar"><h2>TV screen</h2>'
    '<div class="zoom" id="zoom" role="group" aria-label="Picture size">'
    '<button class="ui" data-zoom="fit" aria-pressed="true">Fit</button>'
    '<button class="ui" data-zoom="1" aria-pressed="false">1×</button>'
    '<button class="ui" data-zoom="1.5" aria-pressed="false">1.5×</button>'
    '<button class="ui" data-zoom="2" aria-pressed="false">2×</button></div>'
    '<button class="ui primary" id="live">Watch live</button><button class="ui" id="shot">Take a picture</button></div>'
    '<p class="status" id="status" aria-live="polite"></p>'
    '<div class="frame"><canvas id="canvas" width="1920" height="1080" role="img" aria-label="TV screen picture"></canvas>'
    '<img id="stream" alt="Live TV screen" crossorigin="anonymous" hidden></div></div>'
    '<div class="remote">' + remote +
    '<p class="rc-note" id="screenKbdNote" aria-live="polite">Hold a button for a long press.</p></div></div>'
    '<script>' + JS.strip() + '</script></body></html>\n'
)
io.open(os.path.join(OUT, 'page.html'), 'w', encoding='utf-8', newline='\n').write(PAGE)

# ── the helper: a bundle holds text only ──
SRC = os.path.join(ROOT, 'app', 'native', 'capture')
dll = open(os.path.join(SRC, 'TvCapture.dll'), 'rb').read()
io.open(os.path.join(OUT, 'capture.dll.b64'), 'w', encoding='ascii', newline='\n').write(
    '\n'.join(textwrap.wrap(base64.b64encode(dll).decode('ascii'), 120)) + '\n')
io.open(os.path.join(OUT, 'capture.runtimeconfig.json'), 'w', encoding='utf-8', newline='\n').write(
    io.open(os.path.join(SRC, 'TvCapture.runtimeconfig.json'), encoding='utf-8').read())
print('tv-screen: page.html %d bytes (%d remote rules), helper %d bytes' % (len(PAGE.encode('utf-8')), len(rules), len(dll)))
