import * as THREE from 'three';
import { SPECS, VS, RE, RM, MU_E, MU_M, SOI_M, EARTH_SPIN, PAD_SCALE, PAD_UP, moonPos, moonVel } from './constants.js';
import { glowTex, flareTex } from './textures.js';
import { toon, outline, plumeMeshes, PALETTE, RAMP_HARD } from './toon.js';
/* The plume is a physics consumer, so it reads the sim's own numbers instead of restating them:
   airDensity is literally the function accelAt drags the vehicle with (one exponential, no chance
   of the flame disagreeing with the flight computer about where the air runs out), and the mission
   clock drives the emission rate so the plume thins honestly at high warp instead of lying. */
import { airDensity, getSimTime } from './physics.js';
import * as WORLD from './world.js';
import { LAYER_FX, RES_SCALE } from './halfres.js';

let scene = null;

/* Sea-level density straight off the physics module's own exponential (airDensity(0) = RHO0),
   so the ember quench below normalises by the same number drag reads, never a restated one. */
const RHO_SEA = airDensity(0);

/* ---------------- rocket ---------------- */
export const rocketGroup = new THREE.Group(); rocketGroup.scale.setScalar(VS);

/* Cel materials. These were MeshStandardMaterial with metalness .3-.85, and there is no environment
   map in this scene, so the hull rendered as a black silhouette against the pad — a metal with
   nothing to reflect reflects nothing. Flat banded colour instead; see js/toon.js. */
const matBody = toon({ color: PALETTE.hull, gradientMap: RAMP_HARD });
const matDark = toon({ color: PALETTE.dark });
const matAccent = toon({ color: PALETTE.accent });
const matNozzle = toon({ color: PALETTE.engine });

export const stages = SPECS.map(s => ({ ...s, fuel: s.fuel, separated: false, meshes: new THREE.Group(), tailZ: 0, flame: null, glow: null }));

const ZERO_V = new THREE.Vector3();

/* `edge` adds the inverted-hull outline. Only silhouette parts get one: outlining every ring and
   window would draw lines through the middle of the vehicle, which is not what an outline is for. */
function cyl(rt, rb, len, z, mat, seg = 20, edge = false) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, len, seg), mat);
  m.rotation.x = Math.PI / 2; m.position.z = z; m.castShadow = true;
  if (edge) outline(m);
  return m;
}

/* Build rules for the stack. The old geometry flickered ("collisions within the graphics") because
   shells sat coplanar or interpenetrated. Two rules, enforced on every seam:
   1. an axial joint is ALWAYS covered by a slightly larger-radius sleeve (the black bands do this),
      so the butt faces at the joint are inside solid material and can never show or z-fight;
   2. wherever two meshes meet axially, one is sunk ≥0.4 u (0.6 m) into the other with its junction
      radius ≥ the neighbour's (round-5: the old 0.05..0.15 u sinks at DIFFERENT radii left 3-17 cm
      step-slot rings that grazing below-views read as "open bucket … visible seam gaps"), so no
      two surfaces coincide and no slot rim survives.
   3. every shell material is single-sided — measured `side === 0` (FrontSide) on all 24 shell
      cylinders — so interior back faces are never drawn and an inside can never darken a seam.
   Dimensions are real Saturn V at 1 build unit = VS km = 1.4 m (NASA SP-4029,
   docs/reference/spacecraft.md): Ø10.0 m stage (r 3.57), S-IC 42 m + 3.4 m interstage, S-II 24.8 m,
   S-IVB 17.9 m + 0.9 m instrument unit, SLA tunnel/adapter, SM Ø3.9 m, CM, LES. Engines: 5× F-1
   (centre fixed + 4 gimballed outboards on a bolt circle, ~6° cant), 5× J-2, and one small bell on
   the third stage — the game's stage 3 is the combined CSM engine (SPS/DPS/TLI in one per the
   reference doc), so its single bell rides the S-IVB tail where a single-engine stage has it and
   where updateBurnVisuals needs the flame. Total span stays tail -42 .. LES tip 37.6 so pad
   clearance (PAD_POS/RHALF in constants.js) and the camera framing are untouched. */

// stage 0 — S-IC + its interstage: white body, black engine skirt, five F-1 bells. -42 .. -9.5
{
  /* Skirt/body junction, round-5: the old 4.7 u cone ENDED at -34.9 with r 3.52 while the body
     (3.57) started at -35.0 — from below that left a 0.055 u radial step under a 0.1 u axial slot,
     and grazing angles read the shadowed gap as "seam gaps … open bucket". The cone now runs to
     -34.6 with its mouth (3.60) LARGER than the body: the wall surfaces cross once, transversally,
     at r(z)=3.57 → z=-35.5, the 0.4 u overlap band (≈0.6 m) is solid sleeve over solid body, and
     there is no rim for the eye to fall through. */
  const g = stages[0].meshes;
  g.add(cyl(3.60, 3.30, 5.0, -37.1, matDark, 24, true));      // conical engine skirt, -39.6 .. -34.6
  g.add(cyl(3.57, 3.57, 25.1, -22.45, matBody, 24, true));    // booster body, -35.0 .. -9.95 (top buried in the interstage sleeve; the skirt mouth 3.60 > 3.57 so the skirt/body junction shares no surface)
  g.add(cyl(3.63, 3.63, 2, -32, matAccent));                  // roll band
  g.add(cyl(3.62, 3.62, 2.5, -10.75, matDark, 24, true));     // interstage sleeve -12.0 .. -9.5: shrouds the S-II bells until staging, and covers the body/sleeve butt face because it exists
  const finShape = new THREE.Shape();                         // small swept tail fin: x = radial, y = axial z. Real Saturn V fins are stubby — the old 2.5× body-span sheets read as a model rocket
  finShape.moveTo(3.15, -35.8); finShape.lineTo(4.05, -38.0); finShape.lineTo(4.05, -39.5); finShape.lineTo(3.15, -39.5);
  const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: .22, bevelEnabled: false }); finGeo.translate(0, 0, -.11);
  for (let i = 0; i < 4; i++) {                               // roots buried in the skirt solid at every z (skirt r >= 3.30 > 3.15)
    const arm = new THREE.Group(); arm.rotation.z = i * Math.PI / 2 + Math.PI / 4;
    const fin = new THREE.Mesh(finGeo, matDark); fin.rotation.x = Math.PI / 2; fin.castShadow = true; outline(fin);
    arm.add(fin); g.add(arm);
  }
  /* Five identical F-1 bells: throats hidden in the skirt solid, exits 2.4 u (3.4 m) below the rim.
     Bolt circle r 2.35 puts the exit rims tangent — five Ø2.7..2.8 u bells would otherwise intersect
     each other — and the outboards cant 0.1 rad outward (the real gimbal trim, so an engine that
     quits early still thrusts through the c.g.). Exits define tailZ = -42. */
  const f1 = (rb) => cyl(0.42, rb, 2.6, -40.7, matNozzle, 16);
  g.add(f1(1.19));                                            // centre F-1, fixed, exit -42.0
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    const b = f1(1.15);
    b.position.x = Math.cos(a) * 2.35; b.position.y = Math.sin(a) * 2.35;  // x/y only — position.z (-40.7) is the bell centre and must survive
    b.quaternion.setFromAxisAngle(new THREE.Vector3(-Math.sin(a), Math.cos(a), 0), -0.1);  // -z tips outward
    g.add(b);
  }
  stages[0].tailZ = -42;
}

// stage 1 — S-II + forward shroud (the interstage rode with the S-II): five J-2 bells. -11.8 .. +8.6
{
  const g = stages[1].meshes;
  /* S-II engine skirt, round-5: it was Ø 3.45 at the body while the body is 3.57 — from below the
     exposed white base-cap annulus (0.12 u, 17 cm) around the dark skirt was the "broken bent
     model" rim once stage 0 fell away. The skirt now overlaps the body by 0.45 u (0.63 m) with its
     top radius 3.58 ≥ the body's 3.57 — and stays 0.04 u under the stage-0 sleeve's 3.62, so it
     never shares a surface with the sleeve it rides inside. */
  g.add(cyl(3.58, 3.50, 1.5, -10.3, matDark, 24, true));      // engine skirt -11.05 .. -9.55, top sunk into the body solid; hidden inside the stage-0 sleeve while stacked
  g.add(cyl(3.57, 3.57, 17.0, -1.5, matBody, 24, true));      // white body -10.0 .. +7.0
  g.add(cyl(3.63, 3.63, 2, 5.2, matAccent));                  // S-II roll-pattern band
  g.add(cyl(2.55, 3.52, 1.9, 7.65, matDark, 24));             // forward shroud +6.7 .. +8.6: tapers 10 m → S-IVB and hides the S-IVB bell until this stage falls away
  const j2 = (rb) => cyl(0.30, rb, 1.9, -10.85, matNozzle, 14);  // throat -9.9 buried in the body, exit -11.8: inside the stage-0 sleeve until stage 1 falls
  g.add(j2(0.72));
  for (let i = 0; i < 4; i++) {                               // bolt circle r 1.44 → exit rims tangent, Ø1.4 u bells never intersect
    const a = i * Math.PI / 2 + Math.PI / 4;
    const b = j2(0.70);
    b.position.x = Math.cos(a) * 1.44; b.position.y = Math.sin(a) * 1.44;  // z (-10.85) is the bell centre
    g.add(b);
  }
  stages[1].tailZ = -11.8;
}

/* stage 2 — S-IVB + IU + SLA tunnel/SM + CM: one vehicle to the Moon. +6.8 .. +28.7.
   Stage 3's SPECS is the CSM engine doing TLI, LOI, deorbit and descent at once
   (docs/reference/spacecraft.md), so it gets ONE small bell — at the S-IVB tail, where a
   single-engine stage physically has it and where the flame must sit. */
{
  const g = stages[2].meshes;
  /* S-IVB bottom, round-5: sunk 0.45 u (0.63 m) into the stage-1 shroud solid (was 0.15) — the
     junction now reads as one continuous taper from below, at a radius (2.36) under the shroud's
     2.63..2.78 there, so no surface is shared. */
  g.add(cyl(2.36, 2.36, 11.5, 13.9, matBody, 20, true));      // S-IVB white body Ø6.6 m, +8.15 .. +19.65 (bottom buried in the stage-1 shroud solid)
  g.add(cyl(0.32, 0.85, 1.7, 7.65, matNozzle, 14));           // single engine bell: throat buried in the S-IVB solid, exit +6.8 — inside the shroud while stacked, exposed once stage 1 falls
  g.add(cyl(2.42, 2.42, 1, 18.0, matAccent));                 // S-IVB roll band
  /* IU, round-5: extended to 0.53 u (0.74 m) overlap on the S-IVB top (was 0.1), radius 2.42 ≥ 2.36.
     Tunnel, round-5: its old 2.40 base under the 2.42 IU was the worst near-coplanar step on the
     stack — a 3 cm slot ring. The frustum foot is now 2.46 ≥ the IU's 2.42 and reaches to +21.05,
     shrouding the IU top rim; the walls cross transversally and nothing from below sees a gap. */
  g.add(cyl(2.42, 2.42, 2.18, 20.21, matDark, 20));           // black instrument unit + SLA aft ring, +19.12 .. +21.3
  g.add(cyl(1.55, 2.46, 1.95, 22.025, matDark, 20));          // spacecraft/LM adapter tunnel, frustum from the IU deck to the SM diameter, +21.05 .. +23.0
  g.add(cyl(1.39, 1.39, 3.45, 24.625, matBody, 20, true));    // service module Ø3.9 m, +22.9 .. +26.35 (bottom buried 0.1 into the adapter top, r 1.39 < 1.55)
  const cm = new THREE.Mesh(new THREE.ConeGeometry(1.33, 2.4, 24), matBody);  // command module, +26.3 .. +28.7; base r < SM r and sunk 0.05 into its top so the shells never coincide
  cm.rotation.x = Math.PI / 2; cm.position.z = 27.5; cm.castShadow = true; outline(cm); g.add(cm);
  /* The single bell exits at +6.8 (see above) — tailZ was never set, so the mesh flame and glow
     sat at z=-0.6, inside the S-IVB body, during every S-IVB/CSM burn while the particle plume
     (separate table) came from the real bell. Constraint lifted by Main; the mission harness does
     not read tailZ, so this is visual-only. */
  stages[2].tailZ = 6.8;
}

/* Launch escape system — its own group so it can jettison as a unit (remove `lesGroup` from
   stages[2].meshes and re-parent to the scene exactly like detachStage does). Real LES top-to-bottom
   is nose cone / canards / motor stack / tower (enginehistory.org RPE09.10); the tower was a truss,
   but a lattice reads as noise at game zoom and the brief rules it out, so: solid mast, tapered
   escape-motor stack, nose cone, three canards at the top. Children carry absolute build coords and
   the group stays at the local origin, so detach/re-attach needs no offset bookkeeping. */
export const lesGroup = new THREE.Group(); lesGroup.name = 'les';
stages[2].meshes.add(lesGroup);
{
  lesGroup.add(cyl(.50, .50, .50, 28.8, matDark, 12));        // escape seat on the CM tip, +28.55 .. +29.05 (the CM apex pokes into it; cone meets plane, never a shared surface)
  lesGroup.add(cyl(.24, .24, 5.3, 31.6, matDark, 10, true));  // mast +28.95 .. +34.25, ends sunk into seat and motor solids
  lesGroup.add(cyl(.34, .55, 2.4, 35.4, matDark, 14, true));  // escape-motor stack +34.2 .. +36.6, tapering up (ballast compartment + jettison motor silhouette)
  const nose = new THREE.Mesh(new THREE.ConeGeometry(.34, 1.1, 14), matDark);  // nose cone, base buried 0.1 into the motor top, tip +37.6 = vehicle top
  nose.rotation.x = Math.PI / 2; nose.position.z = 37.05; nose.castShadow = true; outline(nose); lesGroup.add(nose);
  const canard = new THREE.Shape();                           // x = radial, y = axial z; roots buried in the motor solid across the whole band (motor r >= 0.366 > 0.34)
  canard.moveTo(.34, 34.4); canard.lineTo(1.12, 35.3); canard.lineTo(1.12, 36.3); canard.lineTo(.34, 36.3);
  const canardGeo = new THREE.ExtrudeGeometry(canard, { depth: .12, bevelEnabled: false }); canardGeo.translate(0, 0, -.06);
  for (let i = 0; i < 3; i++) {
    const arm = new THREE.Group(); arm.rotation.z = i * Math.PI * 2 / 3;
    const fin = new THREE.Mesh(canardGeo, matDark); fin.rotation.x = Math.PI / 2; fin.castShadow = true; outline(fin);
    arm.add(fin); lesGroup.add(arm);
  }
}

/* Pad-blast light escape (review5/02: "no exhaust flame or light bloom escapes it despite 100 %
   throttle"). The plume is ONE transparent draw call whose smoke half composites source-over —
   and three.js sorts transparent objects by renderOrder first, so a flame sprite at the SAME
   renderOrder as the plume is ordered against the whole smoke volume by z luck: engine-side, the
   anchor sits at the ship, the tie breaks by insertion order, and the blast paints OVER the exit
   plane every frame. Two Sprites at renderOrder 12 (the plume is 0) are therefore a real fix,
   not a brightness knob: crisp flareTex disc as the flame core (Ø 8.8-16.1 m build-scaled) plus
   ONE soft glowTex bloom (Ø 51.8-88.2 m) whose additive halo stacks over the dome — light that
   escapes the silhouette. They ramp in above 35 % throttle and live only under 2.5 km of the
   surface underneath (pad and low lunar burns; at orbital altitude the drawn cone owns the shot). */
const flareCore = new THREE.Sprite(new THREE.SpriteMaterial({ map: flareTex(), color: 0xfff1c8,
  transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
const flareBloom = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: 0xffb060,
  transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
flareCore.renderOrder = flareBloom.renderOrder = 12;
flareCore.visible = flareBloom.visible = false;
flareCore.castShadow = flareBloom.castShadow = false;
rocketGroup.add(flareBloom); rocketGroup.add(flareCore);
const _flAlt = new THREE.Vector3();

stages.forEach(st => {
  /* Two-tone plume: a saturated outer cone with a pale core parented inside it, so scaling the
     outer (which updateBurnVisuals does every frame, for length and flicker) carries the core. */
  const { outer: flame } = plumeMeshes(st.meshes);
  flame.rotation.order = 'YXZ'; // gimbal yaw term must rotate the already-pitched plume; see updateBurnVisuals
  flame.rotation.x = -Math.PI / 2; flame.position.z = st.tailZ - 0.6; flame.visible = false; flame.castShadow = false;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: 0xffb060, transparent: true, opacity: .8, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.position.z = st.tailZ; glow.visible = false; glow.castShadow = false;
  st.meshes.add(glow); st.flame = flame; st.glow = glow;
  rocketGroup.add(st.meshes);
});

/* ---------------- volumetric exhaust plume ----------------
   Every sprite here is a gas parcel with a life, a radius and a velocity. Nothing about the shape
   is keyframed: the pad blast, the high-altitude needle and the post-MECO drift are all outcomes of
   one integration.

   Engine exit plane first. Exhaust velocity is the rocket equation's ve = Isp·g0, and that is
   exactly what physics.js spends when it burns propellant (`sp.thrust * throttle / (sp.isp * 9.81)`
   tonnes/second), so the plume and the acceleration come from one number. Parcels are born on the
   actual bell exit discs of the vehicle geometry (five F-1s on the r 2.35 bolt circle canted 0.1
   rad, five J-2s on r 1.44, one S-IVB bell at +6.8) with the bell's own divergence half-angle, so
   the cone the exit lip draws is the cone the flow takes.

   Throttle moves the physics, not the sprite: exit velocity scales as 0.45+0.55·th and mass flow
   (emission rate) scales with throttle. At 40% the plume is shorter because the parcels leave the
   nozzle slower, fewer are born, and they die sooner — not because a cone was scaled down.

   Drag: `airDensity()` is imported from physics.js, and the velocity is ground-relative exactly the
   way accelAt does it — the atmosphere rides the planet's spin, and a parked plume that believed it
   was moving through still air at 409 m/s would slide west across the pad. The drag itself is
   solved implicitly: the parcel velocity is multiplied by 1/(1+β·h), the exact linearised step of
   dv/dt = −βv with β = ½ρ|v_rel|·CdA/m folded into one ballistic coefficient. Explicit Euler
   cannot integrate β·h ≈ 3-6 per substep without oscillating; the implicit form cannot explode at
   any step size, which is what makes the time warp safe.
   The unforced consequences, which are the whole point: at the pad τ ≈ 10 ms so the flow dies
   inside ~50 m and everything visible is ground interaction; near 60 km τ is tens of seconds, so
   the exhaust flies nearly unimpeded and lays a long thin needle along the flight path; above
   ~100 km ρ is so thin the fan is collisionless and ballistic.

   Bodies: whichever mass is underneath supplies gravity and air, picked with the same SOI test
   physics.js uses. Inside the Moon's: MU_M and no atmosphere at all — which is why lunar burn
   exhaust travels far, settles slowly at 1.62 m/s², and gets a longer life multiplier here.

   Colliders, all analytic and all cheap:
     · ground of the body underneath, radial, plus js/world.js terrain *if* it ever grows a height
       getter (guarded — it exports none today, and a bare call would TypeError against a module
       that has never heard of it);
     · the LC-39 complex as exhaust sees it: a trench BOWL around the rocket (floor below r = RE —
       the bells dip into it), ringed by a low smooth berm out to the 455 u footprint. Flow falls
       into the bowl, is thrown along the rising walls (the column visibly buckles and widens as
       it clears the trench lip), and the berm keeps the near field dense before the apron
       escapes. The complex's 150 u bbox belongs to the masts and towers; standing the ground that
       high would float the blast 210 m above a 5.6 m deck, so thin towers stay uncollided.
     · the vehicle: one analytic cylinder along its own axis, from the active tail to the LES tip,
       so the deflectate washes around the hull instead of through it.

   A ground hit kills the inward radial component, keeps the tangential (that is the blast rolling
   sideways across the flame trench), converts a share of the impact speed into outward tangential
   flow plus a little lift — on Earth enough to billow the smoke up and over the pad; on the Moon
   lift ≈ 0.04, because 1.62 m/s² cannot billow and real lunar ascent footage is a flat radial
   spray sheet. The parcel grows and is marked smoky on impact.

   Rendering is the cel half of the job, in one premultiplied Points draw call (blendSrc ONE,
   blendDst ONE_MINUS_SRC_ALPHA): each parcel carries BOTH a coverage `alpha` and an additive
   `add`. Hot bands lean on add (order-free glow that lights anything); smoke bands lean on cover,
   which REPLACES the pale blue sky toward a darker flat tone — additive smoke cannot darken a
   daytime sky, and that is exactly why an earlier cut of this plume vanished at the pad. The colour
   is NOT continuous — a heat index crosses hard thresholds and steps between flat bands: the drawn
   flame's pale core, its saturated orange, PALETTE.accent cooling to, then a grey-brown for Earth
   smoke and a pale grey for lunar dust. Five discrete colours related to the rest of the game —
   the same quantisation the gradientMap ramps apply to the hull, per
   docs/reference/cartoon-art-direction.md. No lights, no bloom, depthWrite off.

   Pool: NP fixed slots, `alive` + an explicit free stack (full pool recycles a live slot in place)
   — zero allocation per frame and per stage event. Physics arrays are slot-indexed; the geometry's
   attributes are a DENSE render mirror (rPos/rCol/rSiz/rAlp/rAdd) refilled in place every frame and
   drawn as [0, drawn) — never the slot arrays themselves, whose swap-remove holes would render dead
   slots as ghosts and drop live ones past the range (this happened; see fillBuffers). plumeDebug
   counts every silent failure class by name: missing terrain field, non-finite parcel state, NaN
   heights, a bell index nobody built, live parcels about to draw at zero size. */
const NP = 1600;
const MAX_SUB = 30;                       // dt/MAX_SUB ≈ 33 ms per substep at the 1 s clamp
const BAL0 = 0.018, BAL_CAP = 0.055;      // m²/kg normalised as BAL0/r² (r = parcel radius, m)
const R_CAP = 16;                         // m: entrainment ceiling. Density has to come from parcel COUNT;
                                        // at 38 m the few live parcels overlapped into soft lanterns around the pad
const R_YOUNG = 9;                        // m: radius hold for deflected Earth parcels in their first 0.5 s —
                                        // the blast dome must form from entrained parcels, not instant inflation
/* pSmoke codes past 1 are drawn generically but behave specially (fillBuffers / stepParcel):
   2 = staging-seam silhouette puff — low-alpha dark grey, air-gated growth like smoke;
   3 = lunar scorch patch — dark, ground-pinned, slow creep, never additive;
   4 = lunar ground-hugging spray — pale dust crawling radially, never additive;
   5 = staging-flash core — additive white, <0.3 s, drawn BEFORE the smoke takes over (see addDebris). */
const SM_SEAM = 2, SM_SCORCH = 3, SM_SPRAY = 4, SM_FLASH = 5;
const PAD_RP2 = (455 * PAD_SCALE) * (455 * PAD_SCALE);   // pad complex footprint, km²
/* Pad ground as the exhaust actually meets it: the flame trench is a bowl (its floor is BELOW the
   map sphere — the F-1 exit plane itself sits below it), and around the trench a low berm stands
   where the deflectors and crawler decks pile up. Both profiles are continuous at their rims, so
   the deflectate rides the bowl walls up and outward — the column visibly buckles and widens as it
   clears the trench — and the berm keeps the near field dense before the apron escapes. */
const TRP2 = (36 * PAD_SCALE) * (36 * PAD_SCALE);        // trench opening radius, km²
const TRENCH = 9 * PAD_SCALE;                            // trench floor depth below r = RE
const PAD_BERM = 40 * PAD_SCALE;                         // berm crest ≈ PAD_BERM/4 ≈ 14 m, smoothstep-free s·t cap
const SOI2 = SOI_M * SOI_M;
const ALT40_R2 = (RE + 40) * (RE + 40);  // r² gate for "below 40 km": the ascent-rope regime

/* Hard cel bands, hot → smoke, chosen the way the cartoon direction asks: flat tones a brush would
   load, hard steps, no lerps. Three flame bands run almost purely additive (a=cover is tiny) so
   they glow against anything; two smoke bands run almost purely composited (add≈0) so they can
   darken the pale blue sky — a smoke that cannot darken the sky is a smoke that does not exist at
   midday. Sky at the pad is #79b1de (linear ≈ 0.19/0.44/0.73): the smoke tints below are chosen
   clearly darker in luminance than that, and clearly lighter than black space and the grey Moon. */
const _tc = new THREE.Color();
function bandRGB(hex) { _tc.set(hex); return [_tc.r, _tc.g, _tc.b]; }
const BAND_C = [
  bandRGB(0xfff3c2),      // incandescent core
  bandRGB(0xff8a2a),      // saturated flame
  bandRGB(PALETTE.accent),// cooling ember
  bandRGB(0x8a8276),      // Earth smoke: warm grey-brown, darker than the daytime sky
  bandRGB(0xf5eedd),      // lunar dust: pale grey-tan — see the note below, it has to beat regolith
  bandRGB(0xdad5c9),      // cloud foot: the ground-hugging blast roll, seen against grass, not sky
];
/* BAND_C[4] used to be 0x9aa0a6, then 0xdce1e6, "brighter than regolith". Measured against the painted
   surface (js/toonmap.js MOON palette bytes: maria 0.517, mid 0.670, high 0.815, bright 0.910 sRGB
   luminance) the 0.880-luminance cool grey was NOT brighter — and the round-5 review read the sheet as
   "uniform semi-transparent circles" over a ground it never separated from. Dust lit by unfiltered sun
   through no atmosphere is pale GREY-TAN, not white-blue: 0xf5eedd (245/238/221) sits at luminance
   0.934, above the brightest painted ray texel, and carries hue the neutral regolith has none of. */
const BAND_A = [0.0, 0.16, 0.36, 0.62, 0.45, 0.8];    // composited coverage
const BAND_G = [1.0, 0.6, 0.4, 0.10, 0.05, 0.03];     // additive glow

/* One slot = one parcel; `alive` is the live index list, freeSlots[] the recycle stack.
   pPos is Float64Array on purpose: lunar coordinates sit ~384,000 km from the origin, where
   Float32 quantises to a ~31 m grid, and a settling dust parcel moves 1.6 cm per substep —
   position += velocity·h rounds back to the SAME stored value every step, so slow parcels
   froze in space while the Moon travelled on at 1.02 km/s (measured: a scorch parcel's ground
   separation grew at exactly the Moon's z-velocity, 376 m/s, with its own relative velocity at
   1 m/s — that is review3/14's "dots floating mid-air with no ground interaction", and it
   applies to ANY slow parcel at the Moon, not just the new ones). The GPU mirror rPos stays
   Float32 (it is an attribute); its own 31 m grid near the Moon is neutralised by re-anchoring
   the draw call near the vehicle — see plumeAnchor in fillBuffers. */
const pPos = new Float64Array(NP * 3);    // world km — physics only, slot-indexed
const pVel = new Float32Array(NP * 3);    // inertial km/s
const pR = new Float32Array(NP);          // parcel radius, metres (sprite size, bal, entrainment)
const pLife = new Float32Array(NP);       // seconds remaining
const pAge = new Float32Array(NP);
const pInv = new Float32Array(NP);        // 1 / max life — fade shape without a divide
const pHeat = new Float32Array(NP);       // 0..1 incandescence; crosses the band thresholds hard
const pMode = new Uint8Array(NP);         // 0 dead · 1 plume · 2 generic (spawnParticle/explosion)
const pSmoke = new Uint8Array(NP);        // 1 = ground-deflected; past ~0.12 s of age: smoke band, drag floor, fast growth
const pMoon = new Uint8Array(NP);         // 1 = moon-side parcel (spray sheet, no drag, grey dust)
const pTh = new Float32Array(NP);         // last good relief sample, km above the sphere (boot-order guard)
const pColB = new Float32Array(NP * 3);   // fixed colour for generic particles
const alive = new Int32Array(NP);
let nAlive = 0;

/* Fixed pool + explicit free stack: alive[] holds only live slots, free[] the rest, and a full
   pool recycles a live slot in place (it simply becomes fresh exhaust — steady state holds). */
const freeSlots = new Int32Array(NP);
let nFree = NP;
for (let i = 0; i < NP; i++) freeSlots[i] = NP - 1 - i;   // pops come out in order 0,1,2,…
function allocSlot() {
  if (nFree > 0) { alive[nAlive++] = freeSlots[--nFree]; return alive[nAlive - 1]; }
  return alive[(Math.random() * nAlive) | 0];
}
function killSlot(k) {
  const i = alive[k]; pMode[i] = 0;
  alive[k] = alive[--nAlive];
  freeSlots[nFree++] = i;
}

/* Dense render mirror, written by fillBuffers in `alive` order every frame. Physics lives in
   slot-indexed arrays; the GPU draws the index range [0, count). Sharing the slot arrays with the
   draw range (an earlier design here) silently broke the moment swap-remove was introduced: the
   live SET stays correct but not contiguous, so a dead slot under the range renders as a frozen
   ghost of its stale attributes while a live slot above it vanishes — in steady state LIFO reuse
   hid it (holes refill within frames), after an engine cut it would have painted a trail of
   motionless sprites for seconds. Dense + count-guarded also gives the NaN guard somewhere to
   drop parcels: a skipped parcel simply never enters the prefix. */
const rPos = new Float32Array(NP * 3);
const rCol = new Float32Array(NP * 3);    // band colour — rebuilt every frame from heat/smoke
const rSiz = new Float32Array(NP);        // sprite diameter, km
const rAlp = new Float32Array(NP);        // 0..1 composited coverage (darkens pale sky)
const rAdd = new Float32Array(NP);        // 0..1 additive glow (brightens anything)
const pGeo = new THREE.BufferGeometry();
const aPos = new THREE.BufferAttribute(rPos, 3); aPos.setUsage(THREE.DynamicDrawUsage);
const aCol = new THREE.BufferAttribute(rCol, 3); aCol.setUsage(THREE.DynamicDrawUsage);
const aSiz = new THREE.BufferAttribute(rSiz, 1); aSiz.setUsage(THREE.DynamicDrawUsage);
const aAlp = new THREE.BufferAttribute(rAlp, 1); aAlp.setUsage(THREE.DynamicDrawUsage);
const aAdd = new THREE.BufferAttribute(rAdd, 1); aAdd.setUsage(THREE.DynamicDrawUsage);
pGeo.setAttribute('position', aPos);
pGeo.setAttribute('color', aCol);
pGeo.setAttribute('size', aSiz);
pGeo.setAttribute('alpha', aAlp);
pGeo.setAttribute('add', aAdd);
pGeo.setDrawRange(0, 0);
/* Identity assertion (Main's, earned): the pad plume once rendered 503 live parcels as 503 zero
   sprites because the bound attributes and the refilled arrays were different memories. If this
   ever fires — at boot or in the first burning frame — the GPU is drawing an array physics never
   writes, and no amount of visual tuning will help. */
console.assert(
  aPos.array === rPos && aCol.array === rCol && aSiz.array === rSiz && aAlp.array === rAlp && aAdd.array === rAdd,
  'plume: bound geometry attributes are not the pool arrays');
let _idChecked = 0;                        // second check after the first frame that actually wrote

/* Additive glow sprites with per-particle size and alpha. Three constraints make this a
   ShaderMaterial rather than a PointsMaterial: parcels carry individual radii (a 30 m smoke head
   and a 1.5 m jet core), the alpha is physics-shaped (birth ramp, burn-down, smoke-out) instead of
   one global opacity, and — as in toon.js — every custom shader in this renderer must take the
   logdepthbuf route, with <common> first, because r160's logdepthbuf_vertex calls
   isPerspectiveMatrix which is not in ShaderMaterial's auto prefix.

   Blending is premultiplied compositing: `blendSrc ONE, blendDst ONE_MINUS_SRC_ALPHA`, and the
   fragment writes rgb = tint·glow·(add + cover), a = glow·cover. This makes ONE draw call do two
   jobs that used to need two: the hot core runs with cover≈0, add≈1 — pure additive, order-free —
   while smoke runs with add≈0, cover≈0.5, which REPLACES the pale blue sky toward a darker flat
   grey-brown. Additive smoke against a daytime sky is physically incapable of darkening it, and
   that is exactly why the pad plume was invisible. depthWrite stays off and nothing casts shadows;
   the additive half is order-independent, the compositing half is flat single-tone smoke where
   overlap order only slightly deepens the wash — allowed per the cartoon direction. */
const plumeMat = new THREE.ShaderMaterial({
  uniforms: {
    uMap: { value: glowTex() },
    uScale: { value: 600 },               // px scale factor, refreshed in onBeforeRender
  },
  vertexShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_vertex>
    attribute float size;
    attribute float alpha;
    attribute float add;
    varying vec3 vTint;
    varying float vA;
    varying float vAdd;
    uniform float uScale;
    const float RES = ${RES_SCALE.toFixed(2)};   // this pass is drawn at a fraction of the screen's pixels
    void main() {
      vTint = color;
      vA = alpha;
      vAdd = add;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      /* Parcels fade out inside 35 m of the lens, BOTH blend halves. A composited smoke disc 2 m
         off-camera is a circle a sixth of the frame; an additive one a tenth. The 9 m moon chase
         capture ran ~40 such discs across the vehicle they were meant to be evidence for
         (parcelAudit at h=11 m: 188 live deflected parcels, and the deflected sheet passes right
         through the camera position) — the reviewer's "bokeh", at a smaller radius. The sheet
         itself still reads, because the radial ground flow extends well past 35 m; the pad's
         camera sits ~30 m back, outside the fade, where the plume is meant to be one body.
         Depth is view-space km like every position here. */
      float nearFade = smoothstep(0.003, 0.035, -mv.z);
      vA *= nearFade;
      vAdd *= nearFade;
      /* Two caps. Smoke is allowed 220 px: it is the cloud body and it has to merge. Glow-dominant
         parcels get 80 px — a metre from the lens a fully additive puff otherwise blooms into a fat
         lantern a tenth of the screen, and the trench read as a dozen separate lamps instead of one
         sheet. Both caps only bite closer than ~30 m, where the plume is meant to be one body. */
      float cap = mix(220.0, 80.0, min(vAdd, 1.0)) * RES;
      gl_PointSize = clamp(size * (uScale / max(-mv.z, 1e-6)), 1.0, cap);
      gl_Position = projectionMatrix * mv;
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_fragment>
    uniform sampler2D uMap;
    varying vec3 vTint;
    varying float vA;
    varying float vAdd;
    void main() {
      #include <logdepthbuf_fragment>
      float raw = texture2D(uMap, gl_PointCoord).a;
      /* Cel quantisation of the sprite itself: FIVE flat bands now, crossed with ordered dither.
         The round-4 two-step version (g ∈ {0, .55, .90}) fixed the "giant blurred tan disc" but
         the review round-5 measured the next failure on the pad blast: "a soft beige disc whose
         alpha ramps terrac into visible stacked contour arcs" — three identical levels on a few
         dozen overlapping sprites stack into exact terraces, because wherever two sprites' band
         edges run near-tangentially the shared level reads as one drawn contour. Bayer 4×4
         (16 phases, 0.18 wide in raw units against the narrowest 0.20 gap between thresholds, so
         dither can never reorder the stack) turns every band edge into a 1-2 px checker whose
         local average interpolates — overlaps mix phase instead of level, no terrace. Same single
         texture fetch; a handful of arithmetic steps, no more samples, no noise texture. */
      vec2 m4 = mod(floor(gl_FragCoord.xy), 4.0);
      float b2a = fract(floor(m4.x * 0.5) * 0.5 + floor(m4.y * 0.5) * floor(m4.y * 0.5) * 0.75);
      float bay = b2a * 0.25 + fract(m4.x * 0.5 + m4.y * m4.y * 0.75);   // 16 phases, [0,1)
      float d = raw + (bay - 0.5) * 0.18;
      float g = step(0.18, d) * (0.40 + 0.15 * step(0.40, d)
                                       + 0.17 * step(0.58, d)
                                       + 0.18 * step(0.80, d));   // {0, .40, .55, .72, .90}
      float a = g * vA;                                   // composited coverage
      if (a + g * vAdd < 0.004) discard;
      gl_FragColor = vec4(vTint * g * (vAdd + vA), a);    // premultiplied
    }`,
  vertexColors: true,
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
});

const plume = new THREE.Points(pGeo, plumeMat);
plume.frustumCulled = false;
plume.castShadow = false;
/* Fill-rate is all this draw call costs — 16 ms of a 31.6 ms frame at full throttle on the pad,
   measured — so it is drawn in the half-resolution pass (js/halfres.js), after the weather. */
plume.layers.set(LAYER_FX);
plume.renderOrder = 3;
const _dbSize = new THREE.Vector2();
/* The same world-space attenuation PointsMaterial uses (so a parcel is its true diameter at any
   zoom, from pad camera to system view), recomputed from the live camera on render — vehicle.js
   does not own the camera and must not assume its fov. */
plume.onBeforeRender = (renderer, sc, cam) => {
  if (!cam.isPerspectiveCamera) return;
  renderer.getDrawingBufferSize(_dbSize);
  plumeMat.uniforms.uScale.value = _dbSize.y * RES_SCALE / (2 * Math.tan(cam.fov * Math.PI / 360));
};

/* Relief wiring. What world.js actually exports is body-aware: groundHeight / fineGroundHeight for
   Earth (fine = coarse + near-level detail, shoreline-weighted, pad flattening already baked in)
   and moonGroundHeight for the Moon — no fine getter there because the Moon has no near level; its
   coarse field IS its terrain. All return km above the reference sphere, which is exactly the unit
   this collider adds, and all return 0 while the field is unbuilt or when the direction misses.
   Lookup stays runtime-typed on purpose: a renamed export must never take the game down the way a
   missing named import just did to terrain.js, and every silent fallback increments plumeDebug —
   so "the exhaust looks wrong" arrives with a named cause instead of a mystery. The per-parcel
   last-good cache (pTh) is the boot-order guard: before the fields exist a 0 is honest (the mesh
   is a smooth sphere at that moment), but once a parcel has sampled real relief a later 0 never
   drops it through a mountain — worst case a puff collides slightly early, conservative beats
   swallowed. Lunar relief runs −1.45..+2.0 km: without this, highland burns spray dust up to 2 km
   INSIDE the ground and crater burns spray it above a surface that is not there. */
export const plumeDebug = { causeField: 0, causeNaN: 0, causeHeight: 0, causeBell: 0, zeroSize: 0 };
const _tdir = new THREE.Vector3();
function reliefAt(dx, dy, dz, moon, i) {
  const fn = moon ? WORLD.moonGroundHeight
    : (typeof WORLD.fineGroundHeight === 'function' ? WORLD.fineGroundHeight : WORLD.groundHeight);
  if (typeof fn !== 'function') { plumeDebug.causeField++; return pTh[i]; }
  _tdir.set(dx, dy, dz);                                  // uvAlong normalizes; NaN dirs miss → 0
  const v = fn(_tdir);
  if (!(v === v)) { plumeDebug.causeHeight++; return pTh[i]; }
  if (v !== 0) pTh[i] = v;                                // 0 = unbuilt/miss OR true sea level; keep the last good
  return pTh[i];
}

/* Engine exit tables, straight off the built geometry, in build units. `dir` is the axis the flow
   leaves along (outboard F-1s cant 0.1 rad outward, matching their gimbal trim); `th` is each
   bell's divergence half-angle from lip radius and bell length — atan((1.17−0.42)/2.6) ≈ 0.28 for
   the F-1, atan((0.70−0.30)/1.9) ≈ 0.21 for the J-2, atan((0.85−0.32)/1.7) ≈ 0.30 for the S-IVB.
   `ve` is Isp·g0 in km/s — 2.98 / 4.07 / 4.12 — the same number physics.js divides thrust by to
   spend propellant. u1/u2 span the exit plane. */
const _ba = new THREE.Vector3(), _bb = new THREE.Vector3();
function bellA(x, y, z, dx, dy, dz, rb, th) {
  _ba.set(dx, dy, dz).normalize();
  _bb.set(Math.abs(_ba.z) > 0.9 ? 1 : 0, 0, Math.abs(_ba.z) > 0.9 ? 0 : 1);   // helper axis, never parallel to dir
  _bb.crossVectors(_ba, _bb).normalize();
  _ba.crossVectors(_bb, _ba).normalize();
  return { x, y, z, dx, dy, dz, rb, th, u1x: _bb.x, u1y: _bb.y, u1z: _bb.z, u2x: _ba.x, u2y: _ba.y, u2z: _ba.z };
}
const BELL_SETS = [
  { ve: SPECS[0].isp * 9.81 / 1000, rate: 900, tailZ: -42, hullR: 3.63, bells: (() => {
      const a = [bellA(0, 0, -42, 0, 0, -1, 1.19, 0.28)];
      for (let i = 0; i < 4; i++) {
        const an = i * Math.PI / 2 + Math.PI / 4, c = Math.cos(an), s = Math.sin(an);
        /* exit centre: bell centre -40.7 shifted half a bell length along the canted axis,
           bolt circle r 2.35 pushed out by the same cant */
        a.push(bellA(c * (2.35 + 1.3 * Math.sin(0.1)), s * (2.35 + 1.3 * Math.sin(0.1)), -40.7 - 1.3 * Math.cos(0.1),
                     c * Math.sin(0.1), s * Math.sin(0.1), -Math.cos(0.1), 1.15, 0.28));
      }
      return a; })() },
  { ve: SPECS[1].isp * 9.81 / 1000, rate: 520, tailZ: -11.8, hullR: 3.57, bells: (() => {
      const a = [bellA(0, 0, -11.8, 0, 0, -1, 0.72, 0.21)];
      for (let i = 0; i < 4; i++) {
        const an = i * Math.PI / 2 + Math.PI / 4, c = Math.cos(an), s = Math.sin(an);
        a.push(bellA(c * 1.44, s * 1.44, -11.8, 0, 0, -1, 0.70, 0.21));
      }
      return a; })() },
  { ve: SPECS[2].isp * 9.81 / 1000, rate: 240, tailZ: 6.8, hullR: 2.42, bells: [bellA(0, 0, 6.8, 0, 0, -1, 0.85, 0.30)] },
];

/* Emission bookkeeping. rate is parcels/s at full throttle — a visual proxy for ṁ ∝ thrust·throttle,
   per-stage tuned to bell count and pool budget (stage 0: 260/s against mean life ~1.7 s wants
   ~450 live parcels; the pad blast deserves the rest of the pool for smoke). */
let emitAcc = 0;
let bellCursor = 0;
let lastSpawnT = 0;                       // sim-time seconds; emission charges against the mission clock

/* Live frame of the vehicle, cached each frame by updateBurnVisuals so updateParticles — called
   separately and without arguments by main.js — still knows where the hull is. */
const shipPos = new THREE.Vector3(), shipVel = new THREE.Vector3(), shipQuat = new THREE.Quaternion();
const shipQuatI = new THREE.Quaternion();
let shipHullR = 3.63 * VS, shipTailZ = -40, shipTopZ = 37.6, shipLive = false;

const _mo = new THREE.Vector3(), _mv = new THREE.Vector3();
const _lv = new THREE.Vector3(), _lw = new THREE.Vector3();
const _sp = new THREE.Vector3(), _svv = new THREE.Vector3();

/* Scratch outputs of the ground response — no allocation anywhere in the hot loop. */
let _bx = 0, _by = 0, _bz = 0, _hit = 0;

/* Ground response, shared by both bodies. `n` is the outward surface normal at the parcel; `fr*`
   the surface's own velocity there (Earth's ground co-rotates, the Moon travels at moonVel — the
   same two frames physics.js's groundVel uses, for the same reason: relative to the wrong ground,
   a blast on the Moon would drift sideways at 1.02 km/s or a pad blast would slide west at 409 m/s). */
function groundHit(vx, vy, vz, nx, ny, nz, frx, fry, frz, moon) {
  let rx = vx - frx, ry = vy - fry, rz = vz - frz;
  const vn = rx * nx + ry * ny + rz * nz;
  _hit = 0;
  if (vn < 0) {
    let tx = rx - vn * nx, ty = ry - vn * ny, tz = rz - vn * nz;   // tangential: survives — it rolls
    let tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tl < 1e-6) {                                                // straight-on: any tangent will do
      tx = -ny; ty = nx; tz = 0; tl = Math.sqrt(tx * tx + ty * ty);
      if (tl < 1e-6) { tx = 1; ty = 0; tz = 0; tl = 1; }
    }
    const s = -vn;                                                  // impact speed into the surface
    const k = 1 / tl;
    /* Earth: the outward term multiplies the FULL jet speed, and at 0.55 the deflected sheet left
       the trench at 0.55 × 2.9 km/s = 1.6 km/s — it crossed the 700 m pad in half a second, so at
       any shutter time later than the first frame the blast read as NOTHING but a glow (measured
       live MET 2.5: deck clear, 1 229 parcels already 700 m out and 6 cm thin). A trench sheet is
       around Mach 1: 0.08 × 2.9 = 230 m/s leaves the pad still a wall of smoke. The Moon keeps
       0.75 — Apollo's vacuum ejecta really did run far, and frames 13/14 are certified on it. */
    const out = (moon ? 0.75 : 0.08) * s;                            // impact → outward flow
    /* Tangential bleed. It used to survive the hit whole — `tx * (1 + out·k)` — so deflectate left
       the trench at close to exhaust speed and painted a 200 m field of discrete glowing domes around
       the pad. Air, the trench walls and the berm do not allow that: the flow arrives supersonic and
       leaves as a ground-hugging sheet at a fraction of the speed. The Moon bled almost nothing (0.8)
       and the spray left frame in one breath: a translucent gradient cone with no surface event at
       all (review2/12, review2/15). 0.45 keeps a long Apollo-style throw but decelerates the dust
       enough that it crawls, piles and reads as ground interaction. */
    const keep = moon ? 0.45 : 0.12;
    /* Lift is bounded: real deflectate rises by entrainment, not by keeping 16% of Mach-9
       momentum — uncapped this launched the pad blast 2 km into the sky. */
    const up = Math.min(s * (moon ? 0.04 : 0.08), moon ? 0.03 : 0.05);
    /* All three components take the same factor. The bleed used to be written on `rx` alone, so a
       parcel deflected off the trench floor kept its full tangential speed in y and z and the pad
       got a field of discrete puffs flung outward at close to exhaust velocity — the `keep` value
       below had almost no effect, which is why tuning it appeared to do nothing. */
    const flow = keep + out * k;
    rx = tx * flow + nx * up;                                       // bled tangential + re-aimed impact + lift
    ry = ty * flow + ny * up;
    rz = tz * flow + nz * up;
    _hit = 1;
  }
  _bx = rx + frx; _by = ry + fry; _bz = rz + frz;
}

/* Generic particle — the contract physics.js calls for staging puffs and the explosion. Same pool,
   same gravity, same colliders (debris sparks bounce off the pad too), but it keeps the exact
   colour it was handed and skips the heat/band machinery. Signature extended with two OPTIONAL
   trailing args (physics.js's 4-arg explosion calls are unchanged): `size0` in metres, and
   `smoke` = 1 to make the parcel swell like an entraining cloud instead of a fixed spark. The
   staging burst used to be 26 identical 3.5 m puffs strung along the spent stage's arc at one per
   frame — a pearl necklace. Real staging events are a billowing cloud, so the callers now ask for
   big smoke parcels, and updateDebris keeps that cloud fed along the whole debris fall. */
export function spawnParticle(pos, vel, life, color, size0 = 3.5, smoke = 0) {
  const i = allocSlot(), i3 = i * 3;
  pMode[i] = 2; pSmoke[i] = smoke;
  moonPos(getSimTime(), _mo);     // ff() moves the sim clock without running updateParticles; don't trust the cache
  const dx = pos.x - _mo.x, dy = pos.y - _mo.y, dz = pos.z - _mo.z;
  pMoon[i] = dx * dx + dy * dy + dz * dz < SOI2 ? 1 : 0;
  pPos[i3] = pos.x; pPos[i3 + 1] = pos.y; pPos[i3 + 2] = pos.z;
  pVel[i3] = vel.x; pVel[i3 + 1] = vel.y; pVel[i3 + 2] = vel.z;
  pColB[i3] = color[0]; pColB[i3 + 1] = color[1]; pColB[i3 + 2] = color[2];
  pR[i] = size0; pHeat[i] = 0; pAge[i] = 0; pLife[i] = life; pInv[i] = 1 / Math.max(0.05, life);
  pTh[i] = 0;
}

/* Nozzle-exit emission. Called from updateBurnVisuals with the simulated seconds that frame
   represents (frame dt × warp), so at warp the emission is charged honestly and then capped —
   the plume thins under extreme warp rather than falling further and further behind. */
function spawnPlume(set, pos, quat, vel, throttle, simDt) {
  moonPos(getSimTime(), _mo);     // so a burn right after an ff() jump picks the right body underneath
  const onMoon = pos.distanceToSquared(_mo) < SOI2;
  const veEff = set.ve * (0.45 + 0.55 * throttle);     // throttle sets exit velocity, not sprite size
  emitAcc += set.rate * throttle * simDt;              // parcels/s: the mass flow at rendering resolution
  let n = emitAcc | 0; emitAcc -= n;
  if (n > 240) n = 240;                     // 240 = the busiest set × the warp clamp's frame budget
  /* review3/04/06: ±74 m/s per axis of turbulence at the exit scattered the column into a
     300 m-wide confetti cone — consecutive parcels left the SAME streamline 25 m apart sideways
     within 0.2 s, which no sane sprite can bridge. The bell divergence (b.th ≈ 0.28 rad ≈ 16°)
     is the real cone; this jitter only has to keep it from looking like a solid sheet —
     halved to ±37 m/s (Moon keeps its own 0.02, the certified Apollo spray). */
  const jit = veEff * (onMoon ? 0.02 : 0.025);
  const bells = set.bells, nb = bells.length;
  /* One frame charges n parcels, and they all left the nozzle at different instants of the interval
     the frame represents. Emitting them together put a fresh clump at the vehicle every 16 ms while
     the vehicle itself moved on, so the ascent trail came out as a ringed fir tree — one visible
     shell per frame, evenly spaced by the frame rate. Parcel c therefore belongs to the moment
     `tau` seconds ago: back-project the exit point along the velocity, and let age, remaining life
     and heat start as they would have, so the stream is continuous. */
  const span = simDt / n;
  const rope = !onMoon && pos.length() - RE < 40;   // ascent-rope regime — see stepParcel's growth gate
  for (let c = 0; c < n; c++) {
    const tau = (c + Math.random()) * span;
    const b = bells[(bellCursor++) % nb];
    const fr = Math.sqrt(Math.random());               // uniform over the exit disc
    const ph = Math.random() * Math.PI * 2, cx = Math.cos(ph), sx = Math.sin(ph);
    const rx = b.u1x * cx + b.u2x * sx, ry = b.u1y * cx + b.u2y * sx, rz = b.u1z * cx + b.u2z * sx;
    const f = fr * b.rb;
    /* geometric expansion along the bell's divergence half-angle, growing with radial position
       on the lip (a hollow cone would look wrong; a real exit plane fills the angle linearly) */
    const spread = b.th * fr * (0.9 + Math.random() * 0.3);
    const wx = b.dx + rx * spread, wy = b.dy + ry * spread, wz = b.dz + rz * spread;
    const il = 1 / Math.sqrt(wx * wx + wy * wy + wz * wz);
    const v = veEff * (0.92 + Math.random() * 0.16);
    _svv.set(wx * il, wy * il, wz * il).multiplyScalar(v).applyQuaternion(quat);
    _sp.set((b.x + rx * f) * VS, (b.y + ry * f) * VS, (b.z + rz * f) * VS).applyQuaternion(quat).add(pos)
      .addScaledVector(vel, -tau);
    const i = allocSlot(), i3 = i * 3;
    pMode[i] = 1; pSmoke[i] = 0; pMoon[i] = onMoon ? 1 : 0;
    pPos[i3] = _sp.x; pPos[i3 + 1] = _sp.y; pPos[i3 + 2] = _sp.z;
    pVel[i3] = _svv.x + vel.x + (Math.random() - .5) * jit;
    pVel[i3 + 1] = _svv.y + vel.y + (Math.random() - .5) * jit;
    pVel[i3 + 2] = _svv.z + vel.z + (Math.random() - .5) * jit;
    /* `rate` is a rendering-resolution knob, not mass flow (that lives in js/physics.js), so dropping
       the throttle drops the parcel count and the trail came out as separated beads at 40 %. Give the
       survivors proportionally more radius: the same exhaust column, drawn with fewer sprites.
       The base was raised 0.8→1.6 m for review3/04/06: with the sprite now band-quantised (crisp
       disc out to 0.63 of its quad instead of a glowing point with a gradient skirt), the old
       birth radius put hard gaps between consecutive silhouettes — at the S-IC's 900/s the parcels
       leave 3.2 m apart at 2.9 km/s, and a banded silhouette is only ≈3× the parcel radius, so
       anything under ~1.5 m draws as a string of confetti, not a column. Overlap is finished off
       by stepParcel's early-growth boost below. */
    pR[i] = (1.6 + Math.random() * 1.4) * (1 + (1 - throttle) * 1.3);
    /* low throttle also shortens the parcel's life — slow flow does not carry soot to orbit.
       On the Moon the multiplier buys the long, bright, lingering spray of Apollo 11's ascent. */
    const life = (1.1 + Math.random() * 1.2) * (0.6 + 0.4 * throttle) * (onMoon ? 2.2 : 1);
    /* Below 40 km the trail is the whole ascent read (review2/04), and the back-projection above is
       the one place that could still starve it: tau grows with simDt, so a 1 s frame at warp billed
       the oldest parcels up to 1 s of age at birth and they died before they were ever drawn. The
       rope regime floors REMAINING life at 0.9 s — age and pInv stay honest, so the fade shape is
       untouched; only an early death is refused. */
    pLife[i] = rope ? Math.max(0.9, life - tau) : life - tau;
    pInv[i] = 1 / life; pAge[i] = tau;
    pHeat[i] = Math.max(0, 1 - tau * 2.4);               // the same cooling rate stepParcel applies
    pTh[i] = 0;
  }
}

/* Lunar ground-event extras — review3/14/15: ejecta read as "dots floating mid-air with no
   ground interaction". The deflected parcels themselves crawl away; what was missing was the
   record on the surface. Two events, both throttled on SIM seconds, not hit counts — during a
   hover burn every substep carries dozens of ground contacts and an unthrottled spawn would
   eat the 1 600-slot pool:
   · Scorch: 3-4 long-life (6-10 s) parcels pinned at the contact point with near-zero relative
     velocity (SM_SCORCH: coverage only, additive OFF — the certified young-lunar ×3 lift is a
     mode-1 path and must never brighten these; their ad is 0 at the source). They creep outward
     at 1.3 m/s and read as a stain under the plume — round 5: a MID grey-tan stain, because the
     near-black of earlier cuts read to the reviewer as "dark smoke spheres … combustion smoke,
     wrong on an airless body". An airless scorch is displaced dust, not soot.
   · Spray fan: N ground-launched parcels (SM_SPRAY) on explicit ballistic arcs — elevation
     2°…30° cubic-dense flat (a low radial sheet, apex median ~1 m), ±30° azimuth about the
     exhaust axis as the ground reflected it (that IS the deflected flow t: groundHit turns the
     jet tangentially), launch speed scaled to the engine's footprint, birth scatter inside the
     footprint itself. See the block inside.
   Both ride spawnParticle (mode 2: fixed colour, no heat machinery, generic colliders). The
   clock is frozen across a frame's substeps, so the throttle is per rendered frame regardless
   of h or warp; a reset()/teleport clock rewind re-arms the timers (t < last ⇒ rewound). */
const SCORCH_COLOUR = [0.32, 0.28, 0.22];     // disturbed regolith: mid grey-tan stain (sRGB ≈ 153/144/128)
const SPRAY_COLOUR = [0.82, 0.75, 0.63];      // dust tone (sRGB ≈ 236/226/209), in family with BAND_C[4]
let lastScorchT = -99, lastFanT = -99;
function ejectaEvents(gx, gy, gz, nx, ny, nz, rx, ry, rz) {
  const t = getSimTime();
  if (t < lastScorchT) { lastScorchT = -99; lastFanT = -99; }
  const fan = t - lastFanT >= 0.16;
  const scor = t - lastScorchT >= 0.5;
  if (!fan && !scor) return;
  const tl = Math.sqrt(rx * rx + ry * ry + rz * rz);
  // ground-plane basis at the contact: t along the deflected flow, h ⊥ t in the tangent plane
  let vn = rx * nx + ry * ny + rz * nz;
  let tx = rx - vn * nx, ty = ry - vn * ny, tz = rz - vn * nz;
  let td = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (td < 1e-9) { tx = -ny; ty = nx; tz = 0; td = Math.sqrt(tx * tx + ty * ty); }
  if (td < 1e-9) { tx = 1; ty = 0; tz = 0; td = 1; }
  const q = 1 / td; tx *= q; ty *= q; tz *= q;
  let hx = ty * nz - tz * ny, hy = tz * nx - tx * nz, hz = tx * ny - ty * nx;
  const hl = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
  hx /= hl; hy /= hl; hz /= hl;
  /* Engine height above the ground underneath, metres: the one number that sets BOTH how much
     dust is cut and how far it can be thrown (surface momentum flux ∝ 1/footprint-area). The
     round-5 review: at ~9 m the parcels sprinted to the horizon as an even scatter of uniform
     bokeh discs ("not anchored to the engine, no ballistic arcs"), and at 200 m the sheet was
     nearly absent. Same defect both times: speed rode the deflected jet's own tl (2.4-4.5 km/s
     before the cap — the measured figure below) so every parcel drew the far field, and the
     count was a constant 5/0.16 s whatever the altitude. Both now scale with the engine. */
  const altM = shipLive ? Math.max(4, (shipPos.distanceTo(_mo) - RM) * 1000) : 1200;
  if (fan && tl > 1e-9) {
    lastFanT = t;
    const nF = Math.max(3, Math.min(11, Math.round(11 * 160 / (altM + 110))));   // 10 @ 9 m, 8 @ 200 m, 3 ≥ ~3.7 km
    const vmax = 0.045 + 0.009 * Math.sqrt(altM);   // km/s: 72 @ 9 m, 187 @ 200 m, 330 @ 1 km
    const rf = (altM * Math.tan(0.30) + 6) * 0.001; // jet footprint radius (bell half-angle + jitter), km
    for (let c = 0; c < nF; c++) {
      /* Launch state sampled from a cone about the exhaust axis as the ground reflected it —
         that reflection IS t, the deflected flow (groundHit turns the jet tangentially and
         keeps 0.45 of it here) — ±30° in azimuth. Every parcel therefore leaves on a ballistic
         arc (apex v²sin²β/2g): the old launch had vn ≤ 1.5 m/s — an apex under 0.7 m, no arc to
         see, just a disc crawling sideways; the 10-68° law that replaced it put the field in the
         air (see the beta note below). */
      const phi = (Math.random() - 0.5) * (Math.PI / 3);
      const cp = Math.cos(phi), spn = Math.sin(phi);
      const tpx = tx * cp + hx * spn, tpy = ty * cp + hy * spn, tpz = tz * cp + hz * spn;
      const u = Math.random();
      /* The 1.5 km/s sub-orbital cap is CERTIFIED and stays: above ~1.6 km/s the convex ground
         falls away at v²/2R and the parcel outruns its own contact (measured: uncapped fans hit
         tl 2.4-4.5 km/s and gained 8 m in the first second). The new speed law never asks for
         more than vmax ≤ 0.59 km/s inside any plausible burn height (128 km/sqrt… beyond the
         game's own ceiling), and min() keeps the cap explicit for whoever scales vmax next. */
      const vv = Math.min(1.5, vmax * (0.14 + 0.86 * u * u * u));   // steep cubic: median 0.25·vmax
      /* Elevation 2°…30°, cubic-dense at the flat end (median 5.5°, p90 21°). The previous law
         (10° + 58°·r²) drew a MEDIAN of 24.5° — with the cubic speed law that put the common
         parcel on an apex of tens of metres and the fast ones (v·sinβ = 27 m/s at 68°) on
         1.4 km arcs: the 6 m capture frame showed the field as cream bokeh drifting at CAMERA
         height around the vehicle, the same defect review 4 called horizon scatter, just
         gathered closer. Apollo's dust was a low radial sheet hugging the ground — apex is
         v²sin²β/2g_moon with g = 1.62, and 30° cubic caps the median apex at ~1 m with the
         top parcel (65 m/s @ 29°) at ~350 m, 1.7 km out, where it reads as distance, not fog. */
      const beta = (2 + 28 * Math.pow(Math.random(), 3)) * Math.PI / 180;
      const cb = Math.cos(beta), sb = Math.sin(beta);
      /* birth scatter inside the footprint, denser toward the axis (r ∝ √u over the disc):
         near-engine density comes from where parcels are BORN now, not from a uniform point
         smeared outward by a uniform speed. */
      const jr = rf * Math.sqrt(Math.random()) * 0.6, ja = Math.random() * Math.PI * 2;
      const cj = Math.cos(ja), sj = Math.sin(ja);
      _sp.set(gx + (tpx * cj + hx * sj) * jr + nx * 0.001,
              gy + (tpy * cj + hy * sj) * jr + ny * 0.001,
              gz + (tpz * cj + hz * sj) * jr + nz * 0.001);
      _svv.set(_mv.x + (tpx * cb + nx * sb) * vv,
               _mv.y + (tpy * cb + ny * sb) * vv,
               _mv.z + (tpz * cb + nz * sb) * vv);
      /* 0.5-2.2× size spread about the 3 m base (median 1.1×): uniform discs were half of why the
         sheet read as lens bokeh — bokeh is uniform by definition. */
      const sm = 0.5 + 1.7 * Math.pow(Math.random(), 1.5);
      spawnParticle(_sp, _svv, 1.6 + Math.random() * 1.4, SPRAY_COLOUR, 3 * sm, SM_SPRAY);
    }
  }
  if (scor) {
    lastScorchT = t;
    const n2 = 3 + ((Math.random() * 2) | 0);                   // 3-4 patches
    for (let c = 0; c < n2; c++) {
      const j1 = Math.random() - 0.5, j2 = Math.random() - 0.5; // scatter ±~5 m about the contact
      _sp.set(gx + (tx * j1 + hx * j2) * 0.01,
              gy + (ty * j1 + hy * j2) * 0.01,
              gz + (tz * j1 + hz * j2) * 0.01);
      _svv.set(_mv.x + tx * j1 * 0.0006, _mv.y + ty * j1 * 0.0006, _mv.z + tz * j1 * 0.0006);
      // 0.55-1.65× about the 4 m base — the stain field is not uniform either
      spawnParticle(_sp, _svv, 6 + Math.random() * 4, SCORCH_COLOUR,
        4 * (0.55 + 1.1 * Math.random()), SM_SCORCH);
    }
  }
}

/* One parcel, one substep: body underneath → implicit drag → gravity → move → colliders →
   bookkeeping. Returns 1 when the parcel died. All units km / km/s / s except pR (metres). */
function stepParcel(i, h) {
  const i3 = i * 3;
  let px = pPos[i3], py = pPos[i3 + 1], pz = pPos[i3 + 2];
  let vx = pVel[i3], vy = pVel[i3 + 1], vz = pVel[i3 + 2];
  const moon = pMoon[i] === 1;

  if (moon) {
    /* No atmosphere at all: pure ballistics under MU_M, which is exactly why lunar exhaust
       reaches so far and settles so slowly. */
    let dx = px - _mo.x, dy = py - _mo.y, dz = pz - _mo.z;
    let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const g = MU_M / (d * d * d);
    vx -= dx * g * h; vy -= dy * g * h; vz -= dz * g * h;
    px += vx * h; py += vy * h; pz += vz * h;
    dx = px - _mo.x; dy = py - _mo.y; dz = pz - _mo.z;
    d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const gr = RM + reliefAt(dx, dy, dz, 1, i);
    if (d < gr) {
      const nx = dx / d, ny = dy / d, nz = dz / d;
      groundHit(vx, vy, vz, nx, ny, nz, _mv.x, _mv.y, _mv.z, 1);   // the ground travels with the Moon
      px = _mo.x + nx * gr; py = _mo.y + ny * gr; pz = _mo.z + nz * gr;
      if (_hit) {
        if (pSmoke[i] === SM_SCORCH || pSmoke[i] === SM_SPRAY) {
          /* Ground-pinned extras settle WITHOUT bouncing. groundHit's straight-on fallback
             (tl < 1e-6) builds `tx = -ny; ty = nx` — a unit DIRECTION consumed as a VELOCITY —
             so anything landing exactly vertically gets the full keep(0.45) km/s tangential
             kick; measured: a scorch parcel crawled +376 m/s upslope, riding that fallback
             every step it re-settled. That fallback is a corner case for the certified blast
             flow and stays untouched; the correct response for a settling patch of dust is to
             cancel the into-ground velocity component and keep the tangential, position-snapped
             to the surface above. */
          let vrx = vx - _mv.x, vry = vy - _mv.y, vrz = vz - _mv.z;
          const vrn = vrx * nx + vry * ny + vrz * nz;
          if (vrn < 0) { vrx -= nx * vrn; vry -= ny * vrn; vrz -= nz * vrn; }
          vx = vrx + _mv.x; vy = vry + _mv.y; vz = vrz + _mv.z;
        } else {
        vx = _bx; vy = _by; vz = _bz;
        /* Regolith ejecta is pulverised cold rock, not flame, so heat drops below ember on first
           contact. Nothing else cools it here: the vacuum branch has no drag and its cooling term is
           barely half Earth's, so a deflected parcel used to run outward still incandescent for a
           second and a half and the surface event read as a shower of glowing sparks rather than the
           low grey sheet Apollo filmed. The band floor below turns it to dust from 20 ms. */
        if (!pSmoke[i]) pHeat[i] = Math.min(pHeat[i], 0.3);
        /* Reaching here excludes SM_SCORCH/SM_SPRAY (settled above), so the smoke conversion and
           the ×1.25 contact inflation apply once per real deflection — a pinned patch can no
           longer balloon itself to the 16 m ceiling by re-contacting every step. ejectaEvents
           fires only on these real plume-deflection hits, never on settling. */
        pSmoke[i] = 1;                                    // deflected; age gate decides sheet vs dust
        /* The 16 m entrainment ceiling is an AIR rule — a smoke puff grows by dragging air with
           it, and there is no air here. Vacuum ejecta churns at fragment scale: capping the
           contact swell at 7 m is what the physics says, and it is also what the 9 m capture
           frame demanded: with the old ×1.25+0.2 walking to R_CAP, 450 live deflected parcels
           (parcelAudit) drifted between the descending vehicle and the chase camera as
           camera-facing 16 m discs — the lens-bokeh field review 4 punished, back in a paler
           palette. At 7 m and the shorter vacuum life below the near-camera coverage per parcel
           falls by ~4.5x and the sheet reads as ground-hugging dust again. */
        pR[i] = Math.min(7, pR[i] * 1.25 + 0.2);
        pLife[i] = Math.min(pLife[i], 1.3);
        ejectaEvents(px, py, pz, nx, ny, nz, _bx - _mv.x, _by - _mv.y, _bz - _mv.z);
        }
      }
    }
  } else {
    const r2 = px * px + py * py + pz * pz;
    const r = Math.sqrt(r2);
    const alt = r - RE;
    if (alt < 420) {
      const rho = airDensity(alt);
      if (rho > 0) {
        const ax = -EARTH_SPIN * pz, az = EARTH_SPIN * px;          // the atmosphere rides the spin
        let rx = vx + ax, ry = vy, rz = vz + az;
        const vMps = Math.sqrt(rx * rx + ry * ry + rz * rz) * 1000;
        if (vMps > 1e-6) {
          let bal = BAL0 * (pMode[i] === 2 ? 6 : 1) / (pR[i] * pR[i]);
          /* Ground-marked smoke drags like the air-full puff it has become; a 1/r² law alone lets
             it coast at hundreds of m/s for its whole life, which reads as shrapnel, not soot.
             review3/04/06 extends the SAME floor to every mode-1 parcel: a fresh jet that keeps
             2.9 km/s for a second and a half (the old regime — entrainment grows pR, and bal is
             1/r², so growth made the parcels FLY) stretched the ascent trail into a 2 km cone of
             dots ~75 m apart, which no 1600-parcel pool can fill. A real F-1 column couples to
             the air within a few hundred metres and piles into the rope the launch actually
             drags; the floor does exactly that — τ ≈ 0.1 s against the ground-slip at the pad's
             air, and nothing at all where there is no air (vacuum CSM stays ballistic, which is
             correct and is fixed instead by cooling to smoke). The pad's jet meets the trench
             floor within one or two substeps, before drag can shape it. */
          if (pMode[i] === 1) bal = Math.max(bal, 0.005);
          bal = Math.min(BAL_CAP, bal);
          const f = 1 / (1 + bal * rho * vMps * h);                 // exact linearised drag step
          const diss = (1 - f) * vMps;                              // m/s of slip shed → entrainment
          rx *= f; ry *= f; rz *= f;
          vx = rx - ax; vy = ry; vz = rz - az;
          pR[i] = Math.min(R_CAP, pR[i] + Math.min(14, diss * 0.016) * h);
        }
      }
    }
    const g = MU_E / (r2 * r);
    vx -= px * g * h; vy -= py * g * h; vz -= pz * g * h;
    px += vx * h; py += vy * h; pz += vz * h;

    /* Ground: the sphere, plus the LC-39 dome where its footprint applies. The quadratic cap is
       one dot product and one multiply, and it fades to exactly RE at the footprint rim so there
       is no step in the surface. The gate margin (0.6 km) exceeds the largest single-substep fall
       (~142 m at the clamp), so nothing can skip the test and the planet. */
    if (alt < 0.6) {
      const r2b = px * px + py * py + pz * pz;
      const rb = Math.sqrt(r2b);
      const up = px * PAD_UP.x + py * PAD_UP.y + pz * PAD_UP.z;
      const h2 = r2b - up * up;
      /* Bowl inside the trench opening (floor below r = RE — the bells dip into it), berm ring
         between the trench and the complex footprint, planet sphere everywhere else. Continuous
         at both rims by construction: each profile is zero at its own boundary. */
      let gr = RE;
      if (h2 < TRP2) gr = RE - TRENCH * (1 - h2 / TRP2);
      else if (h2 < PAD_RP2) gr = RE + PAD_BERM * ((h2 - TRP2) / (PAD_RP2 - TRP2)) * (1 - h2 / PAD_RP2);
      gr += reliefAt(px, py, pz, 0, i);
      if (rb < gr) {
        const nx = px / rb, ny = py / rb, nz = pz / rb;
        groundHit(vx, vy, vz, nx, ny, nz, EARTH_SPIN * pz, 0, -EARTH_SPIN * px, 0);
        px = nx * gr; py = ny * gr; pz = nz * gr;                   // it does not go through the pad
        if (_hit) {
          vx = _bx; vy = _by; vz = _bz;
          /* Every parcel meets "ground" within a step of birth — the F-1 plane sits below the
             trench floor, inside its own flame trench. pSmoke therefore marks "ground-deflected
             flow", not "soot": it drives the faster cooling, the entrainment swell and the drag
             floor, while the colour stays on the heat curve — the deflected sheet is flame until
             its own heat says smoke. */
          /* One cut of life on first contact. Deflectate used to live its whole 3 s and the roll
             crept out to the horizon as a flat ground fog; the real blast cloud is a few hundred
             metres of churn around the pad that thins fast. Guarded on the flag so a parcel resting
             on the ground is not re-capped every step. */
          if (!pSmoke[i]) pLife[i] = Math.min(pLife[i], 1.15);
          /* Inside the trench itself the flow is still a coherent jet: hold the heat there so the
             pad keeps a bright fire under the vehicle, while the roll climbing out of it cools to
             cloud. Without this the whole event read as grey smoke with a few sparks.
             0.66, not 0.82: the hold sat ABOVE the incandescent band threshold (0.75), so every
             parcel resting in the trench drew band 0 at additive ≈ 1 and the order-free glow
             stacked into the blown-out white pillar the review measured punching up through the
             pad (review2/03). Held below 0.75 it still reads as saturated flame orange, the
             20 ms band gate below turns resting parcels to cloud anyway, and the fire that
             remains visible is the young jet sheet plus the drawn cone. */
          if (h2 < TRP2) pHeat[i] = Math.max(pHeat[i], 0.66);
          pSmoke[i] = 1;
          pR[i] = Math.min(R_CAP, pR[i] * 1.6 + 0.6);
        }
      }
    }
  }

  /* The vehicle's own hull: one cylinder in vehicle frame from the active tail to the LES tip,
     push out along the surface normal and damp-reflect the crossing velocity against the moving
     hull. The cheap bounding test rejects every parcel except the few dozen near the engines. */
  if (shipLive) {
    const hx = px - shipPos.x, hy = py - shipPos.y, hz = pz - shipPos.z;
    if (hx * hx + hy * hy + hz * hz < 0.02) {
      _lv.set(hx, hy, hz).applyQuaternion(shipQuatI);
      const z = _lv.z / VS;
      if (z > shipTailZ && z < shipTopZ) {
        const dl = Math.sqrt(_lv.x * _lv.x + _lv.y * _lv.y);
        const lim = shipHullR + pR[i] * 0.001;
        if (dl < lim && dl > 1e-9) {
          const s = lim / dl;
          _lv.x *= s; _lv.y *= s;
          _lw.set(_lv.x, _lv.y, _lv.z).applyQuaternion(shipQuat);
          px = shipPos.x + _lw.x; py = shipPos.y + _lw.y; pz = shipPos.z + _lw.z;
          _lw.set(_lv.x / dl, _lv.y / dl, 0).applyQuaternion(shipQuat);
          const rvx = vx - shipVel.x, rvy = vy - shipVel.y, rvz = vz - shipVel.z;
          const vn = rvx * _lw.x + rvy * _lw.y + rvz * _lw.z;
          if (vn < 0) {                                             // 45% rebound, 55% absorbed
            vx = rvx - 1.45 * vn * _lw.x + shipVel.x;
            vy = rvy - 1.45 * vn * _lw.y + shipVel.y;
            vz = rvz - 1.45 * vn * _lw.z + shipVel.z;
          }
        }
      }
    }
  }

  pPos[i3] = px; pPos[i3 + 1] = py; pPos[i3 + 2] = pz;
  pVel[i3] = vx; pVel[i3 + 1] = vy; pVel[i3 + 2] = vz;

  /* Bookkeeping: cooling, smoke growth, life. In vacuum nothing entrains and nothing cools fast,
     so the same numbers keep lunar parcels hot, small and flying several times longer. */
  if (pMode[i] === 1) {
    /* Radiation is the only cooling available in vacuum, but a vacuum plume that holds its fire for
       0.75 s at 2 km/s draws a kilometre of glowing beads behind the vehicle, and that light show is
       what the lunar surface event read as. Real exhaust in vacuum is faint — the visible event is
       the dust it lifts — so lunar parcels radiate away their incandescence faster than Earth parcels
       lose it to air.
       review3/04/06 measured the bead problem again AFTER the birth-size fix: the merge into smoke
       is what makes the column continuous, and parcels still took 0.62 s (Earth) / 0.46 s (Moon) to
       cool below the smoke threshold — at 2-3 km/s relative flow that is a 1.3-1.8 km streak of
       individual hot dots no sprite budget can fill (the drawn cone covers ~30 m). Cooling is now
       ~2× faster (Earth 1.25 → 2.4 /s, Moon 1.7 → 3.4/s, keeping the certified asymmetry that
       vacuum loses its fire FASTER): the incandescent/ember streak shrinks to a few hundred metres
       behind the drawn cone, and by then the early-growth boost has carried the parcel to ~4 m,
       whose smoke silhouette is ~16 m — overlapping the 3.2 m neighbour spacing several times. */
    pHeat[i] -= h * (moon ? 3.4 : 2.4) * (pSmoke[i] ? 2.2 : 1);
    /* Round-5 "ghost rocket": at MET+13 the tower region read as a second, intact vehicle wrapped
       in engine fire — 278 live parcels (measured, node harness, real ascent t=13 s) were still
       above the smoke threshold, because base cooling 2.4/s needs 0.33 s to get a parcel under
       heat 0.22 and at 900/s that is a third-of-a-second tail of ember discs at every altitude
       the trail ever touched. Two physical facts fix it: (1) embers quench by entraining COLD
       AIR — the rate must ride air density, which is what stepParcel's drag already reads — and
       (2) an ember that has survived to its second half has stopped mixing with the jet and is
       smoke on its way down. So: an age-ramped extra cooling weighted by ρ/ρ₀ (pad air: total
       ≈ 8.6/s → ember window ~0.1 s, measured hot count at real-ascent t=13: 278 → 77; 30 km up
       ρ/ρ₀=0.015 — the certified ascent rope above the atmosphere is untouched), a hard hue floor
       at 0.45 s, and a late-life decay that has the Earth-side population gone inside ~1.4 s of
       birth — the pad reads clear long before the 8 s the review asked for. */
    if (!moon) {
      const altE = Math.sqrt(px * px + py * py + pz * pz) - RE;
      const rhoN = altE < 420 ? airDensity(altE) / RHO_SEA : 0;
      pHeat[i] -= h * (rhoN * (5.5 + 3 * Math.max(0, pAge[i] - 0.12)) + 4 * Math.max(0, pAge[i] - 0.15));
      if (pAge[i] > 0.45 && pHeat[i] > 0.22) pHeat[i] = 0.22;
      if (pAge[i] > 0.85) pLife[i] -= h * (pAge[i] - 0.85) * 2;
    }
    /* Entrainment: ground-marked smoke swells fast — a Saturn's blast cloud doubles and redoubles
       in its first second, and a sprite that stays 2 m never dwarfs the crawler. Vacuum smoke
       (lunar dust) grows far less: there is no air to roll in. */
    /* Non-deflected exhaust entrains too: at 0.35 m/s the ascent trail was a string of separate beads
       rather than a column. Lunar parcels stay thin — a vacuum rolls in no air.
       Earth's figure used to be a flat 1.2 and the trail still degenerated into a thin squiggly
       thread at ~3 km (review2/04). Cause, measured through the two growth terms: the drag-diss swell
       in the atmosphere branch is `min(14, diss·0.016)·h` and `diss` is the slip SHED per step, so it
       collapses once the parcel flow has decelerated toward the vehicle — which is exactly what
       happens above a few km, where the 900/s emission still spaces parcels only 0.11 m apart at
       100 m/s. Spacing never separated the trail; the swell collapsing did. So the baseline carries
       the rope on its own: 1.9 m/s below 40 km, where the column is the whole read. The bead-merge
       rule from AGENTS.md still holds at the top of the regime — at 720 m/s and 520/s, spacing is
       1.4 m against a 21 m sprite diameter. */
    /* The first 0.45 s of a NON-deflected parcel's life grows at 2.6× the rate below. The
       sprite is band-quantised now (hard silhouette), so the old growth left measurable gaps
       between consecutive silhouettes in the ascent column (review3/04: scattered dots at
       222 m/s, 2.7 parcels/m); the boost closes them where the column is newest and hottest,
       then hands off to the certified steady rates — the bead-merge rule quoted above is a
       steady-state number and is untouched. Deflected (pSmoke) parcels deliberately skip the
       boost: the pad sheet is tuned, and R_YOUNG below already fights the blast dome. */
    const early = pAge[i] < 0.45 ? 2.6 : 1;
    pR[i] = Math.min(R_CAP, pR[i] + (pSmoke[i] ? (moon ? 5 : 10)
                                             : (moon ? 0.4 : (px * px + py * py + pz * pz < ALT40_R2 ? 1.9 : 1.2)) * early) * h);
    /* review3/03: the blast read as one giant blurred tan dome because the deflectate inflated
       to the 16 m ceiling within its first half-second — dome first, definition never. A young
       deflected parcel on Earth is now held at R_YOUNG for its first 0.5 s: the sheet climbing
       out of the trench stays a crisp column (its fire is the held trench heat + the drawn
       cone), and the dome is rebuilt from parcels that have already survived the young regime
       and entrain on their own. Lunar deflectate is exempt — the certified Apollo-style spray
       grows at its own 5 m/s — and so is everything older than 0.5 s. The 0.12 tangential
       bleed and the smoke-band age gate are untouched. */
    if (pSmoke[i] && !moon && pAge[i] < 0.5 && pR[i] > R_YOUNG) pR[i] = R_YOUNG;
  } else {
    /* Generic puffs: sparks keep their size; smoke-flagged ones entrain — but entrainment IS air.
       At 67 km staging there is nothing to roll in, and the ungated growth bloomed 26 puffs into
       kilometre-soft bokeh discs against the black: the reviewer's worst frame. The law now reads
       the same atmosphere the plume physics uses — full billow at the pad, ~nothing up high. */
    let grow = 2.4;
    if (pSmoke[i] === SM_SEAM) {
      /* Staging-seam puffs entrain exactly like certified smoke — the airDensity gate — but with
         a low ceiling: they read as dark silhouettes against the flash for 0.4-0.8 s, and at a
         67 km separation ρ≈0 keeps them at a few tenths of m/s. The ceiling matters down low:
         staging at the pad (the 'x' key) must not hand a young 14 m/s billow to a 0.5 s puff. */
      grow = moon ? 1.5 : 14 * THREE.MathUtils.clamp(
        airDensity(Math.sqrt(px * px + py * py + pz * pz) - RE) / 0.25, 0.02, 0.3);
    } else if (pSmoke[i] === SM_FLASH) {
      /* The staging flash stays SMALL: a light burst that billows is a smoke puff again. */
      grow = 0;
    } else if (pSmoke[i] === SM_SCORCH || pSmoke[i] === SM_SPRAY) {
      /* Lunar ejecta extras (see ejectaEvents): the Moon has no air, so the air gate is trivially
         satisfied — a slow creep constant is the honest ceiling for a ground patch that must stay
         flat. Off-Moon spawn sites (a staging at the pad also uses SM_SEAM, never these two)
         still grow, but bounded. */
      grow = pSmoke[i] === SM_SCORCH ? (moon ? 1.3 : 3) : (moon ? 1.8 : 6);
    } else if (pSmoke[i]) {
      if (moon) grow = 5;
      else {
        const rho = airDensity(Math.sqrt(px * px + py * py + pz * pz) - RE);
        grow = 14 * THREE.MathUtils.clamp(rho / 0.25, 0.03, 1);
      }
    }
    pR[i] = Math.min(R_CAP, pR[i] + grow * h);
  }
  pLife[i] -= h; pAge[i] += h;
  return pLife[i] <= 0 ? 1 : 0;
}

/* Draw-call anchor for the Float32 render mirror — see the note in fillBuffers. Chosen per frame
   before the mirror is refilled; the dense rebuild makes a moving anchor free. */
const plumeAnchor = new THREE.Vector3();

/* Refill the dense render prefix for the live set. The colour is a hard lookup on the heat index —
   no interpolation between bands anywhere; that step is the same quantisation the hull's
   gradientMap uses, applied to the flame. Hot parcels lean on `add` (glow, order-free), smoke
   leans on `alpha` (coverage, darkens the pale sky); the fragment composites both premultiplied.
   Any parcel whose state went non-finite upstream (a missing bell table, a field that defaulted,
   a NaN sneaking through a collider) is DROPPED here rather than uploaded: a NaN vertex colour
   renders as a black band no material toggle can remove, and a NaN position can smear the whole
   primitive — and the failure would be reported as "tuning", not as data. Every drop increments a
   named counter on plumeDebug so the same frame that looks wrong can be interrogated. */

function fillBuffers() {
  let w = 0, zs = 0;
  for (let k = 0; k < nAlive; k++) {
    const i = alive[k], i3 = i * 3;
    const x = pPos[i3], y = pPos[i3 + 1], z = pPos[i3 + 2];
    let sz = pR[i] * 0.005;               // generous glow diameter: 2.5× parcel radius
    if (sz === 0) zs++;
    let a, ad, cr, cg, cb;
    if (pMode[i] === 2) {
      cr = pColB[i3]; cg = pColB[i3 + 1]; cb = pColB[i3 + 2];
      const fade = Math.min(1, pLife[i] * 2) * Math.min(1, pAge[i] * 10 + 0.1);
      if (pSmoke[i] === SM_SEAM) {
        /* Staging-seam silhouette, round-5 tuned DOWN ("the flash is a lumpy soot-egg"):
           these puffs used to carry 0.22 coverage and were the egg's lumpiness. 0.13 now, and a
           0.10 s fade DELAY — the flash sprite (SM_FLASH) peaks at 22 ms and is gone by ~0.28 s,
           so the light burst reads FIRST and the seam smoke only then blooms behind it. ad is 0
           at the source: no additive anywhere near the separation event. */
        sz = pR[i] * 0.007;
        a = 0.13 * fade * THREE.MathUtils.clamp((pAge[i] - 0.10) * 10, 0, 1); ad = 0;
      } else if (pSmoke[i] === SM_SCORCH) {
        /* Scorch stain (0.004 = 4 m of disc per m of parcel radius, against the cloud disc's
           11.5), coverage-only, additive OFF. Round-5: 0.4 coverage of near-black WAS the "dark
           smoke spheres under the craft … combustion smoke" the reviewer flagged on an airless
           body — the SCORCH_COLOUR is now mid grey-tan and the coverage is down to 0.3, so the
           patch reads as disturbed dust, not a fire stain. */
        sz = pR[i] * 0.004;
        a = 0.3 * fade; ad = 0;
      } else if (pSmoke[i] === SM_SPRAY) {
        /* Ground-launched dust sheet, coverage-only (the ×3 young-lunar lift belongs to deflected
           mode-1 dust on its own flight, not to the fan). Coverage rides the parcel radius (the
           0.5-2.2× size spread, see ejectaEvents): a field of equal-alpha discs is what read as
           lens bokeh — real dust is optically thicker where there is more of it. */
        sz = pR[i] * 0.009;
        a = (0.18 + 0.10 * Math.min(1, pR[i] / 6)) * fade; ad = 0;
      } else if (pSmoke[i] === SM_FLASH) {
        /* Staging light burst: near-pure additive white, 15-27 m discs. In 22 ms, linear out,
           dead at 0.20-0.28 s — high luminance (ad hits 1.0, the vertex caps additive sprites at
           80 px so close up it is a crisp burst, not a lantern) and short enough that no smoke
           ever overlaps its peak. */
        sz = pR[i] * 0.007;
        a = 0.05; ad = Math.min(1, pAge[i] * 45) * Math.min(1, pLife[i] * 6);
      } else if (pSmoke[i]) {
        sz = pR[i] * 0.0115;               // wide disc: the burst must overlap into one cloud
        a = 0.30 * fade; ad = 0.04 * fade;  // coverage, almost no light — it is smoke, not sparks
      } else { a = 0.45 * fade; ad = 0.95 * fade; }  // sparks: mostly light, some body
    } else {
      const q = pHeat[i];
      let b = q > 0.75 ? 0 : q > 0.5 ? 1 : q > 0.22 ? 2 : (pMoon[i] ? 4 : 3);
      /* Deflected flow is smoke once it has mixed at all: 20 ms, or above-ember heat, either one
         keeps it flame. The gate has to be that short because the trench floor is one step from the
         bell — at the old 0.12 s the whole rolling cloud fired as flame and the pad bloomed orange;
         with no gate at all the pad had no fire whatsoever. Inside the trench the heat is held
         (stepParcel), so a bright sheet survives under the vehicle while the roll out to the FLR is
         already cloud. */
      if (pSmoke[i] && pAge[i] > 0.02 && q < 0.75) b = pMoon[i] ? 4 : (b < 3 ? 3 : b);
      /* Cloud discs are drawn at ~5.75× the parcel radius against the flame's 2.5×. At 2.5× a whole
         blast cloud rendered as a few hundred separate coins sprinkled over the flat — the parcels
         are metres across and hundreds of metres apart, and nothing merges. Wide discs overlap into
         one body; fire stays compact so the trench keeps an edge. */
      if (b >= 3) sz = pR[i] * 0.0115;
      /* The blast roll that hugs the ground is cloud, not soot: against grass a dark grey sprite reads
         as a scorch mark, and the pad ended up ringed with brown blots. Within 50 m of the sphere the
         smoke band swaps to the pale foot tone; higher up, where the same parcel silhouettes against
         the sky, it goes back to the dark grey that makes a column read. */
      if (b === 3 && (Math.sqrt(x * x + y * y + z * z) - RE) < 0.05) b = 5;
      const c = BAND_C[b]; cr = c[0]; cg = c[1]; cb = c[2];
      const fade = Math.min(1, pAge[i] * 8 + 0.05) * Math.min(1, pLife[i] * pInv[i] * 2.5 + 0.05);
      a = BAND_A[b] * fade; ad = BAND_G[b] * fade;
      /* Deflected flow is air-mixed the moment it leaves the trench, so it carries almost no light:
         at 0.5 it still read as a ring of flaming lanterns rolling across the flat, because glow is
         order-free and a hot parcel anywhere in the cloud lights whatever is behind it. The fire
         belongs to the trench (heat held there) and to the drawn cone, not to the roll.
         The multiply used to sit ABOVE the `ad =` line that overwrites it — it had never dimmed
         anything (the AGENTS species: read the arithmetic that consumes the factor). Every
         deflected parcel therefore left the trench at up to full band-0 additive for its first
         ~90 ms of cooling, and the stack was the white pillar of review2/03. It now lands, gated
         on the same 20 ms the band gate uses: the young sheet climbing out keeps its fire,
         everything older carries 18 %. Lunar settled dust is LIFTED, not dimmed, while young
         (age < 0.25 s): freshly deflected parcels briefly light the ground they crawl over, which
         is the "no ground interaction, no lit dust" half of review2/12 — at ×3 of the dust band's
         0.05 it is a glow, not a beam. */
      if (pSmoke[i] && pAge[i] > 0.02) ad *= (pMoon[i] && pAge[i] < 0.25) ? 3 : 0.18;
    }
    if (!(x === x && y === y && z === z && sz === sz && cr === cr && cg === cg && cb === cb && a === a && ad === ad)) {
      plumeDebug.causeNaN++;              // never uploaded; cause counted, frame continues
      continue;
    }
    const w3 = w * 3;
    /* GPU coordinates ride a Float32 grid: at lunar distance (~384,000 km) one unit-in-the-last-
       place is ~31 m, which is a third of the screen-height at a 50 m hover camera — sprites
       would wobble against a ground that THREE positions with float64 matrices. The dense mirror
       is rebuilt every frame anyway, so it is stored RELATIVE to plumeAnchor (the vehicle, which
       always lives within tens of km of any live parcel: ejecta outlives its burn by ≤10 s) and
       the Points node carries the anchor. Earth-side this changes nothing measurable (0.5 m grid
       at 6,371 km either way); Moon-side it is the difference between a dust sheet and confetti. */
    rPos[w3] = x - plumeAnchor.x; rPos[w3 + 1] = y - plumeAnchor.y; rPos[w3 + 2] = z - plumeAnchor.z;
    rCol[w3] = cr; rCol[w3 + 1] = cg; rCol[w3 + 2] = cb;
    rSiz[w] = sz; rAlp[w] = a; rAdd[w] = ad;
    w++;
  }
  aPos.needsUpdate = aCol.needsUpdate = aSiz.needsUpdate = aAlp.needsUpdate = aAdd.needsUpdate = true;
  pGeo.setDrawRange(0, w);
  plumeDebug.zeroSize = zs;               // per-frame snapshot: live parcels that would draw as zero-pixel points
  if (w > 0 && _idChecked === 0) {        // once after the first frame that actually wrote: identity can be undone post-boot
    _idChecked = 1;
    console.assert(
      aPos.array === rPos && aCol.array === rCol && aSiz.array === rSiz && aAlp.array === rAlp && aAdd.array === rAdd,
      'plume: attribute identity undone after init');
  }
}

/* Lunar-spray census for the node harness: per-live-SM_SPRAY-parcel radius and surface distance
   from `ref` (the engine's ground point, km). The round-5 acceptance is a DENSITY PROFILE —
   "near-engine dense, far horizon sparse" is exactly this array binned — plus the size spread. */
export function sprayCensus(ref, code = SM_SPRAY) {
  const out = [];
  for (let k = 0; k < nAlive; k++) {
    const i = alive[k];
    if (pMode[i] !== 2 || pSmoke[i] !== code) continue;
    const i3 = i * 3;
    const a = pPos[i3] - ref.x, b = pPos[i3 + 1] - ref.y, c = pPos[i3 + 2] - ref.z;
    out.push({ r: pR[i], d: Math.sqrt(a * a + b * b + c * c),
      age: pAge[i], life: pAge[i] + pLife[i] });
  }
  return out;
}

/* Live-parcel census for the node harness (review round 5 asked for ember-population numbers):
   classifies `alive` by the SAME band rule fillBuffers draws with, so the counts describe pixels,
   not bookkeeping fields. `ref` (km) + `nearKm` add a second census restricted to that radius —
   the pad-frame question "what is still glowing over the tower" is a distance question. Read-only;
   nothing in the game calls it. */
export function parcelAudit(ref = null, nearKm = 0.5) {
  const out = { live: nAlive, m1hot75: 0, m1hot50: 0, m1hot22: 0, m1smoke: 0, m2spark: 0, m2smoke: 0,
    seam: 0, scorch: 0, spray: 0, flash: 0, moonM1: 0, nearHot22: 0, nearLive: 0 };
  const n2 = nearKm * nearKm;
  for (let k = 0; k < nAlive; k++) {
    const i = alive[k], i3 = i * 3;
    const q = pHeat[i];
    if (pMode[i] === 1) {
      if (pMoon[i]) out.moonM1++;
      const sm = pSmoke[i] && pAge[i] > 0.02 && q < 0.75;
      if (sm) out.m1smoke++; else {
        if (q > 0.75) out.m1hot75++;
        if (q > 0.5) out.m1hot50++;
        if (q > 0.22) out.m1hot22++;
      }
    } else if (pSmoke[i] === SM_SEAM) out.seam++;
    else if (pSmoke[i] === SM_SCORCH) out.scorch++;
    else if (pSmoke[i] === SM_SPRAY) out.spray++;
    else if (pSmoke[i] === SM_FLASH) out.flash++;
    else if (pSmoke[i]) out.m2smoke++;
    else out.m2spark++;
    if (ref) {
      const dx = pPos[i3] - ref.x, dy = pPos[i3 + 1] - ref.y, dz = pPos[i3 + 2] - ref.z;
      if (dx * dx + dy * dy + dz * dz < n2) {
        out.nearLive++;
        if (pMode[i] === 1 && !(pSmoke[i] && pAge[i] > 0.02 && q < 0.75) && q > 0.22) out.nearHot22++;
      }
    }
  }
  return out;
}

/* Called once per rendered frame with the simulated dt for that frame (main.js: min(1, real×warp)).
   Substepping: h ≈ 1/60 s keeps the step-by-motion under the plume's own depth so the ensemble
   reads as continuous flow. When the warp asks for more than MAX_SUB substeps the system accepts
   h ≈ 33 ms rather than fall behind the clock — at 1000× a 4 km/s parcel can tunnel the ~5 m hull
   radius in one step, the accepted trade; nothing explodes, because the drag update is implicit
   and the colliders are positional. */
export function updateParticles(dt) {
  if (dt > 0) {
    const d = Math.min(1, dt);
    const steps = Math.max(1, Math.min(MAX_SUB, Math.ceil(d * 60)));
    const h = d / steps;
    const t = getSimTime();
    moonPos(t, _mo);
    moonVel(t, _mv);
    shipQuatI.copy(shipQuat).invert();
    for (let s = 0; s < steps; s++)
      for (let k = nAlive - 1; k >= 0; k--)          // back-to-front: swap-remove keeps unvisited k valid
        if (stepParcel(alive[k], h)) killSlot(k);
  }
  /* Re-anchor the Float32 draw mirror at the vehicle every frame (see fillBuffers). Parcels
     only ever live within ~15 km of a burning ship; ejecta outlives its burn by ≤10 s, so the
     anchor and the cloud stay in the same float32-resolvable neighbourhood whatever body is
     underneath. With no live ship the anchor is the Moon, then the origin — the status quo. */
  if (shipLive) plumeAnchor.copy(shipPos);
  else moonPos(getSimTime(), plumeAnchor);
  plume.position.copy(plumeAnchor);
  fillBuffers();
}

/* ---------------- debris (separated stages) ---------------- */
export const debris = [];   // {mesh, vel, angVel, age}

export function initVehicle(target) {
  scene = target;
  scene.add(rocketGroup);
  scene.add(plume);
}

export function setVisible(visible) {
  rocketGroup.visible = visible;
  shipLive = visible;      // after the explosion there is no hull to collide with, only wreckage
}

export function detachStage(mesh, pos, quat) {
  rocketGroup.remove(mesh);
  mesh.position.copy(pos); mesh.quaternion.copy(quat); mesh.scale.setScalar(VS);
  scene.add(mesh);
}

export function addDebris(entry) {
  debris.push(entry);
  /* Staging-seam puffs (review3/05/06 ask): the trail flag marks exactly one event in this
     game — separateStage hands over a flying booster (separateLES and the explosion never set
     it). A real separation seam bursts a short ring of grey smoke with the flash and the
     sparks; 6-10 puffs, 0.4-0.8 s, dark and LOW ALPHA (SM_SEAM's fillBuffers pass), drawn as
     silhouettes against the flash rather than more glowing beads. They stay SMALL in vacuum
     by construction: growth rides the certified airDensity gate (at the 67 km staging altitude
     ρ≈0 caps them at a few tenths of m/s over a 0.5 s life), and the ±3 m birth scatter plus
     5-13 m/s spread keeps them at the seam instead of orbiting it. */
  if (entry.trail) {
    /* Light burst FIRST ("the flash is a lumpy soot-egg … and no light burst"): 4 tiny additive-white parcels
       (SM_FLASH), 2.2-3.8 m → 15-27 m discs, lives 0.20-0.28 s. They peak at 22 ms — before the
       seam puffs' 0.10 s fade-in lets any smoke exist — and are gone by 0.28 s. Then the smoke:
       6-10 puffs, now at 0.13 coverage and 1.8-3.8 m births (was 0.22 / 2.5-4.5) so they ring
       the seam instead of becoming the "lumpy soot-egg with two detached balls" the review saw. */
    for (let k = 0; k < 4; k++) {
      _trailRnd.randomDirection();
      _sp.copy(entry.mesh.position).addScaledVector(_trailRnd, 0.0012 + Math.random() * 0.0012);
      _svv.copy(entry.vel).addScaledVector(_trailRnd, 0.001);
      spawnParticle(_sp, _svv, 0.20 + Math.random() * 0.08, [1, 1, 1], 2.2 + Math.random() * 1.6, SM_FLASH);
    }
    const n = 6 + ((Math.random() * 5) | 0);           // 6..10
    for (let k = 0; k < n; k++) {
      _trailRnd.randomDirection();
      _sp.copy(entry.mesh.position).addScaledVector(_trailRnd, 0.003);
      _svv.copy(entry.vel).addScaledVector(_trailRnd, 0.005 + Math.random() * 0.008);
      spawnParticle(_sp, _svv, 0.4 + Math.random() * 0.4, SEAM_COLOUR, 1.8 + Math.random() * 2, SM_SEAM);
    }
  }
}

/* Debris falls under the same gravity the ship uses. trail-flagged pieces (staged boosters) also
   bleed a continuous smoke ribbon: the old staging event spawned one puff per frame at the release
   point, so the vehicle flew away and left a string of separate coins (the reviewer's "pearl
   chain"). A fed trail — one small parcel every ~11 m of fall — merges into a column the same way
   the plume does, and it dies with the debris rather than the burst. */
export function updateDebris(simDt, accelAt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i]; d.age += simDt;
    const a = accelAt(d.mesh.position, d.vel, 8, null);
    d.vel.addScaledVector(a, simDt); d.mesh.position.addScaledVector(d.vel, simDt);
    d.mesh.rotation.x += d.angVel.x * simDt; d.mesh.rotation.y += d.angVel.y * simDt;
    if (d.trail) {
      const fall = Math.hypot(d.vel.x, d.vel.y, d.vel.z);
      /* Air-gated: a debris trail is smoke, and smoke needs air. The separation itself happens
         at the edge of space, where the honest event is the flash (physics.js) and tumbling
         metal, not a ribbon — the ribbon appears on the way down. */
      const alt = d.mesh.position.length() - RE;
      const rho = alt < 420 ? airDensity(alt) : 0;
      if (rho > 0.004) {
        d.smokeAcc = (d.smokeAcc || 0) + simDt;
        const period = Math.max(0.033, 11 / Math.max(1, fall * 1000));   // ≥11 m apart, ≤30/s
        while (d.smokeAcc >= period) {
          d.smokeAcc -= period;
          const spd = THREE.MathUtils.clamp(fall * 1000 / 700, 0.3, 3);
          _trailPos.copy(d.mesh.position);
          _trailVel.copy(d.vel).multiplyScalar(0.12).addScaledVector(
            _trailRnd.randomDirection(), 0.004);
          spawnParticle(_trailPos, _trailVel, 2.6 + Math.random() * 1.6, TRAIL_COLOUR,
            (6 + Math.random() * 8) * spd, 1);
        }
      } else d.smokeAcc = 0;
    }
    if (d.age > 400 || d.mesh.position.length() > 60000) { scene.remove(d.mesh); debris.splice(i, 1); }
  }
}
const TRAIL_COLOUR = [0.82, 0.83, 0.86];
const SEAM_COLOUR = [0.32, 0.33, 0.36];   // staging-seam smoke: dark grey against the flash
const _trailPos = new THREE.Vector3(), _trailVel = new THREE.Vector3(), _trailRnd = new THREE.Vector3();

export function clearDebris() {
  debris.forEach(d => scene.remove(d.mesh)); debris.length = 0;
}

export function resetStages() {
  /* A new mission starts with clean air. Stale smoke from the previous attempt would hang over
     the pad for its whole remaining life otherwise. */
  nAlive = 0; emitAcc = 0; bellCursor = 0; lastSpawnT = 0;
  nFree = NP; for (let i = 0; i < NP; i++) freeSlots[i] = i;
  pGeo.setDrawRange(0, 0);
  shipLive = true;
  stages.forEach(st => {
    st.meshes.visible = true; st.meshes.position.set(0, 0, 0); st.meshes.quaternion.identity();
    rocketGroup.add(st.meshes);
  });
  /* A jettisoned LES has to fly home too: its children hold absolute build coords and the group
     rides at the local origin, so re-attaching is all the transform fixup needed. */
  if (lesGroup.parent !== stages[2].meshes) {
    lesGroup.position.set(0, 0, 0); lesGroup.quaternion.identity();
    stages[2].meshes.add(lesGroup);
  }
  rocketGroup.visible = true;
  rocketGroup.quaternion.identity();
}

/* ---------------- navigation vectors drawn in the world ----------------
   REMOVED (round 6b). These arrows — an orange cone along the nose while burning and a cyan one
   along the velocity — were the giant orange triangle users kept photographing above the fairing
   ("what is the arrow over the rocket?"). The 1 px THREE.Line survived every object-hide A/B that
   was tried, because the *head* was the conspicuous part and it is a ConeGeometry(1,2) mesh on the
   parented group's far end. Attitude is already legible from the plume, the navball and the ribbon;
   nothing in the game consumed these (no tools, no HUD), so the whole subsystem went. */

/* visuals follow physics: rocket transform, flame/glow, plume emission */
export function updateBurnVisuals({ pos, quat, vel, throttle, activeIdx, burn, fwd, omega }) {
  rocketGroup.position.copy(pos); rocketGroup.quaternion.copy(quat);
  const om = omega || ZERO_V;   // body-frame angular velocity (rad/s)
  stages.forEach((st, idx) => {
    const on = burn && idx === activeIdx;
    st.flame.visible = on; st.glow.visible = on;
    if (on) {
      /* The S-482 cone (idx 2) read as "a tiny blue smear" (review2/13): the shared length factor
         .55 gave 8.25 u at full throttle against the 21.9 u of body hanging off the bell exit
         (+6.8 → CM tip +28.7) — 38% — while the shared radius factor made the mouth (Ø 7.2 u)
         nearly as wide as the cone was long: a squat stub, not exhaust. At .9 it is a 13.5 u
         teardrop, 62% of that body; the ×1.5 radius then opens the mouth to Ø 10.8 u against the
         apex at the bell — a ~22° half-angle plume. Stages 0/1 and the per-stage glow are
         untouched. */
      const L = (4 + throttle * 11) * (idx === 0 ? 1.35 : idx === 1 ? 1.0 : .9);
      const flick = .9 + Math.random() * .2;
      const fr = (2 + throttle * 1.6) * (idx === 2 ? 1.5 : 1);
      /* (radius, length, radius): the cone's axis is its local +Y after the -90° pitch below, so the
         two radial axes have to take the radius. It used to read (rx, L, L), which stretched the plume
         along one radial direction and drew the whole flame as a diamond under the rocket. */
      st.flame.scale.set(fr * flick, L * flick, fr * flick);
      /* The exit-plane bloom is sized by the ENGINE, not by a shared law: at 6+13·throttle the
         CSM's single 91 kN bell wore the same white orb as five F-1s, and a round balloon bigger
         than the flame next to a small cone is exactly the "stub, gap, bigger triangle" the
         review saw. Measured against each stage's cone length (L above). */
      st.glow.scale.setScalar(((idx === 0 ? 6 + throttle * 11 : idx === 1 ? 3.5 + throttle * 6 : 2 + throttle * 4)) * flick);
      // engine gimbal: the plume lags the turn, swinging opposite the body rate (clamped +/-0.22 rad).
      // Euler 'YXZ': Rx pitches apex toward +Y for omega.x > 0 (nose pitches toward -Y),
      // then Ry swings apex toward -X for omega.y > 0 (nose yaws toward +X) — both opposite the turn.
      st.flame.rotation.set(-Math.PI / 2 + THREE.MathUtils.clamp(om.x, -1, 1) * .22, THREE.MathUtils.clamp(om.y, -1, 1) * .22, 0);
    } else {
      st.flame.rotation.set(-Math.PI / 2, 0, 0);
    }
  });
  /* The drawn two-tone cone stays as the incandescent core — a cartoon flame is part of the look,
     and it covers the supersonic few tens of metres no sprite budget can resolve smoothly. The
     volumetric body of the plume is the particle field below. */
  shipPos.copy(pos); shipVel.copy(vel); shipQuat.copy(quat); shipLive = true;
  const bellSet = activeIdx >= 0 ? BELL_SETS[activeIdx] : undefined;
  if (bellSet) {
    shipTailZ = bellSet.tailZ + 2;          // +2u: let the fresh flow leave the exit plane before the hull starts
    shipHullR = bellSet.hullR * VS;
  } else {
    if (activeIdx >= 0) plumeDebug.causeBell++;   // an index nobody built: counted, not a crash
    shipTailZ = 6.8; shipHullR = 1.39 * VS;       // the SM/CM stub after everything else flew
  }
  if (burn && bellSet) {
    /* Emission runs on simulated seconds: the sim clock advanced (dtReal × warp, or a whole ff()
       jump) since the last frame, and the exhaust must be dense per metre flown, not per frame
       rendered. A jump past MAX-emit just thins the plume instead of banking a backlog. */
    const t = getSimTime();
    let sdt = lastSpawnT > 0 ? Math.min(1, Math.max(0, t - lastSpawnT)) : 1 / 60;
    lastSpawnT = t;
    spawnPlume(bellSet, pos, quat, vel, throttle, sdt);
  } else {
    emitAcc = 0;
    lastSpawnT = getSimTime();             // relight after a coast must not bank a second of backlog
  }
  /* Blast flare (see the flareCore note): the surface underneath is whichever body is nearer,
     so a lunar hover at 300 m lights the flare exactly like the pad does. */
  const aS = Math.min(pos.length() - RE, pos.distanceTo(moonPos(getSimTime(), _flAlt)) - RM);
  const flOn = !!(burn && bellSet) && throttle > 0.35 && aS < 2.5;
  flareCore.visible = flareBloom.visible = flOn;
  if (flOn) {
    const tq = (throttle - 0.35) / 0.65;
    flareCore.position.z = flareBloom.position.z = bellSet.tailZ - 1;
    flareCore.scale.setScalar(3.5 + 8 * throttle);
    flareBloom.scale.setScalar(23 + 40 * throttle);
    flareCore.material.opacity = 0.9 * tq;
    flareBloom.material.opacity = 0.3 * tq;
  }
}
