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
export const TAIL_Z = [-42, -11.8, 6.8, 29.3, 29.15];   // engine exit plane of S-1, S-2, the CSM, the LM descent and the LM ascent (the ascent bell is recessed inside the descent stage and only shows after jettison)
export const GEAR_Z = 6.2;                    // soles of the last stage's footpads: its contact plane, 0.6 u under the bell's exit
export const CM_TAIL_Z = 26.0;                // the command module's heat-shield face: the tail once the CSM is dropped
export const NOSE_Z = 28.7;                   // top of the docking tunnel rim: the nose for contact, the pad collider and the camera
export const CM_APEX_Z = 28.6;                // top of the command module's cone (drawn +26.3 .. +28.6): where the parachute risers attach
export const LES_TIP_Z = 42.3;                // tip of the launch escape tower: the top of the hull the exhaust collides with. It stands on the LM's roof now (+4.7 u above the old tip over the CM): the escape tower and the LM cannot both fit above the capsule.
export const SIVB_TOP_Z = 22;                 // above this the pad collider's hull narrows from the S-IVB to the service module

/* ---- the lunar module: it straddles the command module ----
   Legs down at 45°, 135°, 225° and 315° so they clear the service module's radiators and the tower
   arms' sweep line; footpad soles at LM_FOOT_Z, 0.4 u BELOW the heat shield's bottom face, so the LM
   stands on its feet with the capsule safely inside the stride. The descent stage's bell hangs
   between the legs at 29.3; the ascent stage's bell sits just inside the descent stage's ventral
   hatch at 29.15 and is revealed by jettison, as it was on the real stack. The escape tower now
   sits on the LM's roof at LM_TOP_Z (see LES_TIP_Z). */
export const LM_FOOT_Z = 25.6;                // soles of the LM's footpads: CONTACT for the descent stage on the Moon
export const LM_ASC_TAIL_Z = 29.15;           // ascent bell exit plane: CONTACT once the descent stage is left behind
export const LM_TOP_Z = 33.4;                 // top of the ascent cabin: the nose for LM-phase contact and camera framing
export const R_LM = 2.2;                      // the LM as ONE cylinder for ground contact: between the 1.72 body and the 3.35 foot circle

/* ---- radii ---- */
export const R_STACK = 3.57;                  // S-1 and S-2 tanks (10.0 m across)
export const R_S1_SKIRT = 3.63;               // S-1 engine fairing skirt: the hull the exhaust parcels collide with while it burns
export const R_SIVB = 2.36;                   // S-IVB as drawn (6.6 m across): the pad collider's hull between TAIL_Z[2] and SIVB_TOP_Z
export const R_IU = 2.42;                     // instrument unit, the widest ring of the CSM stage: its exhaust hull
export const R_CSM_AERO = 2.2;                // the CSM stage as ONE cylinder for mass, aerodynamics and ground contact (GEOM[2]); not R_SIVB
export const R_SM = 1.4;                      // service + command module for mass and aerodynamics (GEOM[CAPSULE_GEOM]) and the pad collider above SIVB_TOP_Z
export const R_SM_DRAWN = 1.39;               // service module as drawn: the exhaust hull once every stage is gone
export const R_CM_BASE = 1.33;                // command module base: the radius a bare capsule touches the ground with

/* ---- mass and aerodynamic geometry ----
   One table for both: each segment's length L, radius r and middle zc. Moments of inertia, the
   centre of mass, the planform and its centroid are all built from it (js/physics.js). */
export const GEOM = [
  { L: 30.2, r: R_STACK,    zc: -26.9 },      // S-1 booster: 42 m long, 10 m across
  { L: 18.6, r: R_STACK,    zc: -2.5 },       // S-2 upper
  { L: 15.9, r: R_CSM_AERO, zc: 14.75 },      // CSM service body + adapter
  { L: 5.75, r: 1.85,       zc: 28.5 },       // LM descent stage: body plus the straddling legs (25.6 .. 31.35)
  { L: 4.25, r: 1.1,        zc: 31.28 },      // LM ascent stage: cabin and recessed bell (29.15 .. 33.4)
  { L: 6,    r: R_SM,       zc: 25.7 },       // command module
];
export const CAPSULE_GEOM = 5;                // the capsule's GEOM row: the LM stages took stage indices 3 and 4
export const FIN_AREA = 20, FIN_Z = -38;      // m² of effective fin planform per plane, and its station
