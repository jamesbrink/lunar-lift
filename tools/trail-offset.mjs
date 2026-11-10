#!/usr/bin/env node
/* Does the smoke column start on the vehicle's axis? Flies to T+100 s under SAS, then at each warp
   reads the newborn trail puffs (under 0.04 s old) out of the pool on rendered frames and prints
   how far they stand off the line through the drawn vehicle along its axis, in metres. A column
   laid a frame late stands off by the planet's spin (409 m/s) times that frame of mission time, so
   the offset grows with warp. Only newborns: older puffs lie on the path through the air, which
   leaves the axis by the angle of attack (5.8 deg there, 80 m/s of sideways drift, measured).

     node tools/trail-offset.mjs [port=8078]        exits 1 if any median is over 5 m */
import { launch, openGame } from './lib/browser.mjs';
const port = process.argv[2] || 8078;
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await openGame(page, port);
let bad = false;
for (const w of [1, 4, 10]) {
  await openGame(page, port);
  await page.evaluate(`game.ignite(); game.setSas(true, false); game.ff(${100 - 1.2 * w}); game.warp(${w})`);
  await page.waitForTimeout(1200);
  const r = await page.evaluate(async () => {
    const P = await import('/js/exhaust-pool.js'), F = await import('/js/physics.js');
    const THREE = await import('three');
    const out = [];
    for (let f = 0; f < 40; f++) {
      await new Promise(r => requestAnimationFrame(r));
      const ax = new THREE.Vector3(0, 0, 1).applyQuaternion(F.S.q), d = new THREE.Vector3();
      for (let i = 0; i < P.NP; i++) {
        if (!P.alive[i] || P.pSmoke[i] !== P.SM_TRAIL || P.pAge[i] > 0.04) continue;
        d.set(P.pPos[3 * i] - F.S.pos.x, P.pPos[3 * i + 1] - F.S.pos.y, P.pPos[3 * i + 2] - F.S.pos.z);
        out.push(d.addScaledVector(ax, -d.dot(ax)).length() * 1000);
      }
    }
    out.sort((a, b) => a - b);
    return { n: out.length, median: out.length ? +out[out.length >> 1].toFixed(1) : null, max: out.length ? +out[out.length - 1].toFixed(1) : null };
  });
  console.log(`x${w}`.padEnd(5), JSON.stringify(r));
  if (r.median === null || r.median > 5) bad = true;
}
await browser.close();
console.log(bad ? 'trail-offset: FAIL' : 'trail-offset: ok');
process.exit(bad ? 1 : 0);
