import * as THREE from 'three';
import { SPECS, VS, RE, RM, MU_E, MU_M, SOI_M, EARTH_SPIN, PAD_SCALE, PAD_UP, moonPos, moonVel } from './constants.js';
import { glowTex } from './textures.js';
import { toon, outline, plumeMeshes, PALETTE, RAMP_HARD } from './toon.js';
/* The plume is a physics consumer, so it reads the sim's own numbers instead of restating them:
   airDensity is literally the function accelAt drags the vehicle with (one exponential, no chance
   of the flame disagreeing with the flight computer about where the air runs out), and the mission
   clock drives the emission rate so the plume thins honestly at high warp instead of lying. */
import { airDensity, getSimTime } from './physics.js';
import * as WORLD from './world.js';

let scene = null;

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
   2. wherever two meshes meet axially, one is sunk 0.05..0.15 u into the other at a DIFFERENT
      radius, so no two surfaces coincide. Remaining exposed gaps are step rings under 0.2 m.
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
  const g = stages[0].meshes;
  g.add(cyl(3.52, 3.30, 4.7, -37.25, matDark, 24, true));     // conical engine skirt, -39.6 .. -34.9
  g.add(cyl(3.57, 3.57, 25.1, -22.45, matBody, 24, true));    // booster body, -35.0 .. -9.95 (top buried in the interstage sleeve; overlap radii differ 3.57 vs 3.52 so the skirt/body junction shares no surface)
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
  g.add(cyl(3.45, 3.40, .95, -10.375, matDark, 24, true));    // engine skirt -10.85 .. -9.9, buried in the body base; hidden inside the stage-0 sleeve while stacked
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
  g.add(cyl(2.36, 2.36, 11.1, 14.0, matBody, 20, true));      // S-IVB white body Ø6.6 m, +8.45 .. +19.55 (bottom end buried in the stage-1 shroud solid, r 2.36 < 2.55 there)
  g.add(cyl(0.32, 0.85, 1.7, 7.65, matNozzle, 14));           // single engine bell: throat buried in the S-IVB solid, exit +6.8 — inside the shroud while stacked, exposed once stage 1 falls
  g.add(cyl(2.42, 2.42, 1, 18.0, matAccent));                 // S-IVB roll band
  g.add(cyl(2.42, 2.42, 1.85, 20.375, matDark, 20));          // black instrument unit + SLA aft ring, +19.45 .. +21.3 (overlaps the S-IVB top by 0.1 at a larger radius)
  g.add(cyl(1.55, 2.40, 1.75, 22.125, matDark, 20));          // spacecraft/LM adapter tunnel, frustum from the IU deck to the SM diameter, +21.25 .. +23.0
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
  bandRGB(0xdce1e6),      // lunar dust: near-white grey — see the note below, it has to beat regolith
  bandRGB(0xdad5c9),      // cloud foot: the ground-hugging blast roll, seen against grass, not sky
];
/* BAND_C[4] used to be 0x9aa0a6, "brighter than regolith". Measured against the rendered surface it
   was not: the painted Moon lands at about the same 8-bit value as that band, so a whole ejecta sheet
   disappeared into the ground it came off and the lunar burn showed only the flame. There is no shadow
   and no atmosphere out there to separate them with, so the tone has to do the work on its own. */
const BAND_A = [0.0, 0.16, 0.36, 0.62, 0.45, 0.8];    // composited coverage
const BAND_G = [1.0, 0.6, 0.4, 0.10, 0.05, 0.03];     // additive glow

/* One slot = one parcel; `alive` is the live index list, freeSlots[] the recycle stack. */
const pPos = new Float32Array(NP * 3);    // world km — physics only, slot-indexed
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
    void main() {
      vTint = color;
      vA = alpha;
      vAdd = add;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      /* Two caps. Smoke is allowed 220 px: it is the cloud body and it has to merge. Glow-dominant
         parcels get 80 px — a metre from the lens a fully additive puff otherwise blooms into a fat
         lantern a tenth of the screen, and the trench read as a dozen separate lamps instead of one
         sheet. Both caps only bite closer than ~30 m, where the plume is meant to be one body. */
      float cap = mix(220.0, 80.0, min(vAdd, 1.0));
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
      float g = texture2D(uMap, gl_PointCoord).a;
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
const _dbSize = new THREE.Vector2();
/* The same world-space attenuation PointsMaterial uses (so a parcel is its true diameter at any
   zoom, from pad camera to system view), recomputed from the live camera on render — vehicle.js
   does not own the camera and must not assume its fov. */
plume.onBeforeRender = (renderer, sc, cam) => {
  if (!cam.isPerspectiveCamera) return;
  renderer.getDrawingBufferSize(_dbSize);
  plumeMat.uniforms.uScale.value = _dbSize.y / (2 * Math.tan(cam.fov * Math.PI / 360));
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
    const out = (moon ? 0.75 : 0.55) * s;                           // impact → outward flow
    /* Tangential bleed. It used to survive the hit whole — `tx * (1 + out·k)` — so deflectate left
       the trench at close to exhaust speed and painted a 200 m field of discrete glowing domes around
       the pad. Air, the trench walls and the berm do not allow that: the flow arrives supersonic and
       leaves as a ground-hugging sheet at a fraction of the speed. On the Moon nothing bleeds it, which
       is exactly why Apollo's ejecta ran far. */
    const keep = moon ? 0.8 : 0.12;
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
   colour it was handed and skips the heat/band machinery. Signature unchanged. */
export function spawnParticle(pos, vel, life, color) {
  const i = allocSlot(), i3 = i * 3;
  pMode[i] = 2; pSmoke[i] = 0;
  moonPos(getSimTime(), _mo);     // ff() moves the sim clock without running updateParticles; don't trust the cache
  const dx = pos.x - _mo.x, dy = pos.y - _mo.y, dz = pos.z - _mo.z;
  pMoon[i] = dx * dx + dy * dy + dz * dz < SOI2 ? 1 : 0;
  pPos[i3] = pos.x; pPos[i3 + 1] = pos.y; pPos[i3 + 2] = pos.z;
  pVel[i3] = vel.x; pVel[i3 + 1] = vel.y; pVel[i3 + 2] = vel.z;
  pColB[i3] = color[0]; pColB[i3 + 1] = color[1]; pColB[i3 + 2] = color[2];
  pR[i] = 3.5; pHeat[i] = 0; pAge[i] = 0; pLife[i] = life; pInv[i] = 1 / Math.max(0.05, life);
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
  const jit = veEff * (onMoon ? 0.02 : 0.05);
  const bells = set.bells, nb = bells.length;
  /* One frame charges n parcels, and they all left the nozzle at different instants of the interval
     the frame represents. Emitting them together put a fresh clump at the vehicle every 16 ms while
     the vehicle itself moved on, so the ascent trail came out as a ringed fir tree — one visible
     shell per frame, evenly spaced by the frame rate. Parcel c therefore belongs to the moment
     `tau` seconds ago: back-project the exit point along the velocity, and let age, remaining life
     and heat start as they would have, so the stream is continuous. */
  const span = simDt / n;
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
       survivors proportionally more radius: the same exhaust column, drawn with fewer sprites. */
    pR[i] = (0.8 + Math.random() * 0.8) * (1 + (1 - throttle) * 1.3);
    /* low throttle also shortens the parcel's life — slow flow does not carry soot to orbit.
       On the Moon the multiplier buys the long, bright, lingering spray of Apollo 11's ascent. */
    const life = (1.1 + Math.random() * 1.2) * (0.6 + 0.4 * throttle) * (onMoon ? 2.2 : 1);
    pLife[i] = life - tau; pInv[i] = 1 / life; pAge[i] = tau;
    pHeat[i] = Math.max(0, 1 - tau * 1.25);              // the same cooling rate stepParcel applies
    pTh[i] = 0;
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
        vx = _bx; vy = _by; vz = _bz;
        /* Regolith ejecta is pulverised cold rock, not flame, so heat drops below ember on first
           contact. Nothing else cools it here: the vacuum branch has no drag and its cooling term is
           barely half Earth's, so a deflected parcel used to run outward still incandescent for a
           second and a half and the surface event read as a shower of glowing sparks rather than the
           low grey sheet Apollo filmed. The band floor below turns it to dust from 20 ms. */
        if (!pSmoke[i]) pHeat[i] = Math.min(pHeat[i], 0.3);
        pSmoke[i] = 1;                                              // deflected; age gate decides sheet vs dust
        pR[i] = Math.min(R_CAP, pR[i] * 1.25 + 0.2);
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
             it coast at hundreds of m/s for its whole life, which reads as shrapnel, not soot. */
          if (pMode[i] === 1 && pSmoke[i] && pAge[i] > 0.03) bal = Math.max(bal, 0.005);
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
             cloud. Without this the whole event read as grey smoke with a few sparks. */
          if (h2 < TRP2) pHeat[i] = Math.max(pHeat[i], 0.82);
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
       lose it to air. */
    pHeat[i] -= h * (moon ? 1.7 : 1.25) * (pSmoke[i] ? 2.2 : 1);
    /* Entrainment: ground-marked smoke swells fast — a Saturn's blast cloud doubles and redoubles
       in its first second, and a sprite that stays 2 m never dwarfs the crawler. Vacuum smoke
       (lunar dust) grows far less: there is no air to roll in. */
    /* Non-deflected exhaust entrains too: at 0.35 m/s the ascent trail was a string of separate beads
       rather than a column. Lunar parcels stay thin — a vacuum rolls in no air. */
    pR[i] = Math.min(R_CAP, pR[i] + (pSmoke[i] ? (moon ? 5 : 10) : (moon ? 0.4 : 1.2)) * h);
  } else {
    pR[i] = Math.min(R_CAP, pR[i] + 2.4 * h);
  }
  pLife[i] -= h; pAge[i] += h;
  return pLife[i] <= 0 ? 1 : 0;
}

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
      a = 0.45 * fade; ad = 0.95 * fade;  // sparks: mostly light, some body
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
      /* Deflected flow is air-mixed the moment it leaves the trench, so it carries almost no light:
         at 0.5 it still read as a ring of flaming lanterns rolling across the flat, because glow is
         order-free and a hot parcel anywhere in the cloud lights whatever is behind it. The fire
         belongs to the trench (heat held there) and to the drawn cone, not to the roll. */
      if (pSmoke[i]) ad *= 0.18;
      const fade = Math.min(1, pAge[i] * 8 + 0.05) * Math.min(1, pLife[i] * pInv[i] * 2.5 + 0.05);
      a = BAND_A[b] * fade; ad = BAND_G[b] * fade;
    }
    if (!(x === x && y === y && z === z && sz === sz && cr === cr && cg === cg && cb === cb && a === a && ad === ad)) {
      plumeDebug.causeNaN++;              // never uploaded; cause counted, frame continues
      continue;
    }
    const w3 = w * 3;
    rPos[w3] = x; rPos[w3 + 1] = y; rPos[w3 + 2] = z;
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

export function addDebris(entry) { debris.push(entry); }

export function updateDebris(simDt, accelAt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i]; d.age += simDt;
    const a = accelAt(d.mesh.position, d.vel, 8, null);
    d.vel.addScaledVector(a, simDt); d.mesh.position.addScaledVector(d.vel, simDt);
    d.mesh.rotation.x += d.angVel.x * simDt; d.mesh.rotation.y += d.angVel.y * simDt;
    if (d.age > 400 || d.mesh.position.length() > 60000) { scene.remove(d.mesh); debris.splice(i, 1); }
  }
}

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
   The plume shows where the engines are firing, but only while they are lit.
   These two lines make the attitude legible at any zoom: an orange arrow along
   the nose (the direction the thrust will push the vehicle) and a cyan line
   along the velocity. Both are scaled to the camera distance so they stay
   readable from the pad out to orbit.                                            */
const navGroup = new THREE.Group();
navGroup.frustumCulled = false;
function arrowPair(colour) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: .8 }));
  const head = new THREE.Mesh(new THREE.ConeGeometry(1, 2, 14), new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: .85, depthWrite: false }));
  line.frustumCulled = head.frustumCulled = false;
  return { geo, line, head };
}
export const thrustArrow = arrowPair(0xff7a3c);
export const velArrow = arrowPair(0x6fd3ff);

export function initNavVectors(target) {
  navGroup.add(thrustArrow.line, thrustArrow.head, velArrow.line, velArrow.head);
  target.add(navGroup);
}

const _nv = new THREE.Vector3();
/* The vehicle is 79.6 local units long (F-1 exit -42 to LES nose-cone tip 37.6), so this is its
   length in km — a 111 m Saturn V at 1 unit = 1.4 m. */
const SHIP_KM = 79.6 * VS;
function setArrow(a, pos, dir, len) {
  const p = a.geo.attributes.position.array;
  p[0] = pos.x; p[1] = pos.y; p[2] = pos.z;
  p[3] = pos.x + dir.x * len; p[4] = pos.y + dir.y * len; p[5] = pos.z + dir.z * len;
  a.geo.attributes.position.needsUpdate = true;
  a.head.position.set(pos.x + dir.x * len, pos.y + dir.y * len, pos.z + dir.z * len);
  a.head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const s = len * 0.13;
  a.head.scale.setScalar(s);
  a.head.visible = true;
}

export function updateNavVectors(pos, nose, vel, burning, camDist, groundSpeed = 0) {
  /* Sized off the vehicle, never off the camera distance. The old `camDist * 0.35` made each arrow
     35% of the distance to the camera, so pulling the chase view back for the horizon turned them
     into 30 km cones that swamped a 105 m rocket and the planet behind it. Growing with zoom is
     still useful — hence a bounded allowance, so far out the arrow is at most three hull lengths. */
  const len = SHIP_KM * THREE.MathUtils.clamp((camDist / SHIP_KM) * 0.055, 1.1, 3.0);
  thrustArrow.line.visible = thrustArrow.head.visible = burning;
  if (burning) setArrow(thrustArrow, pos, nose, len);
  /* The direction is the steering frame (`navVel()`, so it agrees with the navball), but a vehicle
     sitting on the pad is not moving *across* it — its only velocity is the ground moving underneath
     at 409 m/s, which used to draw a 30 m cone beside a parked rocket for the whole countdown. The
     arrow shows when there is ground speed; the frame the two disagree by is nobody's business here. */
  _nv.copy(vel);
  if (_nv.lengthSq() > 1e-9 && groundSpeed > 0.002) setArrow(velArrow, pos, _nv.normalize(), len);
  else velArrow.line.visible = velArrow.head.visible = false;
}

/* visuals follow physics: rocket transform, flame/glow, plume emission */
export function updateBurnVisuals({ pos, quat, vel, throttle, activeIdx, burn, fwd, omega }) {
  rocketGroup.position.copy(pos); rocketGroup.quaternion.copy(quat);
  const om = omega || ZERO_V;   // body-frame angular velocity (rad/s)
  stages.forEach((st, idx) => {
    const on = burn && idx === activeIdx;
    st.flame.visible = on; st.glow.visible = on;
    if (on) {
      const L = (4 + throttle * 11) * (idx === 0 ? 1.35 : idx === 1 ? 1.0 : .55);
      const flick = .9 + Math.random() * .2;
      /* (radius, length, radius): the cone's axis is its local +Y after the -90° pitch below, so the
         two radial axes have to take the radius. It used to read (rx, L, L), which stretched the plume
         along one radial direction and drew the whole flame as a diamond under the rocket. */
      st.flame.scale.set((2 + throttle * 1.6) * flick, L * flick, (2 + throttle * 1.6) * flick);
      st.glow.scale.setScalar((6 + throttle * 13) * flick);
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
}
