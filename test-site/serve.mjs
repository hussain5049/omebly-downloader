// A small local website for testing the extension: a course page, a stream page, a page of pictures and files,
// and a page with a video inside a frame. Runs on 127.0.0.1 only.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const port = +(process.env.PORT || 4430);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.jpg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf', '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
createServer(async (req, res) => {
  let path; try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (path.includes('..')) { res.writeHead(400).end(); return; }
  const file = normalize(join(root, path.endsWith('/') ? path + 'index.html' : path));
  if (!file.startsWith(root)) { res.writeHead(400).end(); return; }
  try {
    const st = await stat(file), type = TYPES[extname(file)] || 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range && st.size) {
      const a = range[1] ? +range[1] : 0, b = range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
      const body = (await readFile(file)).subarray(a, b + 1);
      res.writeHead(206, { 'content-type': type, 'content-length': body.length, 'content-range': `bytes ${a}-${b}/${st.size}`, 'accept-ranges': 'bytes' });
      res.end(req.method === 'HEAD' ? undefined : body); return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(await readFile(file));
  } catch { res.writeHead(404).end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`test site on http://127.0.0.1:${port}/`));
