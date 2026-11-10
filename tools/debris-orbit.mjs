#!/usr/bin/env node
/* Does a stage dropped in orbit stay in orbit? Puts the stack in a 300 km circular orbit, drops a
   stage, runs most of a revolution at x1000 and compares the stage's altitude and its distance from
   the ship with where they started. A dropped stage is a body on its own orbit 3 m/s from the
   ship's: it must still be up there, a few kilometres away.

     node tools/debris-orbit.mjs [port=8078]     exits 1 if the stage is gone, below 250 km or over 200 km away */
import { launch, openGame } from './lib/browser.mjs';
const port = process.argv[2] || 8078;
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await openGame(page, port);
const read = () => page.evaluate(async () => {
  const V = await import('/js/vehicle.js'), P = await import('/js/physics.js'), C = await import('/js/constants.js');
  const d = V.debris[V.debris.length - 1];
  return { t: Math.round(P.getSimTime()), ship_km: +(P.S.pos.length() - C.RE).toFixed(1), pieces: V.debris.length,
    stage_km: d ? +(d.mesh.position.length() - C.RE).toFixed(1) : null, apart_km: d ? +d.mesh.position.distanceTo(P.S.pos).toFixed(2) : null };
});
await page.evaluate(async () => {
  const C = await import('/js/constants.js');
  game.ignite(); game.ff(5); game.stage();
  const r = C.RE + 300, v = Math.sqrt(C.MU_E / r);
  game.teleport([r, 0, 0], [0, 0, -v], 1000); game.setThrottle(0);
});
await page.waitForTimeout(500);
await page.evaluate(`game.stage(); game.setThrottle(0)`);
await page.waitForTimeout(1500);
const a = await read();
await page.evaluate(`game.warp(1000)`);
await page.waitForTimeout(4000);
await page.evaluate(`game.warp(1)`);
const b = await read();
console.log('after separation', JSON.stringify(a));
console.log('later           ', JSON.stringify(b));
const bad = b.stage_km === null || b.stage_km < 250 || b.apart_km > 200 || b.t - a.t < 1500;
await browser.close();
console.log(bad ? 'debris-orbit: FAIL' : 'debris-orbit: ok');
process.exit(bad ? 1 : 0);
