# Omebly Downloader

See every video, audio file, image and file on a web page, tick what you want, and download it, at full speed.
Free and open source (GPL-3.0-or-later). Made by Omebly.

> You are responsible for what you download. Download only what you own, what is free to save, or what you have
> permission to save. Videos locked with copy protection (DRM) are shown as "Protected" and never downloaded.

## Install

Download the installer from https://omebly.com/tools/downloader/ and run it. Then add the extension once:

1. In the app, open Settings and click **Show folder** (the extension that came with the app).
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked**, choose that folder, and pin the green Omebly Downloader button.

**Updates:** the app checks for a new version when it opens and shows **Update now**. Updates are signed with
Omebly's update key, and the same update refreshes the extension (it reloads itself from the app's folder).
[PRIVACY.md](PRIVACY.md) says what the app sends (only the update check).

## Releasing (maintainers)

Raise the version in `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml` and `extension/manifest.json`,
then run `bash tools/release.sh "what is new"`. It needs the update key in `~/.omebly-keys/`, which is never committed.

## Try the extension (Chrome, Edge or Brave)

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension` folder.
4. Pin the green Omebly Downloader button to the toolbar, open any page and click it.

## Tests

```
npm install
npm test          # the extension on the local test pages (test-site/)
REAL=1 npm test   # also opens a few real websites and saves what the panel shows in tests/out/
```

Make the test media once with `bash tools/make-test-media.sh` (needs FFmpeg). `npm run test-site` serves the test pages on http://127.0.0.1:4430/ to try by hand.

## How it works

- `extension/scan.js` reads each frame of the page: players, links to media and files, pictures (largest size),
  YouTube's video and playlist, and known video sites by their page address.
- `extension/page-hook.js` notices copy-protected videos (media keys) and videos played from pieces.
- `extension/background.js` watches the tab's network for streams (HLS, DASH) and checks links' size and type.
- `extension/popup.*` is the panel, as in the approved design.
