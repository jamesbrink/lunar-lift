import * as THREE from 'three';
import { VS, SOI_M, moonPos } from './constants.js';
import { getSimTime } from './physics.js';
import { TAIL_Z, LES_TIP_Z, R_S1_SKIRT } from './stations.js';

/* The exhaust's memory: one fixed pool of gas parcels, the frame of the vehicle they leave, and the
   generic `spawnParticle` contract js/physics.js calls. Nothing here integrates or draws —
   js/exhaust-emit.js fills the pool, js/exhaust-sim.js moves it, js/exhaust-draw.js puts it on screen.

   Pool: NP fixed slots, `alive` + an explicit free stack (a full pool recycles a live slot in place)
   — zero allocation per frame and per stage event. Every array is slot-indexed; the draw module keeps
   its own dense mirror, because swap-remove leaves the live SET correct but not contiguous. */
export const NP = 1600;

/* pMode: 0 dead · 1 nozzle exhaust (heat-driven: fire, then smoke or dust) · 2 generic, fixed colour.
   For mode 1, pSmoke is 0 until the parcel has been deflected by ground, then 1. For mode 2 it is the
   KIND of thing the parcel is, and both the integrator and the renderer branch on it:
     0 spark (self-lit, keeps its size) · 1 billowing smoke (entrains where there is air)
     2 staging-seam puff — small, dark · 3 unused
     4 lunar ground spray — pale dust on a ballistic arc · 5 staging-flash core — a light burst, < 0.3 s
     6 ascent trail — the long smoke column a kerosene stage leaves in air; buoyant, rides the wind
     7 steam — deluge water flashed out of the trench at ignition; buoyant, bright */
export const SM_SMOKE = 1, SM_SEAM = 2, SM_SPRAY = 4, SM_FLASH = 5, SM_TRAIL = 6, SM_STEAM = 7;

/* pPos is Float64Array on purpose: lunar coordinates sit ~384,000 km from the origin, where
   Float32 quantises to a ~31 m grid, and a settling dust parcel moves 1.6 cm per substep —
   position += velocity·h rounds back to the SAME stored value every step, so slow parcels
   froze in space while the Moon travelled on at 1.02 km/s (measured: a scorch parcel's ground
   separation grew at exactly the Moon's z-velocity, 376 m/s, with its own relative velocity at
   1 m/s). The GPU mirror stays Float32 and is re-anchored near the vehicle instead — see
   js/exhaust-draw.js. */
export const pPos = new Float64Array(NP * 3);    // world km
export const pVel = new Float32Array(NP * 3);    // inertial km/s
export const pR = new Float32Array(NP);          // parcel radius, metres (drawn size, drag, entrainment)
export const pLife = new Float32Array(NP);       // seconds remaining
export const pAge = new Float32Array(NP);
export const pInv = new Float32Array(NP);        // 1 / life at birth
export const pHeat = new Float32Array(NP);       // 0..1 incandescence; crosses the band thresholds hard
export const pMode = new Uint8Array(NP);
export const pSmoke = new Uint8Array(NP);
export const pMoon = new Uint8Array(NP);         // 1 = inside the Moon's SOI (no drag, lunar gravity, dust)
export const pPal = new Uint8Array(NP);          // mode 1: which propellant made it — 0 kerosene, 1 hydrogen
export const pTh = new Float32Array(NP);         // last good relief sample, km above the sphere
export const pColB = new Float32Array(NP * 3);   // fixed colour of a generic parcel
export const alive = new Int32Array(NP);
export let nAlive = 0;

const freeSlots = new Int32Array(NP);
let nFree = NP;
for (let i = 0; i < NP; i++) freeSlots[i] = NP - 1 - i;   // pops come out in order 0,1,2,…
export function allocSlot() {
  if (nFree > 0) { alive[nAlive++] = freeSlots[--nFree]; return alive[nAlive - 1]; }
  return alive[(Math.random() * nAlive) | 0];
}
export function killSlot(k) {
  const i = alive[k]; pMode[i] = 0;
  alive[k] = alive[--nAlive];
  freeSlots[nFree++] = i;
}
export function resetPool() {
  nAlive = 0;
  nFree = NP; for (let i = 0; i < NP; i++) freeSlots[i] = i;
}

/* Remove every live generic parcel of one kind (see pSmoke above). */
export function killKind(kind) {
  for (let k = nAlive - 1; k >= 0; k--) { const i = alive[k]; if (pMode[i] === 2 && pSmoke[i] === kind) killSlot(k); }
}

/* Live frame of the vehicle, written each frame by js/vehicle.js. The integrator collides parcels with
   the hull, the lunar ejecta scales with the engine's height, and the draw call is anchored here. */
export const ship = {
  pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(), quatI: new THREE.Quaternion(),
  hullR: R_S1_SKIRT * VS, tailZ: TAIL_Z[0] + 2, topZ: LES_TIP_Z, live: false,
};

/* The Moon at the current mission time. The integrator refreshes both once per frame; the spawners
   refresh the position themselves, because ff() moves the clock without a frame in between. */
export const moonP = new THREE.Vector3(), moonV = new THREE.Vector3();
export const SOI2 = SOI_M * SOI_M;

/* Every silent failure class the exhaust has had, counted by name so "the exhaust looks wrong" arrives
   with a cause: non-finite parcel state, NaN heights, a bell index nobody
   built, live parcels about to draw at zero size. */
export const plumeDebug = { causeNaN: 0, causeHeight: 0, causeBell: 0, zeroSize: 0 };

/* Generic particle — the contract js/physics.js calls for staging puffs and the explosion. Same pool,
   same gravity, same colliders (debris sparks bounce off the pad too), but it keeps the exact colour
   it was handed and skips the heat machinery. `size0` is metres; `smoke` is one of the kinds above. */
export function spawnParticle(pos, vel, life, color, size0 = 3.5, smoke = 0) {
  const i = allocSlot(), i3 = i * 3;
  pMode[i] = 2; pSmoke[i] = smoke;
  moonPos(getSimTime(), moonP);
  const dx = pos.x - moonP.x, dy = pos.y - moonP.y, dz = pos.z - moonP.z;
  pMoon[i] = dx * dx + dy * dy + dz * dz < SOI2 ? 1 : 0;
  pPos[i3] = pos.x; pPos[i3 + 1] = pos.y; pPos[i3 + 2] = pos.z;
  pVel[i3] = vel.x; pVel[i3 + 1] = vel.y; pVel[i3 + 2] = vel.z;
  pColB[i3] = color[0]; pColB[i3 + 1] = color[1]; pColB[i3 + 2] = color[2];
  pR[i] = size0; pHeat[i] = 0; pAge[i] = 0; pLife[i] = life; pInv[i] = 1 / Math.max(0.05, life);
  pTh[i] = 0;
  return i;
}

/* Is a mode-1 parcel drawn as smoke or dust rather than fire? One rule, shared by the renderer and the
   census below so the counts describe pixels. Deflected flow is smoke once it has mixed at all — 20 ms
   — unless it is still above the incandescent threshold. */
export const isSmoke = (i) => pHeat[i] <= 0.22 || (pSmoke[i] === 1 && pAge[i] > 0.02 && pHeat[i] < 0.75);

/* Lunar-spray census for the harness: per-live-parcel radius and distance from `ref` (km). */
export function sprayCensus(ref, code = SM_SPRAY) {
  const out = [];
  for (let k = 0; k < nAlive; k++) {
    const i = alive[k];
    if (pMode[i] !== 2 || pSmoke[i] !== code) continue;
    const i3 = i * 3;
    const a = pPos[i3] - ref.x, b = pPos[i3 + 1] - ref.y, c = pPos[i3 + 2] - ref.z;
    out.push({ r: pR[i], d: Math.sqrt(a * a + b * b + c * c), age: pAge[i], life: pAge[i] + pLife[i] });
  }
  return out;
}

/* Live-parcel census: what is alive, by the class it is drawn as. `ref` (km) + `nearKm` add a second
   count restricted to that radius. Read-only; nothing in the game calls it. */
export function parcelAudit(ref = null, nearKm = 0.5) {
  const out = { live: nAlive, m1hot75: 0, m1hot50: 0, m1hot22: 0, m1smoke: 0, m2spark: 0, m2smoke: 0,
    seam: 0, spray: 0, flash: 0, trail: 0, steam: 0, moonM1: 0, nearHot22: 0, nearLive: 0 };
  const n2 = nearKm * nearKm;
  for (let k = 0; k < nAlive; k++) {
    const i = alive[k], i3 = i * 3;
    const q = pHeat[i];
    if (pMode[i] === 1) {
      if (pMoon[i]) out.moonM1++;
      if (isSmoke(i)) out.m1smoke++; else {
        if (q > 0.75) out.m1hot75++;
        if (q > 0.5) out.m1hot50++;
        if (q > 0.22) out.m1hot22++;
      }
    } else if (pSmoke[i] === SM_SEAM) out.seam++;
    else if (pSmoke[i] === SM_SPRAY) out.spray++;
    else if (pSmoke[i] === SM_FLASH) out.flash++;
    else if (pSmoke[i] === SM_TRAIL) out.trail++;
    else if (pSmoke[i] === SM_STEAM) out.steam++;
    else if (pSmoke[i]) out.m2smoke++;
    else out.m2spark++;
    if (ref) {
      const dx = pPos[i3] - ref.x, dy = pPos[i3 + 1] - ref.y, dz = pPos[i3 + 2] - ref.z;
      if (dx * dx + dy * dy + dz * dz < n2) {
        out.nearLive++;
        if (pMode[i] === 1 && !isSmoke(i)) out.nearHot22++;
      }
    }
  }
  return out;
}
