// Watches each tab's network for video and audio streams (the pieces sites play videos from), so the panel can
// list streams that have no address on the page. Kept per tab, cleared when the tab goes to a new page.
// Nothing is sent anywhere; the list stays in this browser.
const MEDIA_TYPES = /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;
const MANIFEST = /\.(m3u8|mpd)(\?|$)/i;
const PIECE = /\.(ts|m4s|aac|m4a|m4v|cmfv|cmfa)(\?|$)/i; // a single piece of a stream: not worth listing on its own
const MAX_PER_TAB = 60;

const key = (tabId) => `tab:${tabId}`;
async function list(tabId) { const r = await chrome.storage.session.get(key(tabId)); return r[key(tabId)] ?? []; }
async function remember(tabId, found) {
  const all = await list(tabId);
  if (all.some((x) => x.src === found.src)) return;
  all.push(found);
  await chrome.storage.session.set({ [key(tabId)]: all.slice(-MAX_PER_TAB) });
}

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0) return;
  const type = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
  const len = +((d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-length')?.value || 0);
  const url = d.url, path = new URL(url).pathname;
  const isManifest = MANIFEST.test(path) || /mpegurl|dash\+xml/i.test(type);
  if (!isManifest && (PIECE.test(path) || !MEDIA_TYPES.test(type))) return;
  if (!isManifest && d.statusCode === 206 && len && len < 2_000_000) return; // a range of a bigger file seen already
  const kind = /^audio\//i.test(type) ? 'audio' : 'video';
  void remember(d.tabId, { kind, src: url, type, size: len || 0, stream: isManifest, format: isManifest ? (/mpd|dash/i.test(path + type) ? 'DASH' : 'HLS') : '', at: Date.now() });
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] }, ['responseHeaders']);

chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading' && info.url) void chrome.storage.session.remove(key(tabId)); });
chrome.tabs.onRemoved.addListener((tabId) => void chrome.storage.session.remove(key(tabId)));

// Addresses on this computer or the home network (router, printer): only checked when the page is on one too,
// so a website cannot make the extension knock on them (Security 323).
const isPrivate = (h) => /^(localhost|.*\.local|.*\.localhost)$/i.test(h) || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^\[?(::1|::ffff:|f[cd][0-9a-f]{2}:|fe80:)/i.test(h) || /^0\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only the panel itself may ask (never a web page or a script in one).
  if (sender.id !== chrome.runtime.id || !(sender.url || '').startsWith(chrome.runtime.getURL('popup.html'))) return false;
  if (msg?.type === 'streams') { list(msg.tabId).then(reply); return true; }
  if (msg?.type === 'sizes') { sizes(msg).then(reply); return true; }
  return false;
});

async function sizes(msg) {
  const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
  let pageHost = ''; try { pageHost = new URL(tab?.url || '').hostname; } catch { /* no page */ }
  const out = {};
  const queue = (msg.urls || []).slice(0, 150).filter((u) => { try { const h = new URL(u).hostname; return /^https?:$/.test(new URL(u).protocol) && (!isPrivate(h) || isPrivate(pageHost)); } catch { return false; } });
  const one = async (u) => {
    // Size and type: a link that looks like a file but answers with a web page (a wiki's "File:" page) is not one.
    // Cookies go only to the page's own address (where the person is signed in anyway).
    const same = !!pageHost && new URL(u).hostname === pageHost;
    try { const r = await fetch(u, { method: 'HEAD', credentials: same ? 'include' : 'omit' }); out[u] = { size: +(r.headers.get('content-length') || 0), type: (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), ok: r.ok }; } catch { /* the site refused: unknown */ }
  };
  // Ten at a time, so a page with many links is not flooded.
  await Promise.all(Array.from({ length: 10 }, async () => { while (queue.length) await one(queue.shift()); }));
  return out;
}
