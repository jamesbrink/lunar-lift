import * as THREE from 'three';
import { RE, MOON, SOI_M, PAD_UP, PAD_POS } from './constants.js';
import { S, fwd } from './physics.js';

export const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.01, 400000);

export const camModes = ['chase', 'orbit', 'system'];
let camMode = 0, camYaw = 0.3, camPitch = 0.15, camDist = 2.6, dragging = false, lastInput = 0;
const camPos = new THREE.Vector3(0, -2.4, RE + 1.1), camTgt = PAD_POS.clone(), camUp = new THREE.Vector3(0, 0, 1);
const noseSmooth = new THREE.Vector3(0, 0, 1);
const CAM_RANGE = { chase: [0.35, 300, 2.6], orbit: [0.12, 400, 4.5], system: [6000, 60000, 20000] };

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
  camMode = 0; camYaw = 0.35; camPitch = 0.18; camDist = 72;
  camPos.set(0, 66, 1012); camTgt.copy(PAD_POS);
}

export function resizeCamera() {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}

// "up" follows the nearest body's radial direction, cross-blended near the SOI boundary:
// the horizon stays level and the view can never roll or flip, whatever the rocket does.
function bodyRadial() {
  const e = new THREE.Vector3().copy(S.pos).normalize();
  const rM = S.pos.distanceTo(MOON);
  if (rM > SOI_M * 1.4) return e;
  const m = new THREE.Vector3().subVectors(S.pos, MOON).normalize();
  const w = THREE.MathUtils.smoothstep(SOI_M * 1.4 - rM, 0, SOI_M * 0.8);
  return e.multiplyScalar(1 - w).addScaledVector(m, w).normalize();
}

const desired = new THREE.Vector3();
export function updateCamera(dt) {
  const mode = camModes[camMode];
  let target, up;
  if (mode === 'system') {
    target = new THREE.Vector3(MOON.x / 2, 0, MOON.z / 2); up = PAD_UP;
    const dir = new THREE.Vector3(Math.sin(camYaw) * Math.cos(camPitch), Math.cos(camYaw) * Math.cos(camPitch), Math.sin(camPitch));
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
      if (h.length() < 0.12) h.crossVectors(up, Math.abs(up.z) < 0.9 ? PAD_UP : new THREE.Vector3(1, 0, 0));
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
