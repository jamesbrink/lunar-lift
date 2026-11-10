import * as THREE from 'three';
import { SPECS, VS } from './constants.js';
import { toon, outline, PALETTE, RAMP_HARD } from './toon.js';

/* The Saturn V as drawn hardware: three stage groups and the launch escape system. Nothing here moves
   or burns — js/vehicle.js poses it every frame, and js/flame.js hangs a flame on every engine listed
   in a stage's `engines`.

   Dimensions are real Saturn V at 1 build unit = VS km = 1.4 m (NASA SP-4029,
   docs/reference/spacecraft.md): Ø10.0 m first and second stages (r 3.57), Ø6.6 m S-IVB (r 2.36),
   Ø3.9 m service module. The axis is +z, the state point is z = 0, the F-1 exits are at z = −42 and
   the escape tower's tip at +37.6. Three numbers are contracts with other modules and must not
   drift: each stage's `tailZ` (the exit plane js/vehicle.js emits exhaust from, and which
   js/camera.js frames by), the engine positions on their bolt circles (BELL_SETS in js/exhaust-emit.js
   restates them for the particle field), and the overall span (pad clearance in js/constants.js).

   The look is a cel drawing of the real paint scheme rather than a white tube with stripes: black
   roll-pattern panels on white, a dark instrument unit, a silver service module, engine fairings
   and fins on the first stage, bells with an actual bell contour. Detail is kept to shapes that
   read at pad distance — no rivets, no lattice.

   Build rules, each of which was a visible defect once:
   1. an axial joint is covered by a sleeve of slightly larger radius, or one part is sunk ≥ 0.4 u
      into the other at a radius ≥ its neighbour's — no coplanar faces, no slot ring to see into;
   2. shells are single-sided, so an interior can never darken a seam (bells are the exception:
      they are open, and their inside is part of the drawing);
   3. paint is a separate open arc 0.05 u proud of the shell it sits on, never a recoloured shell;
   4. only silhouette parts carry the inverted-hull outline — outlining a ring or a panel draws a
      line through the middle of the vehicle. */

export const rocketGroup = new THREE.Group(); rocketGroup.scale.setScalar(VS);
export const capsuleGroup = new THREE.Group(); capsuleGroup.name = 'capsule';
rocketGroup.add(capsuleGroup);
export const stages = SPECS.map(s => ({ ...s, fuel: s.fuel, separated: false, meshes: new THREE.Group(), tailZ: 0, engines: [] }));

const SEG = 40;                             // the hull's roundness; 24 showed its facets at the pad camera
const white = toon({ color: PALETTE.hull, gradientMap: RAMP_HARD });
/* A floor under the hull's shaded band. The chase camera spends the whole ascent on the side of the
   vehicle the sun is not on, and on the bare ramp a white rocket was a mid-grey one for the entire
   flight. */
white.emissive = new THREE.Color(0x2c3036);
const black = toon({ color: PALETTE.dark });
const shield = toon({ color: 0x6b4a34 });        // ablator brown
const silver = toon({ color: PALETTE.silver, gradientMap: RAMP_HARD });
silver.emissive = new THREE.Color(0x22262b);
const metal = toon({ color: PALETTE.engine, side: THREE.DoubleSide });
export const bellMetal = metal;             // every bell: js/vehicle.js warms its emissive while an engine fires
const ink = toon({ color: PALETTE.dark, side: THREE.DoubleSide });   // paint arcs are open: both faces

function cyl(rt, rb, len, z, mat, seg = SEG, edge = false) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, len, seg), mat);
  m.rotation.x = Math.PI / 2; m.position.z = z; m.castShadow = true;
  if (edge) outline(m);
  return m;
}

/* A painted panel: an open arc of cylinder just proud of the shell, `width` degrees wide, centred on
   azimuth `az` (degrees from +x in the vehicle's xy plane). CylinderGeometry measures θ from its own
   +z, which after the x-rotation above lands 90° behind the vehicle's azimuth. */
function panel(r, z0, z1, az, width, mat = ink) {
  const g = new THREE.CylinderGeometry(r + 0.05, r + 0.05, z1 - z0, Math.max(6, Math.round(width / 6)), 1, true,
    THREE.MathUtils.degToRad(az + 90 - width / 2), THREE.MathUtils.degToRad(width));
  const m = new THREE.Mesh(g, mat);
  m.rotation.x = Math.PI / 2; m.position.z = (z0 + z1) / 2;
  return m;
}
function panels(g, r, z0, z1, az0, width) { for (let i = 0; i < 4; i++) g.add(panel(r, z0, z1, az0 + i * 90, width)); }

/* A rocket bell with a bell's contour: steep at the throat, flaring to the exit. Open at the exit
   and double-sided, so from below it is a dark mouth and not a capped plug. Same envelope as the
   frustum it replaces (throat rt at +len/2, exit rb at −len/2 about the centre z). */
function bell(rt, rb, len, z) {
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const s = i / 10;                       // 0 at the exit, 1 at the throat
    pts.push(new THREE.Vector2(rb + (rt - rb) * Math.pow(s, 0.55), -len / 2 + len * s));
  }
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts, 20), metal);
  m.rotation.x = Math.PI / 2; m.position.z = z; m.castShadow = true;
  return m;
}

/* Lettering stacked down the hull, as on the real first stage. Needs a canvas, so the headless
   mission harness (which imports this module for the stage records) simply gets none. */
function lettering(text, colour) {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128 * text.length;
  const c = cv.getContext('2d');
  c.font = '900 118px "Helvetica Neue", Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = colour;
  [...text].forEach((ch, i) => c.fillText(ch, 64, 64 + i * 128 + 6));
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const usa = lettering('USA', '#c8402a');
function decal(r, z0, z1, az, width, map) {
  const m = panel(r, z0, z1, az, width, toon({ map, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide }));
  return m;
}

/* ---- stage 0 — S-IC and the interstage it carries away: −42 .. −9.5 ---- */
{
  const g = stages[0].meshes;
  /* The skirt's mouth (3.60) is LARGER than the body (3.57) and overlaps it by 0.4 u: the walls
     cross once, transversally, and there is no rim under the body for the eye to fall through. */
  g.add(cyl(3.60, 3.30, 5.0, -37.1, black, SEG, true));       // engine skirt −39.6 .. −34.6
  g.add(cyl(3.57, 3.57, 25.1, -22.45, white, SEG, true));     // tanks −35.0 .. −9.95, top inside the interstage
  panels(g, 3.57, -34.6, -27.4, 0, 45);                       // aft roll pattern, between the fairings
  g.add(cyl(3.62, 3.62, 0.3, -25.6, black));                  // intertank, marked by its two frames
  g.add(cyl(3.62, 3.62, 0.3, -22.4, black));
  panels(g, 3.57, -15.2, -12.1, 45, 45);                      // forward roll pattern
  if (usa) { g.add(decal(3.57, -21.4, -15.9, 0, 26, usa)); g.add(decal(3.57, -21.4, -15.9, 180, 26, usa)); }
  const tunnel = cyl(0.22, 0.22, 21.6, -23.2, white, 8); tunnel.position.x = 3.6; g.add(tunnel);   // systems tunnel, half sunk in the tank wall
  g.add(cyl(3.62, 3.62, 2.5, -10.75, white, SEG, true));      // interstage −12.0 .. −9.5: shrouds the J-2s until staging
  g.add(cyl(3.66, 3.66, 0.45, -11.75, black));                // its separation frame
  /* Engine fairings and fins at the four outboard positions. Each fairing is a half-buried cone
     over its F-1; the fin's root is inside the fairing along its whole length. */
  const fin = new THREE.Shape();                              // x = radial, y = axial z
  fin.moveTo(3.4, -36.4); fin.lineTo(5.7, -38.7); fin.lineTo(5.7, -39.8); fin.lineTo(3.4, -39.8);
  const finGeo = new THREE.ExtrudeGeometry(fin, { depth: .26, bevelEnabled: false }); finGeo.translate(0, 0, -.13);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    const f = cyl(0.35, 1.75, 6.6, -36.5, white, 20, true);   // −39.8 .. −33.2
    f.position.x = Math.cos(a) * 2.75; f.position.y = Math.sin(a) * 2.75;
    g.add(f);
    const arm = new THREE.Group(); arm.rotation.z = a;
    const m = new THREE.Mesh(finGeo, black); m.rotation.x = Math.PI / 2; m.castShadow = true; outline(m);
    arm.add(m); g.add(arm);
  }
  /* Five F-1s: throats in the skirt solid, exits 2.4 u below its rim. Bolt circle r 2.35 puts the
     exit rims tangent; the outboards cant 0.1 rad outward, the real gimbal trim. */
  g.add(bell(0.42, 1.19, 2.6, -40.7));
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    const b = bell(0.42, 1.15, 2.6, -40.7);
    b.position.x = Math.cos(a) * 2.35; b.position.y = Math.sin(a) * 2.35;
    b.quaternion.setFromAxisAngle(new THREE.Vector3(-Math.sin(a), Math.cos(a), 0), -0.1).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
    g.add(b);
  }
  stages[0].tailZ = -42;
  stages[0].engines = [[0, 0], ...[0, 1, 2, 3].map(i => { const a = i * Math.PI / 2 + Math.PI / 4; return [Math.cos(a) * 2.35, Math.sin(a) * 2.35]; })];
}

/* ---- stage 1 — S-II and the forward cone that hides the S-IVB bell: −11.8 .. +8.6 ---- */
{
  const g = stages[1].meshes;
  g.add(cyl(3.58, 3.50, 1.5, -10.3, black, SEG, true));       // thrust structure −11.05 .. −9.55, inside the interstage while stacked
  g.add(cyl(3.57, 3.57, 17.0, -1.5, white, SEG, true));       // tanks −10.0 .. +7.0
  panels(g, 3.57, 3.4, 6.5, 0, 45);                           // forward roll pattern
  g.add(cyl(3.62, 3.62, 0.3, -7.4, black));                   // aft frame
  const tunnel = cyl(0.2, 0.2, 13.4, -1.0, white, 8); tunnel.position.x = 3.6; g.add(tunnel);
  g.add(cyl(2.55, 3.52, 1.9, 7.65, white, SEG, true));        // forward cone +6.7 .. +8.6, tapering 10 m to the S-IVB
  g.add(cyl(3.61, 3.61, 0.4, 6.8, black));                    // the frame at its foot
  g.add(bell(0.30, 0.72, 1.9, -10.85));                       // five J-2s on r 1.44, exits at −11.8
  const engines = [[0, 0]];
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    const b = bell(0.30, 0.70, 1.9, -10.85);
    b.position.x = Math.cos(a) * 1.44; b.position.y = Math.sin(a) * 1.44;
    g.add(b); engines.push([b.position.x, b.position.y]);
  }
  stages[1].tailZ = -11.8;
  stages[1].engines = engines;
}

/* ---- stage 2 — S-IVB, instrument unit, adapter, service and command modules: +6.8 .. +28.6.
   SPECS[2] is one engine doing TLI, LOI, deorbit and descent (docs/reference/spacecraft.md), so
   it has ONE bell, at the S-IVB tail where the flame must sit. ---- */
{
  const g = stages[2].meshes;
  g.add(cyl(2.36, 2.36, 11.5, 13.9, white, 32, true));        // S-IVB +8.15 .. +19.65, foot inside the S-II cone
  panels(g, 2.36, 8.7, 11.4, 45, 45);                         // aft roll pattern
  g.add(bell(0.32, 0.85, 1.7, 7.65));                         // exit +6.8
  g.add(cyl(2.42, 2.42, 2.18, 20.21, black, 32));             // instrument unit +19.12 .. +21.3, overlapping the S-IVB top
  g.add(cyl(1.55, 2.46, 1.95, 22.025, white, 32, true));      // spacecraft adapter +21.05 .. +23.0, foot over the IU rim
  g.add(cyl(1.39, 1.39, 3.45, 24.625, silver, 32, true));     // service module +22.9 .. +26.35
  g.add(cyl(1.43, 1.43, 0.3, 26.1, black, 32));               // its forward frame
  for (let i = 0; i < 4; i++) {                               // four RCS quads
    const a = i * Math.PI / 2 + Math.PI / 4;
    const q = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.5), black);
    q.position.set(Math.cos(a) * 1.44, Math.sin(a) * 1.44, 24.9); q.rotation.z = a; q.castShadow = true;
    g.add(q);
  }
  /* The command module is its own group on the rocket, not part of this stage: when the CSM is
     dropped (X on the last stage) it is what is left flying, and what the parachutes hang from. */
  capsuleGroup.add(cyl(0.36, 1.33, 2.3, 27.45, white, 32, true));   // +26.3 .. +28.6, base sunk in the SM top
  capsuleGroup.add(cyl(1.33, 1.05, 0.34, 26.2, shield, 32, true));  // heat shield, hidden inside the SM until then
  stages[2].tailZ = 6.8;
  stages[2].engines = [[0, 0]];
}

/* ---- launch escape system: its own group, so it can leave as a unit. Children carry absolute
   build coordinates and the group stays at the local origin, so detaching needs no bookkeeping. ---- */
export const lesGroup = new THREE.Group(); lesGroup.name = 'les';
stages[2].meshes.add(lesGroup);
{
  lesGroup.add(cyl(.50, .50, .50, 28.8, black, 14));          // seat on the CM apex +28.55 .. +29.05
  lesGroup.add(cyl(.16, .16, 5.3, 31.6, black, 8, true));     // mast +28.95 .. +34.25
  for (let i = 0; i < 4; i++) {                               // four tower legs, seat rim to motor base
    const a = i * Math.PI / 2;
    const leg = cyl(.07, .07, 5.2, 31.55, black, 5);
    leg.position.x = Math.cos(a) * 0.37; leg.position.y = Math.sin(a) * 0.37;
    leg.rotateOnWorldAxis(new THREE.Vector3(-Math.sin(a), Math.cos(a), 0), -0.023);
    lesGroup.add(leg);
  }
  lesGroup.add(cyl(.34, .55, 2.4, 35.4, white, 16, true));    // escape motor +34.2 .. +36.6
  lesGroup.add(cyl(.56, .56, 0.3, 34.4, black, 16));          // nozzle skirt
  const nose = new THREE.Mesh(new THREE.ConeGeometry(.34, 1.1, 16), black);   // tip +37.6, the top of the vehicle
  nose.rotation.x = Math.PI / 2; nose.position.z = 37.05; nose.castShadow = true; outline(nose); lesGroup.add(nose);
  const canard = new THREE.Shape();
  canard.moveTo(.34, 34.9); canard.lineTo(1.05, 35.5); canard.lineTo(1.05, 36.2); canard.lineTo(.34, 36.2);
  const canardGeo = new THREE.ExtrudeGeometry(canard, { depth: .1, bevelEnabled: false }); canardGeo.translate(0, 0, -.05);
  for (let i = 0; i < 2; i++) {
    const arm = new THREE.Group(); arm.rotation.z = i * Math.PI;
    const m = new THREE.Mesh(canardGeo, black); m.rotation.x = Math.PI / 2; m.castShadow = true; outline(m);
    arm.add(m); lesGroup.add(arm);
  }
}

stages.forEach((st) => rocketGroup.add(st.meshes));
