#!/usr/bin/env node
/* The lunar crater ladder (js/mooncraters.js) in numbers: how many craters each relief octave
   holds, the range and cost of craterHeight, and a continuity check — the largest height step
   between points 2 m apart along 4,000 random 2 km tracks. A crater cut off along a lattice plane
   (a reject box tighter than the crater's reach) shows up here as a step of tens of metres.

     node tools/crater-stats.mjs        exits 1 if any 2 m step exceeds 8 m */
import { listCraters, craterHeight, CRATER_CELLS } from '../js/mooncraters.js';
for (let k = 0; k < 3; k++) {
  const L = listCraters(k);
  console.log(`octave ${CRATER_CELLS[k]} km: ${L.length} craters, r ${Math.min(...L.map(c => c.r)).toFixed(1)}-${Math.max(...L.map(c => c.r)).toFixed(1)} km, rayed ${L.filter(c => c.rays).length}`);
}
let mn = 1e9, mx = -1e9; const N = 200000, t = performance.now();
for (let i = 0; i < N; i++) {
  const z = 1 - 2 * (i + 0.5) / N, r = Math.sqrt(1 - z * z), a = i * 2.399963;
  const h = craterHeight(r * Math.cos(a), z, r * Math.sin(a), 1, 0);
  if (h < mn) mn = h; if (h > mx) mx = h;
}
console.log(`craterHeight: ${((performance.now() - t) / N * 1000).toFixed(2)} us/call, range ${mn.toFixed(2)} .. ${mx.toFixed(2)} km over ${N} directions`);
let seed = 12345; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
let worst = 0;
for (let k = 0; k < 4000; k++) {
  const z = 2 * rnd() - 1, a = rnd() * 6.2831853, r = Math.sqrt(1 - z * z);
  const x = r * Math.cos(a), y = z, zz = r * Math.sin(a);
  const b = rnd() * 6.2831853, tx = -Math.sin(a) * Math.cos(b) - z * Math.cos(a) * Math.sin(b), ty = r * Math.sin(b), tz = Math.cos(a) * Math.cos(b) - z * Math.sin(a) * Math.sin(b);
  let prev = craterHeight(x, y, zz, 1, 0);
  for (let s = 1; s <= 1000; s++) {
    const d = s * 0.002 / 1737.4, px = x + tx * d, py = y + ty * d, pz = zz + tz * d, l = Math.hypot(px, py, pz);
    const h = craterHeight(px / l, py / l, pz / l, 1, 0);
    if (Math.abs(h - prev) > worst) worst = Math.abs(h - prev);
    prev = h;
  }
}
console.log(`largest step between points 2 m apart, 4,000 tracks of 2 km: ${(worst * 1000).toFixed(2)} m`);
process.exit(worst * 1000 > 8 ? 1 : 0);
