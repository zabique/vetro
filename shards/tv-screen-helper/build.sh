#!/bin/sh
# Builds TvCapture for the TVs' .NET Core 3.1 runtime and writes it into the TV Screen Shard as text
# (capture.dll.b64 + capture.runtimeconfig.json): a Shard bundle holds text only.
# Needs a .NET SDK (any recent one; the project targets netcoreapp3.1).
set -e
here=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) o=$(cygpath -w "$out") ;; *) o=$out ;; esac
dotnet build "$here/TvCapture.csproj" -c Release -o "$o" -p:UseAppHost=false -p:Deterministic=true \
    -p:ContinuousIntegrationBuild=true -p:DebugType=none -p:IncludeSourceRevisionInInformationalVersion=false \
    -p:BaseIntermediateOutputPath="$o/obj/" >/dev/null
dest="$here/../tv-screen"
base64 "$out/TvCapture.dll" | tr -d '\r\n' | fold -w 120 > "$dest/capture.dll.b64"
echo >> "$dest/capture.dll.b64"
tr -d '\r' < "$out/TvCapture.runtimeconfig.json" > "$dest/capture.runtimeconfig.json"
echo "TvCapture.dll: $(wc -c < "$out/TvCapture.dll") bytes, sha256 $(sha256sum "$out/TvCapture.dll" | cut -d' ' -f1)"
