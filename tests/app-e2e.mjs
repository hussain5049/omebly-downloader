// Step 2 test: the whole path. A message as the extension sends it goes through the browser link (the app started
// as Chrome would start it), the app downloads everything into a test folder, and the files are checked. The app's
// screen is reached through WebView2's debugging port for pause and resume and a screenshot.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXE = join(ROOT, 'app/src-tauri/target', process.env.RELEASE ? 'release' : 'debug', 'omebly-downloader.exe');
const ID = 'cjaaiapbiobjhmbhdikahgkokpffpoij';
const SITE = 'http://127.0.0.1:4430';
const data = mkdtempSync(join(tmpdir(), 'odl-data-')), downloads = mkdtempSync(join(tmpdir(), 'odl-dl-'));
const env = { ...process.env, OMEBLY_DATA_DIR: data, OMEBLY_DOWNLOADS: downloads, WEBVIEW2_USER_DATA_FOLDER: join(data, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333' };
let pass = 0, fail = 0;
const ok = (n, c, info = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' — ' + info}`); c ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 200 MB file on the test site, for parts and pause/resume.
const big = join(ROOT, 'test-site/media/big.bin');
if (!existsSync(big) || statSync(big).size !== 200 * 1024 * 1024) { const b = Buffer.alloc(1024 * 1024); writeFileSync(big, ''); for (let i = 0; i < 200; i++) { b.fill(i); writeFileSync(big, b, { flag: 'a' }); } }
const server = spawn(process.execPath, [join(ROOT, 'test-site/serve.mjs')], { stdio: 'ignore' });
await sleep(500);

// The app, started by hand (as after installing).
const app = spawn(EXE, [], { env, stdio: 'ignore' });
await sleep(4000);

// The browser link: started like Chrome starts it, one message in, one answer out.
function send(msg) {
  return new Promise((res) => {
    const p = spawn(EXE, [`chrome-extension://${ID}/`, '--parent-window=0'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const body = Buffer.from(JSON.stringify(msg)), head = Buffer.alloc(4); head.writeUInt32LE(body.length);
    p.stdin.end(Buffer.concat([head, body]));
    const chunks = []; p.stdout.on('data', (c) => chunks.push(c));
    p.on('exit', () => { const b = Buffer.concat(chunks); res(b.length > 4 ? JSON.parse(b.subarray(4, 4 + b.readUInt32LE(0)).toString()) : null); });
  });
}
const jobs = () => { try { return JSON.parse(readFileSync(join(data, 'downloads.json'), 'utf8')); } catch { return []; } };
async function waitFor(pred, ms) { const end = Date.now() + ms; while (Date.now() < end) { const j = jobs(); if (pred(j)) return j; await sleep(500); } return jobs(); }

ok('link: the extension is answered', (await send({ type: 'hello' }))?.ok === true);
const wrong = await new Promise((res) => { const p = spawn(EXE, ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'], { env, stdio: ['pipe', 'pipe', 'ignore'] }); const b = Buffer.from(JSON.stringify({ type: 'hello' })), h = Buffer.alloc(4); h.writeUInt32LE(b.length); p.stdin.end(Buffer.concat([h, b])); const c = []; p.stdout.on('data', (x) => c.push(x)); p.on('exit', () => { const x = Buffer.concat(c); res(x.length > 4 ? JSON.parse(x.subarray(4).toString()) : null); }); });
ok('link: another extension is turned away', wrong?.ok === false, JSON.stringify(wrong));

// A course: five lessons (direct, numbered), a stream with two qualities, and a song.
const course = { type: 'download', page: { url: `${SITE}/course.html`, title: 'React Basics' }, headers: { referer: `${SITE}/course.html` }, cookies: [],
  items: [1, 2, 3, 4, 5].map((n) => ({ url: `${SITE}/media/lesson-${n}.mp4`, title: `${n}. Lesson ${n}`, kind: 'video', ext: 'mp4' })) };
ok('course: sent', (await send(course))?.ok === true);
const stream = { type: 'download', page: { url: `${SITE}/stream.html`, title: 'Knife skills' }, items: [{ url: `${SITE}/media/abr/master.m3u8`, title: 'Knife skills for beginners', kind: 'video', needsApp: true, ext: 'm3u8', height: 720 }] };
ok('stream: sent', (await send(stream))?.ok === true);
let j = await waitFor((x) => x.length >= 6 && x.every((y) => ['done', 'failed', 'protected'].includes(y.state)), 120000);
const lessons = readdirSync(join(downloads, 'Omebly', 'React Basics')).sort();
ok('course: five lessons saved, numbered in order', lessons.join('|') === '01 Lesson 1.mp4|02 Lesson 2.mp4|03 Lesson 3.mp4|04 Lesson 4.mp4|05 Lesson 5.mp4', lessons.join('|'));
ok('course: each lesson is complete (same size as on the site)', lessons.every((f) => statSync(join(downloads, 'Omebly', 'React Basics', f)).size === statSync(join(ROOT, 'test-site/media/lesson-1.mp4')).size));
const st = j.find((x) => x.how === 'site');
ok('stream: saved as one video file', st?.state === 'done' && existsSync(st.saved), JSON.stringify(st && { state: st.state, error: st.error, saved: st.saved }));
if (st?.saved && existsSync(st.saved)) {
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,height', '-of', 'csv=p=0', st.saved]).toString();
  ok('stream: the 720p video and its sound are in it', /video,720/.test(probe.replace(/\r/g, '')) && /audio/.test(probe), probe);
}

let zone = ''; try { zone = readFileSync(join(downloads, 'Omebly', 'React Basics', lessons[0]) + ':Zone.Identifier', 'utf8'); } catch { /* none */ }
ok('safety: a finished file is marked as from the internet (Mark of the Web)', /ZoneId=3/.test(zone) && /HostUrl=http:\/\/127\.0\.0\.1:4430\/media\/lesson-1\.mp4/.test(zone), zone);
// A strange extension cannot lead the file out of its folder.
await send({ type: 'download', page: { title: 'Odd' }, items: [{ url: `${SITE}/media/science-notes.pdf`, title: 'notes', kind: 'file', ext: 'x\\..\\..\\..\\escaped' }] });
j = await waitFor((x) => ['done', 'failed'].includes(x.find((y) => y.title === 'notes')?.state), 30000);
const odd = j.find((y) => y.title === 'notes');
ok('safety: an odd extension becomes .bin inside the page folder', odd?.saved?.startsWith(join(downloads, 'Omebly', 'Odd')) && odd.saved.endsWith('notes.bin') && !existsSync(join(downloads, 'escaped')), JSON.stringify(odd && { state: odd.state, saved: odd.saved }));

// Locked stream: refused, never downloaded.
writeFileSync(join(ROOT, 'test-site/media/abr/locked.m3u8'), '#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:2,\nv0_000.ts\n#EXT-X-ENDLIST\n');
await send({ type: 'download', page: { title: 'Locked' }, items: [{ url: `${SITE}/media/abr/locked.m3u8`, title: 'Locked lesson', kind: 'video', needsApp: true, ext: 'm3u8' }] });
j = await waitFor((x) => x.some((y) => y.title === 'Locked lesson' && y.state !== 'waiting' && y.state !== 'downloading'), 30000);
ok('locked: a DRM stream is refused as Protected', j.find((y) => y.title === 'Locked lesson')?.state === 'protected', JSON.stringify(j.find((y) => y.title === 'Locked lesson')));

// Pause and resume a big file through the app's own screen.
let cdp = null; try { cdp = await chromium.connectOverCDP('http://127.0.0.1:9333'); } catch (e) { console.log('screen not reachable:', e.message); }
const page = cdp?.contexts()[0]?.pages()[0];
await send({ type: 'download', page: { title: 'Big file' }, items: [{ url: `${SITE}/media/big.bin`, title: 'big', kind: 'file', ext: 'bin' }] });
j = await waitFor((x) => { const b = x.find((y) => y.title === 'big'); return b && b.done > 0; }, 20000);
let b = j.find((y) => y.title === 'big');
if (page && b) {
  await page.evaluate((id) => window.__TAURI__.core.invoke('pause', { id }), b.id);
  await sleep(1500);
  const paused = jobs().find((y) => y.id === b.id);
  ok('pause: the big file stops part way', paused.state === 'paused' && paused.state !== 'done', JSON.stringify({ state: paused.state, done: paused.done }));
  await page.screenshot({ path: join(ROOT, 'tests/out/app-paused.png') });
  await page.evaluate((id) => window.__TAURI__.core.invoke('resume', { id }), b.id);
  j = await waitFor((x) => ['done', 'failed'].includes(x.find((y) => y.id === b.id)?.state), 120000);
  b = j.find((y) => y.id === b.id);
  ok('resume: it continues and the file is complete and correct', b.state === 'done' && statSync(b.saved).size === 200 * 1024 * 1024 && readFileSync(b.saved).subarray(150 * 1024 * 1024, 150 * 1024 * 1024 + 4).every((x) => x === 150), JSON.stringify({ state: b.state, error: b.error }));
  await page.evaluate(() => document.querySelector('[data-view="done"]').click()); await sleep(400);
  await page.screenshot({ path: join(ROOT, 'tests/out/app-finished.png') });
} else ok('pause: the app screen is reachable for the test', false, 'no WebView2 debugging port');

// Speed: the same file over 1 connection and over 16 (the test site gives each connection about 2.5 MB/s).
if (page) {
  const timeIt = async (n) => {
    const s = await page.evaluate(() => window.__TAURI__.core.invoke('settings'));
    await page.evaluate((x) => window.__TAURI__.core.invoke('save_settings', { s: { ...x } }), { ...s, connections: n });
    const t0 = Date.now();
    await send({ type: 'download', page: { title: `Speed ${n}` }, items: [{ url: `${SITE}/media/big.bin`, title: `speed-${n}`, kind: 'file', ext: 'bin' }] });
    const r = await waitFor((x) => ['done', 'failed'].includes(x.find((y) => y.title === `speed-${n}`)?.state), n === 1 ? 20000 : 60000);
    const d = r.find((y) => y.title === `speed-${n}`);
    const secs = (Date.now() - t0) / 1000, mb = d?.state === 'done' ? 200 : (d?.done || 0) / 1048576;
    if (d && d.state !== 'done') await page.evaluate((id) => window.__TAURI__.core.invoke('remove', { id }), d.id);
    return mb / secs;
  };
  const one = await timeIt(1), sixteen = await timeIt(16);
  console.log(`speed: 1 connection ${one.toFixed(1)} MB/s, 16 connections ${sixteen.toFixed(1)} MB/s`);
  ok('speed: 16 parts are at least 8 times faster than one connection', sixteen > one * 8, `${one.toFixed(1)} vs ${sixteen.toFixed(1)} MB/s`);
}

// YouTube (a real site): the oldest video on YouTube, 19 seconds.
if (process.env.REAL) {
  await send({ type: 'download', page: { title: 'YouTube test' }, items: [{ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', title: 'Me at the zoo', kind: 'video', needsApp: true, height: 720 }] });
  j = await waitFor((x) => { const y = x.find((z) => z.title === 'Me at the zoo'); return y && ['done', 'failed', 'protected'].includes(y.state); }, 180000);
  const y = j.find((z) => z.title === 'Me at the zoo');
  ok('youtube: a real YouTube video downloads as one file', y?.state === 'done' && existsSync(y.saved), JSON.stringify(y && { state: y.state, error: y.error }));
}

console.log(`\n${pass} passed, ${fail} failed`);
try { await cdp?.close(); } catch {}
app.kill(); server.kill();
// Only the test's own copy is closed (never an Omebly Downloader the person has open).
process.exit(fail ? 1 : 0);
