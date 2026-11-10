import * as THREE from 'three';
import { VS, WARPS } from './constants.js';
import { capsuleGroup } from './saturn.js';
import { hardware as toon, outline } from './toon.js';
import { S, getChute, getChuteOpen, getSimTime, getState, getWarpIndex, landing, surfaceAlt } from './physics.js';

/* The command module's parachutes, as drawn hardware: two drogues, then three ringsail mains in
   Apollo's orange and white. Build units (1 u = 1.4 m), hung from the apex at z = 28.6. Which are
   out and how far they have inflated is js/physics.js's business (getChute / getChuteOpen); this
   only draws it. Mains are 12 u across — 17 m against Apollo's 25 m, so three of them and the
   capsule fit one frame.

   Three things move, and each has its own clock:
   - inflation is physics' (getChuteOpen);
   - the pendulum — the capsule swinging under its canopies, and the canopies breathing — is a pure
     function of the MISSION clock, so a paused frame is a still and a replay swings the same way;
   - the collapse after splashdown runs on real seconds, because the mission clock stops at
     touchdown. It is held while the game is paused. */
const APEX = 28.6, CAP = Math.PI * 0.42;          // the canopy is a spherical cap this far round from its crown
const ORANGE = new THREE.Color(0xff7a2a), WHITE = new THREE.Color(0xf6f8fc);
const lineMat = new THREE.LineBasicMaterial({ color: 0x1a2230 });
const cloth = toon({ vertexColors: true, side: THREE.DoubleSide });
const LINES = 8, Z = new THREE.Vector3(0, 0, 1);

function canopy(r, gores) {
  const geo = new THREE.SphereGeometry(r, gores, 6, 0, Math.PI * 2, 0, CAP).toNonIndexed();
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

/* `count` canopies of radius r on risers of length `len`, splayed `tilt` rad from the axis. Each
   canopy is a pivot at the centre of its sphere; its shroud lines are redrawn from the apex to
   wherever the pose has put its skirt. `settle`: [bearing rad, distance u] where each one comes
   to rest on the water. */
function cluster(count, r, len, tilt, gores, settle) {
  const g = new THREE.Group(), chutes = [];
  for (let k = 0; k < count; k++) {
    const pivot = new THREE.Group(); pivot.add(canopy(r, gores));
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINES * 6), 3));
    const lines = new THREE.LineSegments(geo, lineMat); lines.frustumCulled = false;
    g.add(pivot, lines);
    chutes.push({ pivot, lines, az: k / count * Math.PI * 2, settle: settle[k], lift: 0.14 * k });
  }
  g.position.z = APEX; g.visible = false;
  return { g, chutes, r, len, tilt: count > 1 ? tilt : 0 };
}

const drogues = cluster(2, 1.6, 16, 0.16, 8, [[0.5, 5], [-0.4, 8]]);
const mains = cluster(3, 6, 30, 0.33, 12, [[-0.62, 12], [0.05, 18.5], [0.66, 13]]);
capsuleGroup.add(drogues.g, mains.g);

const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _t = new THREE.Vector3(), _up = new THREE.Vector3(), _h = new THREE.Vector3(), _s = new THREE.Vector3();
const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const ease = (x) => x * x * (3 - 2 * x);

/* w, h: radial and axial fill of every canopy (and of the splay). e: 0 flying .. 1 lying on the water. */
function pose(c, w, h, e) {
  const s = ease(e);
  if (e > 0) {
    /* the water, in the cluster's frame: `up` through the capsule's attitude, the plane through the
       heat shield's face (z 26.0) lifted by however far the last step drove it under */
    _up.copy(S.pos).normalize().applyQuaternion(_qi.copy(S.q).invert());
    _h.set(1, 0, 0).addScaledVector(_up, -_up.x).normalize();           // a level bearing to measure the others from
  }
  for (const ch of c.chutes) {
    _d.set(Math.sin(c.tilt) * Math.cos(ch.az) * w, Math.sin(c.tilt) * Math.sin(ch.az) * w, Math.cos(c.tilt) * h);
    _p.copy(_d).multiplyScalar(c.len);
    _q0.setFromUnitVectors(Z, _d.normalize());
    let sw = w, sh = h;
    if (e > 0) {
      const sink = (26.0 - APEX) - surfaceAlt(false) / VS;              // the water's height under the apex, along `up`
      _t.copy(_h).applyAxisAngle(_up, ch.settle[0]).multiplyScalar(ch.settle[1]).addScaledVector(_up, sink - 0.1 + ch.lift);
      _p.lerp(_t, s);
      _p.addScaledVector(_up, -Math.sin(Math.PI * s) * c.len * 0.12);    // it falls faster than it drifts
      _q0.slerp(_q1.setFromUnitVectors(Z, _up), ease(Math.min(1, e * 1.4)));
      sw = w * (1 - 0.3 * Math.sin(Math.PI * Math.min(1, e * 1.6))) + 0.08 * s;     // caves in, then spreads on the water
      sh = h * (1 - s) + 0.1 * s;
    }
    /* lying, it is not a disc: longer one way than the other, each canopy turned its own way */
    const sx = sw * (1 + 0.14 * s), sy = sw * (1 - 0.16 * s);
    if (e > 0) _q0.multiply(_q1.setFromAxisAngle(Z, s * (1 + ch.az)));
    ch.pivot.position.copy(_p); ch.pivot.quaternion.copy(_q0); ch.pivot.scale.set(sx, sy, sh);
    const a = ch.lines.geometry.attributes.position, sr = c.r * Math.sin(CAP), sz = c.r * Math.cos(CAP);
    for (let j = 0; j < LINES; j++) {
      const th = j / LINES * Math.PI * 2;
      _s.set(Math.cos(th) * sr * sx, Math.sin(th) * sr * sy, sz * sh).applyQuaternion(_q0).add(_p);
      a.setXYZ(j * 2, 0, 0, 0); a.setXYZ(j * 2 + 1, _s.x, _s.y, _s.z);
    }
    a.needsUpdate = true;
  }
}

pose(drogues, 1, 1, 0); pose(mains, 1, 1, 0);      // stowed they are invisible, but never all three in one place

const SWAY = 0.075, SWAY_W = 0.82;        // rad, rad/s: the capsule under three mains, about seven seconds a swing
const COLLAPSE = 3;                       // s for a canopy to come down after contact
let down = 0, last = 0;                   // real seconds since splashdown, and the wall clock it was last advanced at
const _sq = new THREE.Quaternion(), _se = new THREE.Euler(), _pv = new THREE.Vector3();

export function updateChutes() {
  const ch = getChute(), open = getChuteOpen();
  const now = performance.now() / 1000, dtReal = Math.min(0.1, Math.max(0, now - last)); last = now;
  const splashed = getState() === 'won' && landing.home;
  if (!splashed) down = 0; else if (WARPS[getWarpIndex()] !== 0) down = Math.min(COLLAPSE, down + dtReal);
  const e = down / COLLAPSE;

  drogues.g.visible = ch === 1 || (ch === 2 && open < 0.5 && !splashed);
  mains.g.visible = ch === 2;
  const live = ch === 1 ? drogues : ch === 2 ? mains : null;
  if (!live) { capsuleGroup.position.set(0, 0, 0); capsuleGroup.quaternion.identity(); return; }

  /* Inflation: the canopy streams out long and thin, then fills. */
  const t = getSimTime(), calm = 1 - ease(e);
  let w, h;
  if (ch === 2) { w = 0.12 + 0.88 * open * open; h = 0.55 + 0.45 * Math.min(1, open * 2); }
  else { w = 0.2 + 0.8 * open; h = 0.5 + 0.5 * open; }
  pose(live, w, h, e);
  if (ch === 2 && drogues.g.visible) pose(drogues, 1, 1, 0);
  /* the canopies breathe against the risers... */
  live.g.rotation.set(0.05 * calm * Math.sin(t * 0.9), 0.05 * calm * Math.sin(t * 0.7 + 1.3), 0);
  /* ...and the capsule swings under them: a slow ellipse about the middle of the cluster, so the
     canopies all but stand still in the air and the capsule is what moves. Fades with the fill
     on the way in and with the collapse on the way out. */
  const amp = SWAY * calm * (ch === 2 ? 0.6 + 0.4 * open : 0.6 * open);
  _sq.setFromEuler(_se.set(amp * Math.sin(t * SWAY_W), amp * 0.7 * Math.sin(t * SWAY_W * 0.83 + 1.1), 0));
  _pv.set(0, 0, APEX + live.len * h);
  capsuleGroup.quaternion.copy(_sq);
  capsuleGroup.position.copy(_pv).sub(_t.copy(_pv).applyQuaternion(_sq));
}
