import * as THREE from 'three';
import { RM, VS, moonPos } from './constants.js';
import { setGear, GEAR } from './saturn.js';
import { S, getState, getSimTime, activeStage, navVel, landing } from './physics.js';
import { moonGroundHeight } from './world.js';

/* When the landing gear is down. The legs themselves are js/saturn.js's (setGear poses them); this
   reads the flight and decides, once per drawn frame.

   Down: the lander (the last stage, alone) within GEAR_ALT of the Moon and descending, or standing
   on it. Up again only if it climbs back out past GEAR_UP, or a new mission starts. The travel
   takes GEAR_TIME seconds OF THE MISSION CLOCK — the picture is drawn from an interpolated state
   and can be paused, so a frame counter would keep the legs moving in a still frame, and at ×50
   they would crawl. A clock that jumps (reset, teleport, ff) puts them where they belong at once.

   Standing, each foot finds its own ground: the contact js/physics.js scores is one point under
   the axis, the feet are 8 m out from it, and the Moon is not flat. The leg angle is trimmed so
   the pad sits on moonGroundHeight() — the same function the drawn patch is built from. */
const GEAR_ALT = 15, GEAR_UP = 20, GEAR_TIME = 2, TRIM_MAX = 0.3;
let gear = 0, tPrev = null, down = false, trimFor = -1;
const trim = [0, 0, 0, 0];
const _m = new THREE.Vector3(), _r = new THREE.Vector3(), _v = new THREE.Vector3(), _f = new THREE.Vector3();

/* For a harness: hold the gear at 0..1, or hand it back to the flight with null. */
let forced = null;
export function forceGear(v) { forced = v; }

export function updateGear() {
  if (forced !== null) { setGear(forced); return; }
  const t = getSimTime(), state = getState();
  const lander = activeStage() === 2;
  moonPos(t, _m); _r.subVectors(S.pos, _m);
  const alt = _r.length() - RM;
  const landed = state === 'won' && !landing.home;
  if (!lander || alt > GEAR_UP || state === 'pad' || state === 'lost') down = false;
  else if (landed || (alt < GEAR_ALT && navVel(_v).dot(_r) < 0)) down = true;

  const dt = tPrev === null ? Infinity : t - tPrev; tPrev = t;
  const want = down ? 1 : 0;
  if (dt < 0 || dt > 3 * GEAR_TIME) gear = want;                      // the clock jumped
  else gear = THREE.MathUtils.clamp(gear + (down ? dt : -dt) / GEAR_TIME, 0, 1);

  if (landed && trimFor !== landing.time) {
    trimFor = landing.time;
    GEAR.feet.forEach(([x, y, z], k) => {
      _f.set(x, y, z).multiplyScalar(VS).applyQuaternion(S.q).add(S.pos).sub(_m);
      const gap = (_f.length() - RM - (moonGroundHeight(_f) || 0)) / VS;          // u the nominal foot stands above its ground
      trim[k] = THREE.MathUtils.clamp(gap / GEAR.perRad, -TRIM_MAX, TRIM_MAX);
    });
  }
  if (!landed) trimFor = -1;
  setGear(gear, landed ? trim : null);
}
