# TvCapture: the helper of the TV Screen Shard

Source of the program the Shard ships as `tv-screen/capture.dll.b64`.

It takes the picture the TV is showing (video and on-screen graphics, after the scaler) through Samsung's own
`libvideo-capture`, and either writes one PNG (`Program.cs`) or serves MJPEG on `127.0.0.1` only, encoded with the
TV's `libturbojpeg` (`Live.cs`, `--serve`). In live mode it captures only while someone watches and exits 30 s after
the last viewer.

Protected video (HDCP inputs, DRM streams) is refused by Samsung's library; the helper does not try to get around it.

## Build

```
sh shards/tv-screen-helper/build.sh
```

Builds for `netcoreapp3.1` (the runtime the TVs ship) and rewrites `capture.dll.b64` and
`capture.runtimeconfig.json` in the Shard. The build is deterministic for one SDK version; another SDK gives a
different file for the same source. The file in this repository was built with .NET SDK 8.0.427 on Windows.

## Why base64

Vetro 0.5.0 bundles hold text only. Upstream's branch `plugin-native-assets` adds a `native` permission with
declared binary assets; once that is released the Shard should ship the DLL that way instead.

The capture structure layout was read from the libraries of a QN85A (Tizen 6).
