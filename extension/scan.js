// What is on the page: run inside each frame of the tab when the panel opens (chrome.scripting).
// It must be self-contained (it is copied into the page), and only reads the page.
export function scanPage() {
  const VIDEO_EXT = /\.(mp4|m4v|webm|mkv|mov|avi|wmv|flv|3gp|ts|m3u8|mpd)(\?|#|$)/i;
  const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|wma)(\?|#|$)/i;
  const FILE_EXT = /\.(pdf|zip|rar|7z|tar|gz|docx?|xlsx?|pptx?|csv|txt|rtf|epub|apk|exe|msi|dmg|iso|psd|ai|svg)(\?|#|$)/i;
  const vw = innerWidth, vh = innerHeight;
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw; };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const extOf = (u) => { const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(new URL(u).pathname); return m ? m[1].toLowerCase() : ''; };
  const nameOf = (u) => { try { const p = decodeURIComponent(new URL(u).pathname.split('/').pop() || ''); return p.replace(/\.[a-z0-9]{2,5}$/i, ''); } catch { return ''; } };
  const pageTitle = clean(document.title);
  const items = [];
  const byKey = new Map(), els = new Map();
  // The same video can be both a player and a link in a list (the lesson playing): kept once, with the player's
  // state (playing, on screen, length) and the link's name and place in the list.
  const add = (it, el) => {
    if (!it.src) return;
    const k = it.kind + it.src, had = byKey.get(k);
    if (!had) { byKey.set(k, it); items.push(it); if (el) els.set(it, el); return; }
    had.playing = had.playing || it.playing; had.inView = had.inView || it.inView; had.protected = had.protected || it.protected;
    had.duration = Math.max(had.duration || 0, it.duration || 0); had.width = had.width || it.width; had.height = had.height || it.height; had.thumb = had.thumb || it.thumb;
    if (it.fromLink && !had.fromLink) { had.title = it.title; had.fromLink = true; if (el) els.set(had, el); }
  };
  const titleNear = (el) => clean(el.getAttribute('title') || el.getAttribute('aria-label') || el.closest('figure, article, section, li')?.querySelector('h1,h2,h3,h4,figcaption')?.textContent || '');

  // YouTube: videos are played from pieces, so the page address is what the app reads (with every quality and
  // audio language). The video playing, the playlist beside it and the videos showing on screen.
  if (/(^|\.)youtube\.com$/.test(location.hostname)) {
    const playing = document.querySelector('video');
    const v = new URLSearchParams(location.search).get('v');
    if (location.pathname === '/watch' && v) add({ kind: 'video', src: `https://www.youtube.com/watch?v=${v}`, title: pageTitle.replace(/ - YouTube$/, ''), inView: true, playing: !!playing && !playing.paused, duration: playing?.duration || 0, needsApp: true, site: 'YouTube', thumb: `https://i.ytimg.com/vi/${v}/mqdefault.jpg` });
    const shorts = /^\/shorts\/([\w-]{6,})/.exec(location.pathname);
    if (shorts) add({ kind: 'video', src: `https://www.youtube.com/shorts/${shorts[1]}`, title: pageTitle.replace(/ - YouTube$/, ''), inView: true, playing: true, needsApp: true, site: 'YouTube', thumb: `https://i.ytimg.com/vi/${shorts[1]}/mqdefault.jpg` });
    for (const a of document.querySelectorAll('a[href*="/watch?v="], a[href^="/shorts/"]')) {
      const u = abs(a.getAttribute('href')); if (!u) continue;
      const id = new URL(u).searchParams.get('v') || (/\/shorts\/([\w-]+)/.exec(u) || [])[1]; if (!id || id === v) continue;
      const box = a.closest('ytd-playlist-panel-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytm-shorts-lockup-view-model, yt-lockup-view-model') || a;
      const t = clean(box.querySelector('#video-title, [id="video-title"], h3, .yt-lockup-metadata-view-model__title')?.textContent || a.getAttribute('title') || a.getAttribute('aria-label'));
      if (!t || /^(play all|shuffle|mix)$/i.test(t)) continue;
      add({ kind: 'video', src: `https://www.youtube.com/watch?v=${id}`, title: t, inView: inView(box), playing: false, needsApp: true, site: 'YouTube', inList: !!a.closest('ytd-playlist-panel-renderer'), thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` });
    }
    return { url: location.href, title: pageTitle, items, top: window === top };
  }

  // Sites whose videos the app reads from the page address itself (even before Play is pressed).
  const SITE_PAGES = [[/(^|\.)vimeo\.com$/, /^\/(\d+|.+\/videos?\/\d+)/, 'Vimeo', 'video'], [/(^|\.)dailymotion\.com$/, /^\/video\//, 'Dailymotion', 'video'], [/(^|\.)(twitter|x)\.com$/, /\/status\/\d+/, 'X', 'video'], [/(^|\.)instagram\.com$/, /^\/(p|reel|reels|tv)\//, 'Instagram', 'video'], [/(^|\.)facebook\.com$/, /\/(videos|reel|watch)/, 'Facebook', 'video'], [/(^|\.)tiktok\.com$/, /\/video\/\d+/, 'TikTok', 'video'], [/(^|\.)twitch\.tv$/, /^\/(videos\/\d+|[^/]+\/clip\/)/, 'Twitch', 'video'], [/(^|\.)ted\.com$/, /^\/talks\//, 'TED', 'video'], [/(^|\.)soundcloud\.com$/, /^\/[^/]+\/[^/]+$/, 'SoundCloud', 'audio']];
  if (window === top) for (const [host, path, site, kind] of SITE_PAGES) if (host.test(location.hostname) && path.test(location.pathname)) {
    const el = document.querySelector(kind === 'audio' ? 'audio, video' : 'video');
    add({ kind, src: location.href.split('#')[0], title: pageTitle.replace(/\s*[|·]\s*[^|·]*\b(Vimeo|Dailymotion|Instagram|Facebook|TikTok|Twitch|TED|SoundCloud)\b.*$/i, '').replace(/\s+-\s+(Vimeo|Dailymotion|TED)$/i, '') || pageTitle, inView: true, playing: !!el && !el.paused, duration: el && Number.isFinite(el.duration) ? el.duration : 0, needsApp: true, stream: true, site });
  }

  // Video and audio players on the page.
  for (const el of document.querySelectorAll('video, audio')) {
    const kind = el.tagName === 'VIDEO' ? 'video' : 'audio';
    const sources = [el.currentSrc, el.getAttribute('src'), ...[...el.querySelectorAll('source')].map((s) => s.getAttribute('src'))].filter(Boolean).map(abs).filter(Boolean);
    const direct = sources.find((s) => !s.startsWith('blob:') && !s.startsWith('data:'));
    const isProtected = el.hasAttribute('data-omebly-drm') || !!el.mediaKeys;
    const base = { kind, title: titleNear(el) || pageTitle, inView: inView(el), playing: !el.paused && !el.ended, duration: Number.isFinite(el.duration) ? el.duration : 0, width: el.videoWidth || 0, height: el.videoHeight || 0, thumb: el.getAttribute('poster') ? abs(el.getAttribute('poster')) : '', protected: isProtected };
    if (direct) add({ ...base, src: direct, ext: extOf(direct) }, el);
    // Played from pieces (blob:): the stream itself is found by watching the network; the page address is a
    // second way for the app to read it.
    else if (sources.length || el.readyState > 0) add({ ...base, src: location.href, needsApp: true, stream: true }, el);
  }

  // Links to media and files (a course's lesson list, a downloads page).
  for (const a of document.querySelectorAll('a[href]')) {
    const u = abs(a.getAttribute('href')); if (!u || !/^https?:/.test(u)) continue;
    const path = new URL(u).pathname;
    const kind = VIDEO_EXT.test(path) ? 'video' : AUDIO_EXT.test(path) ? 'audio' : FILE_EXT.test(path) ? 'file' : null;
    if (!kind) continue;
    add({ kind, src: u, title: clean(a.textContent) || nameOf(u), inView: inView(a), playing: false, ext: extOf(u), fromLink: true, needsApp: /\.(m3u8|mpd)$/i.test(path) }, a);
  }

  // Pictures at their largest size (srcset), skipping icons and tracking pixels.
  for (const img of document.querySelectorAll('img')) {
    let best = img.currentSrc || img.src, bestW = img.naturalWidth || 0;
    const set = img.getAttribute('srcset');
    if (set) for (const part of set.split(',')) { const [u, d] = part.trim().split(/\s+/); const w = d && d.endsWith('w') ? parseInt(d) : 0; if (u && w > bestW) { best = u; bestW = w; } }
    const src = abs(best); if (!src || src.startsWith('data:')) continue;
    const w = Math.max(img.naturalWidth || 0, bestW), h = img.naturalHeight && img.naturalWidth ? Math.round(img.naturalHeight * (w / img.naturalWidth)) : 0;
    if (w && w < 48 && h < 48) continue;
    add({ kind: 'image', src, title: clean(img.alt) || nameOf(src) || 'Image', inView: inView(img), playing: false, width: w, height: h, ext: extOf(src) || 'jpg', thumb: src }, img);
  }
  // Their place on the page, top to bottom (so a course's lessons are numbered in their order).
  const placed = [...els.entries()].sort((a, b) => (a[1].compareDocumentPosition(b[1]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  placed.forEach(([it], i) => { it.pos = i; });
  return { url: location.href, title: pageTitle, items, top: window === top, mse: document.documentElement.hasAttribute('data-omebly-mse') };
}
