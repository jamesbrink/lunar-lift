import * as THREE from 'three';
import * as WORLD from './world.js';
import { RE, RM, SOI_M, VS, PAD_SCALE, PAD_POS, PAD_UP, moonPos } from './constants.js';
import { S, fwd, getSimTime, activeStage } from './physics.js';
import { stages } from './saturn.js';

/* distances are km; 1 m near plane so the 105 m rocket resolves, 3 M km far plane
   so the starfield and the lunar approach both render (logarithmic depth buffer) */
export const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.001, 3000000);

export const camModes = ['chase', 'orbit', 'system'];
// getCamDist removed with the world-space nav arrows (round 6b); nothing else reads curDist.
let camMode = 0, dragging = false, lastInput = 0;

/* Input writes the `want` numbers and each frame damps the `cur` ones toward them. Assigning a camera
   number straight onto the transform — what this did — turns every wheel notch and mouse jerk into a
   hard cut, and it lets the viewpoint teleport through geometry between frames. Zoom is damped in log
   space so pulling from 0.35 km to 400 km takes the same pleasant half-second as 0.35 to 0.7. */
let wantYaw = 0.3, wantPitch = 0.15, wantDist = 0.35;
let curYaw = 0.3, curPitch = 0.15, curDist = 0.35;

const camPos = new THREE.Vector3(), camTgt = PAD_POS.clone(), camUp = new THREE.Vector3(0, 0, 1);
/* The camera's place is kept as an OFFSET from what it follows, and that offset is what gets damped.
   Damping the absolute position instead (what this did) makes the camera a first-order follower of
   a moving point, and such a follower trails by speed x time-constant: measured in a 300 km orbit at
   x1 with 0.12 km asked for, the camera sat 0.572 km back with the ship 32 % of the way up the frame,
   and under warp it was left behind altogether. An offset has no velocity to lag. */
const camOff = new THREE.Vector3();
/* What the camera looks at: the middle of the hardware still attached, as a distance along the
   vehicle axis from the state point S.pos (which is the middle of the FULL stack — after two
   stagings the nearest metal is 10 m ahead of it and the command module 38 m). It glides to its new
   value when a stage leaves instead of jumping, so staging re-frames the ship rather than cutting. */
const NOSE_Z = 28.7;                       // build units: the command module's apex
let focusZ = null, spanHalf = 37 * VS;
const noseSmooth = new THREE.Vector3(0, 0, 1);
const CAM_RANGE = { chase: [0.02, 400, 0.35], orbit: [0.01, 1000, 2.5], system: [4000, 900000, 150000] };
const SOI_BLEND_HI = SOI_M * 1.4, SOI_BLEND_LO = SOI_M * 0.8;

/* Collision volumes. The camera may come to rest on these and may slide along them; it may not enter.
   - the two bodies, offset by whatever relief js/world.js reports for the direction the camera sits in,
     so a mountain lifts the camera instead of swallowing it
   - the launch complex as a squat dome: 0.64 km of apron carrying 0.13 km of mast, so a sphere would
     wall the camera off from the rocket and a plane would let it shear through the towers
   - the vehicle itself as an ellipsoid along its axis: with the chase floor at 20 m, the viewpoint used
     to sit inside the S-IC
   Damping alone is not enough here, because the target outruns the damping whenever warp, staging or a
   reset moves it, and that step is exactly what used to land the camera under the surface. */
const PAD_R = 455 * PAD_SCALE, PAD_H = 150 * PAD_SCALE;      // apron edge; mast tips plus margin
const SHIP_R = 10 * PAD_SCALE;                               // stage radius; the length is the live span
const SKIN = 0.02;                                           // km of standoff so nothing z-fights
const ORIGIN = new THREE.Vector3();

// scratch, never aliased against each other
const _up = new THREE.Vector3(), _h = new THREE.Vector3(), _dir = new THREE.Vector3();
const _diff = new THREE.Vector3(), _target = new THREE.Vector3(), _padGround = new THREE.Vector3();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const _ax0 = new THREE.Vector3(), _ax1 = new THREE.Vector3(), _ax2 = new THREE.Vector3();
const _moon = new THREE.Vector3(), desired = new THREE.Vector3();

let addLog = () => {};

export function initCamera(canvas, log) {
  addLog = log;
  canvas.addEventListener('pointerdown', e => { dragging = true; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { dragging = false; lastInput = performance.now(); });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    wantYaw += e.movementX * 0.005;
    wantPitch = THREE.MathUtils.clamp(wantPitch - e.movementY * 0.005, -1.3, 1.3);
    lastInput = performance.now();
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const [lo, hi] = CAM_RANGE[camModes[camMode]];
    wantDist = THREE.MathUtils.clamp(wantDist * (e.deltaY > 0 ? 1.12 : 0.9), lo, hi);
  }, { passive: false });
}

export function cycleCamera() {
  camMode = (camMode + 1) % camModes.length;
  const mode = camModes[camMode];
  const [lo, hi] = CAM_RANGE[mode];
  wantDist = THREE.MathUtils.clamp(CAM_RANGE[mode][2], lo, hi);
  wantYaw = mode === 'system' ? 0 : 0.3; wantPitch = mode === 'system' ? 0.25 : 0.15;
  lastInput = performance.now();
  placed = false;            // a mode change is a cut: the pivots are 190 000 km apart
  addLog(`CAMERA: ${mode.toUpperCase()}`);
}

export function setCamMode(name) { camMode = camModes.indexOf(name); }

/* Snaps by default: setCam(d) is the scripted entry point, and a scripted pose has to be true the same
   frame it is asked for, not one the damping is on its way to. `placed = false` forces a re-place
   instead of a lerp from wherever the camera happened to be. */
export function setCamDist(d, snap = true) {
  wantDist = d;
  if (snap) { curDist = d; placed = false; }
}

export function resetCameraView() {
  camMode = 0; wantYaw = curYaw = 0.35; wantPitch = curPitch = 0.18; wantDist = curDist = 0.9;
  camUp.copy(PAD_UP).normalize();
  focusZ = null;
  placed = false;            // updateCamera places it on the first frame, from the numbers above
}

const AXIS = new THREE.Vector3(0, 1, 0);
let placed = false;

export function resizeCamera() {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}

// "up" follows the nearest body's radial direction, cross-blended near the SOI boundary:
// the horizon stays level and the view can never roll or flip, whatever the rocket does.
function bodyRadial(out) {
  out.copy(S.pos).normalize();
  moonPos(getSimTime(), _moon);
  const rM = S.pos.distanceTo(_moon);
  if (rM > SOI_BLEND_HI) return out;
  _diff.subVectors(S.pos, _moon).normalize();
  const w = THREE.MathUtils.smoothstep(SOI_BLEND_HI - rM, 0, SOI_BLEND_LO);
  return out.multiplyScalar(1 - w).addScaledVector(_diff, w).normalize();
}

/* Relief lookup, tolerant of js/world.js not exporting it yet: the camera then collides with the plain
   sphere, which is the old behaviour, so the two changes can land in either order. */
function groundLift(fn, dir) {
  if (typeof fn !== 'function') return 0;
  const h = fn(dir);
  return Number.isFinite(h) && h > 0 ? h : 0;
}

/* Push `pos` onto the surface of the ellipsoid spanned by the orthonormal `ax` with half-widths
   `radii`. Rescaling to a unit sphere and back is not the nearest-point answer, but it can never leave
   a point inside the volume, and that is the only property collision actually needs. */
function pushOut(ax0, ax1, ax2, r0, r1, r2, centre, pos) {
  _diff.subVectors(pos, centre);
  const x = _diff.dot(ax0) / r0, y = _diff.dot(ax1) / r1, z = _diff.dot(ax2) / r2;
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s >= 1) return;
  if (s < 1e-6) { pos.copy(centre).addScaledVector(ax2, r2); return; }
  const inv = 1 / s;
  pos.copy(centre)
    .addScaledVector(ax0, x * inv * r0)
    .addScaledVector(ax1, y * inv * r1)
    .addScaledVector(ax2, z * inv * r2);
}

// Keep `pos` outside the sphere (centre, r), measured radially, so the camera climbs over terrain.
function keepOut(pos, centre, r) {
  _diff.subVectors(pos, centre);
  const d = _diff.length();
  if (d >= r) return;
  if (d < 1e-9) _diff.copy(AXIS); else _diff.multiplyScalar(1 / d);
  pos.copy(centre).addScaledVector(_diff, r);
}

/* Smallest volume first, so the vehicle and the pad get their say before the planet claims the space.
   This runs twice per frame — on `desired` and again on the interpolated `camPos`. The second call is
   the one that matters: a lerp between two points outside a sphere is a chord, and chords are inside,
   so without it a teleport across the planet (reset, warp, `ff()` through the translunar coast) dragged
   the camera 6 019 km through the Earth on its way to a perfectly legal destination. */
function collide(pos, isSystem) {
  if (!isSystem) {
    _ax0.copy(fwd()).normalize();                                // along the vehicle axis
    _ax1.crossVectors(_ax0, _up);
    if (!Number.isFinite(_ax1.x) || _ax1.lengthSq() < 1e-9) _ax1.copy(X_AXIS); else _ax1.normalize();
    _ax2.crossVectors(_ax0, _ax1).normalize();
    pushOut(_ax1, _ax2, _ax0, SHIP_R, SHIP_R, spanHalf + 6 * VS, _target, pos);   // +6u clears the escape tower
  }
  _ax0.copy(PAD_UP).normalize();
  _ax1.crossVectors(AXIS, _ax0).normalize();
  _ax2.crossVectors(_ax0, _ax1).normalize();
  _padGround.copy(_ax0).multiplyScalar(RE);                      // the ground under the complex
  pushOut(_ax1, _ax2, _ax0, PAD_R, PAD_R, PAD_H, _padGround, pos);

  _dir.copy(pos).normalize();
  keepOut(pos, ORIGIN, RE + SKIN + groundLift(WORLD.groundHeight, _dir));
  moonPos(getSimTime(), _moon);
  _diff.subVectors(pos, _moon);
  if (_diff.lengthSq() > 1e-9) _dir.copy(_diff).multiplyScalar(1 / _diff.length());
  keepOut(pos, _moon, RM + SKIN + groundLift(WORLD.moonGroundHeight, _dir));
}

export function updateCamera(dt) {
  const mode = camModes[camMode];
  const kAng = 1 - Math.exp(-16 * dt), kDist = 1 - Math.exp(-8 * dt);
  curYaw += (wantYaw - curYaw) * kAng;
  curPitch += (wantPitch - curPitch) * kAng;
  curDist = Math.exp(THREE.MathUtils.lerp(Math.log(curDist), Math.log(wantDist), kDist));

  if (mode === 'system') {
    moonPos(getSimTime(), _moon);
    _up.copy(AXIS);
    _target.set(_moon.x / 2, 0, _moon.z / 2);                    // system pivot: halfway to the Moon
    _dir.set(Math.sin(curYaw) * Math.cos(curPitch), Math.sin(curPitch), Math.cos(curYaw) * Math.cos(curPitch));
    desired.copy(_target).addScaledVector(_dir, curDist);
  } else {
    const i = activeStage();
    const tail = i >= 0 ? stages[i].tailZ : NOSE_Z - 6;          // capsule alone: its own six units
    const wantZ = 0.5 * (tail + NOSE_Z) * VS;
    focusZ = focusZ === null || !placed ? wantZ : focusZ + (wantZ - focusZ) * (1 - Math.exp(-2.5 * dt));
    spanHalf = 0.5 * (NOSE_Z - tail) * VS;
    _target.copy(S.pos).addScaledVector(fwd(), focusZ);          // the thing the camera orbits
    bodyRadial(_up);
    // horizontal heading the camera trails behind (nose, falling back to velocity, then a fixed axis)
    noseSmooth.lerp(fwd(), 1 - Math.exp(-4 * dt));
    if (noseSmooth.lengthSq() > 1e-9) noseSmooth.normalize(); else noseSmooth.copy(_up);
    _h.copy(noseSmooth).addScaledVector(_up, -noseSmooth.dot(_up));
    if (_h.length() < 0.12) {
      _h.copy(S.v).addScaledVector(_up, -S.v.dot(_up));
      if (_h.length() < 0.12) _h.crossVectors(_up, Math.abs(_up.y) < 0.9 ? AXIS : X_AXIS);
    }
    _h.normalize();
    if (mode === 'chase' && performance.now() - lastInput > 2000) {   // ease back behind the nose
      wantYaw *= Math.exp(-1.6 * dt); wantPitch *= Math.exp(-1.6 * dt);
    }
    const pitch = THREE.MathUtils.clamp((mode === 'chase' ? 0.22 : 0.35) + curPitch, -1.3, 1.3);
    _dir.set(0, 0, 0).addScaledVector(_up, Math.sin(pitch)).addScaledVector(_h, -Math.cos(pitch))
      .applyAxisAngle(_up, curYaw);
    desired.copy(_target).addScaledVector(_dir, curDist);
  }

  collide(desired, mode === 'system');

  const k = 1 - Math.exp(-(mode === 'system' ? 7 : 15) * dt);
  desired.sub(_target);                                          // now an offset
  if (!placed) { camOff.copy(desired); placed = true; } else camOff.lerp(desired, k);
  camPos.copy(_target).add(camOff);
  /* Second collision pass, on the blended place: a lerp between two legal offsets is a chord, and a
     chord can pass through the vehicle, the pad or the ground. */
  collide(camPos, mode === 'system');
  camTgt.copy(_target);                                          // the ship is the centre of the frame, exactly
  camUp.lerp(_up, k).normalize();
  camera.position.copy(camPos); camera.up.copy(camUp); camera.lookAt(camTgt);
}
