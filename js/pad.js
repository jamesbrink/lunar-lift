import * as THREE from 'three';
import { PAD_SCALE } from './constants.js';
import { padware as toon, outline, PALETTE } from './toon.js';
import { ARMS, ARM_FROM, ARM_SWING } from './colliders.js';

/* Launch Complex 39 as the game draws it: the mobile launcher's deck over the flame opening, the
   red umbilical tower with its swing arms and hammerhead crane, the propellant farm, the
   floodlights and the lightning masts. Build units, 1 u = 1.4 m, z up, the vehicle's axis on the
   origin; js/world.js welds the group to the planet.

   Contracts with the rest of the game, none of which this file may move:
   - the vehicle's state point rests at z = 41 (PAD_POS in js/constants.js), which puts its skirt at
     z 1.4, its fins at 1.2 and its bell exits at −1: the deck's top is z 1.0 and the bells hang in
     the opening;
   - the opening is 20 × 16 u and everything within r 6 u of the axis above the deck is air — the
     first stage's fins sweep r 5.7 on the way up;
   - the exhaust's analytic colliders (the trench bowl in js/exhaust-sim.js) know nothing of this mesh.

   Scale is the point of the detail. A 110 m rocket on a bare slab reads as a model; the same rocket
   beside a tower with eleven floors, a handrail and a van reads as 110 m. So the small things here
   are sized to people — a rail a metre high, floors 11 m apart, vehicles 5 m long — and nothing is
   decoration without being a ruler too.

   Everything static is MERGED: one mesh per material (and one more for the parts that carry the
   ink outline), instead of the ~170 draw calls the complex used to cost each frame, twice, with a
   shadow pass on top. */

/* Collects transformed primitives into a few big geometries. Non-indexed position + normal is all
   the toon material reads. */
function batcher() {
  const buckets = new Map();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const n3 = new THREE.Matrix3();
  return {
    /* rot: Euler xyz in radians. key = `${material name}|${edge}` */
    add(geo, mat, edge, x, y, z, rx = 0, ry = 0, rz = 0) {
      const key = mat.name + (edge ? '|edge' : '');
      if (!buckets.has(key)) buckets.set(key, { mat, edge, pos: [], nrm: [] });
      const b = buckets.get(key);
      const g = geo.index ? geo.toNonIndexed() : geo;
      m4.compose(v.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), one);
      n3.getNormalMatrix(m4);
      const p = g.attributes.position, n = g.attributes.normal;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(m4); b.pos.push(v.x, v.y, v.z);
        v.fromBufferAttribute(n, i).applyMatrix3(n3).normalize(); b.nrm.push(v.x, v.y, v.z);
      }
    },
    build(group, shadows = true) {
      for (const b of buckets.values()) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
        const m = new THREE.Mesh(g, b.mat);
        /* The red lattice casts but does not RECEIVE. Its members are 0.6-1.8 m across and a shadow
           texel at the pad is 1.46 m, so what one strut dropped on another was never a shape; and
           every pair of members that happen to stand one shadow bias apart along the light is a
           compare decided by rounding noise — under a thresholded shadow each such texel drags a
           stretch of hard edge with it (tools/flicker-test.mjs 'pad close': 62-103 unstable pixels
           and 15-23 flips with the lattice receiving, 0-19 and under 10 without). The moving parts
           at the vehicle's foot (hold-downs, mast arms) are the same case. The tower is shaded by
           its ramp; the ground, the deck, the shaft and the stack take its shadow. */
        m.castShadow = shadows; m.receiveShadow = shadows && b.mat.name !== 'red';
        if (b.edge) outline(m);
        group.add(m);
      }
    },
  };
}

const arms = [], holdDowns = [], mastArms = [];
const ease = (s) => s * s * (3 - 2 * s);
/* 0 = across the stack, 1 = swung clear against the tower. Eased, so they start and stop gently.
   Everything that lets go of the vehicle runs on this one clock (js/physics.js's armSwing): the
   hold-down arms are back in the first 40 % of it — they are what releases the stack — the tail
   service masts fold up over the first 70 %, and the swing arms take all of it. */
export function setArmSwing(s) {
  const e = ease(s);
  for (const a of arms) a.rotation.z = a.userData.dir * ARM_SWING * e;
  const h = ease(Math.min(1, s / 0.4)) * HOLD_TRAVEL;
  for (const a of holdDowns) a.position.set(a.userData.cx * h, a.userData.cy * h, 0);
  const m = ease(Math.min(1, s / 0.7)) * MAST_FOLD;
  for (const a of mastArms) a.rotation.y = -m;
}
const HOLD_TRAVEL = 3.6;       // u the hold-down arms draw back along the deck
const MAST_FOLD = 1.3;         // rad the tail service masts' umbilical arms fold up

/* Night on the pad, 0..1: the lamp lenses come up, the lens glows and the beams appear. The hard-edged
   light ON the hardware is js/toon.js's flood term; this is only the rig showing that it is lit. */
const LENS_OFF = new THREE.Color(0x30363f), LENS_ON = new THREE.Color(0xfff3cf);
let lensMat = null, beamMat = null, farMat = null, beams = null, beamsFar = null, glows = [];
/* away: 0 while the stack stands in the beams, 1 once it has gone — then they run on into the sky. */
export function setPadNight(n, away = 0) {
  if (!lensMat) return;
  lensMat.color.copy(LENS_OFF).lerp(LENS_ON, n);
  beams.visible = n > 0.02; beamMat.opacity = BEAM_ALPHA * n;
  beamsFar.visible = n * away > 0.02; farMat.opacity = BEAM_ALPHA * n * away;
  for (const l of glows) { l.visible = n > 0.02; l.material.opacity = 0.6 * n; }
}
const BEAM_ALPHA = 0.12;

export function buildPad(glowMap) {
  const g = new THREE.Group();
  g.scale.setScalar(PAD_SCALE);
  const named = (name, opts) => { const m = toon(opts); m.name = name; return m; };
  const deck = named('deck', { color: PALETTE.padDeck });
  const concrete = named('concrete', { color: PALETTE.padConcrete });
  const steel = named('steel', { color: PALETTE.padSteel });
  const red = named('red', { color: PALETTE.lutRed });
  const dark = named('dark', { color: PALETTE.blast });
  const hard = named('hard', { color: PALETTE.hardstand });
  const gravel = named('gravel', { color: PALETTE.gravel });
  const asphalt = named('asphalt', { color: PALETTE.asphalt });
  /* White with a floor of emissive: the tanks and the white room sit on the camera side of their
     own terminator through the launch window, and on the bare ramp they read as black. The real
     ones are the brightest things on the complex. */
  const whiteMat = named('white', { color: 0xe9eef4 }); whiteMat.emissive = new THREE.Color(0x33383f);

  const B = batcher(), thin = batcher();
  const boxGeo = (w, d, h) => new THREE.BoxGeometry(w, d, h);
  const box = (w, d, h, mat, x, y, z, edge = false, rx = 0, ry = 0, rz = 0, into = B) => into.add(boxGeo(w, d, h), mat, edge, x, y, z, rx, ry, rz);

  /* ---- mobile launcher: four slabs round a real opening, the trench floor under it ----
     The deck used to be one solid box with a dark box set into it, both tops at z = 3.0, and the
     vehicle — whose skirt ends at z 1.4 and whose bells hang to −1 — stood sunk through the pair of
     them. Two coplanar faces under a logarithmic depth buffer rasterise as crawling stripes, and
     that is what flickered at the foot of the stack. Now nothing shares a plane: the deck's top is
     z 1.0, just under the skirt and the fins; the opening is an actual hole, with the bells hanging
     into it; and the only surface in the hole is the floor at z 0.62, over the hardstand's 0.45. Every slab's underside is
     below ground, so no bottom edge lies on the terrain either. */
  box(64, 15, 2.6, deck, 0, 15.5, -0.3, true);
  box(64, 15, 2.6, deck, 0, -15.5, -0.3, true);
  box(22, 16.2, 2.6, deck, 21, 0, -0.3, true);
  box(22, 16.2, 2.6, deck, -21, 0, -0.3, true);
  box(20.6, 16.6, 1.6, dark, 0, 0, -0.18);                            // trench floor, top z 0.62
  /* Four hold-down arms between the fins: a wedge from a tall heel on the deck down to a toe just
     under the skirt (z 1.4). They MOVE — each is its own mesh and draws back along the deck when
     the swing arms go (setArmSwing). Underside z 0.75: over the trench floor (0.62), inside the
     deck slab (top 1.0) where it crosses one, so no face of it lies on another. */
  holdDowns.length = 0;
  {
    const sh = new THREE.Shape();                       // x = radius from the axis, y = height
    sh.moveTo(3.5, 0.75); sh.lineTo(3.5, 1.3); sh.lineTo(5.6, 1.3); sh.lineTo(8.6, 2.7); sh.lineTo(11.2, 2.7); sh.lineTo(11.2, 0.75); sh.closePath();
    const geo = new THREE.ExtrudeGeometry(sh, { depth: 2.0, bevelEnabled: false }); geo.translate(0, 0, -1.0); geo.rotateX(Math.PI / 2);
    const cap = boxGeo(1.5, 2.3, 0.5);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2, grp = new THREE.Group(), turn = new THREE.Group();
      turn.rotation.z = a;
      const m = new THREE.Mesh(geo, dark); m.castShadow = true; outline(m); turn.add(m);
      const c = new THREE.Mesh(cap, red); c.position.set(9.9, 0, 2.9); c.castShadow = true; turn.add(c);   // the release housing on the heel
      grp.add(turn); grp.userData.cx = Math.cos(a); grp.userData.cy = Math.sin(a);
      g.add(grp); holdDowns.push(grp);
    }
  }
  // handrail round the deck: 1.1 m high, the first thing on the pad that is the size of a person
  for (const [w, d, x, y] of [[64, 0.12, 0, 22.9], [64, 0.12, 0, -22.9], [0.12, 45.8, 31.9, 0], [0.12, 45.8, -31.9, 0]]) {
    box(w, d, 0.12, steel, x, y, 1.8, false, 0, 0, 0, thin);
  }
  for (let i = 0; i <= 16; i++) for (const y of [22.9, -22.9]) box(0.12, 0.12, 0.8, steel, -32 + i * 4, y, 1.4, false, 0, 0, 0, thin);
  for (let i = 1; i < 12; i++) for (const x of [31.9, -31.9]) box(0.12, 0.12, 0.8, steel, x, -22.9 + i * 3.82, 1.4, false, 0, 0, 0, thin);

  /* ---- launch umbilical tower: 88 u (123 m) of red steel beside the vehicle ----
     Four legs, a floor every 8 u, one diagonal per bay per face, a lift shaft up the middle so it
     is a building and not a cage. Eleven floors is what makes the rocket next to it tall. */
  const TX = -21, TW = 9, Z0 = -3, ZT = 92;
  box(15, 13, 5, concrete, TX, 0, 3.3, true);                          // tower base
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) box(1.3, 1.3, ZT - Z0 - 4, red, TX + sx * TW / 2, sy * TW / 2, (ZT + Z0 + 4) / 2, true);
  box(3.6, 3.6, ZT - Z0 - 4, steel, TX, 0, (ZT + Z0 + 4) / 2, true);   // lift shaft
  for (let z = 12; z <= ZT; z += 8) {
    box(TW + 1.6, TW + 1.6, 0.5, red, TX, 0, z);
    /* A parapet round every floor: a metre-high band of pale plate, 0.04 u off the slab's edge. It
       is the railing a person would stand at, drawn thick enough to hold a pixel at the pad camera,
       and eleven of them are what make the tower read as storeys rather than a lattice. */
    for (const sy of [-1, 1]) {
      box(TW + 2.08, 0.2, 1.35, steel, TX, sy * (TW / 2 + 0.94), z + 0.63);   // underside z − 0.045: the crew arm's is at 67.9, and 0.58 put this one on it
      box(0.2, TW + 1.5, 1.35, steel, TX + sy * (TW / 2 + 0.94), 0, z + 0.63);
    }
    if (z < ZT) {
      const bl = Math.hypot(TW, 8), ba = Math.atan2(TW, 8), zc = z + 4, flip = ((z / 8) & 1) ? 1 : -1;
      box(0.45, 0.45, bl, red, TX, TW / 2, zc, false, 0, flip * ba, 0);
      box(0.45, 0.45, bl, red, TX, -TW / 2, zc, false, 0, -flip * ba, 0);
      box(0.45, 0.45, bl, red, TX + TW / 2, 0, zc, false, flip * ba, 0, 0);
      box(0.45, 0.45, bl, red, TX - TW / 2, 0, zc, false, -flip * ba, 0, 0);
    }
  }
  /* Swing arms, one per joint that needs servicing, each stopping 0.9 u short of the hull it faces
     (hull radii 3.6 / 3.6 / 3.6 / 2.4 / 1.4 at those heights). They are on the −x side; the fins
     sweep the diagonals, so the ascent passes between nothing. */
  /* They MOVE: each arm is its own group hinged on the tower face and swings clear at ignition
     (setArmSwing, driven from js/physics.js's clock). Standing still they were sawn through by the
     wider stages on the way up — the S-1's 3.6 u hull passing an arm that stops 2.3 u from the
     axis. Shapes come from js/colliders.js, the same table collision uses. */
  arms.length = 0;
  for (const [z, hullR, w] of ARMS) {
    const tip = -(hullR + 0.9), len = tip - ARM_FROM;
    const arm = new THREE.Group(); arm.position.set(ARM_FROM, 0, z);
    const part = (gw, gd, gh, mat, x, y, zz, edge, ry = 0) => {
      const m = new THREE.Mesh(boxGeo(gw, gd, gh), mat); m.position.set(x, y, zz); m.rotation.y = ry;
      /* The rule the tower lattice encodes above: members thinner than a shadow texel (1.46 m /
         1.4 m·u⁻¹ ≈ 1.05 u) cast but do not RECEIVE — a stay's own shadow on its neighbour is
         rounding noise that drags a hard edge with it. The arm beams and hoods take the shadow;
         the 0.3 u stays, walkways and plates do not. */
      m.castShadow = true; m.receiveShadow = Math.min(gw, gd, gh) > 1.05;
      if (edge) outline(m); arm.add(m);
    };
    part(len, w, w, red, len / 2, 0, 0, true);
    part(len * 0.6, 0.3, 0.3, red, len * 0.3, 0, w * 1.6, false, -0.42);     // stay from the tower to mid-arm
    part(len * 0.86, w + 0.12, 0.3, steel, len * 0.5, 0, w / 2 + 0.06, false);   // the walkway along its top
    part(0.3, w * 0.8, w * 1.25, dark, len - 0.05, 0, -w * 0.08, false);         // umbilical carrier plate at the tip
    part(len * 0.7, 0.34, 0.34, dark, len * 0.55, w / 2 + 0.2, -w * 0.2, false); // and the propellant line that feeds it
    if (z === 68.5) part(3.2, 3.0, 2.8, whiteMat, -4.6 - ARM_FROM, 0, 0, true);   // the white room, on the crew arm
    /* Alternate sides, so neighbouring arms do not fold into each other against the tower. */
    arm.userData.dir = arms.length % 2 ? 1 : -1;
    g.add(arm); arms.push(arm);
  }
  // hammerhead crane
  box(4.5, 4.5, 3.4, red, TX, 0, ZT + 1.9, true);
  /* Parked along the tower's north-south face, not out over the vehicle: its jib used to end 1.4 m
     from the vehicle's axis at z 96, and the stack flew straight through it (found by
     js/colliders.js the first time the complex was made solid). */
  box(1.8, 34, 2.2, red, TX, 3, ZT + 4.6, true);
  box(3.2, 5, 3.4, dark, TX, -12, ZT + 4.3, true);                     // counterweight: top 6.0, over the jib's 5.7 (they shared 5.7 and fought)
  box(2.6, 3, 2.4, steel, TX + 2.2, 2.5, ZT + 2.25, true);             // operator's cab: top 3.45, under the crane base's 3.6
  box(1.7, 2.6, 3.0, whiteMat, TX + 2.68, 0, 40, true);                // the lift car, on the shaft's face toward the stack
  box(0.12, 1.8, 0.9, dark, TX + 3.56, 0, 40.5);                       // its window
  box(0.5, 0.5, ZT - 14, dark, TX + 2.1, 1.75, (ZT + 10) / 2);         // guide rails either side of it
  box(0.5, 0.5, ZT - 14, dark, TX + 2.1, -1.75, (ZT + 10) / 2);
  /* Two tail service masts at the foot of the vehicle (the solids are js/colliders.js's). Each
     carries an umbilical arm to the first stage's skirt, on the fin diagonal: it reaches r 3.9 at
     z 7.4, over the fairing's tip, and FOLDS UP when the swing arms go — the fin tips (r 5.7) pass
     that height two seconds after release, by which time the arm is vertical at r 14. */
  mastArms.length = 0;
  for (const y of [-11, 11]) {
    box(2.2, 2.2, 7, steel, -11, y, 4.3, true);
    box(2.5, 2.5, 1.1, dark, -11, y, 8.2, true);                       // the hood
    const az = Math.atan2(-y, 11), turn = new THREE.Group(), fold = new THREE.Group();
    turn.position.set(-11 + Math.cos(az) * 1.2, y + Math.sin(az) * 1.2, 7.3); turn.rotation.z = az;
    const part = (gw, gd, gh, mat, x, zz, edge) => {
      const m = new THREE.Mesh(boxGeo(gw, gd, gh), mat); m.position.set(x, 0, zz);
      m.castShadow = true; if (edge) outline(m); fold.add(m);
    };
    part(10.0, 0.9, 0.9, steel, 5.0, 0, true);
    part(0.35, 1.7, 1.7, dark, 10.1, 0, true);                         // the umbilical plate
    part(6.0, 0.36, 0.36, dark, 6.4, -0.6, false);                     // lines slung under the arm
    turn.add(fold); g.add(turn); mastArms.push(fold);
  }

  /* ---- propellant farm: a LOX sphere and an LH2 sphere on ring skirts, three kerosene tanks ---- */
  box(40, 30, 2, concrete, 52, 38, 0.1, true);
  for (const [tx, ty, r] of [[42, 32, 6.5], [60, 44, 5.4]]) {
    B.add(new THREE.SphereGeometry(r, 28, 18), whiteMat, true, tx, ty, 2.3 + r);
    B.add(new THREE.CylinderGeometry(r * 0.62, r * 0.7, 4.6, 20), steel, false, tx, ty, 2.7, Math.PI / 2);
  }
  for (let i = 0; i < 3; i++) B.add(new THREE.CylinderGeometry(2.1, 2.1, 12, 18), whiteMat, true, 56 + i * 5.2, 28, 3.3, 0, 0, 0);
  B.add(new THREE.CylinderGeometry(0.6, 0.6, 30, 10), steel, false, 37, 36, 2.2, 0, 0, Math.PI / 2 + 0.52);   // feed line to the deck
  box(24, 1.0, 1.0, steel, 25, 30, 1.9);

  /* ---- people-sized things on the apron: three vans and a line of crew by the tower ---- */
  for (const [vx, vy, rz] of [[-8, -19, 0.2], [14, 19, -0.1], [-27, 17, 1.3]]) {
    box(3.6, 1.6, 1.3, whiteMat, vx, vy, 1.75, true, 0, 0, rz);
    box(1.4, 1.5, 0.6, dark, vx + Math.cos(rz) * 0.6, vy + Math.sin(rz) * 0.6, 2.6, false, 0, 0, rz);
  }
  for (let i = 0; i < 7; i++) box(0.36, 0.3, 1.25, whiteMat, -13 + i * 1.3 + (i % 2) * 0.3, -9.5 - (i % 3) * 0.7, 1.6, false, 0, 0, 0, thin);

  /* ---- floodlight rig: mast, cross-truss, four housings south of the stack, and two searchlight
     carts out on the hardstand. Each fixture has a LENS (a plate 0.05 u proud of its housing, dark
     glass by day) and at night a BEAM: a flat translucent cone to the part of the stack it is
     aimed at — a shape with hard sides, not a glow. It is narrower at the stack than the hull it
     lights and ends on the vehicle's axis, so its open end is inside the hull and no rim hangs in
     the sky. Once the stack has gone a second mesh carries each beam on, fading along its length
     to nothing (vertex colour under additive blending). Two meshes for all the beams. ---- */
  box(2.4, 2.4, 25, steel, 0, -34, 10.5);
  box(30, 2.0, 2.0, steel, 0, -34, 23, true);
  lensMat = new THREE.MeshBasicMaterial({ color: LENS_OFF.clone(), fog: false });
  beamMat = new THREE.MeshBasicMaterial({ color: 0xfff0c4, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  farMat = beamMat.clone();
  const lenses = batcher(), cones = [[], []], farCones = [[], []], cm = new THREE.Matrix4(), cv = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  lensMat.name = 'lens'; beamMat.name = 'beam';
  glows = [];
  const DOWN = new THREE.Vector3(0, -1, 0), aim = new THREE.Vector3(), qa = new THREE.Quaternion(), ea = new THREE.Euler();
  /* a fixture's beam: apex at the lens, axis through (0, 0, tz) on the vehicle's axis, `at` u wide there */
  const beam = (x, y, z, tz, at) => {
    aim.set(-x, -y, tz - z); const reach = aim.length(); aim.normalize();
    cm.compose(cv.set(x, y, z), qa.setFromUnitVectors(DOWN, aim), one);
    /* [r0, r1] over [d0, d1] along the beam, brightness c0 at the near end and c1 at the far one */
    const run = (out, d0, d1, c0, c1) => {
      const geo = new THREE.CylinderGeometry(at * d0 / reach, at * d1 / reach, d1 - d0, 20, 1, true).toNonIndexed(), p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const c = p.getY(i) > 0 ? c0 : c1;
        cv.set(p.getX(i), p.getY(i) - (d0 + d1) / 2, p.getZ(i)).applyMatrix4(cm); out[0].push(cv.x, cv.y, cv.z); out[1].push(c, c, c);
      }
    };
    run(cones, 0.01, reach, 1, 0.6);
    run(farCones, reach, reach * 2.2, 0.6, 0);
    const l = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xfff2c9, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    l.position.set(x, y, z); l.scale.setScalar(4.2); l.visible = false; g.add(l); glows.push(l);
  };
  for (let i = 0; i < 4; i++) {
    const lx = -13.5 + i * 9;
    box(0.5, 0.5, 2.6, steel, lx, -34, 21.6);
    box(2.6, 1.4, 1.6, steel, lx, -34, 19.8, true);
    lenses.add(boxGeo(2.2, 0.1, 1.2), lensMat, false, lx, -33.3, 19.8);
    beam(lx, -33.2, 19.8, [56, 22, 40, 66][i], [2.0, 3.1, 3.1, 1.15][i]);
  }
  /* Both carts stand south-west of the stack: the default pad camera looks in from the south-east,
     and a searchlight parked under it was a black dome across the bottom of the opening frame. */
  for (const [cx, cy, tz, at] of [[-46, -50, 52, 2.0], [-28, -62, 30, 3.1]]) {
    box(3.4, 2.4, 1.3, steel, cx, cy, 1.05, true);                     // the cart, on the hardstand (top 0.45)
    box(0.5, 2.0, 1.6, steel, cx, cy, 2.4);                            // the yoke
    aim.set(-cx, -cy, tz - 3.4).normalize();
    ea.setFromQuaternion(qa.setFromUnitVectors(DOWN, aim));
    B.add(new THREE.CylinderGeometry(1.0, 1.25, 1.8, 16), whiteMat, true, cx, cy, 3.4, ea.x, ea.y, ea.z);     // the drum, looking up the beam
    lenses.add(new THREE.CylinderGeometry(1.05, 1.05, 0.1, 16), lensMat, false, cx + aim.x * 0.9, cy + aim.y * 0.9, 3.4 + aim.z * 0.9, ea.x, ea.y, ea.z);
    beam(cx + aim.x * 1.0, cy + aim.y * 1.0, 3.4 + aim.z * 1.0, tz, at);
  }
  /* Two lightning masts, tips clear of the vehicle. They and the handrail cast NO shadow: at the
     pad's 1.46 m per shadow texel a sub-metre caster is sub-texel, and PCF dithers its shadow into
     a dotted line marching off across the apron. */
  for (const mx of [-34, 34]) {
    thin.add(new THREE.CylinderGeometry(0.35, 0.6, 102, 8), steel, false, mx, 26, 49, Math.PI / 2);
    thin.add(new THREE.SphereGeometry(0.8, 10, 8), steel, false, mx, 26, 100.4);
  }
  /* ---- the site: what the launcher stands on, and how it got there ----
     The ground here used to be the terrain patch painted concrete-grey for 360 m and fading out by
     920 m: a flat grey field with nothing in it, because a vertex-coloured mesh whose spacing is
     25 m at best cannot hold a road. So the site is geometry — slabs half a metre proud of the
     terrain (which is flat to ±0.22 u within 700 u of the pad, measured) with their undersides
     below it — and the terrain under them is grass again (js/padsite.js padAuthored, painted by js/earthpaint.js).
     Tops, none shared: hardstand 0.45, flame trench 0.55, crawlerway 0.40, road 0.36. */
  const octagon = (r, h) => { const o = new THREE.CylinderGeometry(r, r, h, 8); o.rotateY(Math.PI / 8); return o; };
  B.add(octagon(170, 1.6), hard, false, 0, 0, -0.35, Math.PI / 2);                 // the hardstand, 475 m across
  box(22, 420, 1.6, dark, 0, 0, -0.25);                                           // flame trench, north-south through the launcher
  for (const y of [-11, 11]) box(760, 13, 1.6, gravel, -540, y, -0.4);            // crawlerway: two gravel tracks west to the horizon
  B.add(new THREE.RingGeometry(214, 221, 64), asphalt, false, 0, 0, 0.36);        // perimeter road
  box(9, 120, 1.4, asphalt, 190, 150, -0.35, false, 0, 0, 0.9);                   // and the road in from the north-east
  // the sound-suppression water tower, 88 m: the tallest thing on the site that is not the stack
  B.add(new THREE.CylinderGeometry(7.5, 7.5, 9, 20), whiteMat, true, 120, -150, 56, Math.PI / 2);
  B.add(new THREE.SphereGeometry(7.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), whiteMat, true, 120, -150, 60.5, Math.PI / 2);
  for (const [dx, dy] of [[5, 5], [-5, 5], [5, -5], [-5, -5]]) box(1.1, 1.1, 54, steel, 120 + dx, -150 + dy, 25.5, true);
  B.add(new THREE.CylinderGeometry(1.4, 1.4, 52, 10), steel, false, 120, -150, 26, Math.PI / 2);
  B.build(g, true);
  thin.build(g, false);
  lenses.build(g, false);
  const beamMesh = ([pos, col], mat) => {
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); cg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.Mesh(cg, mat); m.visible = false; g.add(m); return m;
  };
  beams = beamMesh(cones, beamMat); beamsFar = beamMesh(farCones, farMat);
  setArmSwing(0); setPadNight(0);
  return { group: g };
}
