#!/usr/bin/env node
/* Screenshot + console harness: flies the first eleven minutes through window.game and photographs
   the stations a reviewer looks at. Prints every console error AND warning (a dead ShaderMaterial
   logs exactly one console.error, see agents.md) and rAF frame times (vsync-bound: a regression
   detector, not a GPU cost).

     npm i --no-save three@0.187.0 playwright
     node server.js 8078 &
     node tools/shots.mjs <outdir> [port=8078] [only=01,04,...]

   Exits 1 if the console printed any error or warning. Chromium: see tools/lib/browser.mjs. */
import { mkdirSync } from 'node:fs';
import { launch, openGame } from './lib/browser.mjs';

const out = process.argv[2] || 'shots', port = process.argv[3] || 8078;
const only = process.argv[4] ? process.argv[4].split(',') : null;
mkdirSync(out, { recursive: true });

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const msgs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') msgs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on('pageerror', e => msgs.push('PAGEERR ' + e.message));
await openGame(page, port);

const wait = ms => page.waitForTimeout(ms);
const shot = async n => {
  if (only && !only.some(o => n.startsWith(o))) return;
  await wait(900); await page.screenshot({ path: `${out}/${n}.png` });
};
const ft = () => page.evaluate(() => new Promise(res => {
  const d = []; let l = performance.now();
  const f = () => { const n = performance.now(); d.push(n - l); l = n;
    d.length < 90 ? requestAnimationFrame(f) : (d.sort((a, b) => a - b), res({ med: +d[45].toFixed(1), p90: +d[81].toFixed(1) })); };
  requestAnimationFrame(f);
}));
const ev = src => page.evaluate(src);

await wait(2500); await shot('01-pad');
console.log('pad      ', await ft());
await ev(`game.ignite(); game.setSas(true, false)`);
await wait(6000); await shot('02-liftoff');
console.log('liftoff  ', await ft());
await ev(`game.ff(25)`); await shot('03-t35');
await ev(`game.ff(40)`); await shot('04-t75');
await ev(`game.ff(60)`); await shot('05-t135');
console.log('t135     ', await ft());
await ev(`game.ff(120)`); await shot('06-t255');
await ev(`game.ff(400)`); await shot('07-orbit');
console.log('orbit    ', await ft());
await page.keyboard.press('c'); await shot('08-chase');
await page.keyboard.press('c'); await ev(`game.reset()`); await shot('09-reset'); await ev(`game.ignite(); game.setSas(true, false); game.ff(700); game.stage(); game.ignite(); game.setThrottle(1); game.ff(380); game.setThrottle(0)`);
await page.keyboard.press('m'); await shot('10-map');
await page.keyboard.press('m');
console.log('state    ', await ev(`JSON.stringify((s => ({ t: s.simTime | 0, altE: s.altE | 0, speed: +s.speed.toFixed(3) }))(game.state()))`));
console.log(msgs.length ? `console (${msgs.length}):\n  ` + [...new Set(msgs)].slice(0, 12).join('\n  ') : 'console: clean');
await browser.close();
process.exit(msgs.length ? 1 : 0);        // a console error or warning fails the run
