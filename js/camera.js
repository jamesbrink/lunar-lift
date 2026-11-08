import * as THREE from 'three';
import { RE, RM, SOI_M, PAD_POS, moonPos } from './constants.js';
import { S, fwd, getSimTime } from './physics.js';

/* distances are km; 1 m near plane so the 105 m rocket resolves, 3 M km far plane
   so the starfield and the lunar approach both render (logarithmic depth buffer) */
export const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.001, 3000000);

export const camModes = ['chase', 'orbit', 'system'];
export const getCamDist = () => camDist;
let camMode = 0, camYaw = 0.3, camPitch = 0.15, camDist = 0.35, dragging = false, lastInput = 0;
const camPos = new THREE.Vector3(), camTgt = PAD_POS.clone(), camUp = new THREE.Vector3(0, 0, 1);
const noseSmooth = new THREE.Vector3(0, 0, 1);
const CAM_RANGE = { chase: [0.02, 400, 0.35], orbit: [0.01, 1000, 2.5], system: [4000, 900000, 150000] };

let addLog = () => {};

export function initCamera(canvas, log) {
  addLog = log;
  canvas.addEventListener('pointerdown', e => { dragging = true; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { dragging = false; lastInput = performance.now(); });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    camYaw += e.movementX * 0.005; camPitch = THREE.MathUtils.clamp(camPitch - e.movementY * 0.005, -1.3, 1.3);
    lastInput = performance.now();
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const [lo, hi] = CAM_RANGE[camModes[camMode]];
    camDist = THREE.MathUtils.clamp(camDist * (e.deltaY > 0 ? 1.12 : 0.9), lo, hi);
  }, { passive: false });
}

export function cycleCamera() {
  camMode = (camMode + 1) % camModes.length;
  const mode = camModes[camMode];
  camDist = CAM_RANGE[mode][2];
  camYaw = mode === 'system' ? 0 : 0.3; camPitch = mode === 'system' ? 0.25 : 0.15;
  lastInput = performance.now();
  addLog(`CAMERA: ${mode.toUpperCase()}`);
}

export function setCamMode(name) { camMode = camModes.indexOf(name); }
export function setCamDist(d) { camDist = d; }

export function resetCameraView() {
  camMode = 0; camYaw = 0.35; camPitch = 0.18; camDist = 0.9;
  camPos.copy(PAD_POS).addScaledVector(PAD_UP_LOCAL(), 0.6).addScaledVector(PAD_EAST_LOCAL(), -1.2);
  camTgt.copy(PAD_POS); camUp.copy(PAD_UP_LOCAL());
}

const AXIS = new THREE.Vector3(0, 1, 0);
function PAD_UP_LOCAL() { return new THREE.Vector3().copy(PAD_POS).normalize(); }
function PAD_EAST_LOCAL() { return new THREE.Vector3().crossVectors(AXIS, PAD_UP_LOCAL()).normalize(); }

export function resizeCamera() {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}

// "up" follows the nearest body's radial direction, cross-blended near the SOI boundary:
// the horizon stays level and the view can never roll or flip, whatever the rocket does.
function bodyRadial() {
  const e = new THREE.Vector3().copy(S.pos).normalize();
  moonPos(getSimTime(), _m);
  const rM = S.pos.distanceTo(_m);
  if (rM > SOI_M * 1.4) return e;
  const m = new THREE.Vector3().subVectors(S.pos, _m).normalize();
  const w = THREE.MathUtils.smoothstep(SOI_M * 1.4 - rM, 0, SOI_M * 0.8);
  return e.multiplyScalar(1 - w).addScaledVector(m, w).normalize();
}

const _m = new THREE.Vector3();
const desired = new THREE.Vector3();
export function updateCamera(dt) {
  const mode = camModes[camMode];
  let target, up;
  if (mode === 'system') {
    moonPos(getSimTime(), _m);
    target = new THREE.Vector3(_m.x / 2, 0, _m.z / 2); up = AXIS;
    const dir = new THREE.Vector3(Math.sin(camYaw) * Math.cos(camPitch), Math.sin(camPitch), Math.cos(camYaw) * Math.cos(camPitch));
    desired.copy(target).addScaledVector(dir, camDist);
  } else {
    target = S.pos.clone();
    up = bodyRadial();
    // horizontal heading the camera trails behind (nose, falling back to velocity, then a fixed axis)
    noseSmooth.lerp(fwd(), 1 - Math.exp(-4 * dt));
    if (noseSmooth.lengthSq() > 1e-9) noseSmooth.normalize(); else noseSmooth.copy(up);
    const h = noseSmooth.clone().addScaledVector(up, -noseSmooth.dot(up));
    if (h.length() < 0.12) {
      h.copy(S.v).addScaledVector(up, -S.v.dot(up));
      if (h.length() < 0.12) h.crossVectors(up, Math.abs(up.y) < 0.9 ? AXIS : new THREE.Vector3(1, 0, 0));
    }
    h.normalize();
    if (mode === 'chase' && performance.now() - lastInput > 2000) {   // ease back behind the nose
      camYaw *= Math.exp(-1.6 * dt); camPitch *= Math.exp(-1.6 * dt);
    }
    const pitch = THREE.MathUtils.clamp((mode === 'chase' ? 0.22 : 0.35) + camPitch, -1.3, 1.3);
    const dir = new THREE.Vector3().addScaledVector(up, Math.sin(pitch)).addScaledVector(h, -Math.cos(pitch))
      .applyAxisAngle(up, camYaw);
    desired.copy(target).addScaledVector(dir, camDist);
  }
  const k = 1 - Math.exp(-(mode === 'system' ? 7 : 15) * dt);   // snappy follow, no target lag
  camPos.lerp(desired, k);
  camTgt.copy(target);
  camUp.lerp(up, k).normalize();
  camera.position.copy(camPos); camera.up.copy(camUp); camera.lookAt(camTgt);
}
