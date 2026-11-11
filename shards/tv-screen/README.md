# TV Screen

A Vetro Shard: see what the TV shows and drive it from the dashboard (**Vetro Shards → TV-Screen**).

- **Live view** of the whole screen (video and menus), fitted beside the remote. It starts when the page opens
  and always asks for the best the TV gives (30 fps, quality 95, source resolution). Stop live shows a still
  picture instead.
- **Take a picture** saves a 1920x1080 PNG through the browser's downloads (in live view: the current frame).
- **Full remote**: number pad, colour keys, playback, Settings, Guide, app keys. Holding a button is a real long
  press. The right half folds away.
- **Keyboard**: sends this computer's keyboard to the TV, key by key. Open the text field on the TV first.
  Esc is Back, F1 to F4 are the colour keys.
- **Launcher**: opens the Vetro launcher on the TV.

It talks to nothing outside the TV.

## The `exec` permission: commands it runs

All as root, through `ctx.execute`. Nothing runs while the Shard is only switched on, except the first line;
opening its page starts the live view.

| When | Command |
| --- | --- |
| switched on after an install or update, and switched off | `systemctl stop tv-screen-shard-live.service` |
| Take a picture while the live view is stopped | `/usr/bin/dotnet <Shard folder>/bin/TvCapture.dll <file>.png 1920 1080` into `/opt/usr/home/owner/share/tv-screen-shard/tv-<time>/`; folders older than 10 minutes are removed first. If the TV refuses (protected video): `enlightenment_info -topvwins` and `enlightenment_info -dump topvwins <folder>` |
| the page opens, Watch live | `netstat -ltn` (is the helper running?), then `systemd-run --unit=tv-screen-shard-live … /usr/bin/dotnet <Shard folder>/bin/TvCapture.dll --serve 8096 --fps 30 --size 1920x1080 --idle-exit 30` (`setsid nohup …` without systemd-run). The helper listens on `127.0.0.1:8096` only and exits 30 s after the last viewer |
| a remote button or a key | `dbus-send --system … org.enlightenment.wm.Test.EventKey uint32:<1 or 0> string:<key>`: down and up are separate events. The key must be on the fixed list in `index.js`; nothing else from a request reaches a command line. A key left down is released after 20 s |
| Launcher | `echo show > /home/owner/tvlauncher.fifo` (only if that pipe exists) |

## The helper

`capture.dll.b64` is a .NET program, as base64 because a 0.5.0 bundle holds text only; it is unpacked to `bin/` at
start. Its source and build script are in `tv-screen-helper/` in the same repository
(`sh shards/tv-screen-helper/build.sh` rewrites the two `capture.*` files; the build is deterministic). It calls
Samsung's `libvideo-capture` and the TV's `libturbojpeg`. When Vetro releases declared binary assets (the `native`
permission on upstream's `plugin-native-assets` branch), the DLL should ship that way instead.

## Limits

- **Tested on one TV only: a QN85A (Tizen 6, Node 12-class runtime with the root helper).** Not run on any other
  model. It cannot work on TVs without the root helper.
- Protected video (DRM streams, HDCP inputs) is refused by the TV; the visible windows are shown instead. This
  Shard does not try to get around that.
- The TV's capture gives at most the source resolution (720x576 on an SD channel); the page stretches it to 16:9.
- **Saving a picture needs a Vetro whose Shard frame allows downloads** (`sandbox allow-scripts allow-downloads`
  in the dashboard frame and in the plugin host's header). Vetro 0.5.0 does not: there the picture is taken and
  shown but the browser does not save it.
- Text fields ignore the plain minus key (the page sends keypad minus); underscore may not type everywhere.
  Characters come from the TV's own keyboard layout. Keys typed while the TV's on-screen keyboard is still
  opening are lost.
- "Source" sends `XF86Display`, which opened the Home bar on the test TV. Several extra keys (subtitles, picture
  size, Multi View, Ambient, Sleep, TTX, the app keys) use names from the TV's key table and were not each tried.
