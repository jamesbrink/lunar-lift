import * as THREE from 'three';
import { ATMO_H, RHO0, CD_AREA, EARTH_SPIN } from './constants.js';

/* Atmospheric flight model. Display-free: tools/mission-sim.mjs flies through it headless.

   Units are the game's. With rho in kg/m³, area in m² and speed in km/s, ½·rho·A·v² comes out in
   t·km/s² — divide by tonnes for km/s², multiply by 1000 for kN.

   What is modelled, and what each term is:
     axial drag    CA·A_ref·cos α·|cos α| along the body axis. CA·A_ref for the full stack nose-on
                   below Mach 0.8 is CD_AREA, the number the mission was sized against.
     Mach          the transonic drag rise, as a multiplier on CA (machDrag below).
     normal force  what makes a body at an angle of attack fly: slender-body lift CN_BODY·A_ref·
                   sin α·|cos α|, cross-flow drag CD_CROSS·A_plan·sin² α (a cylinder broadside),
                   and the fins' CN_FIN·A_fin·sin α·|cos α|. Lift is not a separate term — it is
                   the part of the normal force perpendicular to the airflow.
     torque        the body terms act at the planform centroid, the fins at the tail; physics.js
                   takes the moment about the live centre of mass, so stability moves as the tanks
                   drain (see `stability` there).

   What is NOT modelled, said here so nobody reads more into it: slender-body theory puts the body's
   lift on the nose, well ahead of the planform centroid, which is why the real Saturn V was
   statically unstable through max-Q and flew on engine gimbal. Lumping it at the centroid makes
   this vehicle more stable than Apollo's. No heating, no ablation, no compressibility beyond the
   drag rise, and the coefficients are textbook orders of magnitude, not wind-tunnel data. */
export const ATMO_TOP = 420;                                   // km — density is exactly 0 above
export function airDensity(alt) { return alt > ATMO_TOP ? 0 : RHO0 * Math.exp(-Math.max(0, alt) / ATMO_H); }

/* The air's own velocity at p, km/s, into `out`: the atmosphere rides the planet's spin, ω × r with
   ω = EARTH_SPIN about +Y. Velocity through the air is v − airVel(p). */
export function airVel(p, out) { return out.set(EARTH_SPIN * p.z, 0, -EARTH_SPIN * p.x); }

/* Speed of sound, km/s: 340 m/s at sea level falling linearly to 295 m/s at the tropopause, held
   above it (the standard atmosphere's stratosphere is isothermal to ~20 km and within 12 % of
   295 m/s up to 85 km, by which height there is no dynamic pressure left to care about). */
export function soundSpeed(alt) { return alt >= 11 ? 0.295 : 0.340 - 0.045 * Math.max(0, alt) / 11; }

/* Drag-rise multiplier on the axial coefficient: 1 below Mach 0.8, peaking 1.6× at Mach 1.1,
   relaxing to 0.9× by Mach 5. Piecewise-smooth; shape after the generic slender-launcher curve. */
export function machDrag(M) {
  if (M <= 0.8) return 1;
  if (M <= 1.1) { const t = (M - 0.8) / 0.3; return 1 + 0.6 * t * t * (3 - 2 * t); }
  if (M <= 5) { const t = (M - 1.1) / 3.9; return 1.6 - 0.7 * t * (2 - t); }
  return 0.9;
}

export const CN_BODY = 2, CD_CROSS = 1.2, CN_FIN = 3;          // per radian / cylinder cross-flow / per radian

const _cross = new THREE.Vector3();
/* The last evaluation that had an axis — the vehicle's — for the HUD, the torque and the load check. */
export const aeroState = {
  q: 0,            // dynamic pressure, Pa
  mach: 0,
  aoa: 0,          // rad, 0 = nose into the wind
  nBody: 0,        // normal force on the body, t·km/s²
  nFin: 0,         // normal force on the fins, t·km/s²
  dir: new THREE.Vector3(),   // unit vector the normal force pushes along (world frame)
};

/* Aerodynamic force on a body, t·km/s², into `out`.
   vrel   velocity relative to the air, km/s
   axis   unit nose vector, or null for a tumbling lump (debris): plain CD_AREA drag
   shape  { aRef, ca, aPlan, aFin } in m² — see aeroShape() in physics.js */
export function aeroForce(out, vrel, alt, axis, shape) {
  const v = vrel.length();
  if (alt >= ATMO_TOP || v < 1e-9) {
    if (axis) { aeroState.q = aeroState.mach = aeroState.aoa = aeroState.nBody = aeroState.nFin = 0; }
    return out.set(0, 0, 0);
  }
  const qk = 0.5 * airDensity(alt) * v * v;                    // t/(km·s²)·… : × m² gives t·km/s²
  const M = v / soundSpeed(alt), fM = machDrag(M);
  if (!axis) return out.copy(vrel).multiplyScalar(-qk * CD_AREA * fM / v);
  const c = THREE.MathUtils.clamp(axis.dot(vrel) / v, -1, 1), s = Math.sqrt(1 - c * c);
  out.copy(axis).multiplyScalar(-qk * shape.aRef * shape.ca * fM * c * Math.abs(c));
  aeroState.q = qk * 1e6; aeroState.mach = M; aeroState.aoa = Math.acos(c);
  aeroState.nBody = aeroState.nFin = 0;
  if (s > 1e-6) {
    _cross.copy(vrel).multiplyScalar(1 / v).addScaledVector(axis, -c).multiplyScalar(1 / s);   // unit cross-flow
    aeroState.dir.copy(_cross).negate();
    aeroState.nBody = qk * (CN_BODY * shape.aRef * s * Math.abs(c) + CD_CROSS * shape.aPlan * s * s);
    aeroState.nFin = qk * CN_FIN * shape.aFin * s * Math.abs(c);
    out.addScaledVector(_cross, -(aeroState.nBody + aeroState.nFin));
  }
  return out;
}
