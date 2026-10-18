// The app's screen: the download list (Downloading, Waiting, Finished) and Settings. All work is done by the app
// itself (src-tauri); this page shows it and sends the buttons' clicks.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const size = (n) => !n ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
const rate = (n) => !n ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB/s` : `${Math.round(n / 1e3)} KB/s`;
const left = (s) => { if (!s || !isFinite(s)) return ''; s = Math.round(s); if (s < 60) return `0:${String(s).padStart(2, '0')} left`; const m = Math.floor(s / 60); return m < 60 ? `${m}:${String(s % 60).padStart(2, '0')} left` : `${Math.floor(m / 60)} h ${m % 60} m left`; };
const when = (t) => { if (!t) return ''; const d = new Date(t * 1000), now = new Date(); const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`; };
const ICON = {
  play: '<svg viewBox="0 0 24 24" style="fill:#fff;stroke:none"><path d="M8 5v14l11-7z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/></svg>',
  music: '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="8.8" cy="9.8" r="1.6"/><path d="m4 16.5 4.7-4.6 4 4 2.5-2.5 5 4.6"/></svg>',
  pause: '<svg viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  resume: '<svg viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><path d="M8 5v14l11-7z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16v.5"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
};
let jobs = [], view = 'active', q = '', tools = null;

const groupOf = (j) => (j.state === 'downloading' || j.state === 'paused') ? 'active' : j.state === 'waiting' ? 'waiting' : 'done';
const iconFor = (j) => j.state === 'failed' ? `<div class="ic bad">${ICON.warn}</div>` : j.state === 'protected' ? `<div class="ic lock">${ICON.lock}</div>` : j.kind === 'video' ? `<div class="ic">${ICON.play}</div>` : `<div class="ic file">${j.kind === 'audio' ? ICON.music : j.kind === 'image' ? ICON.image : ICON.file}</div>`;
const fileName = (j) => `${j.name}${j.how === 'file' && j.ext ? '.' + j.ext : ''}`;
const bar = (parts) => `<div class="seg">${(parts?.length ? parts : Array(16).fill(0)).map((f) => `<i style="background:${f >= 1 ? 'var(--mint)' : f <= 0 ? '' : `linear-gradient(90deg,var(--mint) ${Math.round(f * 100)}%,var(--ink3) ${Math.round(f * 100)}%)`}"></i>`).join('')}</div>`;

function render() {
  for (const k of ['active', 'waiting', 'done']) $(`n-${k}`).textContent = jobs.filter((j) => groupOf(j) === k).length;
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $('title').textContent = { active: 'Downloading', waiting: 'Waiting', done: 'Finished', settings: 'Settings' }[view];
  const total = jobs.filter((j) => j.state === 'downloading').reduce((s, j) => s + (j.speed || 0), 0);
  $('speed').textContent = rate(total);
  $('settings').hidden = view !== 'settings'; $('list').hidden = view === 'settings';
  $('b-pause').hidden = view !== 'active' && view !== 'waiting';
  $('b-pause').textContent = jobs.some((j) => j.state === 'downloading' || j.state === 'waiting') ? 'Pause all' : 'Resume all';
  const running = jobs.filter((j) => j.state === 'downloading').length, waiting = jobs.filter((j) => j.state === 'waiting').length;
  $('foot').innerHTML = `<span>${running} downloading · ${waiting} waiting</span><span>Up to 16 parts per file</span><div class="grow"></div><span>${jobs.filter((j) => j.state === 'done').length} finished</span>`;
  if (view === 'settings') return;
  const list = jobs.filter((j) => groupOf(j) === view && (!q || `${j.title} ${j.name} ${j.site} ${j.group}`.toLowerCase().includes(q)))
    .sort((a, b) => view === 'done' ? (b.finished || b.added) - (a.finished || a.added) : a.id - b.id);
  if (!list.length) {
    $('list').innerHTML = `<div class="empty"><div class="big">${ICON.down}</div><b>${view === 'done' ? 'Nothing finished yet' : view === 'waiting' ? 'Nothing waiting' : 'Nothing downloading'}</b><p>Open a page in your browser, click the green Omebly Downloader button, tick what you want and press Download. Or paste a link with + Add a link.</p></div>`;
    return;
  }
  const out = [];
  let lastGroup = null;
  for (const j of list) {
    if (view !== 'done' && j.group !== lastGroup) { const n = list.filter((x) => x.group === j.group).length; out.push(`<div class="group"><b>${esc(j.group)}</b><span class="k">${n} ${n === 1 ? 'download' : 'downloads'}${j.site ? ` · from ${esc(j.site)}` : ''}</span></div>`); lastGroup = j.group; }
    if (view === 'done') {
      const err = j.state === 'failed' ? `<div class="err">${esc(j.error)}</div>` : j.state === 'protected' ? `<div class="err lock">Protected: locked by the site, not saved</div>` : `<div class="k" style="margin-top:3px">${esc(j.site)} · ${esc(j.group)}</div>`;
      const acts = j.state === 'done' ? `<button class="sm pri" data-open="${j.id}">Open</button><button class="sm" data-show="${j.id}">Show in folder</button>` : j.state === 'failed' ? `<button class="sm pri" data-resume="${j.id}">Try again</button><button class="sm" data-remove="${j.id}">Remove</button>` : `<button class="sm" data-remove="${j.id}">Remove</button>`;
      out.push(`<div class="item done">${iconFor(j)}<div style="min-width:0"><div class="name">${esc(fileName(j))}</div>${err}</div><div class="k">${j.height ? `${j.height}p` : esc((j.ext || j.kind || '').toUpperCase())}${j.languages?.length ? ' · ' + esc(j.languages.join(' + ')) : ''}</div><div class="v mono">${size(j.total) || '—'}</div><div class="v mono" style="color:var(--muted)">${when(j.finished || j.added)}</div><div class="acts">${acts}</div></div>`);
      continue;
    }
    const pct = j.total ? Math.min(100, Math.floor((j.done / j.total) * 100)) : 0;
    const status = j.state === 'paused' ? `<div class="v mono">Paused</div><div class="k">continues from here</div>` : j.phase === 'joining' ? `<div class="v">Joining tracks</div><div class="k">video + audio</div>` : j.state === 'waiting' ? `<div class="v">Waiting</div><div class="k">starts soon</div>` : `<div class="v mono mint">${rate(j.speed) || 'Starting…'}</div><div class="k">${j.connections ? `${j.connections} ${j.connections === 1 ? 'part' : 'parts'}` : ''}</div>`;
    const btn = j.state === 'paused' ? `<button class="ib go" data-resume="${j.id}" aria-label="Continue">${ICON.resume}</button>` : `<button class="ib" data-pause="${j.id}" aria-label="Pause">${ICON.pause}</button>`;
    out.push(`<div class="item">${iconFor(j)}<div style="min-width:0"><div class="name">${esc(fileName(j))}</div>${bar(j.parts)}</div><div><div class="v mono">${pct}%</div><div class="k">${j.total ? `${size(j.done)} of ${size(j.total)}` : size(j.done)}</div></div><div>${status}</div><div><div class="v mono">${j.state === 'downloading' ? left(j.eta) : '—'}</div><div class="k">${j.languages?.length ? esc(j.languages.join(' + ')) : esc(j.site)}</div></div><div class="acts">${btn}<button class="ib" data-remove="${j.id}" aria-label="Cancel">${ICON.x}</button></div></div>`);
  }
  $('list').innerHTML = out.join('');
}

async function renderSettings() {
  const s = await invoke('settings');
  tools = tools || await invoke('tools');
  $('settings').innerHTML = `
    <div class="card"><h3>Where downloads go</h3>
      <div class="line"><div style="flex:1;min-width:0"><div>Folder</div><div class="sub">A folder is made inside it for each page, course or playlist</div></div></div>
      <div class="line"><input class="path" id="s-folder" value="${esc(s.folder)}" spellcheck="false"></div></div>
    <div class="card"><h3>Speed</h3>
      <div class="line"><div style="flex:1"><div>Parts per file</div><div class="sub">More parts is faster on most sites (1 to 32)</div></div><input class="num" id="s-conn" type="number" min="1" max="32" value="${s.connections}"></div>
      <div class="line"><div style="flex:1"><div>Downloads at the same time</div></div><input class="num" id="s-once" type="number" min="1" max="10" value="${s.at_once}"></div></div>
    <div class="card wide"><h3>Engines</h3>
      <div class="line"><div style="flex:1;min-width:0"><div>Site reader (yt-dlp)</div><div class="sub">${tools.ytdlp ? esc(tools.ytdlp) : 'Not found: YouTube and streams cannot download'}</div></div></div>
      <div class="line"><div style="flex:1;min-width:0"><div>Video joiner (FFmpeg)</div><div class="sub">${tools.ffmpeg ? esc(tools.ffmpeg) : 'Not found: video and audio stay in separate files'}</div></div></div></div>
    <div class="card wide" style="display:flex;align-items:center;gap:14px"><div style="flex:1"><div style="font-weight:800">Omebly Downloader ${esc(tools.version)} · free and open source (GPL-3.0)</div><div class="sub">You are responsible for what you download. Download only what you have the right to save. Videos locked with copy protection are never downloaded.</div></div><button class="btn pri" id="s-save">Save</button></div>`;
  $('s-save').onclick = async () => { await invoke('save_settings', { s: { folder: $('s-folder').value.trim() || s.folder, connections: +$('s-conn').value || 16, at_once: +$('s-once').value || 3 } }); $('s-save').textContent = 'Saved'; setTimeout(() => { if ($('s-save')) $('s-save').textContent = 'Save'; }, 1500); };
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.view) { view = b.dataset.view; if (view === 'settings') await renderSettings(); render(); return; }
  if (b.dataset.pause) { await invoke('pause', { id: +b.dataset.pause }); return; }
  if (b.dataset.resume) { await invoke('resume', { id: +b.dataset.resume }); return; }
  if (b.dataset.remove) { await invoke('remove', { id: +b.dataset.remove }); return; }
  if (b.dataset.open) { await invoke('reveal', { id: +b.dataset.open, open: true }); return; }
  if (b.dataset.show) { await invoke('reveal', { id: +b.dataset.show, open: false }); return; }
  if (b.id === 'b-pause') { await invoke(jobs.some((j) => j.state === 'downloading' || j.state === 'waiting') ? 'pause_all' : 'resume_all'); return; }
  if (b.id === 'b-add') { $('links').value = ''; $('add').showModal(); setTimeout(() => $('links').focus(), 50); return; }
});
$('add').addEventListener('close', async () => { if ($('add').returnValue === 'go' && $('links').value.trim()) { const n = await invoke('add_links', { text: $('links').value }); if (n) { view = 'active'; render(); } } });
$('q').addEventListener('input', () => { q = $('q').value.trim().toLowerCase(); render(); });

(async () => {
  jobs = await invoke('list');
  if (!jobs.some((j) => groupOf(j) === 'active') && jobs.some((j) => groupOf(j) === 'done')) view = 'done';
  render();
  tools = await invoke('tools');
  $('eng').innerHTML = tools.ytdlp && tools.ffmpeg ? 'Engines ready<br><span style="color:var(--faint)">yt-dlp and FFmpeg found</span>' : `<b>${!tools.ytdlp ? 'yt-dlp' : 'FFmpeg'} not found</b><br>YouTube and streams need it`;
  await listen('jobs', (ev) => { const was = jobs; jobs = ev.payload; if (view === 'done' && jobs.length > was.length) view = 'active'; render(); });
})();
