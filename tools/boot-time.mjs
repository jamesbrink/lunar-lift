#!/usr/bin/env node
/* Boot time: navigation to the first rendered frame, and to the first PAINTED frame (both planets'
   data fields landed and a frame drawn after them). Fresh browser context per run, medians printed.

     node tools/boot-time.mjs [port=8078] [runs=5] [port2]      a second port alternates A/B in one session */
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
const ports = [process.argv[2] || 8078, process.argv[4]].filter(Boolean), runs = +(process.argv[3] || 5);
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
const res = Object.fromEntries(ports.map(p => [p, { first: [], painted: [], longest: [] }]));
for (let k = 0; k < runs; k++) for (const port of ports) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__boot = { first: 0, long: 0 };
    const raf = window.requestAnimationFrame.bind(window); let n = 0, last = 0;
    window.requestAnimationFrame = cb => raf(t => { cb(t); const now = performance.now(); if (++n === 2) window.__boot.first = now; if (last && n > 3) window.__boot.long = Math.max(window.__boot.long, now - last); last = now; });
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.game && window.__boot.first, null, { timeout: 30000 });
  const painted = await page.evaluate(async () => {
    const T = await import('/js/toonmap.js');
    await Promise.all([T.surfaceData('earth'), T.surfaceData('moon'), T.reliefField('earth'), T.reliefField('moon')]);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now();
  });
  await page.waitForTimeout(1500);
  const b = await page.evaluate(() => window.__boot);
  res[port].first.push(b.first); res[port].painted.push(painted); res[port].longest.push(b.long);
  await ctx.close();
}
const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
for (const port of ports) console.log(`port ${port}: first frame ${med(res[port].first).toFixed(0)} ms, painted ${med(res[port].painted).toFixed(0)} ms, longest frame gap after boot ${med(res[port].longest).toFixed(0)} ms   (medians of ${runs}; painted runs: ${res[port].painted.map(v => v.toFixed(0)).join(' ')})`);
await browser.close();
