import * as THREE from 'three';
import { RE, PAD_SCALE, PAD_UP, PAD_EAST } from './constants.js';
import { toon, outline, PALETTE } from './toon.js';
import { hash2 } from './paintkit.js';
import { SITE, groveAt, siteClear } from './padsite.js';
import { surface } from './surface.js';

/* The Cape as a place: what stands within six kilometres of the pad.

   js/pad.js is the launch complex itself. This is everything a camera sees past it, so that the
   site has a scale and a geography: the Vehicle Assembly Building at the end of the crawlerway
   (160 m tall, 218 × 158 m — the numbers are the real ones, js/padsite.js SITE), its low bay, the
   launch control centre, a mobile launcher parked beside them, the crawler, sheds and tank farms,
   LC-39B 2.7 km up the coast, and the trees — clumps of flat-toned crowns planted inside the wood
   lots the ground shader draws (padsite.js groveAt is the one field both read).

   What is NOT here is anything flat. Roads, the crawlerway, the beach, the ponds and the canal are
   drawn by the ground itself (js/surface-earth.js): a slab on the ground is two surfaces on one
   plane, and the ground can ink a line at any range.

   Rules it is built on:
   - ONE mesh (plus one more for the parts that carry the ink outline): every primitive is merged
     with a vertex colour, so the whole Cape costs two draws and two shadow draws.
   - Built in the pad's frame and units (1 u = 1.4 m, x east, y north, z up, origin on the pad's
     datum) and welded to the planet the same way, so vertices are float32 numbers of at most a few
     thousand units — never planet-centred (js/origin.js).
   - Everything stands ON the ground: the terrain within 90 km of the pad is the exact sphere
     (padsite.js padWeight), so a thing d km from the pad has its foot at −d²/2R, 2.4 m down at the
     assembly building. Every solid's underside is sunk below that; no face lies on the terrain.
   - Nothing shares a plane with anything: doors stand proud of walls, roofs are inset. audit()
     below counts coplanar overlapping faces between primitives and the flicker gate holds it at 0.
   - Nothing thinner than ~2 m: a rail or an antenna is sub-pixel from here and shimmers.
   - Night: the sun's term goes out when the sun sets and twilight is the ground's own measure
     of sky light (js/surface-earth.js sfLit / sfTwi), or the trees glow on a dark field. */

const U = 1 / (PAD_SCALE * 1000);              // build units per metre
const KM = 1 / PAD_SCALE;                      // build units per km
/* the sphere under local (x, y), in build units below the pad's datum */
const ground = (x, y) => (Math.sqrt(RE * RE - (x * x + y * y) * PAD_SCALE * PAD_SCALE) - RE) / PAD_SCALE;

function batcher() {
  const B = { plain: mk(), edge: mk() };
  function mk() { return { pos: [], nrm: [], col: [], idx: [], prim: [] }; }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
  const n3 = new THREE.Matrix3(), c = new THREE.Color();
  let prim = 0;
  return {
    /* x, y: build units from the pad; z: above the GROUND at that spot. Indexed in, indexed out. */
    add(geo, hex, edge, x, y, z, rz = 0, sx = 1, sy = 1, sz = 1) {
      const b = edge ? B.edge : B.plain, base = b.pos.length / 3;
      m4.compose(v.set(x, y, z + ground(x, y)), q.setFromEuler(e.set(0, 0, rz)), sc.set(sx, sy, sz));
      n3.getNormalMatrix(m4); c.setHex(hex);
      const p = geo.attributes.position, n = geo.attributes.normal, ix = geo.index;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(m4); b.pos.push(v.x, v.y, v.z);
        v.fromBufferAttribute(n, i).applyMatrix3(n3).normalize(); b.nrm.push(v.x, v.y, v.z);
        b.col.push(c.r, c.g, c.b);
      }
      const count = ix ? ix.count : p.count;
      for (let i = 0; i < count; i++) b.idx.push(base + (ix ? ix.getX(i) : i));
      for (let i = 0; i < count; i += 3) b.prim.push(prim);
      prim++;
    },
    build(group, mat) {
      const out = [];
      for (const [name, b] of Object.entries(B)) {
        if (!b.pos.length) continue;
        const g = new THREE.BufferGeometry();
        for (const a of [b.pos, b.nrm, b.col]) for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) a[i] = 0;
        g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
        g.setIndex(new THREE.BufferAttribute(new Uint32Array(b.idx), 1));
        const m = new THREE.Mesh(g, mat);
        m.name = 'cape-' + name; m.castShadow = m.receiveShadow = true;
        m.userData.prim = Int32Array.from(b.prim);
        if (name === 'edge') outline(m);
        group.add(m); out.push(m);
      }
      return out;
    },
  };
}

export function buildCape() {
  const g = new THREE.Group();
  g.name = 'cape';
  g.scale.setScalar(PAD_SCALE);
  g.position.copy(PAD_UP).multiplyScalar(RE);
  const north = new THREE.Vector3().crossVectors(PAD_UP, PAD_EAST).normalize();
  g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(PAD_EAST, north, PAD_UP));

  const lit = { value: 1 }, twi = { value: new THREE.Vector3() };
  const daylit = (m) => {
    m.onBeforeCompile = (sh) => {
      sh.uniforms.capeLit = lit; sh.uniforms.capeTwi = twi;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float capeLit;\nuniform vec3 capeTwi;')
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.directDiffuse *= capeLit;\n  reflectedLight.indirectDiffuse += capeTwi * diffuseColor.rgb;');
    };
    return m;
  };
  const mat = daylit(toon({ vertexColors: true }));
  mat.name = 'cape';
  /* The launch complex's own ground slabs (js/pad.js: hardstand, crawlerway, roads) are NOT touched
     here: they are padware materials (js/toon.js), which already go dark with the sun and take the
     floodlights. Hanging this module's onBeforeCompile on them replaced padware's own and left its
     light uniforms unbound — the whole apron drew black in daylight. */
  const B = batcher();
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const SINK = 3;                                               // build units every solid goes into the ground
  /* a box by its footprint centre (km), size (m) and height (m), standing on the ground */
  const block = (xk, yk, wm, dm, hm, hex, edge = true, rz = 0, z0m = 0) => {
    const h = hm * U + (z0m ? 0 : SINK);
    B.add(cube, hex, edge, xk * KM, yk * KM, z0m * U + hm * U / 2 - (z0m ? 0 : SINK / 2), rz, wm * U, dm * U, h);
  };
  const WHITE = 0xe6eaee, PANEL = 0xcfd5db, GREY = 0xaab1ba, DARK = 0x3a424d, ROOF = 0x7d8691, SHED = 0xb9b3a4;

  /* ---- Vehicle Assembly Building: the high bay, its four doors, the low bay to the south ---- */
  const V = SITE.vab, vw = V.w * 1000, vd = V.d * 1000, vh = V.h * 1000;
  block(V.x, V.y, vw, vd, vh, WHITE);
  block(V.x, V.y, vw - 14, vd - 14, 6, ROOF, false, 0, vh - 1);                   // roof deck, inset 7 m all round
  block(V.x, V.y + 0.03, 30, 44, 10, GREY, true, 0, vh + 4);                      // and the plant on it
  for (const side of [1, -1]) {
    const fx = V.x + side * V.w / 2;                                              // an east or west face
    for (const dy of [-0.055, 0.055]) {
      /* a high-bay door is an inverted T: 139 m tall, 23 m wide above, 46 m wide at the foot.
         The slab stands 2 m proud of the wall, the foot 1 m more, the leaves' ribs 1 m more still. */
      block(fx + side * 0.0005, V.y + dy, 3, 26, 139, DARK, false);               // into the wall 1 m, out of it 2
      block(fx + side * 0.0010, V.y + dy, 4, 46, 36, DARK, false);
      for (let k = 0; k < 7; k++) block(fx + side * 0.0025, V.y + dy, 3, 26, 2.4, PANEL, false, 0, 46 + k * 13.5);
    }
    block(fx + side * 0.0003, V.y, 1.4, 16, vh - 8, PANEL, false);                // the pier between the two doors
  }
  block(V.x, V.y - V.d / 2 - 0.0655, 83.5, 135, 64, PANEL);                        // low bay, let 2 m into the high bay's south wall
  block(V.x, V.y - V.d / 2 - 0.0655, 70, 120, 4, ROOF, false, 0, 63);

  /* ---- Launch Control Centre: four storeys, the firing rooms' windows facing the pads ---- */
  const L = SITE.lcc;
  block(L.x, L.y, L.w * 1000, L.d * 1000, L.h * 1000, WHITE);
  block(L.x + L.w / 2 + 0.0004, L.y, 1.6, L.d * 1000 - 16, 7, DARK, false, 0, 11);
  block(L.x - 0.083, L.y + 0.02, 116, 8, 6, GREY, false, 0, 9);                   // the bridge to the low bay, let into both

  /* ---- a mobile launcher parked north of the crawlerway: the pad's tower again, 5 km away ---- */
  {
    const mx = V.x + 0.36, my = 0.21;
    block(mx, my, 49, 41, 7.6, GREY, true, 0, 6.7);
    for (const [dx, dy] of [[-18, -14], [18, -14], [-18, 14], [18, 14]]) block(mx + dx / 1000, my + dy / 1000, 6, 6, 8, DARK, false);
    block(mx - 0.012, my, 13, 13, 118, PALETTE.lutRed, true, 0, 12);
    block(mx - 0.012, my + 0.006, 5, 40, 6, PALETTE.lutRed, false, 0, 128);
  }
  /* the crawler-transporter, on the crawlerway outside the high bay */
  block(V.x + 0.30, 0, 40, 35, 6, DARK, true);
  block(V.x + 0.30, 0, 30, 25, 3.5, GREY, false, 0, 5);

  /* ---- sheds, shops and tanks: [x km, y km, w m, d m, h m, colour] ---- */
  for (const [x, y, w, d, h, c] of [
    [V.x - 0.37, -0.30, 90, 60, 14, SHED], [V.x - 0.37, 0.14, 60, 120, 18, PANEL], [V.x + 0.28, -0.55, 70, 40, 10, SHED],
    [V.x - 0.67, -0.10, 110, 45, 12, PANEL], [V.x + 0.53, 0.55, 50, 50, 9, SHED], [V.x + 0.16, 0.46, 80, 36, 11, GREY],
    [V.x - 0.25, -0.62, 46, 46, 8, GREY],
    [-1.90, -0.22, 40, 24, 9, PANEL],                                             // converter-compressor station on the crawlerway
    [-0.64, -0.50, 28, 16, 6, SHED], [-0.75, -0.53, 14, 14, 5, GREY], [0.53, 0.30, 16, 10, 5, SHED], [0.80, -0.14, 14, 10, 6, WHITE],
    [-3.05, -0.52, 36, 20, 7, SHED], [-4.2, -0.52, 30, 30, 8, GREY],
  ]) block(x, y, w, d, h, c);
  const ball = new THREE.SphereGeometry(1, 16, 10);
  for (const [x, y, r] of [[-1.955, -0.215, 6], [-1.955, -0.238, 6], [-1.975, -0.227, 5], [V.x + 0.42, -0.50, 9], [V.x + 0.42, -0.53, 7]]) {
    B.add(ball, WHITE, true, x * KM, y * KM, r * U * 0.85, 0, r * U, r * U, r * U);
  }

  /* ---- LC-39B: the hardstand, its flame trench and ring road, the water tower. No vehicle on it. ---- */
  {
    const px = SITE.padB.x * KM, py = SITE.padB.y * KM;
    const oct = new THREE.CylinderGeometry(170, 170, 1.6 + SINK, 8); oct.rotateY(Math.PI / 8); oct.rotateX(Math.PI / 2);
    B.add(oct, PALETTE.hardstand, false, px, py, 0.45 - (1.6 + SINK) / 2);
    B.add(cube, PALETTE.blast, false, px, py, 0.55 - (1.6 + SINK) / 2, 0, 22, 420, 1.6 + SINK);
    B.add(new THREE.RingGeometry(214, 221, 64), PALETTE.asphalt, false, px, py, 0.36);
    B.add(cube, PALETTE.padDeck, true, px, py, 4, 0, 42, 34, 9);                   // the launch mount's pedestal
    const tx = px - 120, ty = py + 150;
    const tank = new THREE.CylinderGeometry(7.5, 7.5, 9, 20); tank.rotateX(Math.PI / 2);
    const dome = new THREE.SphereGeometry(7.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2); dome.rotateX(Math.PI / 2);
    B.add(tank, WHITE, true, tx, ty, 56); B.add(dome, WHITE, true, tx, ty, 60.5);
    const leg = new THREE.CylinderGeometry(2.2, 2.6, 54 + SINK, 10); leg.rotateX(Math.PI / 2);
    B.add(leg, PALETTE.padSteel, true, tx, ty, 27 - SINK / 2);
  }

  /* ---- trees. Candidates on a jittered lattice; one stands where the wood-lot field is positive.
     A crown is a squashed low-poly ball sunk a third into the ground — three flat tones from the
     ramp and a polygon for a silhouette — in clumps, the tall ones in the middle of a wood. ---- */
  /* three levels by distance from the pad, which is where the camera lives: 80, 20 and 8 triangles.
     Welded polyhedra with the sphere's normals — the ramp makes the tones, the polygon the outline. */
  const crown = (poly) => {
    const p = poly.attributes.position, key = new Map(), pos = [], idx = [], v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).normalize();
      const k = Math.round(v.x * 1e4) + ',' + Math.round(v.y * 1e4) + ',' + Math.round(v.z * 1e4);
      if (!key.has(k)) { key.set(k, pos.length / 3); pos.push(v.x, v.y, v.z); }
      idx.push(key.get(k));
    }
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g2.setAttribute('normal', new THREE.Float32BufferAttribute(pos, 3));
    g2.setIndex(idx);
    return g2;
  };
  const near = crown(new THREE.IcosahedronGeometry(1, 1)), mid = crown(new THREE.IcosahedronGeometry(1, 0)), far = crown(new THREE.OctahedronGeometry(1, 0));
  const lod = (d) => d < 1.3 ? near : d < 2.4 ? mid : far;
  const GREENS = [0x4d8848, 0x3d7642, 0x669a4c, 0x35693e];
  let trees = 0;
  const STEP = 0.062;                                            // km between candidates
  for (let j = -72; j <= 72; j++) for (let i = -110; i <= 52; i++) {
    const x = (i + (hash2(i, j, 301) - 0.5) * 0.9) * STEP, y = (j + (hash2(i, j, 302) - 0.5) * 0.9) * STEP;
    const d = Math.hypot(x, y);
    if (d > 6.6) continue;
    const gv = groveAt(x, y);
    if (gv <= 0.015) {
      /* open ground is scrub, not lawn: one low bush in twenty candidates, where nothing is built */
      if (hash2(i, j, 308) > 0.10 || d > 3.6 || siteClear(x, y) <= 0.05) continue;
      const r = (4 + 6 * hash2(i, j, 304)) * U;
      B.add(d < 1.3 ? mid : far, GREENS[(hash2(i, j, 305) * 4) | 0], false, x * KM, y * KM, r * 0.25, hash2(i, j, 306) * 6.283, r, r * 0.8, r * 0.75);
      trees++;
      continue;
    }
    const s = hash2(i, j, 303), deep = Math.min(1, gv / 0.2);
    const h = (7 + 9 * s * deep + 4 * deep) * U, r = (9 + 9 * hash2(i, j, 304)) * U * (0.8 + 0.4 * deep);
    B.add(lod(d), GREENS[(hash2(i, j, 305) * 4) | 0], false, x * KM, y * KM, h * 0.3,
      hash2(i, j, 306) * 6.283, r, r * (0.75 + 0.5 * hash2(i, j, 307)), h);
    trees++;
  }

  const meshes = B.build(g, mat);
  /* the daylight, read from the sun the ground shader is given (body-fixed, set each frame by
     js/world.js): the same steps as sfLit and sfTwi */
  const sunU = surface('earth').patch.sfSun.value;
  meshes[0].onBeforeRender = () => {
    const el = sunU.dot(PAD_UP);
    lit.value = THREE.MathUtils.smoothstep(el, -0.006, 0.012);
    const t = (1 - lit.value) * 0.34 * THREE.MathUtils.smoothstep(el, -0.14, 0) / Math.PI;
    twi.value.set(0.50 * t, 0.62 * t, 0.92 * t);
  };
  g.userData.trees = trees;
  g.userData.audit = () => audit(meshes);
  return g;
}

/* Coplanar, overlapping faces between different primitives — the cause of z-fighting — over the
   whole merged Cape; and non-finite attribute values. tools/flicker-test.mjs gates both at zero. */
function audit(meshes) {
  const tris = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  let nonFinite = 0, count = 0, base = 0;
  for (const m of meshes) {
    const pos = m.geometry.attributes.position, prim = m.userData.prim, ix = m.geometry.index;
    for (const name of ['position', 'normal', 'color']) for (const v of m.geometry.attributes[name].array) if (!Number.isFinite(v)) nonFinite++;
    let top = 0;
    for (let i = 0; i < ix.count; i += 3) {
      count++;
      a.fromBufferAttribute(pos, ix.getX(i)); b.fromBufferAttribute(pos, ix.getX(i + 1)); c.fromBufferAttribute(pos, ix.getX(i + 2));
      n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a)); const area = n.length() / 2; if (area < 0.5) continue;
      n.normalize(); const d = n.dot(a), s = n.x + n.y * 1.7 + n.z * 2.9 < 0 ? -1 : 1;
      top = Math.max(top, prim[i / 3]);
      tris.push({ p: base + prim[i / 3], key: [Math.round(n.x * s * 400), Math.round(n.y * s * 400), Math.round(n.z * s * 400), Math.round(d * s * 20)].join(','),
        min: [Math.min(a.x, b.x, c.x), Math.min(a.y, b.y, c.y), Math.min(a.z, b.z, c.z)], max: [Math.max(a.x, b.x, c.x), Math.max(a.y, b.y, c.y), Math.max(a.z, b.z, c.z)] });
    }
    base += top + 1;
  }
  const buckets = new Map(), pairs = new Set();
  for (const t of tris) { if (!buckets.has(t.key)) buckets.set(t.key, []); buckets.get(t.key).push(t); }
  for (const list of buckets.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const p = list[i], q = list[j]; if (p.p === q.p) continue;
    let ov = true; for (let k = 0; k < 3; k++) if (p.min[k] > q.max[k] - 0.05 || q.min[k] > p.max[k] - 0.05) ov = false;
    if (ov) pairs.add(Math.min(p.p, q.p) + ':' + Math.max(p.p, q.p));
  }
  return { triangles: count, nonFinite, coplanar: pairs.size, pairs: [...pairs].slice(0, 8) };
}
