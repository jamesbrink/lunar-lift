import * as THREE from 'three';
import { capsuleGroup } from './saturn.js';
import { toon, outline } from './toon.js';
import { getChute, getChuteOpen, getSimTime } from './physics.js';

/* The command module's parachutes, as drawn hardware: two drogues, then three ringsail mains in
   Apollo's orange and white. Build units (1 u = 1.4 m), hung from the apex at z = 28.6. Which are
   out and how far they have inflated is js/physics.js's business (getChute / getChuteOpen); this
   only draws it. Mains are 12 u across — 17 m against Apollo's 25 m, so three of them and the
   capsule fit one frame. */
const APEX = 28.6;
const ORANGE = new THREE.Color(0xff7a2a), WHITE = new THREE.Color(0xf6f8fc);
const lineMat = new THREE.LineBasicMaterial({ color: 0x1a2230 });
const cloth = toon({ vertexColors: true, side: THREE.DoubleSide });

function canopy(r, gores) {
  const geo = new THREE.SphereGeometry(r, gores, 6, 0, Math.PI * 2, 0, Math.PI * 0.42).toNonIndexed();
  const n = geo.attributes.position.count, col = new Float32Array(n * 3), p = geo.attributes.position;
  for (let i = 0; i < n; i += 3) {                 // one colour per triangle, alternating by gore
    const a = Math.atan2(p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2), p.getX(i) + p.getX(i + 1) + p.getX(i + 2));
    const c = Math.floor((a / (Math.PI * 2) + 1) * gores) % 2 ? ORANGE : WHITE;
    for (let k = 0; k < 3; k++) c.toArray(col, (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.Mesh(geo, cloth);
  m.rotation.x = Math.PI / 2;                      // dome opens toward −z, the capsule
  m.castShadow = true; outline(m);
  return m;
}

/* `count` canopies of radius r on risers of length `len`, splayed `tilt` rad from the axis. */
function cluster(count, r, len, tilt, gores) {
  const g = new THREE.Group();
  const pts = [];
  for (let k = 0; k < count; k++) {
    const arm = new THREE.Group();
    arm.rotation.z = k / count * Math.PI * 2;
    const leg = new THREE.Group(); leg.rotation.y = count > 1 ? tilt : 0;
    const c = canopy(r, gores); c.position.z = len;
    leg.add(c); arm.add(leg); g.add(arm);
    const skirt = r * Math.sin(Math.PI * 0.42), drop = len + r * Math.cos(Math.PI * 0.42);
    for (let j = 0; j < 8; j++) {                  // shroud lines from the skirt to the apex
      const a = j / 8 * Math.PI * 2;
      pts.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * skirt, Math.sin(a) * skirt, drop));
    }
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts.splice(0)), lineMat);
    leg.add(lines);
  }
  g.position.z = APEX; g.visible = false;
  return g;
}

const drogues = cluster(2, 1.6, 16, 0.16, 8);
const mains = cluster(3, 6, 30, 0.33, 12);
capsuleGroup.add(drogues, mains);

export function updateChutes() {
  const ch = getChute(), open = getChuteOpen();
  drogues.visible = ch === 1 || (ch === 2 && open < 0.5);
  mains.visible = ch === 2;
  const live = ch === 1 ? drogues : ch === 2 ? mains : null;
  if (!live) return;
  /* Inflation: the canopy streams out long and thin, then fills. A slow two-axis sway keeps it
     from looking bolted on. */
  const fill = ch === 2 ? open : 1, w = 0.12 + 0.88 * fill * fill;
  live.scale.set(w, w, 0.55 + 0.45 * Math.min(1, open * 2));
  const t = getSimTime();
  live.rotation.x = 0.05 * Math.sin(t * 0.9); live.rotation.y = 0.05 * Math.sin(t * 0.7 + 1.3);
  if (ch === 1) { const w1 = 0.2 + 0.8 * open; drogues.scale.set(w1, w1, 0.5 + 0.5 * open); }
}
