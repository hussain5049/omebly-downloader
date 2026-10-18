#!/usr/bin/env bash
# Publishes a new Omebly Downloader version: builds the installer, signs the update with the key kept on this PC
# (never on the server or GitHub), and puts the installer and the update list on the server.
#   bash tools/release.sh "What is new, in one line"
# The version is the one in app/src-tauri/tauri.conf.json (raise it first). Run only after Security and a yes.
set -euo pipefail
cd "$(dirname "$0")/.."
NOTES="${1:?say what is new}"
KEY="$HOME/.omebly-keys/downloader-updater.key"
SSH_KEY="$HOME/.ssh/omebly_vps"
HOST="root@omebly-server.tailf76a70.ts.net"
BASE="https://api.omebly.com/downloads/downloader"
V=$(node -p "require('./app/src-tauri/tauri.conf.json').version")
[ "$(node -p "require('./extension/manifest.json').version")" = "$V" ] || { echo "extension version is not $V"; exit 1; }

PIN=$(grep -v "^#" tools/yt-dlp.pin | sed -n 2p | tr -d "\r")
[ "$(sha256sum app/src-tauri/tools/yt-dlp.exe | cut -d" " -f1)" = "$PIN" ] || { echo "yt-dlp.exe is not the pinned one (tools/yt-dlp.pin)"; exit 1; }
FF=$(grep -v "^#" tools/ffmpeg.pin | sed -n 4p | tr -d "\r")
[ "$(sha256sum app/src-tauri/tools/ffmpeg.exe | cut -d" " -f1)" = "$FF" ] || { echo "ffmpeg.exe is not the pinned one (tools/ffmpeg.pin)"; exit 1; }

export PATH="$HOME/.cargo/bin:$PATH" TAURI_SIGNING_PRIVATE_KEY="$KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
(cd app && npx tauri build)
OUT="app/src-tauri/target/release/bundle/nsis/Omebly Downloader_${V}_x64-setup.exe"
FILE="Omebly-Downloader-Setup-$V.exe"
cp "$OUT" "$FILE"
# The extension on its own, for people who only want it (the app carries the same one and keeps it updated).
EXT="Omebly-Downloader-Extension-$V.zip"
rm -f "$EXT"; (cd extension && /c/Windows/System32/tar.exe -a -c -f "../$EXT" *)

node -e '
const [v, notes, sigFile, url] = process.argv.slice(1);
const fs = require("fs");
fs.writeFileSync("latest.json", JSON.stringify({ version: v, notes, pub_date: new Date().toISOString(),
  platforms: { "windows-x86_64": { signature: fs.readFileSync(sigFile, "utf8").trim(), url } } }, null, 2));
' "$V" "$NOTES" "$OUT.sig" "$BASE/$FILE"

ssh -i "$SSH_KEY" "$HOST" 'mkdir -p /opt/omebly/downloads/downloader'
ssh -i "$SSH_KEY" "$HOST" "cat > /opt/omebly/downloads/downloader/$FILE" < "$FILE"
ssh -i "$SSH_KEY" "$HOST" "cat > /opt/omebly/downloads/downloader/$EXT" < "$EXT"
ssh -i "$SSH_KEY" "$HOST" "cd /opt/omebly/downloads/downloader && ln -sfn $EXT OmeblyDownloaderExtension.zip"
# The website button always gets the newest: OmeblyDownloaderSetup.exe points at it.
ssh -i "$SSH_KEY" "$HOST" "cd /opt/omebly/downloads/downloader && ln -sfn $FILE OmeblyDownloaderSetup.exe"
# The update list goes up last, so the app never sees a version whose file is not there yet.
ssh -i "$SSH_KEY" "$HOST" "cat > /opt/omebly/downloads/downloader/latest.json" < latest.json
ssh -i "$SSH_KEY" "$HOST" 'cd /opt/omebly/downloads/downloader && ls -1t Omebly-Downloader-Setup-*.exe | tail -n +4 | xargs -r rm -f; ls -1t Omebly-Downloader-Extension-*.zip | tail -n +4 | xargs -r rm -f'
rm -f latest.json
curl -s "$BASE/latest.json"; echo
curl -sI "$BASE/OmeblyDownloaderSetup.exe" | grep -i -E "^(HTTP|content-length|content-disposition)"
