import * as THREE from 'three';
import { RE, VS, PAD_UP, PAD_EAST, EARTH_SPIN } from './constants.js';
import { TAIL_Z, SIVB_TOP_Z, R_STACK, R_SIVB, R_SM } from './stations.js';

/* What the vehicle can run into at the launch complex. Display-free (the headless mission harness
   flies through it), and the ONE table of these shapes: js/pad.js draws the swing arms from ARMS
   below, so what is drawn and what is solid cannot drift apart.

   Everything is an axis-aligned box in the pad's own frame — build units (1 u = 1.4 m), x east,
   y north, z up, origin on the vehicle's axis at ground level; js/world.js welds that frame to
   the spinning Earth. [name, cx, cy, cz, half-x, half-y, half-z] */
export const TOWER_X = -21, TOWER_W = 9, ARM_FROM = TOWER_X + TOWER_W / 2;
/* Swing arms: [z, hull radius they serve, width]. Each stops 0.9 u short of the hull it faces. */
export const ARMS = [[14, 3.6, 1.6], [30, 3.6, 1.6], [48, 3.6, 1.5], [61, 2.4, 1.4], [68.5, 1.4, 1.2]];
export const ARM_SWING = 1.75;               // rad each arm turns about the tower face to clear the stack
/* s from ignition to fully retracted. Short on purpose: this vehicle leaves the pad the instant
   it is lit (pad thrust-to-weight 1.37, no hold-down build-up), and the narrow upper stages have to
   be out of the crew arm's reach before the 2.4 u S-IVB shoulder gets there, 5.5 u up — 2.1 s after
   ignition. Apollo's arms took 2-5 s, against a vehicle that was held down for 8.9 s first. */
export const ARM_TIME = 1.5;

const FIXED = [
  ['THE LAUNCH TOWER', TOWER_X, 0, 46, 5.6, 5.6, 50],
  ['THE TOWER CRANE', TOWER_X, 3, 96.6, 0.9, 17, 1.1],
  ['THE TOWER CRANE', TOWER_X, -12, 96.2, 1.6, 2.5, 1.5],
  ['A TAIL SERVICE MAST', -11, 11, 4.3, 1.1, 1.1, 3.5],
  ['A TAIL SERVICE MAST', -11, -11, 4.3, 1.1, 1.1, 3.5],
  ['THE FLOODLIGHT RIG', 0, -34, 10.5, 1.2, 1.2, 12.5],
  ['THE FLOODLIGHT RIG', 0, -34, 23, 15, 1, 1],
  ['A LIGHTNING MAST', 34, 26, 50, 0.7, 0.7, 51],
  ['A LIGHTNING MAST', -34, 26, 50, 0.7, 0.7, 51],
  ['THE LOX SPHERE', 42, 32, 8.8, 6.5, 6.5, 6.5],
  ['THE HYDROGEN SPHERE', 60, 44, 7.7, 5.4, 5.4, 5.4],
  ['THE KEROSENE TANKS', 61.2, 28, 3.3, 7.6, 6, 2.2],
  ['THE WATER TOWER', 120, -150, 32, 8, 8, 36],
];
/* The big solids of the rest of the Cape (js/cape.js draws them from js/padsite.js SITE; these are
   the same footprints in this file's units: km / 0.0014). Exported for the camera, which must not
   end up inside one either. */
export const CAPE_SOLIDS = [
  ['THE VEHICLE ASSEMBLY BUILDING', -3985.7, 0, 60, 56.4, 77.9, 64],
  ['THE VEHICLE ASSEMBLY BUILDING', -3985.7, -124.6, 22, 29.8, 48.2, 26],          // its low bay
  ['THE LAUNCH CONTROL CENTRE', -3857.1, -153.6, 7, 19.6, 41.1, 9.5],
  ['A MOBILE LAUNCHER', -3728.6, 150, 4, 17.5, 14.6, 6.2],
  ['A MOBILE LAUNCHER', -3737.1, 150, 50, 4.7, 4.7, 46],
  ['THE CRAWLER', -3771.4, 0, 2.5, 14.3, 12.5, 4],
];
FIXED.push(...CAPE_SOLIDS);
const ARM_BOXES = ARMS.map(([z, hullR, w]) => {
  const tip = -(hullR + 0.9);
  return ['A SWING ARM', (ARM_FROM + tip) / 2, 0, z, (tip - ARM_FROM) / 2, w / 2, w / 2];
});
ARM_BOXES.push(['THE WHITE ROOM', -4.6, 0, 68.5, 1.6, 1.5, 1.4]);

/* Hull radius at a station along the vehicle axis (build units), for whatever is still attached.
   25.6..31.4: the LM straddling the CM (soles at LM_FOOT_Z), ring capped at 2.2 u: the crew arm's
   box (ARMS entry [68.5, 1.4, 1.2]) tips at 2.3 u from the axis at build 26.9..28.1, and while
   armSwing < 0.6 it is solid — a wider ring opens the mission with `COLLISION WITH A SWING ARM
   AT 0 m/s`. Above the tank: the ascent cabin, then only the escape tower's mast. The one-way test
   stacks run with the LM pre-separated and clear the same boxes the same way. */
function hullRadius(z) { return z < TAIL_Z[2] ? R_STACK : z < SIVB_TOP_Z ? R_SIVB : z < 25.6 ? R_SM : z < 31.4 ? 2.2 : z < 33.5 ? 1.2 : 0.6; }

const NORTH = new THREE.Vector3().crossVectors(PAD_UP, PAD_EAST).normalize();
const Y = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3(), _a = new THREE.Vector3();

/* Does the vehicle — a run of spheres along its axis from tailZ to noseZ — touch any solid?
   pos, axis: world position of the state point and unit nose vector; t: mission time (the pad
   rides the planet's spin); armsIn: swing arms still across. Returns the solid's name or null. */
export function padHit(pos, axis, t, tailZ, noseZ, armsIn) {
  _p.copy(pos).applyAxisAngle(Y, -EARTH_SPIN * t).addScaledVector(PAD_UP, -RE);
  const lx = _p.dot(PAD_EAST) / VS, ly = _p.dot(NORTH) / VS, lz = _p.dot(PAD_UP) / VS;
  /* nowhere near: the launch complex is within 260 u of the origin, the assembly building's group 5.5 km west */
  if (lx > 260 || lx < -4100 || Math.abs(ly) > 260 || lz > 220 || lz < -60 || (lx < -260 && lx > -3650)) return null;
  _a.copy(axis).applyAxisAngle(Y, -EARTH_SPIN * t);
  const ax = _a.dot(PAD_EAST), ay = _a.dot(NORTH), az = _a.dot(PAD_UP);
  const step = Math.min(2.4, Math.max(0.6, (noseZ - tailZ) / 4));       // a bare capsule is 2.7 u long: sample it finely
  for (let z = tailZ; z <= noseZ + 1e-6; z += step) {
    const x = lx + ax * z, y = ly + ay * z, h = lz + az * z, r = hullRadius(z);
    const hit = scan(FIXED, x, y, h, r) || (armsIn ? scan(ARM_BOXES, x, y, h, r) : null);
    if (hit) return hit;
  }
  return null;
}
function scan(boxes, x, y, z, r) {
  for (const b of boxes) {
    const dx = Math.max(0, Math.abs(x - b[1]) - b[4]), dy = Math.max(0, Math.abs(y - b[2]) - b[5]), dz = Math.max(0, Math.abs(z - b[3]) - b[6]);
    if (dx * dx + dy * dy + dz * dz < r * r) return b[0];
  }
  return null;
}
