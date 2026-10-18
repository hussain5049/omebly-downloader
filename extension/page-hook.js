// Runs inside the page before its own code, only to notice two things the page itself does:
// - a video locked with copy protection (DRM): the page attaches "media keys" to it, so that video is marked
//   Protected and is never offered for download;
// - a video played from pieces (Media Source): its address is "blob:", so the real stream is found elsewhere.
// It changes nothing about how the page works and sends nothing anywhere.
(() => {
  const P = window.HTMLMediaElement && HTMLMediaElement.prototype;
  if (P && P.setMediaKeys) {
    const setMediaKeys = P.setMediaKeys;
    P.setMediaKeys = function (keys) {
      try { if (keys) this.setAttribute('data-omebly-drm', '1'); } catch (e) { /* not ours to break */ }
      return setMediaKeys.call(this, keys);
    };
  }
  const MS = window.MediaSource;
  if (MS && MS.prototype.addSourceBuffer) {
    const add = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function (type) {
      try { document.documentElement.setAttribute('data-omebly-mse', '1'); } catch (e) { /* ignore */ }
      return add.call(this, type);
    };
  }
})();
