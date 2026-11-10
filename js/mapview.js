import * as THREE from 'three';
import { RE, RM, MOON_DIST, MOON_U, MOON_V, SOI_M, moonPos } from './constants.js';
import { S, getSimTime, getState, gravityAt } from './physics.js';
import { ribbon } from './ribbon.js';

/* What the map adds to the scene. The map IS the scene — the same Earth, Moon and trajectory
   ribbon, seen from the map camera — so all that is missing at 100 000 km is what is too small to
   see: a marker for the ship, a name on each body, the Moon's orbit and its sphere of influence.
   Everything here is drawn at a constant size on screen and exists only while the map is up. */
const group = new THREE.Group();
group.visible = false;
let moonDot = null, earthDot = null;
let shipMark = null, earthTag = null, moonTag = null, soiRing = null, meetTag = null, meetRing = null;

/* The coast from here, if the engine stays off: the whole transfer in one line, which the flight
   ribbon (js/predictor.js — 30 hours ahead at most, and faded near the ship) is not built to show.
   Re-integrated twice a second with the game's own gravity at a step that scales with distance
   (1/250 of the local radius per step, 1-300 s): a picture, not a certificate — js/targeting.js
   owns the number in the orbit panel. It stops at an impact, after one lap of a closed orbit, or
   after eight days, and remembers the closest pass of the Moon so the map can show WHERE THE MOON
   WILL BE when you get there, which is the thing a translunar burn is aimed at. */
const CAP = 4096;
const path = ribbon({ widthPx: 2.4, glowWidthPx: 8, vertexColors: true, capacity: CAP, opacity: 1, glowOpacity: 0.4 });
const pts = new Float32Array(CAP * 3), cols = new Float32Array(CAP * 3);
const _p = new THREE.Vector3(), _v = new THREE.Vector3(), _a = new THREE.Vector3(), _mm = new THREE.Vector3(), _prev = new THREE.Vector3();
const meet = { r: Infinity, t: 0, moon: new THREE.Vector3(), pos: new THREE.Vector3() };
let tick = 1;
function coast() {
  let t = getSimTime(), n = 0, swept = 0;
  _p.copy(S.pos); _v.copy(S.v); _prev.copy(_p);
  gravityAt(_p, _a, t); _v.addScaledVector(_a, 0.05);      // the game's velocity is half a step behind: js/targeting.js
  meet.r = Infinity;
  /* mint before the closest lunar pass, amber after it (what the Moon does to you is a different
     leg of the trip, and one colour through the bend read as a kink in the line), red at an impact */
  let past = false;
  const put = (red) => {
    pts[n * 3] = _p.x; pts[n * 3 + 1] = _p.y; pts[n * 3 + 2] = _p.z;
    cols[n * 3] = red ? 1 : past ? 1 : 0.36; cols[n * 3 + 1] = red ? 0.3 : past ? 0.78 : 0.95; cols[n * 3 + 2] = red ? 0.25 : past ? 0.35 : 0.62; n++;
  };
  put(false);
  for (let k = 0; k < 40000 && n < CAP - 1; k++) {
    moonPos(t, _mm);
    const rE = _p.length(), rM = _p.distanceTo(_mm);
    if (rM < meet.r) { meet.r = rM; meet.t = t; meet.moon.copy(_mm); meet.pos.copy(_p); }
    else if (rM > meet.r * 1.02 && meet.r < SOI_M) past = true;
    if (rE < RE || rM < RM) { put(true); break; }
    const dt = THREE.MathUtils.clamp(0.004 * Math.min(rE, rM) / Math.max(_v.length(), 1e-3), 1, 300);
    _v.addScaledVector(_a, dt / 2); _p.addScaledVector(_v, dt); t += dt;      // velocity Verlet, as js/targeting.js
    gravityAt(_p, _a, t); _v.addScaledVector(_a, dt / 2);
    swept += _prev.angleTo(_p); _prev.copy(_p);
    put(false);
    if (swept > 6.4 && rM > SOI_M) break;                 // one lap of a closed orbit
    if (t - getSimTime() > 8 * 86400 || rE > 1.5e6) break;
  }
  path.setPoints(pts, n); path.setColors(cols, n);
}

function tag(text, colour, ring) {
  const wide = text.length > 6;
  const cv = document.createElement('canvas'); cv.width = wide ? 512 : 256; cv.height = 128;
  const g = cv.getContext('2d');
  g.font = '700 30px ui-monospace, SFMono-Regular, Menlo, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 7; g.strokeStyle = 'rgba(4,8,14,.9)'; g.strokeText(text, cv.width / 2, 30);
  g.fillStyle = colour; g.fillText(text, cv.width / 2, 30);
  if (ring) {                                   // a ring with a dot: "the ship is here"
    g.beginPath(); g.arc(128, 96, 20, 0, 6.2832); g.lineWidth = 9; g.strokeStyle = 'rgba(4,8,14,.9)'; g.stroke();
    g.lineWidth = 5; g.strokeStyle = colour; g.stroke();
    g.beginPath(); g.arc(128, 96, 5, 0, 6.2832); g.fill();
  }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false }));
  sp.center.set(0.5, ring ? 0.25 : -0.6);       // the ring's centre sits on the ship; a name floats over its body
  sp.scale.set(0.16, 0.08, 1); sp.renderOrder = 9;
  return sp;
}

/* A body is never smaller than this on the map: from Earth orbit the Moon was a 2-pixel speck. */
function dot(colour) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 32;
  const g = cv.getContext('2d'); g.beginPath(); g.arc(16, 16, 11, 0, 6.2832); g.fillStyle = colour; g.fill(); g.lineWidth = 4; g.strokeStyle = 'rgba(4,8,14,.9)'; g.stroke();
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthTest: true, depthWrite: false, sizeAttenuation: false, fog: false }));
  sp.scale.set(0.016, 0.016, 1); sp.renderOrder = 8;
  return sp;
}

function ring(radius, colour, opacity, dashed) {
  const pts = [];
  for (let k = 0; k <= 256; k++) {
    const a = k / 256 * Math.PI * 2;
    pts.push(MOON_U.clone().multiplyScalar(Math.cos(a) * radius).addScaledVector(MOON_V, Math.sin(a) * radius));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = dashed ? new THREE.LineDashedMaterial({ color: colour, transparent: true, opacity, dashSize: radius * 0.03, gapSize: radius * 0.03, fog: false })
    : new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity, fog: false });
  const l = new THREE.Line(geo, mat);
  if (dashed) l.computeLineDistances();
  l.frustumCulled = false;
  return l;
}

export function initMapView(scene) {
  shipMark = tag('SHIP', '#8df0b4', true);
  earthTag = tag('EARTH', '#9cc9ff', false);
  moonTag = tag('MOON', '#d8dde8', false);
  soiRing = ring(SOI_M, 0xd8dde8, 0.5, true);
  meetTag = tag('MOON AT ARRIVAL', '#ffd27a', false); meetTag.scale.set(0.3, 0.075, 1);
  meetRing = ring(RM, 0xffd27a, 0.9, false);
  path.frustumCulled = false;
  moonDot = dot('#d8dde8'); earthDot = dot('#6fa8ff');
  group.add(moonDot, earthDot);
  group.add(shipMark, earthTag, moonTag, ring(MOON_DIST, 0x6f86a8, 0.55, false), soiRing, path, meetTag, meetRing);
  scene.add(group);
}

/* Closest lunar pass of the engine-off coast from here, km above the surface (Infinity: none). */
const _m = new THREE.Vector3();
export function updateMapView(on, dt = 0.016) {
  group.visible = on;
  /* The coast runs whether or not the map is up: its closest lunar pass is the HUD's coarse aim
     while the engine is burning and the exact prediction (js/targeting.js) is not available. */
  tick += dt;
  if (tick > 0.5) { tick = 0; if (getState() === 'flying') coast(); else { path.clear(); meet.r = Infinity; } }
  if (!on) return;
  moonPos(getSimTime(), _m);
  shipMark.position.copy(S.pos);
  moonTag.position.copy(_m); soiRing.position.copy(_m); moonDot.position.copy(_m);
  /* The Moon's place at closest approach, when the path actually goes there and it is not now. */
  const show = getState() === 'flying' && meet.r < SOI_M * 2 && meet.moon.distanceTo(_m) > SOI_M * 0.5;   // not while it would sit on the Moon's own name
  meetTag.visible = meetRing.visible = show;
  if (show) { meetTag.position.copy(meet.moon); meetRing.position.copy(meet.moon); }
}
