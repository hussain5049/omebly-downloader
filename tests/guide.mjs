// The one-time extension guide: it shows the extension folder, and turns to "Connected" as soon as the extension
// says hello to the app (sent here the way Chrome starts the app). Runs a separate copy of the app (never the real one).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXE = join(ROOT, 'app/src-tauri/target', process.env.RELEASE ? 'release' : 'debug', 'omebly-downloader.exe');
const ID = 'cjaaiapbiobjhmbhdikahgkokpffpoij';
const data = mkdtempSync(join(tmpdir(), 'odl-guide-'));
const env = { ...process.env, OMEBLY_DATA_DIR: data, OMEBLY_DOWNLOADS: data, WEBVIEW2_USER_DATA_FOLDER: join(data, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9334' };
let pass = 0, fail = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); ok ? pass++ : fail++; };

const app = spawn(EXE, [], { env, stdio: 'ignore' });
let cdp = null;
for (let i = 0; i < 40 && !cdp; i++) { await new Promise((r) => setTimeout(r, 500)); cdp = await chromium.connectOverCDP('http://127.0.0.1:9334').catch(() => null); }
const page = cdp.contexts()[0].pages()[0];
await page.waitForFunction(() => typeof openGuide === 'function');
await page.evaluate(() => openGuide());
await page.waitForSelector('#ext[open]');
const folder = await page.textContent('#ext-folder');
check(/[\\/]extension$/.test(folder), `guide: shows the extension folder (${folder})`);
check((await page.textContent('#ext-state')).startsWith('Waiting'), 'guide: waits while the extension is not added');
mkdirSync(join(ROOT, 'tests/out'), { recursive: true });
await page.screenshot({ path: join(ROOT, 'tests/out/guide.png') });

// The extension says hello, as it does right after "Load unpacked".
await new Promise((res) => { const p = spawn(EXE, [`chrome-extension://${ID}/`], { env, stdio: ['pipe', 'ignore', 'ignore'] }); const b = Buffer.from(JSON.stringify({ type: 'hello' })), h = Buffer.alloc(4); h.writeUInt32LE(b.length); p.stdin.end(Buffer.concat([h, b])); p.on('exit', res); });
const ok = await page.waitForFunction(() => document.querySelector('#ext-state')?.classList.contains('ok'), null, { timeout: 8000 }).then(() => true).catch(() => false);
check(ok, 'guide: turns to Connected after the extension says hello');
await page.screenshot({ path: join(ROOT, 'tests/out/guide-connected.png') });

await cdp.close().catch(() => {});
app.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
