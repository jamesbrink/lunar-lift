/* The vehicle's stations and radii: the ONE place these numbers are written.

   Build units (1 u = U_M = 1.4 m) along the vehicle axis, +z toward the nose, z = 0 at the state
   point S.pos — the middle of the FULL stack, where it stays after staging. js/saturn.js draws the
   hardware at these stations; physics, the pad collider, the camera, the parachutes and the
   exhaust all read them from here. Display-free and import-free: tools/mission-sim.mjs flies
   through it headless.

   Several consumers use slightly different numbers for what looks like the same thing. They are
   kept apart, each under its own name, because the certified mission is flown with exactly these
   values: merging two of them is a physics change, and has to be re-measured as one. */
export const U_M = 1.4;                       // metres per build unit

/* ---- along the axis ---- */
export const TAIL_Z = [-42, -11.8, 6.8];      // engine exit plane of S-1, S-2 and the CSM: the lowest point of each
export const CM_TAIL_Z = 26.0;                // the command module's heat-shield face: the tail once the CSM is dropped
export const NOSE_Z = 28.7;                   // top of the docking tunnel rim: the nose for contact, the pad collider and the camera
export const CM_APEX_Z = 28.6;                // top of the command module's cone (drawn +26.3 .. +28.6): where the parachute risers attach
export const LES_TIP_Z = 37.6;                // tip of the launch escape tower: the top of the hull the exhaust collides with
export const SIVB_TOP_Z = 22;                 // above this the pad collider's hull narrows from the S-IVB to the service module

/* ---- radii ---- */
export const R_STACK = 3.57;                  // S-1 and S-2 tanks (10.0 m across)
export const R_S1_SKIRT = 3.63;               // S-1 engine fairing skirt: the hull the exhaust parcels collide with while it burns
export const R_SIVB = 2.36;                   // S-IVB as drawn (6.6 m across): the pad collider's hull between TAIL_Z[2] and SIVB_TOP_Z
export const R_IU = 2.42;                     // instrument unit, the widest ring of the CSM stage: its exhaust hull
export const R_CSM_AERO = 2.2;                // the CSM stage as ONE cylinder for mass, aerodynamics and ground contact (GEOM[2]); not R_SIVB
export const R_SM = 1.4;                      // service + command module for mass and aerodynamics (GEOM[3]) and the pad collider above SIVB_TOP_Z
export const R_SM_DRAWN = 1.39;               // service module as drawn: the exhaust hull once every stage is gone
export const R_CM_BASE = 1.33;                // command module base: the radius a bare capsule touches the ground with

/* ---- mass and aerodynamic geometry ----
   One table for both: each segment's length L, radius r and middle zc. Moments of inertia, the
   centre of mass, the planform and its centroid are all built from it (js/physics.js). */
export const GEOM = [
  { L: 30.2, r: R_STACK,    zc: -26.9 },      // S-1 booster: 42 m long, 10 m across
  { L: 18.6, r: R_STACK,    zc: -2.5 },       // S-2 upper
  { L: 15.9, r: R_CSM_AERO, zc: 14.75 },      // CSM service body + adapter
  { L: 6,    r: R_SM,       zc: 25.7 },       // command module
];
export const FIN_AREA = 20, FIN_Z = -38;      // m² of effective fin planform per plane, and its station
