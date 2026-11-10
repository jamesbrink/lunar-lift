#!/usr/bin/env node
/* GPU time per frame, by EXT_disjoint_timer_query_webgl2 around the whole rAF callback — the only
   honest frame cost here (rAF deltas are vsync; see agents.md). Retina-sized buffer by default.

     node tools/gpu-time.mjs [port=8078] [query-string]      e.g.  node tools/gpu-time.mjs 8078 '?logdepth=0'

   Stations: pad idle, full throttle at liftoff, 15 km, 500 km orbit. Prints median / p90 ms. */
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

const port = process.argv[2] || 8078, qs = process.argv[3] || '';
function findChrome() {
  if (process.env.EXE) return process.env.EXE;
  const cache = `${homedir()}/Library/Caches/ms-playwright`;
  if (!existsSync(cache)) return undefined;
  for (const d of readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).sort().reverse()) {
    const p = `${cache}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    if (existsSync(p)) return p;
  }
}
const browser = await chromium.launch({ headless: true, executablePath: findChrome(),
  args: ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.addInitScript(() => {
  const raf = window.requestAnimationFrame.bind(window);
  window.__gpu = { samples: [], on: false };
  let gl = null, ext = null; const pending = [];
  window.requestAnimationFrame = cb => raf(t => {
    if (!gl) { const c = document.getElementById('gl'); gl = c && c.getContext('webgl2'); ext = gl && gl.getExtension('EXT_disjoint_timer_query_webgl2'); window.__gpu.ext = !!ext; }
    let q = null;
    if (ext && window.__gpu.on) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    cb(t);
    if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(q); }
    while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const p = pending.shift();
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) window.__gpu.samples.push(gl.getQueryParameter(p, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(p);
    }
  });
});
await page.goto(`http://127.0.0.1:${port}/index.html${qs}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.game, null, { timeout: 20000 });
await page.waitForTimeout(2500);
const measure = async name => {
  await page.evaluate(() => { window.__gpu.samples.length = 0; window.__gpu.on = true; });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => { window.__gpu.on = false; const d = window.__gpu.samples.slice().sort((a, b) => a - b);
    return { ext: window.__gpu.ext, n: d.length, med: d.length ? +d[d.length >> 1].toFixed(2) : null, p90: d.length ? +d[Math.floor(d.length * 0.9)].toFixed(2) : null }; });
  console.log(name.padEnd(10), JSON.stringify(r));
};
await measure('pad');
await page.evaluate(() => { game.ignite(); game.setSas(true, false); });
await page.waitForTimeout(5000); await measure('liftoff');
await page.evaluate(() => game.ff(65)); await page.waitForTimeout(800); await measure('15km');
await page.evaluate(() => game.ff(580)); await page.waitForTimeout(3000); await measure('orbit');
await browser.close();
