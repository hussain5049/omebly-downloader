// Step 2 test, end to end in Chrome: the installed app registers itself with the browsers, the extension's Download
// button sends a course page's lessons to it, and the files arrive. The app's download folder is pointed at a test
// folder for the run and put back afterwards.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXE = process.env.EXE || join(ROOT, 'app/src-tauri/target/release/omebly-downloader.exe');
const EXT = join(ROOT, 'extension');
const DATA = join(process.env.LOCALAPPDATA, 'Omebly Downloader');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, info = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' — ' + info}`); c ? pass++ : fail++; };

const server = spawn(process.execPath, [join(ROOT, 'test-site/serve.mjs')], { stdio: 'ignore' });
// Start the app once so it registers with the browsers, then point its folder at a test folder.
try { execFileSync('taskkill', ['/F', '/IM', 'omebly-downloader.exe'], { stdio: 'ignore' }); } catch {}
let app = spawn(EXE, [], { stdio: 'ignore', detached: true }); await sleep(3500);
const settingsFile = join(DATA, 'settings.json');
const before = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : null;
// Put the settings back however the test ends.
const restore = () => { try { if (before) writeFileSync(settingsFile, before); else { const x = JSON.parse(readFileSync(settingsFile, 'utf8')); x.folder = join(process.env.USERPROFILE, 'Downloads', 'Omebly'); writeFileSync(settingsFile, JSON.stringify(x, null, 2)); } } catch { /* nothing to restore */ } };
process.on('exit', restore);
const out = mkdtempSync(join(tmpdir(), 'odl-browser-'));
try { execFileSync('taskkill', ['/F', '/IM', 'omebly-downloader.exe'], { stdio: 'ignore' }); } catch {}
const s = before ? JSON.parse(before) : { connections: 16, at_once: 3 };
writeFileSync(settingsFile, JSON.stringify({ ...s, folder: out }, null, 2));
const reg = execFileSync('reg', ['query', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.omebly.downloader', '/ve']).toString();
ok('the app tells Chrome where it is', /com\.omebly\.downloader\.json/.test(reg), reg);
app = spawn(EXE, [], { stdio: 'ignore', detached: true }); await sleep(3500);

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'odl-chrome-')), {
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: !process.env.HEADED, ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'], viewport: { width: 1280, height: 800 },
});
const cdp = await ctx.browser().newBrowserCDPSession();
const { id } = await cdp.send('Extensions.loadUnpacked', { path: EXT });
ok('the extension has its fixed address', id === 'cjaaiapbiobjhmbhdikahgkokpffpoij', id);
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:4430/course.html'); await sleep(2500);
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/popup.html`);
const tabId = await panel.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.includes('course.html'))?.id);
await panel.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
await panel.waitForFunction(() => document.getElementById('h-title').textContent !== 'Looking at this page…');
await sleep(1500);
const label = await panel.evaluate(() => document.getElementById('go-label').textContent);
ok('the panel knows the app is there', /^Download \d+ videos/.test(label), label);
await panel.click('#go'); await sleep(1500);
const sent = await panel.evaluate(() => document.getElementById('go-label').textContent);
ok('the panel says they were sent to the app', /^Sent \d+ videos to Omebly Downloader$/.test(sent), sent);
let files = [];
for (let i = 0; i < 60 && files.length < 5; i++) { await sleep(1000); try { files = readdirSync(join(out, 'React Basics · Lesson 3')).filter((f) => f.endsWith('.mp4')); } catch { /* not yet */ } }
ok('the lessons arrive in a folder named after the page, numbered in order', files.length === 5 && files.sort()[0].startsWith('01 '), JSON.stringify(files));
await panel.screenshot({ path: join(ROOT, 'tests/out/browser-sent.png') });

await ctx.close(); server.kill();
try { execFileSync('taskkill', ['/F', '/IM', 'omebly-downloader.exe'], { stdio: 'ignore' }); } catch {}
restore();
// The test's downloads leave the real list too.
try { const f = join(DATA, 'downloads.json'); const list = JSON.parse(readFileSync(f, 'utf8')).filter((j) => !j.folder.startsWith(out)); writeFileSync(f, JSON.stringify(list, null, 2)); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
