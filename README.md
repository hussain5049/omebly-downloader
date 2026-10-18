# Omebly Downloader

See every video, audio file, image and file on a web page, tick what you want, and download it, at full speed.
Free and open source (GPL-3.0-or-later). Made by Omebly.

> You are responsible for what you download. Download only what you own, what is free to save, or what you have
> permission to save. Videos locked with copy protection (DRM) are shown as "Protected" and never downloaded.

## Status

Step 1 of 7: the browser extension finds everything on a page. Direct links (videos, audio, images, files)
download through the browser for now; streams and sites like YouTube need the Windows app, which comes in the
next steps.

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
