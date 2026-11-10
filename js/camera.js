import * as THREE from 'three';
import * as WORLD from './world.js';
import { RE, RM, MU_E, SOI_M, MOON_DIST, EARTH_SPIN, MOON_PLANE_N, MOON_U, MOON_V, VS, PAD_SCALE, PAD_POS, PAD_UP, moonPos } from './constants.js';
import { S, keys, fwd, getSimTime, activeStage, isBurning, getThrottle, airDensity, groundVel, navVel, orbitalElements, getChute } from './physics.js';
import { stages } from './saturn.js';

/* distances are km; 1 m near plane so the 105 m rocket resolves, 3 M km far plane
   so the starfield and the lunar approach both render (logarithmic depth buffer) */
export const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.001, 3000000);

/* orbit   the default. The camera circles the ship on a heading that is carried along with it —
           parallel-transported over the body, never taken from the nose or the velocity — so the
           view moves only when the mouse moves it. Pitching the rocket over pitches the rocket,
           not the world.
   chase   sits behind the flight path: heading follows the horizontal velocity, elevation follows
           the climb angle, so "forward" on screen is where the ship is going (not where it points —
           those differ by 180° in a braking burn, and the old nose-chase spun round with every flip).
   map     (M, not in the C cycle) the same scene from far off, pivoting on a body you choose with F:
           Earth, Moon or the ship. The pole of the Moon's orbit is up, drag and the arrow keys turn
           it, the wheel zooms.
   Nothing eases the view "home" on a timer: that takes the camera out of the user's hand two
   seconds after every drag. Double-click re-centres. */
export const camModes = ['orbit', 'chase'];
const FOCI = ['earth', 'moon', 'ship'];
let mapOn = false, focus = 0;
const MAP_RANGE = { earth: [RE * 1.25, 1.6e6], moon: [RM * 1.4, 4e5], ship: [30, 1.6e6] };
let camMode = 0, dragging = false;

/* Input writes the `want` numbers and each frame damps the `cur` ones toward them. Assigning a camera
   number straight onto the transform — what this did — turns every wheel notch and mouse jerk into a
   hard cut, and it lets the viewpoint teleport through geometry between frames. Zoom is damped in log
   space so pulling from 0.35 km to 400 km takes the same pleasant half-second as 0.35 to 0.7. */
/* The opening shot: from the south-east apron, low, so the sunlit side of the stack stands in front
   of the umbilical tower instead of behind it (measured in the pad's frame: yaw 0.5 put the camera
   at azimuth −151°, with 123 m of red steel between it and the rocket). */
const PAD_YAW = 2.33;
let wantYaw = PAD_YAW, wantPitch = 0, wantDist = 0.13;
let curYaw = PAD_YAW, curPitch = 0, curDist = 0.13;

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
let wantFov = 64, placedFov = false, shakeT = 0;
const refH = new THREE.Vector3(1, 0, 0);     // the carried heading, horizontal and unit
let refOk = false, climb = 0, frame = 1, lastSimT = 0;
const FULL_SPAN = 0.5 * (NOSE_Z + 42) * VS; // half-length of the whole stack
const saved = { yaw: PAD_YAW, pitch: 0, dist: 0.13 };
const CAM_RANGE = { chase: [0.02, 1000, 0.13], orbit: [0.02, 1000, 0.13] };
const range = () => mapOn ? MAP_RANGE[FOCI[focus]] : CAM_RANGE[camModes[camMode]];
const SOI_BLEND_HI = SOI_M * 1.4, SOI_BLEND_LO = SOI_M * 0.8;

/* Collision volumes. The camera may come to rest on these and may slide along them; it may not enter.
   - the two bodies, offset by whatever relief js/world.js reports for the direction the camera sits in,
     so a mountain lifts the camera instead of swallowing it
   - the launch complex as three ellipsoids in the pad's own build-unit frame (js/pad.js): the mobile
     launcher's deck, the umbilical tower with its crane, the propellant farm. Three, not one dome
     over the whole site: a dome keeps the camera out of the towers by keeping it off the apron, and
     the view from the apron looking up the stack is the one that makes a Saturn V big
   - the vehicle itself as an ellipsoid along its axis: with the zoom floor at 20 m the viewpoint
     would otherwise sit inside the S-IC
   Damping alone is not enough here, because the target outruns the damping whenever warp, staging or a
   reset moves it, and that step is exactly what lands a camera under the surface.
   PAD_SOLIDS: [radii xyz, centre xyz] */
const PAD_SOLIDS = [[42, 30, 3.5, 0, 0, 0], [9, 9, 58, -21, 0, 46], [26, 20, 15, 52, 38, 6]];
const SHIP_R = 10 * PAD_SCALE;                               // stage radius; the length is the live span
const SKIN = 0.02;                                           // km of standoff so nothing z-fights
const ORIGIN = new THREE.Vector3();

// scratch, never aliased against each other
const _up = new THREE.Vector3(), _h = new THREE.Vector3(), _dir = new THREE.Vector3();
const _diff = new THREE.Vector3(), _target = new THREE.Vector3();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const _ax0 = new THREE.Vector3(), _ax1 = new THREE.Vector3(), _ax2 = new THREE.Vector3();
const _moon = new THREE.Vector3(), desired = new THREE.Vector3();
const _look = new THREE.Matrix4();
const _inv = new THREE.Matrix4(), _loc = new THREE.Vector3(), _c = new THREE.Vector3(), _gv = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);

let addLog = () => {};

export function initCamera(canvas, log) {
  addLog = log;
  canvas.addEventListener('pointerdown', e => { dragging = true; canvas.setPointerCapture(e.pointerId); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(ev, () => { dragging = false; });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    wantYaw += e.movementX * 0.005;
    wantPitch = THREE.MathUtils.clamp(wantPitch - e.movementY * 0.005, -1.3, 1.3);
  });
  canvas.addEventListener('dblclick', () => {
    if (mapOn) { wantYaw = 0.6; wantPitch = 0.95; return; }
    let d = (-wantYaw) % (2 * Math.PI);                         // the short way round to "behind"
    if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
    wantYaw += d; wantPitch = 0;
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const [lo, hi] = range();
    /* By how far the wheel turned, not once per event: a trackpad sends dozens of small events a
       gesture and zoomed many times faster than a mouse. One notch (~100) is still ~12 %. */
    wantDist = THREE.MathUtils.clamp(wantDist * Math.exp(THREE.MathUtils.clamp(e.deltaY, -240, 240) * 0.00113), lo, hi);
  }, { passive: false });
}

export function cycleCamera() {
  if (mapOn) return;
  camMode = (camMode + 1) % camModes.length;
  wantYaw = 0; wantPitch = 0;                 // orbit <-> chase keep the zoom and glide
  addLog(`CAMERA: ${camModes[camMode].toUpperCase()}`);
}
export const getCamMode = () => mapOn ? 'map' : camModes[camMode];
export const isMap = () => mapOn;
export const getMapFocus = () => FOCI[focus];

/* A distance that shows what matters around the focus: the whole orbit when it is a closed one near
   the Earth, both bodies when the path goes to the Moon. */
function mapFrame() {
  const f = FOCI[focus], [lo, hi] = MAP_RANGE[f];
  moonPos(getSimTime(), _moon);
  let d;
  if (f === 'moon') d = Math.max(RM * 4, 3 * S.pos.distanceTo(_moon));
  else if (f === 'ship') d = Math.max(2000, 0.6 * Math.min(S.pos.length(), S.pos.distanceTo(_moon)));
  else {
    const el = orbitalElements(S.pos, S.v, MU_E, RE);
    const reach = el.escape || el.ap > MOON_DIST * 0.5 ? MOON_DIST : RE + Math.max(el.ap, S.pos.length() - RE);
    d = 2.6 * Math.max(reach, RE * 1.4);
  }
  return THREE.MathUtils.clamp(d, lo, hi);
}
export function setMap(on) {
  if (on === mapOn) return;
  if (on) {
    saved.yaw = wantYaw; saved.pitch = wantPitch; saved.dist = wantDist;
    mapOn = true;
    moonPos(getSimTime(), _moon);
    focus = S.pos.distanceTo(_moon) < SOI_M ? 1 : 0;
    /* Open on the ship's side of the planet: its marker draws through the globe, and a map that
       opens with the ship behind the Earth points at the wrong ocean. */
    wantYaw = Math.atan2(S.pos.dot(MOON_U), S.pos.dot(MOON_V)) + 0.35; wantPitch = 0.8; wantDist = mapFrame();
  } else { mapOn = false; wantYaw = saved.yaw; wantPitch = saved.pitch; wantDist = saved.dist; }
  curYaw = wantYaw; curPitch = wantPitch; curDist = wantDist;
  placed = false;                             // a cut: the pivots can be 380 000 km apart
}
export function cycleMapFocus() {
  if (!mapOn) return;
  focus = (focus + 1) % FOCI.length;
  wantDist = curDist = mapFrame(); placed = false;
  addLog(`MAP FOCUS: ${FOCI[focus].toUpperCase()}`);
}

export function setCamMode(name) { const k = camModes.indexOf(name); if (k >= 0 && k !== camMode) { camMode = k; placed = false; } }

/* Snaps by default: setCam(d) is the scripted entry point, and a scripted pose has to be true the same
   frame it is asked for, not one the damping is on its way to. `placed = false` forces a re-place
   instead of a lerp from wherever the camera happened to be. */
export function setCamDist(d, snap = true) {
  wantDist = d;
  if (snap) { curDist = d; placed = false; }
}

/* Scripted view (tools/clip-test.mjs, screenshots): yaw/pitch offsets and zoom, snapped. */
export function setCamView(yaw, pitch, dist) {
  wantYaw = curYaw = yaw; wantPitch = curPitch = pitch; wantDist = curDist = dist; placed = false;
}

export function resetCameraView() {
  camMode = 0; mapOn = false; saved.yaw = PAD_YAW; saved.pitch = 0; saved.dist = 0.13; wantYaw = curYaw = PAD_YAW; wantPitch = curPitch = 0; wantDist = curDist = 0.13;
  camUp.copy(PAD_UP).normalize();
  focusZ = null; refOk = false; climb = 0; frame = 1;
  placed = false;            // updateCamera places it on the first frame, from the numbers above
}

const AXIS = new THREE.Vector3(0, 1, 0);
let placed = false;

/* The instrument cluster owns the bottom-centre of the screen, so the optical centre is lifted
   12 % of the height: the ship the camera aims at stands above the attitude ball, not behind it. */
export function resizeCamera() {
  camera.aspect = innerWidth / innerHeight;
  camera.setViewOffset(innerWidth, innerHeight, 0, Math.round(innerHeight * 0.12), innerWidth, innerHeight);
  camera.updateProjectionMatrix();
}
resizeCamera();

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

/* Relief under `dir`, km above the datum sphere; never negative and never non-finite, so a bad
   lookup leaves the camera on the plain sphere. */
function groundLift(fn, dir) {
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
   This runs twice per frame — on `desired` and again on the blended `camPos`. The second call is
   the one that matters: a lerp between two points outside a sphere is a chord, and chords are inside,
   so without it a teleport across the planet (reset, warp, `ff()` through the translunar coast) drags
   the camera 6 019 km through the Earth on its way to a perfectly legal destination.
   `map`: the map camera is nowhere near the vehicle, so the hull is not tested. */
function collide(pos, map) {
  /* Three rounds, ground last. One round is not enough: the planet's push-out is radial, and a
     camera squeezed between the pad and the stack was pushed up out of the ground straight into
     the hull (tools/clip-test.mjs found it 3 m inside the S-1 at pitch −1.3 on the pad). */
  for (let round = 0; round < 3; round++) {
    if (!map) shipOut(pos);
    const pm = WORLD.padMatrix();
    if (pm && pos.distanceToSquared(_c.setFromMatrixPosition(pm)) < 0.09) {   // within 300 m of the complex
      _loc.copy(pos).applyMatrix4(_inv.copy(pm).invert());
      for (const s of PAD_SOLIDS) pushOut(X_AXIS, Y_AXIS, Z_AXIS, s[0], s[1], s[2], _c.set(s[3], s[4], s[5]), _loc);
      pos.copy(_loc).applyMatrix4(pm);
    }
    groundOut(pos);
  }
  /* Still inside the vehicle's volume means there is no room between it and the ground along the
     line that was asked for: leave sideways, level with the ground, which always exists. */
  if (!map && insideShip(pos)) {
    _diff.subVectors(pos, _target); _diff.addScaledVector(_up, -_diff.dot(_up));
    if (_diff.lengthSq() < 1e-12) _diff.copy(_ax1);
    _diff.normalize();
    pos.copy(_target).addScaledVector(_up, pos.clone().sub(_target).dot(_up)).addScaledVector(_diff, SHIP_R + spanHalf);
    groundOut(pos);
  }
}
function shipAxes() {
  _ax0.copy(fwd()).normalize();                                // along the vehicle axis
  _ax1.crossVectors(_ax0, _up);
  if (!Number.isFinite(_ax1.x) || _ax1.lengthSq() < 1e-9) _ax1.copy(X_AXIS); else _ax1.normalize();
  _ax2.crossVectors(_ax0, _ax1).normalize();
}
/* The hull is a cylinder and the collider an ellipsoid, which pinches toward its ends; 1.3× the
   half-span plus 8 u keeps the pinch clear of the nose and the bells (measured: nearest approach
   to the hull over the whole sweep, see tools/clip-test.mjs). */
const shipLen = () => spanHalf * 1.3 + 8 * VS;
function shipOut(pos) { shipAxes(); pushOut(_ax1, _ax2, _ax0, SHIP_R, SHIP_R, shipLen(), _target, pos); }
function insideShip(pos) {
  shipAxes(); _diff.subVectors(pos, _target);
  const x = _diff.dot(_ax1) / SHIP_R, y = _diff.dot(_ax2) / SHIP_R, z = _diff.dot(_ax0) / shipLen();
  return x * x + y * y + z * z < 0.98;
}
function groundOut(pos) {
  _dir.copy(pos).normalize();
  keepOut(pos, ORIGIN, RE + SKIN + groundLift(WORLD.fineGroundHeight, _dir));
  moonPos(getSimTime(), _moon);
  _diff.subVectors(pos, _moon);
  if (_diff.lengthSq() > 1e-9) _dir.copy(_diff).multiplyScalar(1 / _diff.length());
  keepOut(pos, _moon, RM + SKIN + groundLift(WORLD.moonGroundHeight, _dir));
}

/* The frame shakes with what would shake a camera: engine noise carried by air (thrust × √density —
   violent on the pad, gone by the time the sky is black) and aerodynamic buffet (dynamic pressure,
   normalised so max-Q ≈ 1). It is a rotation of the finished view, a fraction of a degree, built
   from four incommensurate sines so it rumbles instead of jittering; position and aim are untouched,
   so nothing downstream of the camera (the ribbon's gap, the colliders) sees it. A camera further
   from the vehicle shakes less. */
function shake(dt) {
  shakeT += dt;
  const altE = Math.max(0, S.pos.length() - RE);
  const rho = airDensity(altE) / airDensity(0);
  const sp = groundVel(_gv).length();
  const q = Math.min(1, rho * sp * sp / 0.05);                 // 0.05 ≈ ρ/ρ0 · v² at max-Q (0.2 × 0.5² km²/s²)
  const thrust = isBurning() ? getThrottle() * Math.sqrt(rho) : 0;
  const amp = Math.min(1, 0.9 * thrust + 0.7 * q) / (1 + curDist / 0.5);
  if (amp < 0.01) return;
  const t = shakeT;
  camera.rotateX(amp * 0.0045 * (Math.sin(t * 37.1) + Math.sin(t * 53.7 + 1.3)));
  camera.rotateY(amp * 0.0045 * (Math.sin(t * 41.3 + 2.1) + Math.sin(t * 59.9 + 0.4)));
}

export function updateCamera(dt, paused = false) {
  const mode = mapOn ? 'map' : camModes[camMode];
  /* Arrow keys look around, - and = zoom: the same numbers the mouse writes. */
  const kx = (keys['arrowleft'] ? 1 : 0) - (keys['arrowright'] ? 1 : 0), ky = (keys['arrowup'] ? 1 : 0) - (keys['arrowdown'] ? 1 : 0);
  const kz = (keys['-'] || keys['_'] ? 1 : 0) - (keys['='] || keys['+'] ? 1 : 0);
  if (kx || ky || kz) {
    wantYaw += kx * 1.6 * dt;
    wantPitch = THREE.MathUtils.clamp(wantPitch + ky * 1.2 * dt, -1.3, 1.3);
    const [lo, hi] = range();
    wantDist = THREE.MathUtils.clamp(wantDist * Math.exp(kz * 1.4 * dt), lo, hi);
  }
  const kAng = 1 - Math.exp(-16 * dt), kDist = 1 - Math.exp(-8 * dt);
  curYaw += (wantYaw - curYaw) * kAng;
  curPitch += (wantPitch - curPitch) * kAng;
  curDist = Math.exp(THREE.MathUtils.lerp(Math.log(curDist), Math.log(wantDist), kDist));

  if (mode === 'map') {
    wantFov = 50;
    moonPos(getSimTime(), _moon);
    /* 'Up' is the pole of the Moon's orbit, not the Earth's: the transfer, the parking orbit and the
       Moon all lie in that one plane (the launch window is built that way), so this is the view
       that looks DOWN on the mission. With north up the whole picture was an edge-on sliver. */
    _up.copy(MOON_PLANE_N);
    const f = FOCI[focus];
    if (f === 'earth') _target.set(0, 0, 0); else if (f === 'moon') _target.copy(_moon); else _target.copy(S.pos);
    _dir.set(0, 0, 0).addScaledVector(MOON_U, Math.sin(curYaw) * Math.cos(curPitch)).addScaledVector(MOON_PLANE_N, Math.sin(curPitch))
      .addScaledVector(MOON_V, Math.cos(curYaw) * Math.cos(curPitch));
    desired.copy(_target).addScaledVector(_dir, curDist);
  } else {
    const i = activeStage();
    const tail = i >= 0 ? stages[i].tailZ : NOSE_Z - 2.7;        // capsule alone: heat shield to apex
    /* Under parachutes the vehicle is the capsule AND what it hangs from: frame both. */
    const ch = i < 0 ? getChute() : 0, top = ch === 2 ? NOSE_Z + 36 : ch === 1 ? NOSE_Z + 18 : NOSE_Z;
    const wantZ = 0.5 * (tail + top) * VS;
    focusZ = focusZ === null || !placed ? wantZ : focusZ + (wantZ - focusZ) * (1 - Math.exp(-2.5 * dt));
    spanHalf = 0.5 * (top - tail) * VS;
    _target.copy(S.pos).addScaledVector(fwd(), focusZ);          // the thing the camera orbits
    bodyRadial(_up);
    /* First frame after a placement (boot, reset, setCam): start settled. The heading, the up vector
       and the lens each used to ease in from their module defaults, so every mission opened with
       the horizon rolling level and the view swinging round for a second. */
    if (!placed) { camUp.copy(_up); placedFov = false; }
    /* The carried heading: yesterday's, laid back into today's horizontal plane. Seeded from the
       ground track (east, on the pad), which is what makes yaw 2.33 the south-east apron shot. */
    /* Near the ground the heading belongs to the ground: it turns with the planet. Carried purely in
       inertial space it drifted against the pad at the Earth's rate — 15 degrees an hour, a
       thousandth of a pixel a frame, which is enough to flip the coverage of every sub-pixel edge
       (the last unstable pixels of tools/flicker-test.mjs), and under x10000 on the pad it swung the
       view round the rocket. By 120 km up it is an orbit's heading and inertial again. */
    {
      const tNow = getSimTime(), dT = tNow - lastSimT; lastSimT = tNow;
      const ground = 1 - THREE.MathUtils.smoothstep(S.pos.length() - RE, 20, 120);
      if (refOk && ground > 0 && dT > 0 && dT < 1e5) refH.applyAxisAngle(AXIS, EARTH_SPIN * dT * ground);
    }
    if (refOk) {
      refH.addScaledVector(_up, -refH.dot(_up));
      if (refH.lengthSq() < 1e-6) refOk = false; else refH.normalize();
    }
    if (!refOk) {
      refH.copy(S.v).addScaledVector(_up, -S.v.dot(_up));
      if (refH.length() < 0.12) refH.crossVectors(_up, Math.abs(_up.y) < 0.9 ? AXIS : X_AXIS);
      refH.normalize(); refOk = true;
    }
    moonPos(getSimTime(), _moon);
    const altE = S.pos.length() - RE;
    const alt = Math.max(0, Math.min(altE, S.pos.distanceTo(_moon) - RM));
    let pitch;
    if (mode === 'chase') {
      /* Behind the flight path. Ground-relative in the air (on the pad the inertial velocity is
         409 m/s of planet spin), orbital above it. Below 20 m/s there is no path to sit behind and
         the carried heading stands in; the climb angle is capped so a vertical ascent is seen from
         below-behind rather than from inside the plume. */
      const v = altE < 120 ? groundVel(_gv) : navVel(_gv);
      const sp = v.length(), w = THREE.MathUtils.smoothstep(sp, 0.02, 0.15);
      let gamma = 0;
      if (w > 0) {
        const vUp = v.dot(_up);
        _h.copy(v).addScaledVector(_up, -vUp);
        const hl = _h.length();
        gamma = Math.atan2(vUp, hl);
        if (hl > 0.004) {
          _h.multiplyScalar(1 / hl);
          if (_h.dot(refH) < -0.98) refH.applyAxisAngle(_up, 0.05);     // dead astern: break the tie
          refH.lerp(_h, w * (1 - Math.exp(-2.5 * dt))).normalize();
        }
      }
      climb += (THREE.MathUtils.clamp(w * gamma, -0.8, 0.8) - climb) * (placed ? 1 - Math.exp(-2.5 * dt) : 1);
      wantFov = 68;
      pitch = 0.2 - climb + curPitch;
    } else {
      /* The orbit camera is a crane shot written as a function of height. On the ground it sits low
         and looks UP the stack — a 110 m rocket seen from above its own nose is a pencil. As the
         vehicle climbs the camera rises over it, until from the stratosphere up it looks down past
         the ship at the ground falling away, which is the only thing in the frame that says how high
         this is. Same law over the Moon, so the landing ends looking up at the lander. */
      const rise = THREE.MathUtils.smoothstep(alt, 0.1, 2.5), high = THREE.MathUtils.smoothstep(alt, 2.5, 45);
      wantFov = 64 + 12 * high;                 // and the lens widens with it: depth is what a wide lens draws
      pitch = -0.20 + 0.42 * rise + 0.30 * high + curPitch;
    }
    pitch = THREE.MathUtils.clamp(pitch, -1.35, 1.35);
    _dir.set(0, 0, 0).addScaledVector(_up, Math.sin(pitch)).addScaledVector(refH, -Math.cos(pitch))
      .applyAxisAngle(_up, curYaw);
    /* The zoom is in ship-lengths: when a stage leaves, the same wheel position frames what is left. */
    const wantFrame = Math.sqrt(spanHalf / FULL_SPAN);
    frame = placed ? frame + (wantFrame - frame) * (1 - Math.exp(-1.5 * dt)) : wantFrame;
    desired.copy(_target).addScaledVector(_dir, curDist * frame);
  }

  collide(desired, mode === 'map');

  const k = 1 - Math.exp(-(mode === 'map' ? 7 : 15) * dt);
  desired.sub(_target);                                          // now an offset
  if (!placed) { camOff.copy(desired); placed = true; } else camOff.lerp(desired, k);
  camPos.copy(_target).add(camOff);
  /* Second collision pass, on the blended place: a lerp between two legal offsets is a chord, and a
     chord can pass through the vehicle, the pad or the ground. */
  collide(camPos, mode === 'map');
  camTgt.copy(_target);                                          // the ship is the centre of the frame, exactly
  camUp.lerp(_up, k).normalize();
  /* Orientation by hand, not camera.lookAt: the camera is a child of the scene, whose position is the
     floating origin (js/origin.js), and Object3D.lookAt would aim from the shifted world position
     at an unshifted target. */
  camera.position.copy(camPos); camera.up.copy(camUp);
  camera.quaternion.setFromRotationMatrix(_look.lookAt(camPos, camTgt, camUp));
  if (Math.abs(wantFov - camera.fov) > 0.01) {
    camera.fov += (wantFov - camera.fov) * (placedFov ? 1 - Math.exp(-2 * dt) : 1); placedFov = true;
    camera.updateProjectionMatrix();
  }
  /* Shake is the engine and the air, and neither is happening while time is stopped. The view
     itself stays live: a pause is for looking around. */
  if (mode !== 'map' && !paused) shake(dt);
}
