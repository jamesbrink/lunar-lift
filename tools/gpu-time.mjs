#!/usr/bin/env node
/* GPU time per frame, by EXT_disjoint_timer_query_webgl2 around the whole rAF callback — the only
   honest frame cost here (rAF deltas are vsync; see AGENTS.md). Retina-sized buffer by default.

     node tools/gpu-time.mjs [port=8078] [query-string]      e.g.  node tools/gpu-time.mjs 8078 '?scale=1'

   Stations: pad idle, full throttle at liftoff, 15 km, 500 km orbit, the Moon from 100 km and
   from 10 km. Prints median / p90 ms. */
import { launch, openGame } from './lib/browser.mjs';

const port = process.argv[2] || 8078, qs = process.argv[3] || '';
const browser = await launch();
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
await openGame(page, port, qs);
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
/* the Moon, paused over a sunlit site: nadir from 100 km, and toward the horizon from 10 km */
const moonAt = (alt, pitch) => page.evaluate(async ([alt, pitch]) => {
  const C = await import('/js/constants.js'), T = await import('three'), W = await import('/js/world.js');
  const t = 1000, m = C.moonPos(t, new T.Vector3()), mv = C.moonVel(t, new T.Vector3());
  const up = W.SUN_DIR.clone().setY(0).normalize().applyAxisAngle(new T.Vector3(0, 1, 0), 0.7);
  const put = a => game.teleport(m.clone().addScaledVector(up, C.RM + W.moonGroundHeight(up) + a).toArray(), mv.toArray(), t);
  game.reset(); put(alt + 1); game.stage(); game.stage(); put(alt); game.warp(0); game.setView(0.6, pitch, 0.2);
}, [alt, pitch]);
await moonAt(100, 1.3); await page.waitForTimeout(1500); await measure('moon100');
await moonAt(10, 0.12); await page.waitForTimeout(1500); await measure('moon10');
await browser.close();
