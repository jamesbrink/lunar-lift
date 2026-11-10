import * as THREE from 'three';
import * as C from './constants.js';
import { ATMO_TOP } from './aero.js';
import { S, getState, getSimTime, getEngineOn, getThrottle, gravityAt, orbitalElements, coastDrag } from './physics.js';

/* Will the trajectory you are on meet the Moon, and how close?

   The translunar aim is tight — measured with tools/mission-sim.mjs, 1e-3 rad of launch phase is
   worth ~130 km of periselene — and periselene sets what capture and the landing cost. You cannot
   steer toward a number you cannot see, so this predicts the closest lunar approach of the coast
   from the present state, continuously, and says which way a trim burn would move it.

   CORRIDOR is the band of periselene the mission has been flown to a soft touchdown in (a sweep of
   launch phases with the tool's autopilot): everything from 745 km down to 123 km landed at
   2.6-4.9 m/s; 110 km and 91 km ran the tank dry. The low edge is a cliff, not a slope. It is a
   landing-safety band for that autopilot, not a promise about where you land. */

export const CORRIDOR = { lo: 120, hi: 745 };   // 120: the 123 km flight lands, and targeting reads it as 121.3 km

export const aim = { status: 'na', altKm: NaN, tMet: NaN, corridor: false, steps: 0, trim: 0 };

/* THE PREDICTOR. It used to replay the game's own scheme — 0.1 s steps, 5 million of them for a
   translunar coast, a fixed budget per frame — which took 6-14 s to answer, went blank whenever the
   engine burned, and left a player to cut a 13-minute injection burn blind.

   The game's step (v += a·dt, then p += v·dt) is the leapfrog scheme with its velocity written half
   a step late: the state (p, v) the game holds evolves, to second order, like a true trajectory
   started from p with velocity v + a(p)·dt/2. So a velocity-Verlet integration from THAT state,
   with a step that follows the local radius (1/1000 of it per step, 0.5-300 s), lands on the game's
   own future: measured from the certified coast start, 344.87 km against the game scheme's 345.66
   (and 442.74 without the half-step term — the ~100 km 'Verlet disagrees with the game' of earlier
   notes was exactly that term). It costs about a millisecond, so it runs four times a second, with
   the engine lit or not: while burning, the figure is the pass you would get by cutting now. */
const p = new THREE.Vector3(), u = new THREE.Vector3(), a = new THREE.Vector3(), moon = new THREE.Vector3(), _q = new THREE.Vector3(), _m = new THREE.Vector3();
const AIR_R = C.RE + ATMO_TOP;
export function lunarPass(pos, vel, t0, out) {
  p.copy(pos); u.copy(vel);
  let t = t0, best = Infinity, bestT = t0, hit = false;
  gravityAt(p, a, t); if (p.length() < AIR_R) coastDrag(a, p, u);
  u.addScaledVector(a, C.DTPHYS / 2);                       // the game's velocity is half a step behind
  for (let n = 0; n < 60000; n++) {
    C.moonPos(t, moon);
    const rE = p.length(), rM = p.distanceTo(moon);
    if (rM < best) { best = rM; bestT = t; }
    else if (n > 200 && rM > best * 1.5 && rE > C.MOON_DIST * 0.5) break;      // past the Moon and leaving
    if (rM < C.RM) { hit = true; break; }
    if (rE < C.RE || t - t0 > 8 * 86400 || rE > 1.5e6) break;
    const dt = Math.min(Math.max(0.001 * Math.min(rE, rM) / Math.max(u.length(), 1e-3), 0.5), 300);
    u.addScaledVector(a, dt / 2); p.addScaledVector(u, dt); t += dt;
    gravityAt(p, a, t); if (rE < AIR_R) coastDrag(a, p, u);
    u.addScaledVector(a, dt / 2);
  }
  out.alt = hit ? -1 : best - C.RM; out.t = bestT;
  return out;
}

/* Guidance cutoff. At full CSM thrust the lunar pass moves through the whole 625 km corridor in
   about a tenth of a second of burn: no hand can cut on it. With SAS on (prograde), js/physics.js
   asks this every step of an injection burn and shuts the engine down when the pass is inside the
   corridor with 60 km in hand — what an Apollo guidance computer did. With SAS off the cut is the
   pilot's, and the trim burn afterwards is how it is repaired. Evaluated every step once the pass is
   within 30,000 km, every tenth step before that. */
let guardN = 0, guardLast = Infinity;
const _g = { alt: 0, t: 0 };
export function cutoffNow() {
  if (guardLast > 30000 && (guardN++ % 10)) return false;
  C.moonPos(getSimTime(), _m);
  const el = orbitalElements(S.pos, S.v, C.MU_E, C.RE);
  if (isFinite(el.ap) && el.ap < C.MOON_DIST * 0.9) { guardLast = Infinity; return false; }
  guardLast = lunarPass(S.pos, S.v, getSimTime(), _g).alt;
  if (guardLast < 0) guardLast = 0;
  return _g.alt >= CORRIDOR.lo + 60 && _g.alt <= CORRIDOR.hi - 60;
}

function applicable() {
  if (getState() !== 'flying') return false;
  C.moonPos(getSimTime(), _m);
  if (_q.copy(S.pos).distanceTo(_m) < C.SOI_M) return false;
  const el = orbitalElements(_q, S.v, C.MU_E, C.RE);          // inertial: the transfer is Earth-centred
  return !isFinite(el.ap) || el.ap >= C.MOON_DIST * 0.9;     // otherwise the Moon is not on the list
}

export function resetAim() { aim.status = 'na'; aim.altKm = NaN; aim.tMet = NaN; aim.corridor = false; aim.trim = 0; last = -1e9; }

/* aim.trim: metres per second of prograde (+) or retrograde (−) burn that would bring the pass to
   the middle of the corridor, from the slope of the pass against a 1 m/s nudge either way; 0 when
   on course or when a small trim cannot do it. */
let last = -1e9;
const _r = { alt: 0, t: 0 }, _vp = new THREE.Vector3(), _dir = new THREE.Vector3();
export function updateAim() {
  if (!applicable()) { if (aim.status !== 'na') resetAim(); return; }
  const now = performance.now();
  if (now - last < 250) return;
  last = now;
  lunarPass(S.pos, S.v, getSimTime(), _r);
  aim.altKm = _r.alt; aim.tMet = _r.t; aim.steps++;
  aim.corridor = aim.altKm >= CORRIDOR.lo && aim.altKm <= CORRIDOR.hi;
  aim.status = getEngineOn() && getThrottle() > 0.02 ? 'burning' : 'done';
  aim.trim = 0;
  if (!aim.corridor && aim.altKm < 60000) {
    _dir.copy(S.v).normalize();
    const up = lunarPass(S.pos, _vp.copy(S.v).addScaledVector(_dir, 0.001), getSimTime(), { alt: 0, t: 0 }).alt;
    const dn = lunarPass(S.pos, _vp.copy(S.v).addScaledVector(_dir, -0.001), getSimTime(), { alt: 0, t: 0 }).alt;
    const here = aim.altKm < 0 ? 0 : aim.altKm, slope = ((up < 0 ? 0 : up) - (dn < 0 ? 0 : dn)) / 2;      // km of pass per m/s
    const want = (CORRIDOR.lo + CORRIDOR.hi) / 2 - here;
    if (Math.abs(slope) > 1) aim.trim = THREE.MathUtils.clamp(want / slope, -60, 60);
  }
}
