import * as THREE from 'three';
import { MOON_DIST, MOON_U, MOON_V, SOI_M, moonPos } from './constants.js';
import { S, getSimTime } from './physics.js';

/* What the map adds to the scene. The map IS the scene — the same Earth, Moon and trajectory
   ribbon, seen from the map camera — so all that is missing at 100 000 km is what is too small to
   see: a marker for the ship, a name on each body, the Moon's orbit and its sphere of influence.
   Everything here is drawn at a constant size on screen and exists only while the map is up. */
const group = new THREE.Group();
group.visible = false;
let shipMark = null, earthTag = null, moonTag = null, soiRing = null;

function tag(text, colour, ring) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
  const g = cv.getContext('2d');
  g.font = '700 30px ui-monospace, SFMono-Regular, Menlo, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 7; g.strokeStyle = 'rgba(4,8,14,.9)'; g.strokeText(text, 128, 30);
  g.fillStyle = colour; g.fillText(text, 128, 30);
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
  group.add(shipMark, earthTag, moonTag, ring(MOON_DIST, 0x6f86a8, 0.55, false), soiRing);
  scene.add(group);
}

const _m = new THREE.Vector3();
export function updateMapView(on) {
  group.visible = on;
  if (!on) return;
  moonPos(getSimTime(), _m);
  shipMark.position.copy(S.pos);
  moonTag.position.copy(_m); soiRing.position.copy(_m);
}
