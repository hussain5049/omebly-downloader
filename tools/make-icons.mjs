// Draws the extension icons (mint rounded square, dark down arrow onto a line) at 16, 32, 48 and 128 px.
import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const MINT = [46, 242, 179], INK = [4, 19, 13];
mkdirSync(new URL('../extension/icons/', import.meta.url), { recursive: true });
for (const S of [16, 32, 48, 128, 1024]) {
  const png = new PNG({ width: S, height: S }), k = 4; // 4x4 samples per pixel for smooth edges
  const r = S * 0.22, sw = Math.max(1.2, S * 0.105);
  const inBox = (x, y) => { const cx = Math.min(Math.max(x, r), S - r), cy = Math.min(Math.max(y, r), S - r); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; };
  const seg = (x, y, x0, y0, x1, y1) => { const dx = x1 - x0, dy = y1 - y0, t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)) <= sw / 2; };
  const u = S / 24; // the 24-unit drawing of the logo: M12 4v11 M7 11l5 5 5-5 M5 20h14
  const inArrow = (x, y) => seg(x, y, 12 * u, 4 * u, 12 * u, 15 * u) || seg(x, y, 7 * u, 11 * u, 12 * u, 16 * u) || seg(x, y, 12 * u, 16 * u, 17 * u, 11 * u) || seg(x, y, 5 * u, 20 * u, 19 * u, 20 * u);
  for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
    let box = 0, ink = 0;
    for (let sy = 0; sy < k; sy++) for (let sx = 0; sx < k; sx++) { const x = px + (sx + 0.5) / k, y = py + (sy + 0.5) / k; if (inBox(x, y)) { box++; if (inArrow(x, y)) ink++; } }
    const a = box / (k * k), t = box ? ink / box : 0, i = (py * S + px) * 4;
    for (let c = 0; c < 3; c++) png.data[i + c] = Math.round(MINT[c] * (1 - t) + INK[c] * t);
    png.data[i + 3] = Math.round(a * 255);
  }
  writeFileSync(new URL(S === 1024 ? '../app/app-icon.png' : `../extension/icons/${S}.png`, import.meta.url), PNG.sync.write(png));
}
console.log('icons written');
