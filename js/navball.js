import * as THREE from 'three';
import { RE, RM, MU_E, MU_M, SOI_M, moonPos } from './constants.js';
import { S, getSimTime, isBurning, orbitalElements, navVel, fwd } from './physics.js';
/* One-directional: js/hud.js draws the navball and js/world.js paints the canvases this plot
   blits; world never imports navball, so this edge does not close a cycle. */
import * as WORLD from './world.js';

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
const POLE = new THREE.Vector3(0, 1, 0);
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

function marker(c, cx, cy, dir, R, colour, r = 5, label = null) {
  const p = proj(dir, R);
  if (!p) return null;
  c.save();
  c.globalAlpha = p.front ? 1 : 0.3;
  /* Dark underlay ring first: on the black half of the dial it is invisible, but over the
     flat fills (Earth's #3a7ab8 sky, regolith grey) a bare #5ddc9a prograde ring is 2.61:1
     on the sky fill — the review's "unreadable markers on flat blue". With the halo the
     green reads 10.6:1 against its own dark edge (measured, WCAG). */
  c.strokeStyle = 'rgba(6,10,18,.9)'; c.lineWidth = 3.4;
  c.beginPath(); c.arc(cx + p.x, cy + p.y, r + 1, 0, 6.283); c.stroke();
  c.strokeStyle = colour; c.fillStyle = colour; c.lineWidth = 1.4;
  c.beginPath(); c.arc(cx + p.x, cy + p.y, r, 0, 6.283); c.stroke();
  c.beginPath(); c.arc(cx + p.x, cy + p.y, 1.6, 0, 6.283); c.fill();
  if (label) { c.font = '8px ui-monospace,monospace'; c.lineWidth = 2.4; c.strokeStyle = 'rgba(6,10,18,.85)';
    c.strokeText(label, cx + p.x + r + 2, cy + p.y + 3); c.fillText(label, cx + p.x + r + 2, cy + p.y + 3); }
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
  /* Ticks ride 0.78R, not the old 0.86R: at 0.86R the lowest tick box reached y ≈ 139 and sat
     directly in the ball's bottom label band (the round-3 'N' + status-string mush). The band
     0.78R·71 px keeps every tick glyph inside y ∈ [15.6, 134.4], clear of the fixed top legend
     (box ends y 12) and the bottom status slot (starts y 137) in every attitude.
     The 2.6px dark stroke underneath is what lets the same glyph read on the flat #3a7ab8
     sky fill: #c9cbd2@.85 alone composites to 2.42:1 there, the stroke edge is 3.85:1 and
     the glyph over its own stroke 8.1:1 (measured, WCAG). */
  const gx = cx + Math.cos(a) * R * 0.78 - 4, gy = cy + Math.sin(a) * R * 0.78 + 4;
  c.lineWidth = 2.6; c.strokeStyle = 'rgba(6,10,18,.85)'; c.strokeText(label, gx, gy);
  c.fillText(label, gx, gy);
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
  const north = POLE.clone().addScaledVector(up, -POLE.dot(up));   // the spin axis is +Y; this was +Z, and HDG read 214° for a true 110°
  if (north.lengthSq() < 1e-9) north.set(1, 0, 0);
  north.normalize();
  const east = north.clone().cross(up).normalize();
  return { up, north, east };
}

/* |nose·up| ≥ 0.999 (pitch beyond ~87.4°): the horizon great circle has moved onto the rim —
   the dial is flat sky or flat ground and without an edge carries no readable datum
   ("fills flat blue with unreadable crosshair" in 15/09). The rim itself takes the horizon,
   drawn halo-under-core like the crosshair: measured WCAG against the flat #3a7ab8 sky fill
   the dark underlay is 4.06:1 and the rgba(224,236,248,.9) core 3.37:1; against the
   near-black lunar vacuum the core reads 13.5:1 (the dark underlay vanishes there). */
function rimDatum(c, cx, cy, R) {
  c.strokeStyle = 'rgba(6,10,18,.9)'; c.lineWidth = 3;
  c.beginPath(); c.arc(cx, cy, R - 1, 0, 6.283); c.stroke();
  c.strokeStyle = 'rgba(224,236,248,.9)'; c.lineWidth = 1.4;
  c.beginPath(); c.arc(cx, cy, R - 1, 0, 6.283); c.stroke();
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
  /* The ball's palette follows the body underneath: blue sky over green ground at Earth, and
     black vacuum over grey regolith at the Moon — a green horizon under a lunar descent read as
     a broken instrument, because no such surface exists there. */
  c.fillStyle = nearMoon ? '#06080d' : '#3a7ab8'; c.fillRect(0, 0, NB, NB);   // sky / vacuum
  const groundCol = nearMoon ? '#4b4b54' : '#2b4b36';

  const u = toBody(up);
  if (u.z < -0.999) {
    c.fillStyle = groundCol; c.fillRect(0, 0, NB, NB);          // looking straight down
    rimDatum(c, cx, cy, R);
  } else if (u.z < 0.999) {
    const arc = horizonArc(u);
    if (arc.length) {
      c.fillStyle = groundCol;
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

      /* Pitch ladder, anchored to the HORIZON: the tick for pitch line p sits at angle
         (p − nosePitch) from the nose along the up great circle, nosePitch = asin(u.z).
         The old ladder was nose-centred (symmetric ±10…60 about the dial centre), so with
         the nose high the "pitch" ticks floated through empty sky — the reviewer's
         "hatch of 10+ parallel scratch lines across the dial" at high pitch over an
         all-sky ball. Horizon anchoring moves them onto the ground/sky band where they
         belong, and near the horizon-less limit they crowd against the rim, where the
         cull rule below takes over: a line is SKIPPED when its vertical offset from the
         nearest surviving line is < 4 px. Recorded with a segment-counting context
         (harness /tmp/navball-count.mjs, 150 px dial): the old constant ±11 px ladder
         drew 12 strokes at 0°, ±45° AND ±85…87° — the hatch; the new one draws 12 at 0°
         (unchanged standard view), 9 of 10 candidates at ±45°, 5 of 6 at ±85/±87° as the
         ticks compress into the rim, and 0 with |pitch| ≥ 87.4°. */
      const ux = Math.hypot(u.x, u.y);
      if (ux > 0.05) {
        const hx = u.x / ux, hy = -u.y / ux;                  // screen dir of "up"
        const tx = -hy, ty = hx;                              // along the horizon
        const nose = Math.asin(Math.min(1, Math.max(-1, u.z)));
        const cands = [];
        for (let p = -60; p <= 60; p += 10) {
          if (!p) continue;
          const d = p * Math.PI / 180 - nose;                 // angle from the nose
          if (Math.abs(d) >= Math.PI / 2) continue;           // behind the horizon of the view
          cands.push({ d, off: Math.sin(d) * R * 0.9 });
        }
        cands.sort((a, b) => a.off - b.off);
        c.strokeStyle = 'rgba(224,236,248,.35)'; c.lineWidth = 1;
        let lastOff = -Infinity;
        for (const { d, off } of cands) {
          if (off - lastOff < 4) continue;                    // screen spacing floor: skip
          lastOff = off;
          const half = Math.cos(d) * R * 0.22;
          const px = cx + hx * off, py = cy + hy * off;
          c.beginPath(); c.moveTo(px - tx * half, py - ty * half); c.lineTo(px + tx * half, py + ty * half); c.stroke();
        }
      }
    }
  } else {
    rimDatum(c, cx, cy, R);
  }

  c.strokeStyle = 'rgba(150,165,190,.22)'; c.lineWidth = 1; c.setLineDash([3, 4]);
  c.beginPath(); c.arc(cx, cy, R * 0.5, 0, 6.283); c.stroke();
  c.beginPath(); c.arc(cx, cy, R * 0.866, 0, 6.283); c.stroke();
  c.setLineDash([]);

  compass(c, cx, cy, R, north, 'N');
  compass(c, cx, cy, R, east, 'E');
  compass(c, cx, cy, R, north.clone().negate(), 'S');

  let offDeg = 0;                                    // consumed by the bottom status slot below
  if (vel.lengthSq() > 1e-8) {
    const pp = marker(c, cx, cy, vel, R, '#5ddc9a', 6);
    marker(c, cx, cy, vel.clone().negate(), R, '#ffb45c', 5);
    if (pp) {
      offDeg = Math.acos(Math.min(1, Math.max(-1, toBody(vel.clone().normalize()).z))) * 57.2958;
      c.strokeStyle = 'rgba(93,220,154,.4)'; c.lineWidth = 1; c.setLineDash([2, 3]);
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + pp.x, cy + pp.y); c.stroke(); c.setLineDash([]);
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
  /* From lunar space Earth is the destination — give it the same courtesy marker the Moon gets
     from cislunar space, so the return burn can be aimed off the ball. */
  if (nearMoon) marker(c, cx, cy, S.pos.clone().negate(), R, '#7fb2e8', 5, 'EARTH');
  c.restore();

  /* The nose: the direction the engines are pushing — at the centre by construction of proj().
     Halo pass first (dark 3.6/4.4 px underlay), bright core on top: the old
     rgba(150,165,190,.45) core composited over the flat #3a7ab8 sky fill to rgb(99,141,187) —
     1.30:1 against that fill, the review's "unreadable crosshair". The bright core is 4.24:1
     over the sky fill directly, 17.2:1 against its own dark halo, 18.8:1 over lunar vacuum. */
  c.strokeStyle = 'rgba(6,10,18,.9)';
  c.lineWidth = isBurning() ? 4.4 : 3.6;
  c.beginPath();
  c.moveTo(cx - 9, cy); c.lineTo(cx + 9, cy);
  c.moveTo(cx, cy - 9); c.lineTo(cx, cy + 9);
  c.stroke();
  c.strokeStyle = isBurning() ? '#ff7a3c' : '#f4f8ff';
  c.lineWidth = isBurning() ? 2 : 1.4;
  c.beginPath();
  c.moveTo(cx - 9, cy); c.lineTo(cx + 9, cy);
  c.moveTo(cx, cy - 9); c.lineTo(cx, cy + 9);
  c.stroke();
  if (isBurning()) { c.fillStyle = 'rgba(255,122,60,.95)'; c.beginPath(); c.arc(cx, cy, 2.6, 0, 6.283); c.fill(); }

  /* Top legend — 'prograde' names the green ring. Its box (x 57..100, y 0..12 incl. the 'g'
     descender) is clear of the 0.78R tick band, whose topmost glyph box starts at y ≈ 15.6.
     It now sits on the same opaque strip the bottom status slot uses — over the flat sky fill
     the old rgba(150,165,190,.45) glyph composited to 1.30:1; #c9cbd2 on the strip is 10.6:1
     and the strip is invisible on the black half of the dial. Slot unchanged. */
  c.fillStyle = 'rgba(8,11,18,.85)'; c.fillRect(cx - 21, 0, 49, 12);
  c.fillStyle = '#c9cbd2'; c.font = '9px ui-monospace,monospace';
  c.fillText('prograde', cx - 18, 10);

  /* Status slot — the strip y ∈ [137, 149] is the one and only place a string lives at the
     bottom of the ball area, backed by an opaque panel. Round 3 piled THREE strings onto the
     old shared baseline y = NB−4: 'x° off prograde' at x = 4, 'nose = centre' at x = 49, and
     any tick that swung near nadir — mush in every frame. With ticks at 0.78R (lowest glyph box
     y ≈ 134.4) nothing on the dial enters this strip; the opaque panel also covers rim-pinned
     marker labels ('EARTH', 8 px) that pass behind it, keeping the slot exclusive. Widths at
     9px mono ≈ 5.4 px/char (established in this file): '58° off prograde' (16 chars) = 86 px,
     'nose = centre' (12) = 65 px — the panel spans at most x ∈ [23, 127], inside the canvas.
     The orbit status strings (escape/impact) live in the sub-map's own tagged slot — the ball
     slot carries the ball's state only, so the two can never collide. */
  const statusTxt = offDeg > 4 ? `${offDeg.toFixed(0)}° off prograde` : 'nose = centre';
  const statusW = statusTxt.length * 5.4;
  c.fillStyle = 'rgba(8,11,18,.92)';
  c.fillRect(cx - statusW / 2 - 5, 137, statusW + 10, 12);
  c.fillStyle = offDeg > 4 ? '#5ddc9a' : 'rgba(150,165,190,.7)';
  c.fillText(statusTxt, cx - statusW / 2, 146);

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
  /* The body-radius floor is 1.8, not the old 1.05, and it is what keeps the disc ON the plot:
     bodyRpx = 65·bodyR / max(reach, k·bodyR) ≤ 65/k, so the disc can never exceed 36.1 px on a
     canvas that is only 80 px tall. At k = 1.05 every bound orbit painted the body at r = 61.9
     px: the circle overflowed the top and bottom edges and the canvas itself cropped it into
     straight-sided blocks (the 'unmasked rectangular crop' of the 05/09/12/13/15 review frames —
     no circular clip can mask an edge that lives on the canvas boundary). Fitted, the clip
     circle is the plot's outer boundary; apoapsis stays inside too for LEO/MLO
     ((6671/6371)·36.1 = 37.8 px; the higher-apo tips clip as before, and always did).
     Finiteness guard: a NaN anywhere in the denominator would poison scale/bodyRpx, and Chrome
     THROWS on non-finite drawImage args — which, wrapped by main.js's frame catch, used to erase
     the whole panel down to its CSS background. A non-finite reach is not constructible from
     orbitalElements (escape returns Infinity, which `isFinite` already reroutes), but the plot
     now treats that as mathematically impossible rather than trusting it. */
  let denom = Math.max(reach, bodyR * 1.8);
  if (!Number.isFinite(denom)) denom = bodyR * 1.8;
  const scale = (Math.min(ORB_W, ORB_H * 1.9) / 2 - 10) / denom;
  const ox = ORB_W / 2, oy = ORB_H / 2;
  const px = p => [ox + p.x * scale, oy - p.y * scale];

  /* The centre body is the PAINTED MAP, not a token dot: the same canvas the planet wears is
     blitted into a clipped disc, centred on the ground beneath the vehicle (body-local, so it
     turns with the planet), with a night side laid over the anti-sun half. A navy circle made
     the plot read as decoration; a chart you can pick Florida out of is navigation.
     The crop is linear in lon/lat, not true orthographic — at 150 px the difference is under a
     coastline's width, and every pixel here has to survive a 2× dpr canvas first. */
  let bodyRpx = Math.max(2, bodyR * scale);
  if (!Number.isFinite(bodyRpx)) bodyRpx = 2;
  const pcv = WORLD.planetCanvas(nearMoon ? 'moon' : 'earth');
  /* The blit gets its own save → clip → restore, and the clip radius is inset 0.75 px below the
     limb ring stroked after the restore: ring lineWidth is 1, so its stroke covers bodyRpx ± 0.5
     and the mask edge hides underneath it. A rectangular edge can then only reach the ring's
     outer antialiased pixels, which the ring itself paints over — the crop is masked regardless
     of which draw escaped the old same-radius clip.
     NaN/exception hardening (round-3 'empty black sub-map', both Earth and Moon sessions): the
     spin comes off the live scene graph, and world.js latches a NaN into earth/moon rotation.y
     permanently if syncTime/spinBodies ever sees a non-finite time — from there lon → cu → NaN
     and drawImage THROWS (as does any non-finite arg, or a zero-pixel source canvas), which
     main.js's frame catch swallows once and leaves the cleared canvas showing its CSS
     background forever. So: non-finite spin reads as spin 0; a non-finite crop window skips
     the blit; and anything that still throws falls back to the flat disc INSIDE the clip. The
     disc, trajectory, dots and labels after this block are unconditionally drawn. */
  c.save();
  c.beginPath(); c.arc(ox, oy, Math.max(0.5, bodyRpx - 0.75), 0, 6.283); c.clip();
  let discPainted = false;
  if (pcv && pcv.width > 1 && pcv.height > 1) {
    try {
      const raw = WORLD.bodySpin(nearMoon ? 'moon' : 'earth');
      const spin = Number.isFinite(raw) ? raw : 0;
      const cs = Math.cos(spin), sn = Math.sin(spin);
      const lx = cs * rel.x - sn * rel.z, lz = sn * rel.x + cs * rel.z;   // rotY(−spin), world→body
      const lat = Math.asin(THREE.MathUtils.clamp(rel.y / rel.length(), -1, 1));
      const lon = Math.atan2(-lz, lx);
      const cu = ((lon / (2 * Math.PI)) + 0.5) * pcv.width;
      const cvr = (0.5 - lat / Math.PI) * pcv.height;
      /* The disc edge is 90° of ground from the centre in both axes: ±90° lon = quarter of the map
         width, ±90° lat = half the height. (Ground km was the wrong currency here: the horizon of
         an orthographic disc is πR/2 km away, not R.) */
      const sxw = pcv.width / 4;
      const syw = pcv.height / 2;
      const drawWin = (sx, dx, w) => c.drawImage(pcv, sx, cvr - syw, w, syw * 2, dx, oy - bodyRpx, w * (bodyRpx / sxw), bodyRpx * 2);
      const srcLeft = cu - sxw, srcRight = cu + sxw;
      if (Number.isFinite(cu) && Number.isFinite(cvr)) {
        if (srcLeft >= 0 && srcRight <= pcv.width) {
          drawWin(srcLeft, ox - bodyRpx, sxw * 2);
        } else if (srcLeft < 0) {                       // window wraps the dateline: two true-offset draws
          drawWin(srcLeft + pcv.width, ox - bodyRpx, -srcLeft);
          drawWin(0, ox - bodyRpx - srcLeft, srcRight);
        } else {
          const w1 = pcv.width - srcLeft;
          drawWin(srcLeft, ox - bodyRpx, w1);
          drawWin(0, ox - bodyRpx + w1, srcRight - pcv.width);
        }
        /* night side: the anti-sun half in the plot's own basis */
        const su = A.dot(WORLD.SUN_DIR), sv = B.dot(WORLD.SUN_DIR);
        const sl = Math.hypot(su, sv) || 1;
        const gx = ox + (su / sl) * bodyRpx, gy = oy - (sv / sl) * bodyRpx;
        const g = c.createLinearGradient(gx, gy, ox - (su / sl) * bodyRpx, oy - (sv / sl) * bodyRpx);
        g.addColorStop(0, 'rgba(4,8,16,0)'); g.addColorStop(0.52, 'rgba(4,8,16,0)');
        g.addColorStop(0.62, 'rgba(4,8,16,.62)'); g.addColorStop(1, 'rgba(4,8,16,.86)');
        c.fillStyle = g; c.fillRect(ox - bodyRpx, oy - bodyRpx, bodyRpx * 2, bodyRpx * 2);
      }
      discPainted = Number.isFinite(cu) && Number.isFinite(cvr);
    } catch { discPainted = false; }
  }
  if (!discPainted) {
    c.fillStyle = nearMoon ? '#c9cbd2' : '#2f6ca8';
    c.fillRect(ox - bodyRpx, oy - bodyRpx, bodyRpx * 2, bodyRpx * 2);
  }
  c.restore();
  c.strokeStyle = 'rgba(143,220,255,.28)'; c.lineWidth = 1;
  c.beginPath(); c.arc(ox, oy, bodyRpx, 0, 6.283); c.stroke();

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
    /* Escape leg: drawn dashed so it reads as 'not a closed orbit' even where it enters the
       bound window. Degenerate first — a radial flight or hover has h → 0, which collapses the
       conic to a sub-pixel dot at the disc centre (r = p/(1+e·cos θ) with p → 0); drawing that
       noise is what read as 'nothing but black', so a polyline that cannot reach 4 px is
       skipped and the disc + status slot carry the state instead. */
    const p = h.lengthSq() / (nearMoon ? MU_M : MU_E);
    if (Number.isFinite(p) && p * scale >= 4) {
      c.setLineDash([5, 3]);
      const thMax = Math.acos(-1 / el.e) * 0.95;
      for (let i = -70; i <= 70; i++) { const th = i / 70 * thMax; add(p / (1 + el.e * Math.cos(th)), th); }
    }
  }
  if (started) c.stroke();
  c.setLineDash([]);

  /* Label tags. Every string in the sub-map sits on a small opaque panel because the disc
     blit is bright ground and the trajectory line crosses the corners (in 08 the orange
     trajectory blob landed straight on 'Ap 323 k'). Slots, measured at 9px mono ≈ 5.4 px/char:
       top-left   (4, 11)     'Ap …' bound-OR status — the two are branch-exclusive, one slot
       bottom-left(4, ORB_H−5) 'Pe …' — longest value 'Pe −400,000 km' (14) ends x ≈ 79.6
       bottom-right(ORB_W−4, ORB_H−5) body caption — 'earth' starts x ≈ 115.5: a 35 px gutter,
                                and the caption finally left the band that visually merged
                                with the ball's rim labels (the round-3 pile-up read).
     No pair shares a line that can grow into it at any telemetry value. */
  const tag = (txt, x, y, col, right) => {
    const w = txt.length * 5.4;
    const x0 = right ? x - w : x;
    c.fillStyle = 'rgba(8,11,18,.85)';
    c.fillRect(x0 - 3, y - 9, w + 6, 12);
    c.fillStyle = col; c.font = '9px ui-monospace,monospace';
    c.fillText(txt, x0, y);
  };
  if (isFinite(el.ap) && el.ap > 0 && el.e < 1) {
    /* A is the eccentricity vector and points at periapsis: per is at +a(1-e) on the
       +x axis, apo at -a(1+e). The apo dot used to sit at +a(1+e), the mirror point. */
    const apo = px({ x: -el.a * (1 + el.e), y: 0 }), per = px({ x: el.a * (1 - el.e), y: 0 });
    c.fillStyle = '#8fdcff'; c.beginPath(); c.arc(apo[0], apo[1], 2.4, 0, 6.283); c.fill();
    c.fillStyle = '#ff6a5c'; c.beginPath(); c.arc(per[0], per[1], 2.4, 0, 6.283); c.fill();
    tag(`Ap ${Math.round(el.ap).toLocaleString()} km`, 4, 11, 'rgba(143,220,255,.85)');
    tag(`Pe ${Math.round(el.pe).toLocaleString()} km`, 4, ORB_H - 5, 'rgba(143,220,255,.85)');
  } else {
    /* Degenerate element: the status line takes the top-left slot — a Moon orbit that escapes
       (or a radial fall) still shows disc + dashed leg + this, never a blank plot. */
    tag(el.escape ? 'escape trajectory' : 'impact trajectory', 4, 11, 'rgba(143,220,255,.85)');
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
  /* Body caption: bottom-right, tagged like everything else. Round 2 moved it top-right to keep
     it off the disc; round 3 then read it as part of the rim mush because that row sat directly
     under the ball while the sub-map itself was blank. It now lives diagonally away from both
     the ball and the Ap/status line: 'earth' (widest, ≈ 27 px) spans x 115.5..142, y 66..78,
     while the bottom-left 'Pe' tag ends at x ≈ 79.6 even for 'Pe −400,000 km' — a 35 px gutter.
     Drawn last, so it wins over any vehicle dot or velocity arrow passing through the corner. */
  tag(nearMoon ? 'moon' : 'earth', ORB_W - 4, ORB_H - 5, 'rgba(150,165,190,.75)', true);
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
