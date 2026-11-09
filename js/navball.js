import * as THREE from 'three';
import { RE, RM, MU_E, MU_M, SOI_M, moonPos } from './constants.js';
import { S, getSimTime, isBurning, orbitalElements, navVel, fwd } from './physics.js';

/* ---------------- KSP-style attitude ball ----------------
   The ball is an orthographic view of the sky as seen from the nose of the
   rocket: the centre of the disc IS the thrust vector. The sky/ground halves
   rotate with attitude, prograde/retrograde markers show the velocity, small
   markers point at apogee / perigee, and the Moon is shown as a target.       */
const NB = 150;
const ORB_W = 150, ORB_H = 80;
let ballCtx = null, orbCtx = null;

export function initNavball(ballCanvas, orbCanvas) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  for (const [cv, w, h] of [[ballCanvas, NB, NB], [orbCanvas, ORB_W, ORB_H]]) {
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
  }
  ballCanvas.style.margin = '0 auto';
  ballCtx = ballCanvas.getContext('2d'); ballCtx.scale(dpr, dpr);
  orbCtx = orbCanvas.getContext('2d'); orbCtx.scale(dpr, dpr);
}

const _iq = new THREE.Quaternion();
const Z = new THREE.Vector3(0, 0, 1);
const toBody = v => v.clone().applyQuaternion(_iq.copy(S.q).invert());

/* a world direction becomes a point on the unit sphere in the rocket frame; the
   near half (z > 0) is drawn, the far half is pinned to the rim and dimmed */
function proj(v, R) {
  const b = toBody(v);
  if (b.lengthSq() < 1e-9) return null;
  b.normalize();
  if (b.z > 0) return { x: b.x * R, y: -b.y * R, front: true };
  const m = Math.hypot(b.x, b.y) || 1;
  return { x: b.x / m * R, y: -b.y / m * R, front: false };
}

function marker(c, cx, cy, dir, R, colour, r = 5) {
  const p = proj(dir, R);
  if (!p) return null;
  c.save();
  c.globalAlpha = p.front ? 1 : 0.3;
  c.strokeStyle = colour; c.fillStyle = colour; c.lineWidth = 1.4;
  c.beginPath(); c.arc(cx + p.x, cy + p.y, r, 0, 6.283); c.stroke();
  c.beginPath(); c.arc(cx + p.x, cy + p.y, 1.6, 0, 6.283); c.fill();
  c.restore();
  return p;
}

function compass(c, cx, cy, R, dir, label) {
  const b = toBody(dir);
  if (b.z < -0.15) return;
  const m = Math.hypot(b.x, b.y);
  if (m < 0.12) return;
  const a = Math.atan2(-b.y, b.x);
  c.save();
  c.globalAlpha = b.z > 0 ? 0.85 : 0.3;
  c.fillStyle = '#c9cbd2'; c.font = '10px ui-monospace,monospace';
  c.fillText(label, cx + Math.cos(a) * R * 0.86 - 4, cy + Math.sin(a) * R * 0.86 + 4);
  c.restore();
}

/* the visible half of the horizon great circle: {d : d·up = 0, d.z >= 0} */
function horizonArc(u, steps = 64) {
  const m = Math.hypot(u.x, u.y);
  if (m < 1e-6) return [];
  const d1 = new THREE.Vector3(u.y / m, -u.x / m, 0);
  const e2 = new THREE.Vector3(-u.z * u.x / m, -u.z * u.y / m, m);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps * Math.PI;
    pts.push(d1.clone().multiplyScalar(Math.cos(t)).addScaledVector(e2, Math.sin(t)));
  }
  return pts;
}

function localFrame(r) {
  const up = r.clone().normalize();
  const north = Z.clone().addScaledVector(up, -Z.dot(up));
  if (north.lengthSq() < 1e-9) north.set(1, 0, 0);
  north.normalize();
  const east = north.clone().cross(up).normalize();
  return { up, north, east };
}

export function drawNavball() {
  if (!ballCtx) return null;
  const c = ballCtx, cx = NB / 2, cy = NB / 2, R = NB / 2 - 4;
  c.clearRect(0, 0, NB, NB);

  const moon = moonPos(getSimTime(), new THREE.Vector3());
  const rM = S.pos.distanceTo(moon);
  const nearMoon = rM < SOI_M;
  const centre = nearMoon ? moon : new THREE.Vector3();
  const rel = S.pos.clone().sub(centre);
  const { up, north, east } = localFrame(rel);
  /* One velocity vector, the one SAS steers by: inertial about the Earth, Moon-relative inside
     the Moon's SOI. Both the markers and the ap/pe readouts below depend on it being the
     velocity measured in the frame of the body being orbited. */
  const vel = navVel(new THREE.Vector3());

  c.save();
  c.beginPath(); c.arc(cx, cy, R, 0, 6.283); c.clip();
  c.fillStyle = '#3a7ab8'; c.fillRect(0, 0, NB, NB);           // sky

  const u = toBody(up);
  if (u.z < -0.999) {
    c.fillStyle = '#2b4b36'; c.fillRect(0, 0, NB, NB);         // looking straight down
  } else if (u.z < 0.999) {
    const arc = horizonArc(u);
    if (arc.length) {
      c.fillStyle = '#2b4b36';
      c.beginPath();
      arc.forEach((d, i) => i ? c.lineTo(cx + d.x * R, cy - d.y * R) : c.moveTo(cx + d.x * R, cy - d.y * R));
      const a2 = Math.atan2(arc[arc.length - 1].y, arc[arc.length - 1].x);
      const mid = new THREE.Vector3(Math.cos(a2 + Math.PI / 2), Math.sin(a2 + Math.PI / 2), 0);
      const dir = mid.dot(u) < 0 ? 1 : -1;
      for (let i = 1; i <= 32; i++) {
        const a = a2 + dir * i / 32 * Math.PI;
        c.lineTo(cx + Math.cos(a) * R, cy - Math.sin(a) * R);
      }
      c.closePath(); c.fill();

      c.strokeStyle = 'rgba(224,236,248,.75)'; c.lineWidth = 1.3;
      c.beginPath();
      arc.forEach((d, i) => i ? c.lineTo(cx + d.x * R, cy - d.y * R) : c.moveTo(cx + d.x * R, cy - d.y * R));
      c.stroke();

      // pitch ladder, parallel to the horizon
      const ux = Math.hypot(u.x, u.y);
      if (ux > 0.05) {
        const hx = u.x / ux, hy = -u.y / ux;                  // screen dir of "up"
        const tx = -hy, ty = hx;                              // along the horizon
        c.strokeStyle = 'rgba(224,236,248,.35)'; c.lineWidth = 1;
        for (let deg = 10; deg <= 60; deg += 10) {
          const off = Math.sin(deg * Math.PI / 180) * R * 0.9;
          const half = Math.cos(deg * Math.PI / 180) * R * 0.22;
          for (const s of [1, -1]) {
            const px = cx + hx * off * s, py = cy + hy * off * s;
            c.beginPath(); c.moveTo(px - tx * half, py - ty * half); c.lineTo(px + tx * half, py + ty * half); c.stroke();
          }
        }
      }
    }
  }

  c.strokeStyle = 'rgba(150,165,190,.22)'; c.lineWidth = 1; c.setLineDash([3, 4]);
  c.beginPath(); c.arc(cx, cy, R * 0.5, 0, 6.283); c.stroke();
  c.beginPath(); c.arc(cx, cy, R * 0.866, 0, 6.283); c.stroke();
  c.setLineDash([]);

  compass(c, cx, cy, R, north, 'N');
  compass(c, cx, cy, R, east, 'E');
  compass(c, cx, cy, R, north.clone().negate(), 'S');

  if (vel.lengthSq() > 1e-8) {
    const pp = marker(c, cx, cy, vel, R, '#5ddc9a', 6);
    marker(c, cx, cy, vel.clone().negate(), R, '#ffb45c', 5);
    if (pp) {
      const off = Math.acos(Math.min(1, Math.max(-1, toBody(vel.clone().normalize()).z))) * 57.2958;
      c.strokeStyle = 'rgba(93,220,154,.4)'; c.lineWidth = 1; c.setLineDash([2, 3]);
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + pp.x, cy + pp.y); c.stroke(); c.setLineDash([]);
      if (off > 4) { c.fillStyle = '#5ddc9a'; c.font = '10px ui-monospace,monospace'; c.fillText(`${off.toFixed(0)}° off prograde`, 4, NB - 4); }
    }
  }

  const mu = nearMoon ? MU_M : MU_E;
  const el = orbitalElements(rel, vel, mu, nearMoon ? RM : RE);
  /* eccentricity vector — points at PERIapsis, so the +e marker is perigee/periselene
     and the -e one is apogee/apolune */
  const ecc = new THREE.Vector3().crossVectors(vel, rel.clone().cross(vel)).multiplyScalar(1 / mu).addScaledVector(rel.clone().normalize(), -1);
  if (isFinite(el.a) && el.a > 0 && el.e < 1 && el.e > 1e-4) {
    ecc.normalize();
    marker(c, cx, cy, centre.clone().addScaledVector(ecc, el.a * (1 - el.e)).sub(S.pos), R, '#ff6a5c', 4);
    marker(c, cx, cy, centre.clone().addScaledVector(ecc, -el.a * (1 + el.e)).sub(S.pos), R, '#8fdcff', 4);
  }
  if (rM < 1.2e6) marker(c, cx, cy, moon.clone().sub(S.pos), R, '#c9cbd2', 4);
  c.restore();

  // the nose: the direction the engines are pushing — at the centre by construction of proj()
  c.strokeStyle = isBurning() ? '#ff7a3c' : 'rgba(150,165,190,.45)';
  c.lineWidth = isBurning() ? 2.4 : 1.4;
  c.beginPath();
  c.moveTo(cx - 9, cy); c.lineTo(cx + 9, cy);
  c.moveTo(cx, cy - 9); c.lineTo(cx, cy + 9);
  c.stroke();
  if (isBurning()) { c.fillStyle = 'rgba(255,122,60,.95)'; c.beginPath(); c.arc(cx, cy, 2.6, 0, 6.283); c.fill(); }

  c.fillStyle = 'rgba(150,165,190,.45)'; c.font = '9px ui-monospace,monospace';
  c.fillText('prograde', cx - 18, 10);
  c.fillText('nose = centre', cx - 26, NB - 4);

  return { el, up, north, east, nearMoon, vel, centre, ecc };
}

/* ---------------- orbit plot, drawn in the orbital plane ---------------- */
function drawOrbit(nearMoon, centre, vel, el, ecc) {
  const c = orbCtx;
  c.clearRect(0, 0, ORB_W, ORB_H);
  const bodyR = nearMoon ? RM : RE;
  const rel = S.pos.clone().sub(centre);
  const h = rel.clone().cross(vel);
  const n = h.clone().normalize();
  const A = ecc.lengthSq() > 1e-9 ? ecc.clone().normalize() : rel.clone().normalize();
  const B = n.cross(A).normalize();
  const plane = p => ({ x: p.dot(A), y: p.dot(B) });

  const reach = el.ap > 0 && isFinite(el.ap) ? el.ap : rel.length() * 1.7;
  const scale = (Math.min(ORB_W, ORB_H * 1.9) / 2 - 10) / Math.max(reach, bodyR * 1.05);
  const ox = ORB_W / 2, oy = ORB_H / 2;
  const px = p => [ox + p.x * scale, oy - p.y * scale];

  c.fillStyle = nearMoon ? '#c9cbd2' : '#2f6ca8';
  c.beginPath(); c.arc(ox, oy, Math.max(2, bodyR * scale), 0, 6.283); c.fill();

  const bound = Math.max(reach * 1.15, rel.length() * 1.15, bodyR * 1.05);
  c.strokeStyle = 'rgba(143,220,255,.55)'; c.lineWidth = 1.2; c.beginPath();
  let started = false;
  const add = (r, th) => {
    if (r > bound) return;
    const q = px({ x: r * Math.cos(th), y: r * Math.sin(th) });
    started ? c.lineTo(q[0], q[1]) : (c.moveTo(q[0], q[1]), started = true);
  };
  if (isFinite(el.e) && el.e < 1 && el.a > 0) {
    const p = el.a * (1 - el.e * el.e);
    for (let i = 0; i <= 90; i++) add(p / (1 + el.e * Math.cos(i / 90 * 6.283)), i / 90 * 6.283);
    c.closePath();
  } else if (isFinite(el.e) && el.e >= 1) {
    const p = h.lengthSq() / (nearMoon ? MU_M : MU_E);
    const thMax = Math.acos(-1 / el.e) * 0.95;
    for (let i = -70; i <= 70; i++) { const th = i / 70 * thMax; add(p / (1 + el.e * Math.cos(th)), th); }
  }
  if (started) c.stroke();

  if (isFinite(el.ap) && el.ap > 0 && el.e < 1) {
    /* A is the eccentricity vector and points at periapsis: per is at +a(1-e) on the
       +x axis, apo at -a(1+e). The apo dot used to sit at +a(1+e), the mirror point. */
    const apo = px({ x: -el.a * (1 + el.e), y: 0 }), per = px({ x: el.a * (1 - el.e), y: 0 });
    c.fillStyle = '#8fdcff'; c.beginPath(); c.arc(apo[0], apo[1], 2.4, 0, 6.283); c.fill();
    c.fillStyle = '#ff6a5c'; c.beginPath(); c.arc(per[0], per[1], 2.4, 0, 6.283); c.fill();
    c.fillStyle = 'rgba(143,220,255,.85)'; c.font = '9px ui-monospace,monospace';
    c.fillText(`Ap ${Math.round(el.ap).toLocaleString()} km`, 4, 11);
    c.fillText(`Pe ${Math.round(el.pe).toLocaleString()} km`, 4, ORB_H - 5);
  } else {
    c.fillStyle = 'rgba(143,220,255,.85)'; c.font = '9px ui-monospace,monospace';
    c.fillText(el.e >= 1 ? 'escape trajectory' : 'impact trajectory', 4, 11);
  }

  const pos = plane(rel);
  const vx = ox + pos.x * scale, vy = oy - pos.y * scale;
  c.fillStyle = '#e8ecf4'; c.beginPath(); c.arc(vx, vy, 3, 0, 6.283); c.fill();
  /* frame rule (navVel in physics.js): the plot is centred on the body being orbited, so the
     arrow must be the velocity in that frame. S.v is wrong inside SOI_M — the Moon itself
     travels at 1.02 km/s there. Outside, navVel returns S.v, so Earth-side is unchanged. */
  const d = plane(vel);
  const m = Math.hypot(d.x, d.y);
  if (m > 1e-9) {
    const ux = d.x / m, uy = -d.y / m;
    const L = isBurning() ? 22 : 16;
    c.strokeStyle = isBurning() ? '#ff7a3c' : '#5ddc9a'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(vx, vy); c.lineTo(vx + ux * L, vy + uy * L); c.stroke();
    c.fillStyle = isBurning() ? '#ff7a3c' : '#5ddc9a';
    c.beginPath();
    c.moveTo(vx + ux * L, vy + uy * L);
    c.lineTo(vx + ux * (L - 5) - uy * 2.6, vy + uy * (L - 5) + ux * 2.6);
    c.lineTo(vx + ux * (L - 5) + uy * 2.6, vy + uy * (L - 5) - ux * 2.6);
    c.closePath(); c.fill();
  }
  if (nearMoon) { c.fillStyle = 'rgba(150,165,190,.6)'; c.font = '9px ui-monospace,monospace'; c.fillText('moon', ORB_W - 26, ORB_H - 5); }
  else { c.fillStyle = 'rgba(150,165,190,.6)'; c.font = '9px ui-monospace,monospace'; c.fillText('earth', 4, ORB_H - 18); }
}

export function updateNavball() {
  const info = drawNavball();
  if (!info) return;
  drawOrbit(info.nearMoon, info.centre, info.vel, info.el, info.ecc);
  const nose = fwd();
  const pitch = Math.asin(Math.max(-1, Math.min(1, nose.dot(info.up)))) * 57.2958;
  const heading = Math.atan2(nose.dot(info.east), nose.dot(info.north)) * 57.2958;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('nPitch', `${pitch >= 0 ? '+' : ''}${pitch.toFixed(0)}°`);
  set('nHeading', `${((heading + 360) % 360).toFixed(0)}°`);
  set('nBurn', isBurning() ? 'burning' : 'idle');
}
