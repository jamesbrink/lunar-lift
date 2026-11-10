import * as THREE from 'three';
import { SPECS, VS } from './constants.js';
import { TAIL_Z, GEAR_Z } from './stations.js';
import { hardware as toon, outline, PALETTE, RAMP_HARD } from './toon.js';

/* The Saturn V as drawn hardware: three stage groups and the launch escape system. Nothing here moves
   or burns — js/vehicle.js poses it every frame, and js/flame.js hangs a flame on every engine listed
   in a stage's `engines`.

   Dimensions are real Saturn V at 1 build unit = VS km = 1.4 m (NASA SP-4029,
   docs/reference/spacecraft.md): Ø10.0 m first and second stages (r 3.57), Ø6.6 m S-IVB (r 2.36),
   Ø3.9 m service module. The axis is +z, the state point is z = 0, the F-1 exits are at z = −42 and
   the escape tower's tip at +37.6. Three numbers are contracts with other modules and must not
   drift: each stage's `tailZ` (the exit plane js/vehicle.js emits exhaust from, and which
   js/camera.js frames by — taken from js/stations.js, where every station and radius another
   module depends on is written once), the engine positions on their bolt circles (BELL_SETS in js/exhaust-emit.js
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
      line through the middle of the vehicle;
   5. surface detail is a TONE, not a relief: stringers and corrugation are alternate strips of a
      second flat grey 0.03 u proud of the skin (under the paint, which is 0.05 proud), wide
      enough to hold several pixels at 60 m. Ribs as geometry are sub-pixel and shimmer;
   6. small repeated parts are FUSED into one mesh per material (fuse(), below): a draw call each
      for forty ullage motors, seams and radiator panels is a cost nobody can see. */

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
/* The LM's polyimide foil: amber metal, darker and warmer than the white rocket it rides on top of,
   with the same low emissive floor the hull has so the chase camera does not lose it in Earth shadow. */
const gold = toon({ color: 0x8f7434, gradientMap: RAMP_HARD }); gold.emissive = new THREE.Color(0x241d10);
const glass = toon({ color: 0x17304a }); glass.emissive = new THREE.Color(0x0a1c30);   // window glass: deep blue, never quite black
const frame = toon({ color: 0x2b3038 });        // window and hatch frames, RCS ports
const silver = toon({ color: PALETTE.silver, gradientMap: RAMP_HARD });
silver.emissive = new THREE.Color(0x22262b);
const metal = toon({ color: PALETTE.engine, side: THREE.DoubleSide });
export const bellMetal = metal;             // every bell: js/vehicle.js warms its emissive while an engine fires
const ink = toon({ color: PALETTE.dark, side: THREE.DoubleSide });   // paint arcs are open: both faces
const tone = toon({ color: 0xcdd3dc, side: THREE.DoubleSide });      // the second flat grey of rule 5
const seam = toon({ color: 0x8b929c, side: THREE.DoubleSide });      // panel lines
const panelWhite = toon({ color: 0xf6f8fb, side: THREE.DoubleSide }); panelWhite.emissive = new THREE.Color(0x2c3036);
/* Inside a bell. The liner and the lip share the bells' emissive COLOUR OBJECT, so when
   js/vehicle.js warms `bellMetal` for a burn the throat and the rim glow with it, brighter. */
const liner = toon({ color: 0x2b2e35, side: THREE.DoubleSide }); liner.emissive = metal.emissive; liner.emissiveIntensity = 1.8;
const lip = toon({ color: 0x9a8f86, side: THREE.DoubleSide }); lip.emissive = metal.emissive; lip.emissiveIntensity = 3.2;

/* Rule 6: transformed copies of small parts, merged into one non-indexed mesh. */
const _v = new THREE.Vector3(), _n3 = new THREE.Matrix3(), _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), ONE = new THREE.Vector3(1, 1, 1);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
function fuse(mat, { cast = false, edge = false } = {}) {
  const pos = [], nrm = [];
  return {
    /* place `geo` at (x, y, z) after turning it by Euler (rx, ry, rz), then turn the lot `az` about the axis */
    add(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, az = 0) {
      _m4.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), ONE);
      if (az) _m4.premultiply(new THREE.Matrix4().makeRotationZ(az));
      return this.put(geo, _m4);
    },
    put(geo, m) {
      const g = geo.index ? geo.toNonIndexed() : geo, p = g.attributes.position, n = g.attributes.normal;
      _n3.getNormalMatrix(m);
      for (let i = 0; i < p.count; i++) {
        _v.fromBufferAttribute(p, i).applyMatrix4(m); pos.push(_v.x, _v.y, _v.z);
        _v.fromBufferAttribute(n, i).applyMatrix3(_n3).normalize(); nrm.push(_v.x, _v.y, _v.z);
      }
      return this;
    },
    into(group) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      const m = new THREE.Mesh(g, mat); m.castShadow = cast; if (edge) outline(m);
      group.add(m); return m;
    },
  };
}
/* A cylinder (or cone, or an arc of one) already stood along the vehicle's axis and centred on z.
   th0/thLen are azimuths in degrees from +x. */
function zcyl(rt, rb, len, seg, open = false, az0 = 0, azLen = 360) {
  const g = new THREE.CylinderGeometry(rt, rb, len, seg, 1, open, THREE.MathUtils.degToRad(az0 + 90), THREE.MathUtils.degToRad(azLen));
  g.rotateX(Math.PI / 2);
  return g;
}
/* Rule 5: `n` strips of the second tone round a shell of radius r (rt at the top for a cone),
   every other one of 2n facets. */
function stringers(group, r, z0, z1, n, rTop = r, mat = tone) {
  const full = zcyl(rTop + 0.03, r + 0.03, z1 - z0, n * 2, true).toNonIndexed();
  const p = full.attributes.position, nr = full.attributes.normal, pos = [], nrm = [];
  for (let k = 0; k < n * 2; k += 2) for (let i = k * 6; i < k * 6 + 6; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nrm.push(nr.getX(i), nr.getY(i), nr.getZ(i)); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  const m = new THREE.Mesh(g, mat); m.position.z = (z0 + z1) / 2; group.add(m);
  return m;
}

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
  m.userData = { rt, rb, len };
  return m;
}

/* What makes a bell an engine at 30 m: a dark liner and an injector face inside it, a lip that glows
   when it fires, and the turbine-exhaust manifold band round its waist. One fused mesh per material
   for all the bells of a stage, each placed by its bell's own matrix (the outboards are canted). */
function dressBells(group, bells) {
  const fl = fuse(liner), fp = fuse(lip), fb = fuse(ink), m = new THREE.Matrix4();
  for (const b of bells) {
    const { rt, rb, len } = b.userData, r = (s) => rb + (rt - rb) * Math.pow(s, 0.55), y = (s) => -len / 2 + len * s;
    const prof = (s0, s1, inset) => { const pts = []; for (let i = 0; i <= 8; i++) { const s = s0 + (s1 - s0) * i / 8; pts.push(new THREE.Vector2(r(s) - inset, y(s))); } return new THREE.LatheGeometry(pts, 20); };
    b.updateMatrix(); m.copy(b.matrix);
    fl.put(prof(0.10, 0.9, 0.05), m);
    const face = new THREE.CircleGeometry(r(0.9) - 0.05, 20); face.rotateX(Math.PI / 2); face.translate(0, y(0.9), 0); fl.put(face, m);
    fp.put(prof(0.0, 0.10, 0.035), m);
    const band = new THREE.CylinderGeometry(r(0.56) + 0.07, r(0.44) + 0.07, len * 0.12, 20, 1, true); band.translate(0, y(0.5), 0); fb.put(band, m);
  }
  fl.into(group); fp.into(group); fb.into(group);
}

/* Lettering stacked down the hull, as on the real first stage. Needs a canvas, so the headless
   mission harness (which imports this module for the stage records) simply gets none. */
function lettering(text, colour) {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128 * text.length;
  const c = cv.getContext('2d');
  c.font = '900 112px "Arial Black", "Helvetica Neue", Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = colour;
  [...text].forEach((ch, i) => c.fillText(ch, 64, 64 + i * 128 + 6));
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const usa = lettering('USA', '#c8402a'), unitedStates = lettering('UNITED STATES', '#c8402a');
/* The flag, drawn: thirteen stripes and a blue canton with a block of stars. */
function flagTexture() {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas'); cv.width = 190; cv.height = 100;
  const c = cv.getContext('2d');
  for (let i = 0; i < 13; i++) { c.fillStyle = i % 2 ? '#f4f5f7' : '#c8402a'; c.fillRect(0, Math.round(i * 100 / 13), 190, Math.ceil(100 / 13)); }
  c.fillStyle = '#27407a'; c.fillRect(0, 0, 76, 54);
  c.fillStyle = '#f4f5f7';
  for (let j = 0; j < 5; j++) for (let i = 0; i < 6; i++) c.fillRect(7 + i * 11.5, 6 + j * 9.4, 4, 4);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const flag = flagTexture();
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
  if (flag) for (const az of [90, 270]) g.add(decal(3.57, -19.6, -17.9, az, 52, flag));   // 3.2 × 1.7 u, between the frames and the forward pattern
  /* Systems tunnel, half sunk in the tank wall, at azimuth 30°: clear of the lettering (0°), the
     flags (90°) and the aft roll pattern (±22.5°). It stood at 0° and ran through the "USA". */
  const tunnel = cyl(0.22, 0.22, 21.6, -23.2, white, 8); tunnel.position.set(3.6 * Math.cos(Math.PI / 6), 3.6 * Math.sin(Math.PI / 6), -23.2); g.add(tunnel);
  stringers(g, 3.57, -25.45, -22.55, 40);                     // intertank corrugation, between its two frames
  g.add(cyl(3.62, 3.62, 2.5, -10.75, white, SEG, true));      // interstage −12.0 .. −9.5: shrouds the J-2s until staging
  g.add(cyl(3.66, 3.66, 0.45, -11.75, black));                // its separation frame
  stringers(g, 3.62, -11.45, -9.6, 40);                       // the interstage is corrugated skin
  {
    /* Eight ullage motors round the interstage, in pairs either side of each fin line: a fairing
       half sunk in the skin with its nozzle looking aft. They leave with the interstage. */
    const f = fuse(white, { cast: true, edge: true }), nz = fuse(black);
    for (let i = 0; i < 8; i++) {
      const az = (i * 45 + 22.5) * Math.PI / 180;
      f.add(zcyl(0.1, 0.26, 1.25, 10), 3.66, 0, -10.55, 0, 0, 0, az);
      nz.add(zcyl(0.2, 0.3, 0.3, 10), 3.7, 0, -11.3, 0, 0, 0, az);
    }
    f.into(g); nz.into(g);
  }
  /* Engine fairings and fins at the four outboard positions. Each fairing is a half-buried cone
     over its F-1; the fin's root is inside the fairing along its whole length. */
  const fin = new THREE.Shape();                              // x = radial, y = axial z
  fin.moveTo(3.4, -36.4); fin.lineTo(5.7, -38.7); fin.lineTo(5.7, -39.8); fin.lineTo(3.4, -39.8);
  const finGeo = new THREE.ExtrudeGeometry(fin, { depth: .26, bevelEnabled: false }); finGeo.translate(0, 0, -.13);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    const f = cyl(0.35, 1.75, 6.5, -36.45, white, 20, true);  // −39.7 .. −33.2: 0.1 u short of the fin's lower edge, which it shared a plane with
    f.position.x = Math.cos(a) * 2.75; f.position.y = Math.sin(a) * 2.75;
    g.add(f);
    const arm = new THREE.Group(); arm.rotation.z = a;
    const m = new THREE.Mesh(finGeo, black); m.rotation.x = Math.PI / 2; m.castShadow = true; outline(m);
    arm.add(m); g.add(arm);
  }
  /* Five F-1s: throats in the skirt solid, exits 2.4 u below its rim. Bolt circle r 2.35 puts the
     exit rims tangent; the outboards cant 0.1 rad outward, the real gimbal trim. */
  const bells = [bell(0.42, 1.19, 2.6, -40.7)];
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    const b = bell(0.42, 1.15, 2.6, -40.7);
    b.position.x = Math.cos(a) * 2.35; b.position.y = Math.sin(a) * 2.35;
    b.quaternion.setFromAxisAngle(new THREE.Vector3(-Math.sin(a), Math.cos(a), 0), -0.1).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
    bells.push(b);
  }
  g.add(...bells); dressBells(g, bells);
  stages[0].tailZ = TAIL_Z[0];
  stages[0].engines = [[0, 0], ...[0, 1, 2, 3].map(i => { const a = i * Math.PI / 2 + Math.PI / 4; return [Math.cos(a) * 2.35, Math.sin(a) * 2.35]; })];
}

/* ---- stage 1 — S-II and the forward cone that hides the S-IVB bell: −11.8 .. +8.6 ---- */
{
  const g = stages[1].meshes;
  g.add(cyl(3.58, 3.50, 1.5, -10.3, black, SEG, true));       // thrust structure −11.05 .. −9.55, inside the interstage while stacked
  g.add(cyl(3.57, 3.57, 16.85, -1.425, white, SEG, true));    // tanks −9.85 .. +7.0: clear of the S-1 tank's top (−9.9), same radius
  panels(g, 3.57, 3.4, 6.5, 0, 45);                           // forward roll pattern
  g.add(cyl(3.62, 3.62, 0.3, -7.4, black));                   // aft frame
  const tunnel = cyl(0.2, 0.2, 13.4, -1.0, white, 8); tunnel.position.set(3.6 * Math.cos(Math.PI / 6), 3.6 * Math.sin(Math.PI / 6), -1.0); g.add(tunnel);
  stringers(g, 3.57, -9.4, -7.6, 40);                         // aft skirt
  stringers(g, 3.57, 3.45, 6.5, 40);                          // forward skirt, under the roll pattern
  g.add(panel(3.57 - 0.02, -3.2, -2.9, 0, 360, tone));        // two weld lines round the hydrogen tank
  g.add(panel(3.57 - 0.02, 1.3, 1.6, 0, 360, tone));
  if (unitedStates) for (const az of [90, 270]) g.add(decal(3.57, -7.0, 3.1, az, 12.5, unitedStates));   // 0.78 u a letter
  g.add(cyl(2.55, 3.52, 1.9, 7.65, white, SEG, true));        // forward cone +6.7 .. +8.6, tapering 10 m to the S-IVB
  /* +6.58 .. +7.08: its top face stands 0.08 u over the tank's top cap (+7.0). At 0.4 tall it ended
     at +7.0 exactly, and the two caps shared the ring between the cone's foot (r 3.52) and the tank
     wall (r 3.57) — coplanar faces, which flickered as a speckled band round the shoulder. */
  g.add(cyl(3.61, 3.61, 0.5, 6.83, black));                   // the frame at its foot
  const bells = [bell(0.30, 0.72, 1.9, -10.85)];              // five J-2s on r 1.44, exits at −11.8
  const engines = [[0, 0]];
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    const b = bell(0.30, 0.70, 1.9, -10.85);
    b.position.x = Math.cos(a) * 1.44; b.position.y = Math.sin(a) * 1.44;
    bells.push(b); engines.push([b.position.x, b.position.y]);
  }
  g.add(...bells); dressBells(g, bells);
  stages[1].tailZ = TAIL_Z[1];
  stages[1].engines = engines;
}

/* ---- stage 2 — S-IVB, instrument unit, adapter, service and command modules: +6.8 .. +28.6.
   SPECS[2] is one engine doing TLI, LOI, deorbit and descent (docs/reference/spacecraft.md), so
   it has ONE bell, at the S-IVB tail where the flame must sit. ---- */
{
  const g = stages[2].meshes;
  g.add(cyl(2.36, 2.36, 11.5, 13.9, white, 32, true));        // S-IVB +8.15 .. +19.65, foot inside the S-II cone
  panels(g, 2.36, 8.7, 11.4, 45, 45);                         // aft roll pattern
  const j2 = bell(0.32, 0.85, 1.7, 7.65); g.add(j2); dressBells(g, [j2]);   // exit +6.8
  /* The thrust structure: a dark cone from the tank's aft dome in to the engine. Without it the
     lander was a tube with a flat bottom and a bell stuck on. Inside the S-II's forward cone while
     stacked (r 2.75 there against 2.3 here). */
  g.add(cyl(2.3, 0.72, 0.8, 7.85, black, 32, true));          // +7.45 .. +8.25, mouth inside the tank's foot
  stringers(g, 2.36, 8.75, 11.35, 28);                        // aft skirt, under the roll pattern
  stringers(g, 2.36, 17.2, 19.1, 28);                         // forward skirt
  {
    /* Two auxiliary propulsion pods on the aft skirt, at 135° and 315° (the roll pattern's black
       quadrants, so they read), and two ullage motors on the other pair. */
    const pod = fuse(white, { cast: true, edge: true }), dk = fuse(black);
    for (const azd of [135, 315]) {
      const az = azd * Math.PI / 180;
      pod.add(new THREE.BoxGeometry(0.62, 0.95, 1.9), 2.5, 0, 10.0, 0, 0, 0, az);
      pod.add(zcyl(0.05, 0.42, 0.6, 4), 2.48, 0, 11.25, 0, 0, Math.PI / 4, az);          // its pointed fairing
      for (const sy of [-1, 1]) dk.add(new THREE.CylinderGeometry(0.1, 0.15, 0.3, 8), 2.62, sy * 0.52, 10.3, 0, 0, 0, az);   // thrusters, firing sideways
      dk.add(zcyl(0.1, 0.15, 0.3, 8), 2.66, 0, 8.95, 0, 0, 0, az);                                                         // and one aft
    }
    for (const azd of [45, 225]) {
      const az = azd * Math.PI / 180;
      pod.add(zcyl(0.08, 0.22, 1.1, 10), 2.42, 0, 9.5, 0, 0, 0, az);
      dk.add(zcyl(0.17, 0.25, 0.26, 10), 2.46, 0, 8.86, 0, 0, 0, az);
    }
    pod.into(g); dk.into(g);
  }
  /* Instrument unit and forward skirt, +19.12 .. +21.3: the skirt is the black band; the IU proper
     is the ring of pale plate on top of it, with its antenna and umbilical boxes. */
  g.add(cyl(2.42, 2.42, 2.18, 20.21, black, 32));
  g.add(panel(2.42, 20.42, 21.12, 0, 360, seam));             // the IU: a grey ring 0.7 u tall, 0.05 proud of the band
  {
    const f = fuse(silver, { cast: true });
    for (const azd of [20, 110, 200, 290]) f.add(new THREE.BoxGeometry(0.2, 0.5, 0.42), 2.5, 0, 20.77, 0, 0, 0, azd * Math.PI / 180);
    f.into(g);
  }
  g.add(cyl(1.55, 2.46, 1.95, 22.025, white, 32, true));      // spacecraft adapter +21.05 .. +23.0, foot over the IU rim
  {
    /* The adapter is four panels: their seams, and the hinge line they fold at. Arcs of the cone's
       own slope (r 2.46 at +21.05 to 1.55 at +23.0), 0.03 u proud. */
    const f = fuse(seam), rAt = (z) => 2.46 - (z - 21.05) * (2.46 - 1.55) / 1.95 + 0.03;
    for (const azd of [45, 135, 225, 315]) f.add(zcyl(rAt(22.85), rAt(21.4), 1.45, 2, true, azd - 1.6, 3.2), 0, 0, 22.125);
    f.add(zcyl(rAt(21.52), rAt(21.4), 0.12, 40, true), 0, 0, 21.46);
    f.into(g);
  }
  g.add(cyl(1.39, 1.39, 3.45, 24.625, silver, 32, true));     // service module +22.9 .. +26.35
  g.add(cyl(1.43, 1.43, 0.3, 26.1, black, 32));               // its forward frame
  {
    /* The service module's skin: two big environmental radiators low on opposite sides, eight small
       fuel-cell radiators under the forward frame, the sector seams between them — all paint
       (rule 3) — and the things that stand off it: four RCS quads with their nozzles and two
       scimitar antennas. */
    const wp = fuse(panelWhite), sm = fuse(seam), dk = fuse(black, { cast: true }), sv = fuse(silver, { cast: true, edge: true });
    for (const azd of [90, 270]) {
      sm.add(zcyl(1.42, 1.42, 1.56, 12, true, azd - 36, 72), 0, 0, 23.95);
      wp.add(zcyl(1.44, 1.44, 1.4, 12, true, azd - 33, 66), 0, 0, 23.95);
      for (const d of [-11, 11]) sm.add(zcyl(1.46, 1.46, 1.4, 2, true, azd + d - 1.2, 2.4), 0, 0, 23.95);   // its tube runs
    }
    for (let i = 0; i < 8; i++) wp.add(zcyl(1.42, 1.42, 0.55, 4, true, i * 45 + 8, 29), 0, 0, 25.55);
    for (const azd of [0, 180]) sm.add(zcyl(1.42, 1.42, 2.9, 2, true, azd - 1.8, 3.6), 0, 0, 24.45);
    for (let i = 0; i < 4; i++) {
      const az = i * Math.PI / 2 + Math.PI / 4;
      dk.add(new THREE.BoxGeometry(0.3, 0.4, 0.5), 1.47, 0, 24.9, 0, 0, 0, az);
      dk.add(zcyl(0.07, 0.12, 0.92, 8), 1.66, 0, 24.9, 0, 0, 0, az);                        // fore-and-aft pair
      dk.add(new THREE.CylinderGeometry(0.07, 0.12, 0.92, 8), 1.66, 0, 24.9, 0, 0, 0, az);  // roll pair
    }
    const sc = new THREE.Shape(); sc.moveTo(0, -0.42); sc.lineTo(0.5, -0.3); sc.lineTo(0.62, 0); sc.lineTo(0.5, 0.3); sc.lineTo(0, 0.42); sc.closePath();
    const scGeo = new THREE.ExtrudeGeometry(sc, { depth: 0.1, bevelEnabled: false }); scGeo.translate(0, 0, -0.05); scGeo.rotateX(Math.PI / 2);
    for (const azd of [22, 202]) sv.add(scGeo, 1.34, 0, 23.5, 0, 0, 0, azd * Math.PI / 180);
    sm.into(g); wp.into(g); dk.into(g); sv.into(g);
  }
  /* The command module is its own group on the rocket, not part of this stage: when the CSM is
     dropped (X on the last stage) it is what is left flying, and what the parachutes hang from. */
  capsuleGroup.add(cyl(0.36, 1.33, 2.3, 27.45, white, 32, true));   // +26.3 .. +28.6, base sunk in the SM top
  capsuleGroup.add(cyl(1.33, 1.05, 0.34, 26.2, shield, 32, true));  // heat shield, hidden inside the SM until then
  /* The command module's face. Apollo's had five windows — two forward-looking rendezvous windows,
     two square side windows and a round one in the crew hatch — the hatch itself, and reaction
     control ports round the base. Without them the capsule alone was a plain grey cone, and it is
     the whole vehicle for the trip home. Each piece is a thin plate laid on the cone (half-angle
     22.9°: r 1.33 at z 26.3 to 0.36 at 28.6), 0.02 u proud so nothing shares a surface. */
  {
    const CONE = Math.atan((1.33 - 0.36) / 2.3), cs = Math.cos(CONE), sn = Math.sin(CONE);
    const u = new THREE.Vector3(), v = new THREE.Vector3(), n = new THREE.Vector3(), basis = new THREE.Matrix4();
    const lay = (geo, mat, azDeg, z, lift = 0.02) => {
      const az = THREE.MathUtils.degToRad(azDeg), r = 1.33 - (z - 26.3) * (1.33 - 0.36) / 2.3;
      n.set(Math.cos(az) * cs, Math.sin(az) * cs, sn);
      u.set(-Math.sin(az), Math.cos(az), 0); v.crossVectors(n, u);
      const m = new THREE.Mesh(geo, mat);
      m.quaternion.setFromRotationMatrix(basis.makeBasis(u, v, n));
      m.position.set(Math.cos(az) * r, Math.sin(az) * r, z).addScaledVector(n, lift);
      capsuleGroup.add(m);
      return m;
    };
    const plate = (w, h) => new THREE.PlaneGeometry(w, h);
    const taper = (w0, w1, h) => {                       // a window narrower at the top, like the cone it sits on
      const sh = new THREE.Shape();
      sh.moveTo(-w0 / 2, -h / 2); sh.lineTo(w0 / 2, -h / 2); sh.lineTo(w1 / 2, h / 2); sh.lineTo(-w1 / 2, h / 2); sh.closePath();
      return new THREE.ShapeGeometry(sh);
    };
    // crew hatch: frame, door, round window — on the side that faces the tower's white room (−x)
    lay(plate(0.74, 0.92), frame, 180, 27.2);
    lay(plate(0.62, 0.80), white, 180, 27.2, 0.03);
    lay(new THREE.CircleGeometry(0.15, 20), frame, 180, 27.36, 0.04);
    lay(new THREE.CircleGeometry(0.11, 20), glass, 180, 27.36, 0.05);
    lay(plate(0.30, 0.05), frame, 180, 26.95, 0.04);     // hatch handle
    // two square side windows flanking the hatch
    for (const az of [128, 232]) { lay(plate(0.40, 0.40), frame, az, 27.3); lay(plate(0.30, 0.30), glass, az, 27.3, 0.03); }
    // two rendezvous windows, forward-looking, either side of the hatch line
    for (const az of [156, 204]) { lay(taper(0.24, 0.15, 0.50), frame, az, 28.0); lay(taper(0.16, 0.09, 0.40), glass, az, 28.0, 0.03); }
    // reaction control ports: pairs of dark nozzles in four quads round the base
    for (const az of [45, 135, 225, 315]) for (const d of [-7, 7]) lay(new THREE.CircleGeometry(0.07, 12), frame, az + d, 26.72, 0.03);
    // the black band where the cone meets the heat shield, and the forward cap under the tunnel
    capsuleGroup.add(cyl(1.345, 1.345, 0.07, 26.36, black, 32));
    capsuleGroup.add(cyl(0.38, 0.50, 0.30, 28.43, silver, 24, true));
    capsuleGroup.add(cyl(0.20, 0.26, 0.16, 28.66, black, 16));   // docking tunnel rim (under the escape tower until it leaves)
  }
  stages[2].tailZ = TAIL_Z[2];
  stages[2].engines = [[0, 0]];
}

/* ---- stages 3 and 4 — the lunar module, stacked ABOVE the command module ----
   The one layout where the LM can land on its own feet and the capsule still ride the primary
   engine: the lander straddles the CM's apex, soles (LM_FOOT_Z, js/stations.js) hanging down past
   the heat shield, its crew tunnel reaching down to the CM's docking rim. The descent stage is the
   octagonal foil-wrapped box with the landing legs; the ascent stage is the cabin on top, and its
   little bell sits recessed INSIDE the descent engine's skirt (Apollo's own arrangement — 0.09 u
   of radial clearance, and the two exit planes 29.15/29.3 are different planes, so the coplanar
   gate cannot see them). Legs are built deployed: Apollo's unfolded once and stayed; there is no
   setGear for them, and gear.js never asks.

   The 3-row test stacks (tools/mission-sim.mjs overrides SPECS with its own literals) have no LM
   at all, so this whole block is guarded on the row count. */
if (stages.length > 3) {
  const g3 = stages[3].meshes, g4 = stages[4].meshes;

  /* descent stage: the octagonal foil-wrapped tank cluster +29.7 .. +31.35, bell to +29.3.
     Real proportions (1 u = 1.4 m): the body is 2.9 u across, and the four landing legs splay
     WIDER than the body — foot circle 2.62 u against the tank's 1.72 — which is what makes the
     LM read as a spider and not a box on stilts. The old version stood its feet inside the hull
     and wore its RCS quads on the descent stage; the real quads are on the ASCENT stage (fore
     and aft), and the descent stage carries the landing radar instead. */
  g3.add(cyl(1.72, 1.72, 1.65, 30.525, gold, 8, true));
  g3.add(cyl(1.76, 1.76, 0.16, 29.78, tone, 8));              // aft frame at the tank's foot
  g3.add(cyl(1.76, 1.76, 0.16, 31.27, tone, 8));              // and the deck the cabin bolts to
  {
    const dk = fuse(black, { cast: true });
    for (let k = 0; k < 8; k++)                               // the eight corner posts of the tank cluster
      dk.add(new THREE.BoxGeometry(0.10, 0.10, 1.58), 1.70, 0, 30.52, 0, 0, 0, k * Math.PI / 4);
    dk.add(new THREE.BoxGeometry(0.10, 0.62, 0.46), 1.60, 0, 29.62, 0, 0, 0, 3 * Math.PI / 4);   // AGS/RDMA bay
    for (const yo of [-0.20, 0, 0.20])                        // its three antenna horns
      dk.add(new THREE.CylinderGeometry(0.045, 0.065, 0.2, 8).rotateZ(Math.PI / 2), 1.74, yo, 29.62, 0, 0, 0, 3 * Math.PI / 4);
    dk.into(g3);
  }
  const db = bell(0.30, 0.68, 1.4, 30.0); g3.add(db); dressBells(g3, [db]);   // exit +29.3

  /* landing legs, hinged at the tank's corner, feet 4.4 u below on LM_FOOT_Z — the plane
     js/physics.js scores contact (CONTACT_Z[3]). Each: a main strut out to r 2.62, two
     secondary struts to points down its length, and a 1.6 u dish footpad whose rim sits exactly
     at contact, far out past the heat shield's widest ring (r 1.33): nothing of the capsule is
     under a foot. At 225° the strut carries the ladder the crew walks down onto the Moon. */
  {
    const A = new THREE.Vector3(), B = new THREE.Vector3(), D = new THREE.Vector3(), YAX = new THREE.Vector3(0, 1, 0);
    const leg = (mat, ra, za, rb, zb, r, edge = true) => {    // a strut from (ra,0,za) to (rb,0,zb); cylinder axis is Y → map Y onto the strut
      A.set(ra, 0, za); B.set(rb, 0, zb); D.subVectors(B, A);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, D.length(), 8), mat);
      m.position.copy(A).addScaledVector(D, 0.5);
      m.quaternion.setFromUnitVectors(YAX, D.clone().normalize());
      m.castShadow = true; if (edge) outline(m); g3.add(m); return m;
    };
    const padPts = [new THREE.Vector2(0.80, 0), new THREE.Vector2(0.72, 0.07), new THREE.Vector2(0.45, 0.14), new THREE.Vector2(0.20, 0.17), new THREE.Vector2(0, 0.18)];
    const padGeo = new THREE.LatheGeometry(padPts, 20);       // a shallow dish, opening up: rim is the sole
    for (let i = 0; i < 4; i++) {
      const az = i * Math.PI / 2 + Math.PI / 4, c = Math.cos(az), s = Math.sin(az);
      leg(silver, 1.78, 30.10, 2.62, 25.80, 0.085);           // main strut (hinge bracket to foot centre)
      leg(silver, 1.70, 29.78, 2.20, 27.05, 0.045, false);    // the two secondaries Apollo braced it with
      leg(silver, 1.70, 29.78, 2.42, 26.45, 0.045, false);
      const pad = new THREE.Mesh(padGeo, tone);
      pad.position.set(c * 2.62, s * 2.62, 25.60); pad.castShadow = true; outline(pad); g3.add(pad);  // rim at 25.6 = LM_FOOT_Z
      const hng = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.34, 10), black);
      hng.quaternion.setFromUnitVectors(YAX, new THREE.Vector3(-s, c, 0));   // hinge pin horizontal, tangential
      hng.position.set(c * 1.80, s * 1.80, 30.10); g3.add(hng);
    }
    const lad = fuse(silver, { cast: true });                 // ladder on the 225° leg, outside its strut
    const ux = (2.62 - 1.78) / 4.40, uz = (25.80 - 30.10) / 4.40, th = Math.atan2(ux, uz);
    for (let j = 0; j < 5; j++)
      lad.add(new THREE.BoxGeometry(0.06, 0.42, 0.06), 1.78 + ux * (1.35 + j * 0.62) - uz * 0.30, 0, 30.10 + uz * (1.35 + j * 0.62) + ux * 0.30, 0, th, 0, 5 * Math.PI / 4);
    for (const yo of [-0.19, 0.19])
      lad.add(new THREE.BoxGeometry(0.05, 0.05, 3.7), 1.78 + ux * 2.2 - uz * 0.30, yo, 30.10 + uz * 2.2 + ux * 0.30, 0, th, 0, 5 * Math.PI / 4);
    lad.into(g3);
  }
  stages[3].tailZ = TAIL_Z[3];
  stages[3].engines = [[0, 0]];

  /* ascent stage: equipment deck, wedge cabin and roof 31.35 .. 33.4 (LM_TOP_Z), and the docking
     tunnel that spans down to the CM rim at +28.66. The octagon is turned 22.5° so its FLAT
     faces centre on the cardinals and diagonals: the two big front windows and two smaller sides
     sit on true facets, not across a corner as they used to. White crew cabin over the gold
     equipment deck is the real scheme — the foil ends where the crew compartment begins. */
  g4.add(cyl(0.34, 0.34, 2.6, 30.0, silver, 16, true));       // docking tunnel +28.7 .. +31.3
  g4.add(cyl(0.56, 0.56, 0.16, 31.24, silver, 16));           // tunnel collar at the cabin floor
  g4.add(cyl(0.5, 0.5, 0.14, 28.78, silver, 16));             // and the capture ring at the CM end
  g4.add(cyl(1.16, 1.16, 0.16, 31.42, tone, 8));              // lower frame to the descent deck
  const deck = new THREE.Mesh(zcyl(1.12, 1.16, 0.60, 8, false, 22.5), gold);
  deck.position.z = 31.80; deck.castShadow = true; outline(deck); g4.add(deck);
  const cab = new THREE.Mesh(zcyl(0.88, 0.97, 1.20, 8, false, 22.5), panelWhite);
  cab.position.z = 32.55; cab.castShadow = true; outline(cab); g4.add(cab);   // foot sunk into the deck; top 33.15
  const roof = new THREE.Mesh(zcyl(1.10, 1.10, 0.12, 8, false, 22.5), tone);
  roof.position.z = 33.34; roof.castShadow = true; outline(roof); g4.add(roof);   // top 33.40 = LM_TOP_Z
  {
    const gl = fuse(glass, { edge: false }), fr = fuse(frame), dk = fuse(black, { cast: true }), sv = fuse(silver, { cast: true });
    for (const azd of [90, 270]) {                            // the two big front windows, and their frames
      gl.add(new THREE.PlaneGeometry(0.46, 0.32), 0.880, 0, 32.60, 0, 0, 0, azd * Math.PI / 180);
      fr.add(new THREE.PlaneGeometry(0.58, 0.44), 0.865, 0, 32.60, 0, 0, 0, azd * Math.PI / 180);
    }
    for (const azd of [45, 225]) {                            // the two side windows
      gl.add(new THREE.PlaneGeometry(0.30, 0.22), 0.880, 0, 32.56, 0, 0, 0, azd * Math.PI / 180);
      fr.add(new THREE.PlaneGeometry(0.40, 0.32), 0.865, 0, 32.56, 0, 0, 0, azd * Math.PI / 180);
    }
    fr.add(new THREE.PlaneGeometry(0.50, 0.60), 0.868, 0, 32.45);                // hatch frame at 0°...
    gl.add(new THREE.PlaneGeometry(0.32, 0.42), 0.885, 0, 32.45);                // ...and its glass
    /* RCS: the two quads the real ascent stage carries, fore on one diagonal and aft on the
       other, each four nozzles. They live above the deck, never on the descent stage. */
    for (const [azd, zq] of [[45, 33.02], [225, 31.80]]) {
      const az = azd * Math.PI / 180, r = azd === 45 ? 0.97 : 1.08;
      dk.add(new THREE.BoxGeometry(0.28, 0.28, 0.26), r, 0, zq, 0, 0, 0, az);
      for (const dz of [-0.19, 0.19]) dk.add(new THREE.CylinderGeometry(0.05, 0.07, 0.22, 8).rotateX(Math.PI / 2), r, 0, zq + dz, 0, 0, 0, az);
      dk.add(new THREE.CylinderGeometry(0.05, 0.07, 0.22, 8).rotateZ(Math.PI / 2), r + 0.22, 0, zq, 0, 0, 0, az);
    }
    /* high-gain antenna: a dish on the aft deck tilted up and out, on a short mast */
    sv.add(new THREE.SphereGeometry(0.42, 14, 6, 0, Math.PI * 2, 0, 0.85), 0.62, 0, 33.38, 1.35, 0, 0, 7 * Math.PI / 4);
    sv.add(new THREE.CylinderGeometry(0.05, 0.05, 0.26, 8), 0.56, 0, 33.53, 1.35, 0, 0, 7 * Math.PI / 4);
    gl.into(g4); fr.into(g4); dk.into(g4); sv.into(g4);
  }
  const ab = bell(0.22, 0.50, 0.9, 29.6); g4.add(ab); dressBells(g4, [ab]);   // exit +29.15, inside the descent skirt
  stages[4].tailZ = TAIL_Z[4];
  stages[4].engines = [[0, 0]];
}

/* ---- landing gear: four legs on the S-IVB's aft skirt, at 0°, 90°, 180° and 270° ----
   This stage is what lands on the Moon, and it used to do it standing on its engine bell. Each leg
   is a strut hinged at the foot of the tank: stowed it lies up the hull like a fairing (0.09 u
   clear of the skin, above the S-II's forward cone and under every swing arm), deployed it swings
   out and down through LEG_DOWN to put a footpad on GEAR_Z — the plane js/physics.js calls contact
   for this stage (CONTACT_Z[2]), 0.6 u below the bell's exit at +6.8, so the bell hangs clear. Two
   telescoping stays per leg run from the hull to the strut; the pad stays level by turning against
   the strut. setGear(0..1) poses all of it and is all of it: js/gear.js decides when. */
export { GEAR_Z };
const HINGE_R = 2.62, HINGE_Z = 9.0, FOOT_R = 5.9, END_Z = GEAR_Z + 0.3;
const LEG_L = Math.hypot(FOOT_R - HINGE_R, HINGE_Z - END_Z), LEG_DOWN = Math.atan2(FOOT_R - HINGE_R, END_Z - HINGE_Z);
const STAY_AT = 0.62, STAY_R = 2.25, STAY_Y = 0.9, STAY_Z = 11.6;
export const GEAR = { feet: [0, 1, 2, 3].map(i => [Math.cos(i * Math.PI / 2) * FOOT_R, Math.sin(i * Math.PI / 2) * FOOT_R, GEAR_Z]), perRad: LEG_L * Math.sin(LEG_DOWN) };
const legs = [];
{
  const g = stages[2].meshes;
  const strutGeo = new THREE.BoxGeometry(0.34, 0.62, LEG_L); strutGeo.translate(0, 0, LEG_L / 2);
  { const p = strutGeo.attributes.position; for (let i = 0; i < p.count; i++) if (p.getZ(i) > LEG_L / 2) { p.setY(i, p.getY(i) * 0.5); p.setX(i, p.getX(i) * 0.8); } strutGeo.computeVertexNormals(); }
  const padGeo = new THREE.CylinderGeometry(0.6, 0.72, 0.18, 18); padGeo.rotateX(Math.PI / 2);
  const stayGeo = new THREE.CylinderGeometry(0.1, 0.1, 1, 8);
  const fixed = fuse(black, { cast: true });
  for (let i = 0; i < 4; i++) {
    const az = i * Math.PI / 2, turn = new THREE.Group(); turn.rotation.z = az;
    fixed.add(new THREE.BoxGeometry(0.56, 0.86, 0.5), HINGE_R - 0.08, 0, HINGE_Z, 0, 0, 0, az);          // hinge fitting
    for (const sy of [-1, 1]) fixed.add(new THREE.BoxGeometry(0.34, 0.34, 0.34), STAY_R + 0.05, sy * STAY_Y, STAY_Z, 0, 0, 0, az);
    const strut = new THREE.Mesh(strutGeo, silver); strut.castShadow = true; outline(strut);
    const knee = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 8), black); knee.position.z = LEG_L; strut.add(knee);
    strut.position.set(HINGE_R, 0, HINGE_Z);
    const pad = new THREE.Mesh(padGeo, black); pad.castShadow = true; outline(pad);
    const stays = [-1, 1].map(sy => { const m = new THREE.Mesh(stayGeo, black); m.castShadow = true; m.userData.sy = sy; return m; });
    turn.add(strut, pad, ...stays); g.add(turn);
    legs.push({ strut, pad, stays });
  }
  fixed.into(g);
}
const _d = new THREE.Vector3();
/* gear: 0 stowed .. 1 down (eased here). trim: optional rad per leg added when down, so each foot
   can find its own ground. */
export function setGear(gear, trim = null) {
  const e = gear * gear * (3 - 2 * gear);
  legs.forEach((leg, k) => {
    const th = (LEG_DOWN + (trim ? trim[k] : 0)) * e, sn = Math.sin(th), cs = Math.cos(th);
    leg.strut.rotation.y = th;
    leg.pad.position.set(HINGE_R + LEG_L * sn - 0.15 * (1 - e), 0, HINGE_Z + LEG_L * cs + 0.5 - 0.71 * e);
    leg.pad.rotation.y = (1 - e) * Math.PI / 2;
    const bx = HINGE_R + STAY_AT * LEG_L * sn, bz = HINGE_Z + STAY_AT * LEG_L * cs;
    for (const s of leg.stays) {
      _d.set(bx - STAY_R, -s.userData.sy * STAY_Y, bz - STAY_Z);
      const len = _d.length();
      s.position.set((bx + STAY_R) / 2, s.userData.sy * STAY_Y / 2, (bz + STAY_Z) / 2);
      s.quaternion.setFromUnitVectors(AXIS_Y, _d.multiplyScalar(1 / len));
      s.scale.set(1, len, 1);
    }
  });
}
setGear(0);

/* ---- launch escape system: its own group, so it can leave as a unit. Children carry absolute
   build coordinates and the group stays at the local origin, so detaching needs no bookkeeping. ---- */
export const lesGroup = new THREE.Group(); lesGroup.name = 'les';
stages[2].meshes.add(lesGroup);
{
  /* Every piece sits +4.7 u higher than Apollo's: with the LM on top of the CM (stages 3-4), the
     escape tower launches from the LM roof, not the capsule apex. Tip at +42.3 = LES_TIP_Z. */
  lesGroup.add(cyl(.50, .50, .50, 33.5, black, 14));          // seat on the LM roof +33.25 .. +33.75
  lesGroup.add(cyl(.16, .16, 5.3, 36.3, black, 8, true));     // mast +33.65 .. +38.95
  for (let i = 0; i < 4; i++) {                               // four tower legs, seat rim to motor base
    const a = i * Math.PI / 2;
    const leg = cyl(.07, .07, 5.2, 36.25, black, 5);
    leg.position.x = Math.cos(a) * 0.37; leg.position.y = Math.sin(a) * 0.37;
    leg.rotateOnWorldAxis(new THREE.Vector3(-Math.sin(a), Math.cos(a), 0), -0.023);
    lesGroup.add(leg);
  }
  lesGroup.add(cyl(.34, .55, 2.4, 40.1, white, 16, true));    // escape motor +38.9 .. +41.3
  lesGroup.add(cyl(.56, .56, 0.3, 39.1, black, 16));          // nozzle skirt
  const nose = new THREE.Mesh(new THREE.ConeGeometry(.34, 1.1, 16), black);   // tip +42.3, the top of the vehicle
  nose.rotation.x = Math.PI / 2; nose.position.z = 41.75; nose.castShadow = true; outline(nose); lesGroup.add(nose);
  const canard = new THREE.Shape();
  canard.moveTo(.34, 39.6); canard.lineTo(1.05, 40.2); canard.lineTo(1.05, 40.9); canard.lineTo(.34, 40.9);
  const canardGeo = new THREE.ExtrudeGeometry(canard, { depth: .1, bevelEnabled: false }); canardGeo.translate(0, 0, -.05);
  for (let i = 0; i < 2; i++) {
    const arm = new THREE.Group(); arm.rotation.z = i * Math.PI;
    const m = new THREE.Mesh(canardGeo, black); m.rotation.x = Math.PI / 2; m.castShadow = true; outline(m);
    arm.add(m); lesGroup.add(arm);
  }
}

stages.forEach((st) => rocketGroup.add(st.meshes));
