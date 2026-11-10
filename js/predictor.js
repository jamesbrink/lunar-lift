import * as THREE from 'three';
import { RE, RM, MU_E, MU_M, SOI_M, VS, moonPos, moonVel } from './constants.js';
import { S, getSimTime, getEngineOn, getThrottle, gravityAt, surfaceAlt, tailStation, getChute } from './physics.js';
import { ribbon } from './ribbon.js';

/* Where the vehicle is going: the trajectory ribbon ahead of the ship and its apsis markers.

   Two jobs on two clocks, and keeping them apart is what makes the line steady.

   predict() integrates the path a few times a second and stores it as DATA: positions relative to
   the body the ship is orbiting, each with the mission time it belongs to.

   updatePredictor() draws that data EVERY frame, from where the ship is now. It drops the points
   already flown, starts the ribbon a short gap ahead of the ship and fades it in from nothing.

   What this replaces drew the integration's raw points, fixed in the world, until the next tick
   0.35 s later. Three things followed, each of which was the reported "glitchy line that flickers
   through the ship":
   - between ticks the ship flew 2.7 km along a line whose first vertex stayed behind, so the ribbon
     ran through the hull and its start jumped forward three times a second (far worse under warp);
   - a closed orbit was drawn all the way round, so its last hour arrived from behind the camera and
     ended inside the ship;
   - points were absolute Float32 world coordinates, which near the Moon (384 000 km out) quantise
     to a 31 m grid — the ribbon beside a 100 m ship snapped between grid cells as it was rebuilt.
     The ribbon is now a child of a group that sits ON the ship, and its vertices are offsets from it.

   In lunar space the path is kept relative to the Moon and re-attached to where the Moon is now.
   In the inertial frame the Moon moves 1 km/s, and an orbit around it is drawn as a coil. */

const PRED_MAX = 2700;
const FADE = [1, 1.4, 2, 2.8, 4];             // ribbon fade-in stops, in gaps ahead of the ship
const FADE_A = [0, 0.14, 0.42, 0.78, 1];
const CAP = PRED_MAX + FADE.length + 2;
const MINT = [0.36, 0.95, 0.62], RED = [1, 0.22, 0.18];

/* The stored prediction. rel is km from the frame body's centre at time t. */
const rel = new Float64Array(PRED_MAX * 3), tt = new Float64Array(PRED_MAX);
export const path = { n: 0, frame: 'earth', impact: null, closed: false, ap: -1, pe: -1, apAlt: 0, peAlt: 0, exact: false, apPos: new THREE.Vector3(), pePos: new THREE.Vector3() };
let cursor = 1;

const line = ribbon({ widthPx: 2.2, glowWidthPx: 9, vertexColors: true, capacity: CAP, opacity: 1, glowOpacity: 0.55 });
export const predLine = new THREE.Group();
predLine.add(line);

const vPos = new Float32Array(CAP * 3), vCol = new Float32Array(CAP * 3), vAlpha = new Float32Array(CAP);

let groundE = null, groundM = null, setWarn = () => {};
let impactWarn = '';

/* ---- apsis markers: a diamond on the path and its altitude, constant size on screen ---- */
function marker(tag, colour) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 96;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: false, fog: false }));
  sp.center.set(0.5, 0.14);                     // the diamond, not the label, sits on the path
  sp.scale.set(0.168, 0.063, 1);
  sp.renderOrder = 7; sp.visible = false;
  let shown = '';
  sp.userData.label = (km) => {
    const txt = `${tag} ${km >= 10000 ? Math.round(km / 1000) + 'k' : Math.round(km)} km`;
    if (txt === shown) return;                  // a texture upload only when the reading changes
    shown = txt;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, 256, 96);
    g.font = '600 30px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 6; g.strokeStyle = 'rgba(4,8,14,.85)'; g.strokeText(txt, 128, 34);
    g.fillStyle = colour; g.fillText(txt, 128, 34);
    g.beginPath(); g.moveTo(128, 66); g.lineTo(142, 82); g.lineTo(128, 96); g.lineTo(114, 82); g.closePath();
    g.fillStyle = colour; g.fill(); g.lineWidth = 3; g.strokeStyle = 'rgba(4,8,14,.9)'; g.stroke();
    tex.needsUpdate = true;
  };
  predLine.add(sp);
  return sp;
}
let apMark = null, peMark = null;

export function initPredictor(deps) {
  groundE = deps.groundE || null; groundM = deps.groundM || null; setWarn = deps.setWarn || setWarn;
  apMark = marker('Ap', '#8df0b4'); peMark = marker('Pe', '#ffd27a');
  deps.scene.add(predLine);
}

export function clearPredictor() {
  path.n = 0; path.impact = null;
  line.clear();
  if (apMark) apMark.visible = peMark.visible = false;
  impactWarn = ''; setWarn(null);
}

const _p = new THREE.Vector3(), _v = new THREE.Vector3(), _g = new THREE.Vector3(), _m = new THREE.Vector3();
const _r0 = new THREE.Vector3(), _v0 = new THREE.Vector3(), _h = new THREE.Vector3(), _e = new THREE.Vector3();
const _q = new THREE.Vector3(), _mq = new THREE.Vector3(), _d = new THREE.Vector3(), _base = new THREE.Vector3();

/* Every stored point is lifted to just above whatever surface it flies over: a line grazing a
   surface z-fights, and one inside a painted hill disappears. +100 m is invisible at every
   distance the ribbon is legible. */
function lift(q, t) {
  const rE = q.length();
  if (rE - RE < 4) {
    const need = RE + Math.max(0, groundE ? groundE(q) : 0) + 0.10;
    if (rE < need) q.multiplyScalar(need / rE);
  }
  moonPos(t, _mq);
  _d.subVectors(q, _mq);
  const rM = _d.length();
  if (rM - RM < 4) {
    const needM = RM + Math.max(0, groundM ? groundM(_d) : 0) + 0.10;
    if (rM < needM) q.copy(_mq).addScaledVector(_d, needM / rM);
  }
}

function store(q, t) {
  const k = path.n * 3;
  if (path.frame === 'moon') { moonPos(t, _mq); rel[k] = q.x - _mq.x; rel[k + 1] = q.y - _mq.y; rel[k + 2] = q.z - _mq.z; }
  else { rel[k] = q.x; rel[k + 1] = q.y; rel[k + 2] = q.z; }
  tt[path.n++] = t;
}

/* THE ORBIT YOU ARE ON, not the one you are flying toward. The path is the coast from the present
   state with the engine off and no air: what a conic through this position and velocity does, bent
   only by the other body's gravity. That is what the HUD's apoapsis and periapsis are (osculating
   elements), so the line, its markers and the numbers are one thing, and cutting the engine changes
   none of them.

   It used to integrate the burn in progress — thrust along the nose's present direction until the
   tank ran dry — plus drag. The line then showed where the ship would be IF nothing was touched for
   minutes, swung sideways with every degree of attitude, and its apoapsis dropped the moment the
   engine was cut (reported from play: "they don't truly show my current AP").

   Velocity Verlet, variable step: short where the arc bends or the ground is close, long across a
   multi-hour coast. A picture of the trajectory, not a certificate — js/targeting.js is the number. */
export function predict() {
  const sim = getSimTime();
  const burning = getEngineOn() && getThrottle() > 0.01;
  const p = _p.copy(S.pos), v = _v.copy(S.v);
  const rM0 = S.pos.distanceTo(moonPos(sim, _m));
  /* Parked or already down: the first step of a vehicle sitting on a body reaches that body's
     contact shell at once, which used to publish "IMPACT PREDICTED: EARTH IN 0 min" over a rocket
     waiting for ignition. Nothing about a pad sit has anything to predict. */
  const reach = -tailStation() * VS;      // contact is the tail meeting the ground (js/physics.js surfaceAlt), flown upright
  if (surfaceAlt() <= 0.002) { clearPredictor(); return; }

  path.n = 0; path.impact = null; path.closed = false; path.ap = path.pe = -1; path.exact = false;
  path.frame = rM0 < SOI_M ? 'moon' : 'earth';
  cursor = 1;
  store(p, sim);
  let t = sim, impactT = 0, swept = 0;
  gravityAt(p, _g, t);
  for (let s = 0; s < 20000 && path.n < PRED_MAX - 1; s++) {
    const alt = Math.min(p.length() - RE, p.distanceTo(moonPos(t, _m)) - RM);
    const dt = THREE.MathUtils.clamp(Math.min(alt, v.length() * 40, 3000) * 0.006, 0.2, 20);
    v.addScaledVector(_g, dt / 2); p.addScaledVector(v, dt); t += dt;
    gravityAt(p, _g, t);
    v.addScaledVector(_g, dt / 2);
    moonPos(t, _m);
    const rM = p.distanceTo(_m);
    /* Never store a point already inside a body: lift() would drag it onto the surface, and a
       long descent step puts that on the far side of the sphere. */
    if (s % 2 === 0 && p.length() >= RE && rM >= RM) {
      const k = (path.n - 1) * 3;
      const ax = rel[k], ay = rel[k + 1], az = rel[k + 2];
      _q.copy(p); lift(_q, t); store(_q, t);
      const bx = rel[k + 3], by = rel[k + 4], bz = rel[k + 5];
      const c = (ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz));
      swept += Math.acos(Math.min(1, Math.max(-1, c)));
      /* One lap is the whole story of a closed orbit. Drawn further, the path comes back round
         from behind the camera and finishes inside the ship it started from. */
      if (swept > 5.9) { path.closed = true; break; }
    }
    if (rM <= RM + reach) { path.impact = 'moon'; impactT = t - sim; break; }
    if (p.length() <= RE + reach) { path.impact = 'earth'; impactT = t - sim; break; }
    if (p.length() > 900000 || rM > 900000) break;
  }
  if (path.impact) { _q.copy(p); lift(_q, t); store(_q, t); }

  /* Apsides: the first interior maximum and minimum of range from the frame body. On an ascent
     that is the top of the arc — "where the peak is going to be" — long before there is an orbit. */
  const R = path.frame === 'moon' ? RM : RE;
  const rad = (j) => Math.hypot(rel[j * 3], rel[j * 3 + 1], rel[j * 3 + 2]);
  let r0 = rad(0), r1 = path.n > 1 ? rad(1) : r0;
  for (let j = 1; j < path.n - 1 && (path.ap < 0 || path.pe < 0); j++) {
    const r2 = rad(j + 1);
    if (path.ap < 0 && r1 > r0 && r1 > r2) { path.ap = j; path.apAlt = r1 - R; }
    if (path.pe < 0 && r1 < r0 && r1 < r2) { path.pe = j; path.peAlt = r1 - R; }
    r0 = r1; r1 = r2;
  }

  /* Where the path is a closed conic round its body, the markers sit on the conic's own apsides —
     the eccentricity vector's two ends — and carry the HUD's numbers exactly. Found on the sampled
     path alone they hopped from sample to sample as the path was redrawn. */
  {
    const moon = path.frame === 'moon', mu = moon ? MU_M : MU_E;
    _r0.copy(S.pos); _v0.copy(S.v);
    if (moon) { _r0.sub(moonPos(sim, _m)); _v0.sub(moonVel(sim, _m)); }
    const r = _r0.length(), v2 = _v0.lengthSq(), a = 1 / (2 / r - v2 / mu);
    _h.crossVectors(_r0, _v0); _e.crossVectors(_v0, _h).multiplyScalar(1 / mu).addScaledVector(_r0, -1 / r);
    const e = _e.length();
    if (a > 0 && e < 1 && e > 1e-4 && a * (1 + e) < (moon ? SOI_M : 300000)) {
      _e.multiplyScalar(1 / e);
      path.exact = true;
      path.apAlt = a * (1 + e) - R; path.peAlt = a * (1 - e) - R;
      path.apPos.copy(_e).multiplyScalar(-a * (1 + e)); path.pePos.copy(_e).multiplyScalar(a * (1 - e));
    }
  }

  /* The impact pill is for UNPOWERED flight heading down, where the state vector is the whole
     story. Measured at MET 10 on the pillar, rising 40 m/s under 46 000 kN, it read "EARTH IN
     4 min": true for a rock thrown at 40 m/s, a lie for a rocket about to stage and pitch. While
     an engine burns, the red end of the ribbon is the only honest element and it stays. */
  let msg = '';
  if (path.impact && !burning && getChute() <= 0 && (impactT < 3000 || path.impact === 'moon')) {   // under a canopy the ground is the plan
    const body = moonPos(sim, _m);
    const overMoon = S.pos.distanceToSquared(body) < S.pos.lengthSq();
    _d.copy(S.pos); if (overMoon) _d.sub(body);
    if (S.v.dot(_d) / _d.length() <= 0.05) {
      msg = `IMPACT PREDICTED: ${path.impact === 'moon' ? 'MOON' : 'EARTH'} IN ${Math.round(impactT / 60)} min`;
    }
  }
  if (msg !== impactWarn) { impactWarn = msg; setWarn(msg || null); }
}

/* Draw the stored path from where the ship is this frame. */
export function updatePredictor(camera) {
  const n = path.n;
  if (n < 2) { line.clear(); if (apMark) apMark.visible = peMark.visible = false; return; }
  const sim = getSimTime();
  while (cursor < n && tt[cursor] <= sim) cursor++;
  if (cursor >= n) { line.clear(); apMark.visible = peMark.visible = false; return; }

  if (path.frame === 'moon') moonPos(sim, _base); else _base.set(0, 0, 0);
  predLine.position.copy(S.pos);                // vertices are offsets from the ship: see the header
  const ox = S.pos.x - _base.x, oy = S.pos.y - _base.y, oz = S.pos.z - _base.z;   // ship, frame-relative

  /* The gap that keeps the ribbon out of the hull scales with the view: 9 % of the camera distance,
     never less than the stack is long. */
  const gap = Math.max(0.12, 0.09 * camera.position.distanceTo(S.pos));
  let m = 0;
  const put = (x, y, z, a, c) => {
    vPos[m * 3] = x; vPos[m * 3 + 1] = y; vPos[m * 3 + 2] = z;
    vCol[m * 3] = c[0]; vCol[m * 3 + 1] = c[1]; vCol[m * 3 + 2] = c[2];
    vAlpha[m++] = a;
  };
  /* Walk the polyline ship -> cursor -> ... and drop the fade-in vertices at set distances along
     it. The stored points are kilometres apart at orbital speed, so the fade cannot be left to them. */
  let ax = 0, ay = 0, az = 0, walked = 0, j = cursor, stop = 0;
  while (j < n && stop < FADE.length) {
    const bx = rel[j * 3] - ox, by = rel[j * 3 + 1] - oy, bz = rel[j * 3 + 2] - oz;
    const seg = Math.hypot(bx - ax, by - ay, bz - az);
    const want = FADE[stop] * gap;
    if (walked + seg >= want && seg > 0) {
      const f = (want - walked) / seg;
      put(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f, FADE_A[stop], MINT);
      stop++;
    } else { walked += seg; ax = bx; ay = by; az = bz; j++; }
  }
  /* The far end dims with time ahead — the next minutes are loud, the hours beyond are a hint — and
     a closed orbit fades out entirely before it would meet its own beginning. */
  const span = Math.max(1, n - 1 - cursor);
  for (; j < n; j++) {
    const f = (j - cursor) / span;
    let a = 1 - 0.72 * Math.pow(f, 1.6);
    if (path.closed) a *= 1 - THREE.MathUtils.smoothstep(f, 0.70, 1.0);
    const hit = path.impact && j >= n - 2;
    put(rel[j * 3] - ox, rel[j * 3 + 1] - oy, rel[j * 3 + 2] - oz, hit ? 1 : a, hit ? RED : MINT);
  }
  line.setPoints(vPos, m); line.setColors(vCol, m); line.setAlphas(vAlpha, m);

  const place = (mark, idx, alt, exact) => {
    mark.visible = idx >= cursor;
    if (!mark.visible) return;
    if (path.exact) mark.position.set(exact.x - ox, exact.y - oy, exact.z - oz);
    else mark.position.set(rel[idx * 3] - ox, rel[idx * 3 + 1] - oy, rel[idx * 3 + 2] - oz);
    /* An apsis the ship is sitting on is a label stuck to the hull. It comes back once it is far
       enough ahead to point at something. */
    if (mark.position.length() < 14 * gap) { mark.visible = false; return; }
    mark.userData.label(alt);
  };
  place(apMark, path.ap, path.apAlt, path.apPos); place(peMark, path.pe, path.peAlt, path.pePos);
}
