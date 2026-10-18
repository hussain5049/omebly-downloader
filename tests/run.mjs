// Step 1 test: loads the extension into Chrome, opens each test page, opens the panel for it and checks what it
// lists. With REAL=1 it also opens a few real websites and saves what the panel shows (no checks: they change).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const OUT = fileURLToPath(new URL('./out/', import.meta.url)); mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SITE = 'http://127.0.0.1:4430';
const server = spawn(process.execPath, [fileURLToPath(new URL('../test-site/serve.mjs', import.meta.url))], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'omebly-dl-')), {
  executablePath: CHROME, headless: !process.env.HEADED && !process.env.REAL, viewport: { width: 1280, height: 800 }, ignoreDefaultArgs: ['--disable-extensions'],
  // Chrome no longer takes --load-extension, so the extension is loaded through the debugging protocol.
  args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
});
let id = null;
const cdp = await ctx.browser()?.newBrowserCDPSession?.().catch(() => null) ?? null;
if (cdp) id = (await cdp.send('Extensions.loadUnpacked', { path: EXT }).catch((e) => { console.log(e.message); return {}; })).id ?? null;

if (!id) { console.log('Could not load the extension into Chrome.'); await ctx.close(); server.kill(); process.exit(1); }
console.log('extension', id);

let pass = 0, fail = 0;
const ok = (name, cond, info = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + info}`); cond ? pass++ : fail++; };

async function panelFor(url, waitMs = 2500, scrollY = 0) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(waitMs);
  if (scrollY) await page.evaluate((y) => scrollTo(0, y), scrollY);
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/popup.html`);
  const tabId = await panel.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u || t.url?.startsWith(u))?.id, page.url());
  await panel.setViewportSize({ width: 420, height: 600 });
  panel.on('pageerror', (e) => console.log('PANEL ERROR', e.message)); panel.on('console', (m) => { if (m.type() === 'error') console.log('PANEL CONSOLE', m.text()); });
  await panel.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
  await panel.waitForFunction(() => document.getElementById('h-title').textContent !== 'Looking at this page…', null, { timeout: 8000 }).catch(() => {});
  await panel.waitForTimeout(300);
  return { page, panel };
}
const read = (panel) => panel.evaluate(() => ({
  title: document.getElementById('h-title').textContent,
  tabs: [...document.querySelectorAll('#tabs button')].map((b) => b.textContent),
  chips: [...document.querySelectorAll('#chips button')].map((b) => `${b.textContent}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`),
  rows: [...document.querySelectorAll('.row, .tile')].map((r) => ({ name: r.querySelector('.name')?.textContent || r.getAttribute('aria-label'), pills: [...r.querySelectorAll('.pill')].map((p) => p.textContent), locked: !!r.querySelector('.locked'), on: r.querySelector('.ck')?.getAttribute('aria-checked') })),
  note: document.getElementById('note').hidden ? '' : document.getElementById('note').textContent,
  go: document.getElementById('go-label').textContent, goOff: document.getElementById('go').disabled,
}));
const tab = async (panel, label) => { await panel.locator('#tabs button', { hasText: label }).click(); await panel.waitForTimeout(150); };
const shot = (panel, name) => panel.screenshot({ path: join(OUT, `${name}.png`) });

// 1. The course page: the lesson playing, the lesson list, one locked lesson, and a bonus lesson further down.
{
  const { page, panel } = await panelFor(`${SITE}/course.html`);
  let s = await read(panel); await shot(panel, '1-course-on-screen');
  ok('course: says how many videos', /^\d+ videos on this page$/.test(s.title), s.title);
  ok('course: the playing lesson is first and marked Playing', s.rows[0]?.pills.includes('Playing'), JSON.stringify(s.rows[0]));
  ok('course: the lesson list is there', ['1. Welcome and setup', '2. Your first component', '4. State and events', '5. Lists and keys'].every((n) => s.rows.some((r) => r.name === n)), JSON.stringify(s.rows.map((r) => r.name)));
  ok('course: the locked lesson shows as protected', s.rows.some((r) => r.locked), JSON.stringify(s.rows));
  ok('course: "On screen" leaves out the bonus lesson further down', !s.rows.some((r) => /bonus/.test(r.name || '')) && s.chips.some((c) => c.startsWith('On screen') && c.endsWith('*')), JSON.stringify(s.chips));
  ok('course: the button downloads the chosen ones', /^Download \d+ videos/.test(s.go) && !s.goOff, s.go);
  await panel.locator('#chips button', { hasText: 'Whole page' }).click(); await panel.waitForTimeout(150);
  s = await read(panel); await shot(panel, '1-course-whole-page');
  ok('course: "Whole page" adds the bonus lesson', s.rows.some((r) => /bonus/.test(r.name || '')), JSON.stringify(s.rows.map((r) => r.name)));
  await page.close(); await panel.close();
}
// 2. A stream played from pieces.
{
  const { page, panel } = await panelFor(`${SITE}/stream.html`, 3000);
  const s = await read(panel); await shot(panel, '2-stream');
  ok('stream: the HLS stream is found on the network', s.rows.some((r) => r.pills.includes('HLS')), JSON.stringify(s.rows));
  ok('stream: it is marked as needing the app, with a note', s.rows.some((r) => r.pills.includes('Uses the app')) && /needs? the Omebly Downloader app/.test(s.note), JSON.stringify(s));
  await page.close(); await panel.close();
}
// 3. Photos, audio and files.
{
  const { page, panel } = await panelFor(`${SITE}/media.html`);
  let s = await read(panel);
  ok('media: four tabs with counts', s.tabs.length === 4 && /Images [1-9]/.test(s.tabs[2]) && /Files [1-9]/.test(s.tabs[3]) && /Audio 1/.test(s.tabs[1]), JSON.stringify(s.tabs));
  await tab(panel, 'Images'); s = await read(panel); await shot(panel, '3-images');
  ok('media: big images only by default (3), the icon left out', s.rows.length === 3, JSON.stringify(s.rows));
  const big = await panel.evaluate(() => [...document.querySelectorAll('.tile .dim')].map((d) => d.textContent));
  ok('media: the largest size from srcset is offered (4000 wide)', big.some((d) => d.startsWith('4000')), JSON.stringify(big));
  await tab(panel, 'Files'); s = await read(panel); await shot(panel, '3-files');
  ok('media: the four files are listed', ['Class 10 science notes', 'Maths formula sheet', 'Project template', 'Past papers 2020-2025'].every((n) => s.rows.some((r) => r.name === n)), JSON.stringify(s.rows.map((r) => r.name)));
  await tab(panel, 'Audio'); s = await read(panel);
  ok('media: the audio player is listed', s.rows.length === 1, JSON.stringify(s.rows));
  await page.close(); await panel.close();
}
// 4. A video inside a frame.
{
  const { page, panel } = await panelFor(`${SITE}/frame.html`);
  const s = await read(panel); await shot(panel, '4-frame');
  ok('frame: the video inside the frame is found', s.rows.some((r) => /Garden planning/.test(r.name || '')), JSON.stringify(s.rows));
  await page.close(); await panel.close();
}
// 5. Downloading the chosen files: the panel asks Chrome to save each one, in a folder named after the page.
// (Chrome itself does the saving; under test it is driven by Playwright, so the calls are recorded instead.)
{
  const { page, panel } = await panelFor(`${SITE}/media.html`);
  await tab(panel, 'Files');
  const calls = await panel.evaluate(async () => { const got = []; chrome.downloads.download = async (o) => { got.push(o); return got.length; }; document.getElementById('go').click(); await new Promise((r) => setTimeout(r, 500)); return got; });
  ok('download: all four files are sent to Chrome', calls.length === 4, JSON.stringify(calls));
  ok('download: in a folder named after the page, with their names', calls.every((c) => c.filename.startsWith('Omebly/Resources and photos/')) && calls.some((c) => c.filename.endsWith('Class 10 science notes.pdf')), JSON.stringify(calls.map((c) => c.filename)));
  await page.close(); await panel.close();
}
{
  const { page, panel } = await panelFor(`${SITE}/course.html`);
  const calls = await panel.evaluate(async () => { const got = []; chrome.downloads.download = async (o) => { got.push(o); return got.length; }; document.getElementById('go').click(); await new Promise((r) => setTimeout(r, 500)); return got.map((c) => c.filename); });
  ok('download: course lessons are numbered in page order', calls.length >= 4 && calls[0].includes('/01 ') && calls[1].includes('/02 ') && /Welcome and setup/.test(calls[0]), JSON.stringify(calls));
  await page.close(); await panel.close();
}

if (process.env.REAL) {
  const real = [['youtube-video', 'https://www.youtube.com/watch?v=jNQXAC9IVRw', 6000], ['youtube-playlist', 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', 6000], ['vimeo', 'https://vimeo.com/76979871', 7000], ['wikimedia', 'https://commons.wikimedia.org/wiki/Category:Videos_of_cats', 5000], ['news-pictures', 'https://en.wikipedia.org/wiki/Taj_Mahal', 4000]];
  for (const [name, url, wait] of real) {
    const { page, panel } = await panelFor(url, wait);
    await panel.waitForTimeout(3000); // link checks on big pages can finish after the first view
    const s = await read(panel); await shot(panel, `real-${name}`);
    writeFileSync(join(OUT, `real-${name}.json`), JSON.stringify(s, null, 2));
    console.log(`REAL ${name}: ${s.title} | tabs ${s.tabs.join(', ')} | first: ${s.rows.slice(0, 3).map((r) => r.name).join(' / ')}`);
    await page.close(); await panel.close();
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
await ctx.close(); server.kill();
process.exit(fail ? 1 : 0);
