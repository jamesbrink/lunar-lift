import * as THREE from 'three';
import { PAD_SCALE } from './constants.js';
import { toon, outline, PALETTE } from './toon.js';

/* Launch Complex 39 as the game draws it: the mobile launcher's deck over the flame opening, the
   red umbilical tower with its swing arms and hammerhead crane, the propellant farm, the
   floodlights and the lightning masts. Build units, 1 u = 1.4 m, z up, the vehicle's axis on the
   origin; js/world.js welds the group to the planet.

   Contracts with the rest of the game, none of which this file may move:
   - the deck's top is z = 4 (PAD_POS in js/constants.js stands the vehicle on it);
   - the opening under the engines is 20 × 16 u and everything within r 6 u of the axis above the
     deck is air — the first stage's fins sweep r 5.7 on the way up;
   - the exhaust's analytic colliders (the trench bowl in js/vehicle.js) know nothing of this mesh.

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
        m.castShadow = shadows; m.receiveShadow = shadows;
        if (b.edge) outline(m);
        group.add(m);
      }
    },
  };
}

export function buildPad(glowMap) {
  const g = new THREE.Group();
  g.scale.setScalar(PAD_SCALE);
  const named = (name, opts) => { const m = toon(opts); m.name = name; return m; };
  const deck = named('deck', { color: PALETTE.padDeck });
  const concrete = named('concrete', { color: PALETTE.padConcrete });
  const steel = named('steel', { color: PALETTE.padSteel });
  const red = named('red', { color: PALETTE.lutRed });
  const dark = named('dark', { color: PALETTE.blast });
  /* White with a floor of emissive: the tanks and the white room sit on the camera side of their
     own terminator through the launch window, and on the bare ramp they read as black. The real
     ones are the brightest things on the complex. */
  const whiteMat = named('white', { color: 0xe9eef4 }); whiteMat.emissive = new THREE.Color(0x33383f);

  const B = batcher(), thin = batcher();
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const boxGeo = (w, d, h) => new THREE.BoxGeometry(w, d, h);
  const box = (w, d, h, mat, x, y, z, edge = false, rx = 0, ry = 0, rz = 0, into = B) => into.add(boxGeo(w, d, h), mat, edge, x, y, z, rx, ry, rz);
  void unit;

  /* ---- mobile launcher: deck, skirts, the ring of slabs round the flame opening ----
     Every ground-touching slab sinks ≥ 0.6 m below z = 0: coplanar with the terrain, their bottom
     edges rasterised as running dashes. */
  box(64, 46, 3.6, deck, 0, 0, 1.2, true);
  box(64, 9, 4.2, deck, 0, -23, 0.9, true);
  box(64, 9, 4.2, deck, 0, 23, 0.9, true);
  box(44, 12, 1, concrete, 0, -14, 3.5);
  box(44, 12, 1, concrete, 0, 14, 3.5);
  box(12, 16, 1, concrete, -16, 0, 3.5);
  box(12, 16, 1, concrete, 16, 0, 3.5);
  // flame trench and four canted deflectors; plate tops peak at z ≈ 3.25, clear of every bell
  box(21, 17, 4.4, dark, 0, 0, 0.8);
  box(18, 6, 1.2, dark, 0, -3.5, 1.2, true, 0.75);
  box(18, 6, 1.2, dark, 0, 3.5, 1.2, true, -0.75);
  box(15, 6, 1.2, dark, -7, 0, 1.2, true, 0, 0.75);
  box(15, 6, 1.2, dark, 7, 0, 1.2, true, 0, -0.75);
  // four hold-down arms reaching in from the opening's edge to the skirt, between the fins
  box(5.6, 1.8, 1.4, dark, 7.3, 0, 3.6, true); box(5.6, 1.8, 1.4, dark, -7.3, 0, 3.6, true);
  box(1.8, 3.6, 1.4, dark, 0, 6.3, 3.6, true); box(1.8, 3.6, 1.4, dark, 0, -6.3, 3.6, true);
  // handrail round the deck: 1.1 m high, the first thing on the pad that is the size of a person
  for (const [w, d, x, y] of [[64, 0.12, 0, 27.3], [64, 0.12, 0, -27.3], [0.12, 54.6, 31.9, 0], [0.12, 54.6, -31.9, 0]]) {
    box(w, d, 0.12, steel, x, y, 4.8, false, 0, 0, 0, thin);
  }
  for (let i = 0; i <= 16; i++) for (const y of [27.3, -27.3]) box(0.12, 0.12, 0.8, steel, -32 + i * 4, y, 4.4, false, 0, 0, 0, thin);
  for (let i = 1; i < 14; i++) for (const x of [31.9, -31.9]) box(0.12, 0.12, 0.8, steel, x, -27.3 + i * 3.9, 4.4, false, 0, 0, 0, thin);

  /* ---- launch umbilical tower: 88 u (123 m) of red steel beside the vehicle ----
     Four legs, a floor every 8 u, one diagonal per bay per face, a lift shaft up the middle so it
     is a building and not a cage. Eleven floors is what makes the rocket next to it tall. */
  const TX = -21, TW = 9, Z0 = 4, ZT = 92;
  box(15, 13, 5, concrete, TX, 0, 6.4, true);                          // tower base
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) box(1.3, 1.3, ZT - Z0 - 4, red, TX + sx * TW / 2, sy * TW / 2, (ZT + Z0 + 4) / 2, true);
  box(3.6, 3.6, ZT - Z0 - 4, steel, TX, 0, (ZT + Z0 + 4) / 2, true);   // lift shaft
  for (let z = 12; z <= ZT; z += 8) {
    box(TW + 1.6, TW + 1.6, 0.5, red, TX, 0, z);
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
  const armFrom = TX + TW / 2;
  for (const [z, hullR, w] of [[14, 3.6, 1.6], [30, 3.6, 1.6], [48, 3.6, 1.5], [61, 2.4, 1.4], [68.5, 1.4, 1.2]]) {
    const tip = -(hullR + 0.9), len = tip - armFrom;
    box(len, w, w, red, armFrom + len / 2, 0, z, true);
    box(len * 0.6, 0.3, 0.3, red, armFrom + len * 0.3, 0, z + w * 1.6, false, 0, -0.42, 0);   // stay from the tower to mid-arm
  }
  box(3.2, 3.0, 2.8, whiteMat, -4.6, 0, 68.5, true);                   // the white room, on the crew arm
  // hammerhead crane
  box(4.5, 4.5, 3.4, red, TX, 0, ZT + 1.9, true);
  box(34, 1.8, 2.2, red, TX + 3, 0, ZT + 4.6, true);
  box(5, 3.2, 3, dark, TX - 12, 0, ZT + 4.2, true);                    // counterweight
  box(3, 2.6, 2.4, steel, TX + 2.5, 2.2, ZT + 2.4, true);              // operator's cab
  // two tail service masts at the foot of the vehicle
  for (const y of [-11, 11]) { box(2.2, 2.2, 7, steel, -11, y, 7.5, true); box(4.5, 0.7, 0.7, steel, -8.6, y * 0.82, 9.6, false, 0, 0, y > 0 ? -0.5 : 0.5); }

  /* ---- propellant farm: a LOX sphere and an LH2 sphere on ring skirts, three kerosene tanks ---- */
  box(40, 30, 2, concrete, 52, 38, 3, true);
  for (const [tx, ty, r] of [[42, 32, 6.5], [60, 44, 5.4]]) {
    B.add(new THREE.SphereGeometry(r, 28, 18), whiteMat, true, tx, ty, 5.2 + r);
    B.add(new THREE.CylinderGeometry(r * 0.62, r * 0.7, 4.6, 20), steel, false, tx, ty, 5.6, Math.PI / 2);
  }
  for (let i = 0; i < 3; i++) B.add(new THREE.CylinderGeometry(2.1, 2.1, 12, 18), whiteMat, true, 56 + i * 5.2, 28, 6.4, 0, 0, 0);
  B.add(new THREE.CylinderGeometry(0.6, 0.6, 30, 10), steel, false, 37, 36, 5.2, 0, 0, Math.PI / 2 + 0.52);   // feed line to the deck
  box(24, 1.0, 1.0, steel, 25, 30, 5.0);

  /* ---- people-sized things on the apron: three vans and a line of crew by the tower ---- */
  for (const [vx, vy, rz] of [[-8, -19, 0.2], [14, 19, -0.1], [-27, 17, 1.3]]) {
    box(3.6, 1.6, 1.3, whiteMat, vx, vy, 5.0, true, 0, 0, rz);
    box(1.4, 1.5, 0.6, dark, vx + Math.cos(rz) * 0.6, vy + Math.sin(rz) * 0.6, 5.85, false, 0, 0, rz);
  }
  for (let i = 0; i < 7; i++) box(0.36, 0.3, 1.25, whiteMat, -13 + i * 1.3 + (i % 2) * 0.3, -9.5 - (i % 3) * 0.7, 4.6, false, 0, 0, 0, thin);

  /* ---- floodlight rig: mast, cross-truss, four housings; the lamps themselves are sprites ---- */
  box(2.4, 2.4, 22, steel, 0, -34, 15);
  box(30, 2.0, 2.0, steel, 0, -34, 26, true);
  const lamps = [];
  for (let i = 0; i < 4; i++) {
    const lx = -13.5 + i * 9;
    box(0.5, 0.5, 2.6, steel, lx, -34, 24.6);
    box(2.6, 1.4, 1.6, steel, lx, -34, 22.8, true);
    /* The sprite is the LENS of a fixture, sitting proud of the housing face: alone it was a bokeh
       disc hanging in the air. */
    const l = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xfff2c9, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    l.position.set(lx, -33.4, 22.8); l.scale.setScalar(3.4); g.add(l);
    lamps.push(l);
  }
  /* Two lightning masts, tips clear of the vehicle. They and the handrail cast NO shadow: at the
     pad's 1.46 m per shadow texel a sub-metre caster is sub-texel, and PCF dithers its shadow into
     a dotted line marching off across the apron. */
  for (const mx of [-34, 34]) {
    thin.add(new THREE.CylinderGeometry(0.35, 0.6, 96, 8), steel, false, mx, -26, 52, Math.PI / 2);
    thin.add(new THREE.SphereGeometry(0.8, 10, 8), steel, false, mx, -26, 100.4);
  }
  B.build(g, true);
  thin.build(g, false);
  return { group: g, lamps };
}
