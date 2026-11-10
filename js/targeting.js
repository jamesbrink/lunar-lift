import * as THREE from 'three';
import * as C from './constants.js';
import { S, getState, getSimTime, getEngineOn, getThrottle, gravityAt, orbitalElements, coastDrag } from './physics.js';
import { ATMO_TOP } from './aero.js';
const AIR_R2 = (C.RE + ATMO_TOP) ** 2;

/* Will the trajectory you are on meet the Moon, and how hard?

   This is the readout that the translunar coast otherwise leaves invisible. Nothing in the game
   punishes a 5 km/s pass at the Moon, and the aim is tight: measured with tools/mission-sim.mjs,
   1e-3 rad of launch phase is worth ~130 km of periselene, and periselene sets what LOI and
   the landing cost. You cannot steer toward a number you cannot see, so this propagates the current
   state forward through the same gravity the integrator uses and reports the closest lunar approach.

   It deliberately reproduces the GAME's discretisation rather than the true two-body solution,
   because "what will happen" in this game is its own 0.1 s integration. physStep advances simTime,
   evaluates gravity at the advanced time, then v += a·dt, then p += v·dt; that is what the loop
   below does, at DTPHYS, and from the shipped coast-start state it and a real physStep coast both
   arrive at 345.66 km (run headless in Node). Two alternatives were measured from that same state
   and rejected:
     - converged integration (velocity Verlet at dt 0.1 s: 443.6 km) where the game flies 345.7 km.
       The Moon's position is sampled 0.05 s off the state on every step, which is a coherent
       perturbation, and a lunar flyby amplifies that into ~98 km.
     - a coarser coast step, which is what the mission tool used to take: the game's scheme at
       dt = 1 s predicts an impact 474.5 km under the surface. Ten times cheaper, ~820 km wrong.
   Running the game's own scheme is also what keeps this affordable: one gravityAt per step.

   The propagation is incremental because a multi-day coast is millions of 0.1 s steps and will not
   fit in a frame: `updateAim` spends a fixed step budget per frame and publishes the best so far. A coast
   does not change the answer (the trajectory is the trajectory), so it re-seeds only when something
   has actually pushed the vehicle, when the predicted encounter has been passed, or when the result
   has gone stale.

   CORRIDOR is the band inside which the mission has been flown to a soft touchdown, measured with
   tools/mission-sim.mjs across launch phases (periselene -> result; the table is in
   js/constants.js at MOON_PHASE0): 745 km 2.8 m/s, 477 km 2.8 m/s, 346 km (the window) 3.3 m/s,
   218 km 4.1 m/s, 123 km 4.9 m/s — all WON with 6.6-7.6 t spare — then 110 km and 91 km LOST with
   the tank run down (91 km: 71 m/s). The low edge is a cliff, not a slope, so the band stops at
   the last flight that landed. It is a landing-safety band for that autopilot, not a promise
   about *where* you land: that also depends on when you brake. */

export const CORRIDOR = { lo: 120, hi: 745 };   // 120: the 123 km flight lands, and targeting reads it as 122.0 km

export const aim = { status: 'na', altKm: NaN, tMet: NaN, corridor: false, steps: 0 };

const p = new THREE.Vector3(), u = new THREE.Vector3(), a = new THREE.Vector3(), moon = new THREE.Vector3();
/* Separate scratch for the tests below: p and u are the propagated state, and reuse here would
   silently restart the integration from the live vehicle position on every frame. */
const _q = new THREE.Vector3(), _m = new THREE.Vector3();
const seed = { pos: new THREE.Vector3(), v: new THREE.Vector3(), t: -1e9 };
const DT = C.DTPHYS, HORIZON = 6 * 86400, MAX_STEPS = 7000000, BUDGET = 6000;
let tCur = 0, t0 = 0, steps = 0, bestR = Infinity, bestT = 0, running = false, finished = false, lastStart = -1e9, seedRange = Infinity;

function applicable() {
  if (getState() !== 'flying') return false;
  C.moonPos(getSimTime(), _m);
  if (_q.copy(S.pos).distanceTo(_m) < C.SOI_M) return false;
  const el = orbitalElements(_q, S.v, C.MU_E, C.RE);          // inertial: the transfer is Earth-centred
  return !isFinite(el.ap) || el.ap >= C.MOON_DIST * 0.9;     // otherwise the Moon is not on the list
}

function needsSeed() {
  if (seed.t < 0) return true;
  if (getEngineOn() && getThrottle() > 0.02) return true;    // thrust invalidates the prediction
  /* Only a FINISHED scan can have its encounter pass. While one is still running and the Moon is
     receding, the best range so far is the starting one and bestT sits at t0: tested unconditionally
     this abandoned and re-seeded the scan every 400 ms for as long as the ship moved away from the
     Moon (reviewer: 428 restarts in 3,000 frames, the readout stuck on 'scanning'). */
  if (finished && getSimTime() > bestT) return true;
  /* (A 20 s 'belt and braces' re-seed used to sit here. A coast does not change its own answer, and
     the restart republished 'best so far' ranges on a loop — 92,570 → 170,146 → 139,093 → … — and at
     under ~43 fps never let a scan finish at all.) */
  return false;
}

/* Forget everything. The game calls this on mission reset and on a debug teleport: a prediction of
   the previous vehicle's trajectory must not survive into the new mission, and the module's own
   re-seed rules deliberately do not fire for a state that was replaced rather than flown into. */
export function resetAim() {
  running = false; finished = false; steps = 0; bestR = Infinity; bestT = 0; seedRange = Infinity;
  seed.t = -1e9; aim.status = 'na'; aim.altKm = NaN; aim.tMet = NaN; aim.corridor = false; aim.steps = 0;
}

export function updateAim() {
  if (!applicable()) { aim.status = 'na'; aim.altKm = NaN; running = false; return; }
  if (running && needsSeed()) running = false;               // abandon a prediction under thrust
  if (!running && needsSeed()) {
    if (performance.now() - lastStart < 400) return;         // do not thrash the solver at high warp
    lastStart = performance.now();
    p.copy(S.pos); u.copy(S.v); t0 = getSimTime(); tCur = t0; steps = 0; finished = false;
    bestR = Infinity; bestT = t0;
    C.moonPos(t0, moon); seedRange = p.distanceTo(moon);
    seed.pos.copy(S.pos); seed.v.copy(S.v); seed.t = t0;
    running = true; aim.status = 'running';
  }
  if (!running) return;
  const stop = Math.min(steps + BUDGET, MAX_STEPS);
  for (; steps < stop; steps++) {
    const t = tCur + DT;
    gravityAt(p, a, t);                     // the advanced time, exactly as physStep does it
    /* and the air, while there is any: a coast that starts at a 150 km perigee loses enough to
       drag to move the lunar pass by 227 km (measured against a physStep coast). */
    if (p.lengthSq() < AIR_R2) coastDrag(a, p, u);
    u.addScaledVector(a, DT);
    p.addScaledVector(u, DT);
    C.moonPos(t, moon);
    const rM = p.distanceTo(moon);
    if (rM < bestR) { bestR = rM; bestT = t; }
    /* Past the Moon and clearly leaving, or out of look-ahead: either way the answer is final. */
    if ((steps > 5000 && p.length() > C.MOON_DIST * 1.15 && rM > bestR * 1.5) || t > t0 + HORIZON) { finished = true; break; }
    tCur = t;
  }
  /* Do not publish while the propagation is still in the "best so far" phase before the Moon is in
     sight: the best range then is simply how far away the Moon currently is, which reads as a
     prediction of a 376,000 km miss. Publish once the closest approach so far is genuinely inside
     the lunar region, or once the propagation is complete; until then the HUD says "scanning". */
  const resolved = finished || bestR < 0.5 * seedRange;
  if (resolved) { aim.altKm = bestR - C.RM; aim.tMet = bestT; }
  aim.steps = steps;
  aim.corridor = isFinite(aim.altKm) && aim.altKm >= CORRIDOR.lo && aim.altKm <= CORRIDOR.hi;
  aim.status = finished ? 'done' : 'running';
}
