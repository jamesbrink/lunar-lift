#!/usr/bin/env node
/* Is the drawn orbit the orbit the ship is on? Flies the S-2 burn under SAS, reads the trajectory
   ribbon's apoapsis with the engine lit, cuts the engine, reads it again, and compares both with the
   osculating apoapsis of the state vector (what the HUD prints). A ribbon that integrates the burn
   in progress shows a different apoapsis lit and cut.

     node tools/orbit-line.mjs [port=8078]      exits 1 if any of the three differ by more than 2 km */
import { launch, openGame } from './lib/browser.mjs';
const port = process.argv[2] || 8078;
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await openGame(page, port);
const read = () => page.evaluate(async () => {
  const P = await import('/js/predictor.js'), F = await import('/js/physics.js'), C = await import('/js/constants.js');
  P.predict();
  const el = F.orbitalElements(F.S.pos, F.S.v, C.MU_E, C.RE);
  return { ribbonAp: +P.path.apAlt.toFixed(1), stateAp: +el.ap.toFixed(1), points: P.path.n, closed: P.path.closed, impact: P.path.impact };
});
await page.evaluate(`game.ignite(); game.setSas(true, false); game.ff(420)`);
await page.waitForTimeout(600);
const lit = await read();
await page.evaluate(`game.setThrottle(0)`);
await page.waitForTimeout(600);
const cut = await read();
console.log('engine lit', JSON.stringify(lit));
console.log('engine cut', JSON.stringify(cut));
const bad = Math.abs(lit.ribbonAp - lit.stateAp) > 2 || Math.abs(cut.ribbonAp - cut.stateAp) > 2;
await browser.close();
console.log(bad ? 'orbit-line: FAIL' : 'orbit-line: ok');
process.exit(bad ? 1 : 0);
