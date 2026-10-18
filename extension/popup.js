// The panel: asks every frame of the tab what is on it (scan.js), adds the streams seen on the network
// (background.js), and shows them in four tabs with checkboxes. Step 1: direct links download through the
// browser; streams and sites like YouTube are handed to the Omebly Downloader app once it exists (step 2 on).
import { scanPage } from './scan.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KINDS = [['video', 'Videos'], ['audio', 'Audio'], ['image', 'Images'], ['file', 'Files']];
const NOUN = { video: ['video', 'videos'], audio: ['audio file', 'audio files'], image: ['image', 'images'], file: ['file', 'files'] };
const ICON = {
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
};
const fmtSize = (n) => !n ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
const fmtTime = (s) => { if (!s || !Number.isFinite(s)) return ''; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
const quality = (it) => it.height ? (it.height >= 2000 ? '4K' : `${it.height}p`) : it.format || (it.needsApp ? '' : (it.ext || '').toUpperCase());
// A picture's address for CSS: only web addresses, with every character that could end the CSS string encoded
// (Security 323), so a page cannot change how the panel looks.
const cssUrl = (u) => (/^https?:\/\//i.test(u || '') ? `url("${u.replace(/["'()\\s<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase())}")` : 'none');
const safe = (s) => (s || 'Download').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Download';

const state = { tab: null, page: { title: '', host: '' }, items: [], kind: 'video', onScreen: true, bigOnly: true, chosen: new Set(), sizes: {} };

async function load() {
  // For tests the panel can be opened as a page with ?tab=<id>; normally it is the current tab.
  const q = new URLSearchParams(location.search).get('tab');
  state.tab = q ? await chrome.tabs.get(+q) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!state.tab?.id || !/^https?:|^file:/.test(state.tab.url || '')) return render('blocked');
  let frames = [];
  try { frames = await chrome.scripting.executeScript({ target: { tabId: state.tab.id, allFrames: true }, func: scanPage }); }
  catch { return render('blocked'); }
  const top = frames.find((f) => f.result?.top)?.result;
  const host = (() => { try { return new URL(state.tab.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  state.page = { title: top?.title || state.tab.title || host, host };
  const items = [], seen = new Set();
  for (const f of frames) for (const it of f.result?.items || []) if (!seen.has(it.kind + it.src)) { seen.add(it.kind + it.src); items.push(it); }
  // Streams seen on the network (videos played in pieces): listed when the page shows no address of its own.
  const streams = await chrome.runtime.sendMessage({ type: 'streams', tabId: state.tab.id }).catch(() => []);
  const pageStream = items.find((i) => i.stream && i.needsApp);
  for (const s of streams || []) {
    if (seen.has(s.kind + s.src)) continue;
    seen.add(s.kind + s.src);
    items.push({ kind: s.kind, src: s.src, title: pageStream?.title || state.page.title, inView: !!pageStream?.inView, playing: !!pageStream?.playing, needsApp: s.stream, stream: s.stream, format: s.format, size: s.size, ext: s.stream ? (s.format === 'DASH' ? 'mpd' : 'm3u8') : '' , protected: items.some((i) => i.protected && (i.kind === 'video' || i.kind === 'audio')), sniffed: true });
  }
  // A player whose pieces were found on the network does not need the page-address entry as well.
  if (pageStream && (streams || []).some((s) => s.stream)) items.splice(items.indexOf(pageStream), 1);
  // Playing first, then what is on screen, then the rest in page order.
  // order = place on the page (frames after the page itself); the list shows playing and on-screen ones first.
  items.forEach((it, i) => { it.order = (it.pos ?? 100000) + i / 1e6; });
  items.sort((a, b) => (+b.playing - +a.playing) || (+b.inView - +a.inView) || a.order - b.order);
  state.items = items;
  // Links that look like files are checked first (size and type, a second at most): one that answers with a web
  // page is dropped, so a wiki's "File:cat.webm" page is not offered as a video.
  const urls = items.filter((i) => !i.needsApp && !i.size && i.kind !== 'image').map((i) => i.src);
  if (urls.length) {
    const asked = chrome.runtime.sendMessage({ type: 'sizes', urls, tabId: state.tab.id }).catch(() => ({}));
    const info = await Promise.race([asked, new Promise((r) => setTimeout(() => r(null), 1500))]);
    if (info) applyInfo(info); else asked.then((i) => { applyInfo(i || {}); render(); });
  }
  state.kind = KINDS.find(([k]) => state.items.some((i) => i.kind === k))?.[0] || 'video';
  for (const it of visible()) if (!it.protected) state.chosen.add(it.src);
  render();
}
function applyInfo(info) {
  for (const [u, x] of Object.entries(info)) if (x?.size) state.sizes[u] = x.size;
  state.items = state.items.filter((i) => { const x = info[i.src]; return !(x && i.fromLink && (x.type === 'text/html' || x.type === 'application/xhtml+xml')); });
  for (const s of [...state.chosen]) if (!state.items.some((i) => i.src === s)) state.chosen.delete(s);
}

function ofKind(kind = state.kind) { return state.items.filter((i) => i.kind === kind); }
function visible() {
  let list = ofKind();
  if ((state.kind === 'video' || state.kind === 'audio') && state.onScreen && list.some((i) => i.inView)) list = list.filter((i) => i.inView || i.playing || i.inList);
  if (state.kind === 'image' && state.bigOnly) list = list.filter((i) => (i.width || 0) >= 300 || (i.height || 0) >= 300);
  return list;
}
const sizeOf = (it) => it.size || state.sizes[it.src] || 0;

function render(mode) {
  const main = $('list');
  if (mode === 'blocked') {
    $('h-title').textContent = 'Nothing to find here';
    main.innerHTML = `<div class="empty"><div class="ic">${ICON.search}</div><b>Open a website first</b><p>Omebly Downloader looks at web pages. Browser pages like settings or the new tab page have nothing to download.</p></div>`;
    return;
  }
  const counts = Object.fromEntries(KINDS.map(([k]) => [k, ofKind(k).length]));
  const n = counts[state.kind], [one, many] = NOUN[state.kind];
  $('h-title').textContent = n ? `${n} ${n === 1 ? one : many} on this page` : `No ${many} here yet`;
  $('h-sub').textContent = [state.page.title, state.page.host].filter(Boolean).join(' · ');
  $('tabs').innerHTML = KINDS.map(([k, label]) => `<button role="tab" data-kind="${k}" aria-selected="${state.kind === k}">${label} ${counts[k]}</button>`).join('');
  const media = state.kind === 'video' || state.kind === 'audio', all = ofKind();
  $('chips').innerHTML = media && all.some((i) => i.inView) && all.some((i) => !i.inView)
    ? `<button data-chip="screen" aria-pressed="${state.onScreen}">On screen · ${all.filter((i) => i.inView || i.playing || i.inList).length}</button><button data-chip="page" aria-pressed="${!state.onScreen}">Whole page · ${all.length}</button>`
    : state.kind === 'image' && all.length ? `<button data-chip="big" aria-pressed="${state.bigOnly}">Big ones only</button><button data-chip="allsizes" aria-pressed="${!state.bigOnly}">All sizes</button>` : '';
  const list = visible(), pickable = list.filter((i) => !i.protected), chosen = pickable.filter((i) => state.chosen.has(i.src));
  $('selall').hidden = !pickable.length;
  $('ck-all').setAttribute('aria-checked', chosen.length === 0 ? 'false' : chosen.length === pickable.length ? 'true' : 'mixed');
  $('sel-count').textContent = `${chosen.length} of ${pickable.length} chosen`;
  if (!list.length) {
    main.innerHTML = state.kind === 'video' || state.kind === 'audio'
      ? `<div class="empty"><div class="ic">${ICON.search}</div><b>Press play, and it appears here</b><p>Some sites load their ${many} only when they start playing. Start it, then look again.</p><button class="again" id="again">Look again</button></div>`
      : `<div class="empty"><div class="ic">${ICON.search}</div><b>No ${many} on this page</b><p>${state.kind === 'image' && all.length ? 'Only small pictures here. Choose All sizes to see them.' : 'Try another tab above.'}</p></div>`;
  } else if (state.kind === 'image') {
    main.innerHTML = `<div class="grid">${list.map((it) => `<button class="tile" data-src="${esc(it.src)}" style="background-image:${esc(cssUrl(it.thumb))}" aria-label="${esc(it.title)}"><span class="ck" role="checkbox" aria-checked="${state.chosen.has(it.src)}"></span>${it.width ? `<span class="dim">${it.width}×${it.height || '?'}</span>` : ''}</button>`).join('')}</div>`;
  } else {
    main.innerHTML = list.map((it) => {
      if (it.protected) return `<div class="row"><span class="lock">${ICON.lock}</span><div class="thumb" style="opacity:.6"></div><div class="info"><div class="name" style="color:var(--muted)">${esc(it.title)}</div><div class="locked">Protected by the site, can't be saved</div></div></div>`;
      const on = state.chosen.has(it.src), size = fmtSize(sizeOf(it)), q = quality(it);
      const thumb = it.kind === 'file' ? `<span class="badge ${esc(it.ext)}">${esc(it.ext || 'file')}</span>` : `<div class="thumb" style="${it.thumb ? `background-image:${esc(cssUrl(it.thumb))}` : ''}">${it.kind === 'audio' && !it.thumb ? `<span style="left:26px;bottom:12px">♪</span>` : ''}<span>${fmtTime(it.duration)}</span></div>`;
      return `<button class="row${on ? ' on' : ''}" data-src="${esc(it.src)}"><span class="ck" role="checkbox" aria-checked="${on}"></span>${thumb}<div class="info"><div class="name">${esc(it.title)}</div><div class="meta">${it.playing ? '<span class="pill play">Playing</span>' : ''}${q ? `<span class="pill">${esc(q)}</span>` : ''}${it.needsApp ? '<span class="pill app">Uses the app</span>' : ''}${size ? `<span class="size">${size}</span>` : ''}</div></div></button>`;
    }).join('');
  }
  // Footer: where it goes, and the button.
  const sel = state.items.filter((i) => state.chosen.has(i.src) && !i.protected && i.kind === state.kind);
  const direct = sel.filter((i) => !i.needsApp), viaApp = sel.length - direct.length, total = direct.reduce((s, i) => s + sizeOf(i), 0);
  $('foot').hidden = !pickable.length;
  $('where').textContent = `Downloads\\Omebly\\${safe(state.page.title)}${direct.length > 1 && media ? ', numbered in order' : ''}`;
  $('note').hidden = !viaApp;
  $('note').textContent = viaApp ? `${viaApp} ${viaApp === 1 ? 'needs' : 'need'} the Omebly Downloader app (streams and sites like YouTube). The app arrives in the next step.` : '';
  $('go').disabled = !direct.length;
  $('go-label').textContent = direct.length ? `Download ${direct.length} ${direct.length === 1 ? one : many}${total ? ` · ${fmtSize(total)}` : ''}` : viaApp ? 'Needs the Omebly Downloader app' : 'Choose something to download';
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.kind) {
    // The first time a tab is opened, everything in it is chosen (as when the panel opens).
    state.kind = t.dataset.kind;
    if (!state.items.some((x) => x.kind === state.kind && state.chosen.has(x.src))) for (const it of visible()) if (!it.protected) state.chosen.add(it.src);
    render(); return;
  }
  if (t.dataset.chip) { if (t.dataset.chip === 'screen') state.onScreen = true; if (t.dataset.chip === 'page') state.onScreen = false; if (t.dataset.chip === 'big') state.bigOnly = true; if (t.dataset.chip === 'allsizes') state.bigOnly = false; render(); return; }
  if (t.id === 'ck-all') { const list = visible().filter((i) => !i.protected), all = list.every((i) => state.chosen.has(i.src)); for (const i of list) if (all) state.chosen.delete(i.src); else state.chosen.add(i.src); render(); return; }
  if (t.id === 'again') { state.items = []; state.chosen.clear(); void load(); return; }
  if (t.id === 'go') { void download(); return; }
  if (t.dataset.src) { const s = t.dataset.src; if (state.chosen.has(s)) state.chosen.delete(s); else state.chosen.add(s); render(); }
});

async function download() {
  // Step 1: direct links through the browser's own downloads, in a folder named after the page, numbered when
  // there are several (so a course's lessons stay in order).
  const sel = visible().filter((i) => state.chosen.has(i.src) && !i.protected && !i.needsApp).sort((a, b) => a.order - b.order);
  const folder = safe(state.page.title), numbered = sel.length > 1 && (state.kind === 'video' || state.kind === 'audio');
  let n = 0;
  for (const it of sel) {
    n++;
    const ext = it.ext || (state.kind === 'image' ? 'jpg' : 'bin');
    // Numbered in page order; a number the site already put in front ("3. Components") is not repeated.
    const title = numbered ? safe(it.title).replace(/^(lesson\s*)?\d{1,3}\s*[.):\-–]\s*/i, '') : safe(it.title);
    const name = `${numbered ? String(n).padStart(2, '0') + ' ' : ''}${title}`.replace(new RegExp(`\\.${ext}$`, 'i'), '');
    try { await chrome.downloads.download({ url: it.src, filename: `Omebly/${folder}/${name}.${ext}`, conflictAction: 'uniquify' }); } catch { /* the browser shows its own message */ }
  }
  $('go-label').textContent = `Started ${sel.length} ${sel.length === 1 ? NOUN[state.kind][0] : NOUN[state.kind][1]}`;
  $('go').disabled = true;
}

void load();
