import * as THREE from 'three';
import { RE, MU_E, RM, MU_M, SOI_M, PAD_UP, PAD_POS, PAD_ANGULAR, RHALF, ATMO_H, RHO0, CD_AREA, WARPS, LAND_SAFE, SAFE_EARTH, SPECS, CAPSULE_MASS, EARTH_SPIN, SPIN_AXIS, PAD_EAST, MOON_DIST, TURN, moonPos, moonVel } from './constants.js';

/* ---------------- injected dependencies (see initPhysics) ----------------
   hooks:      addLog(msg, cls), showEndOverlay(title, body, btn), setWarn(textOrNull)
   audio:      engine(on), thud(), explosion(), win()
   vehicleOps: spawnParticle(pos, vel, life, color), addDebris(entry), detachStage(mesh, pos, quat), setVisible(visible)
   stages:     the stage records built by vehicle.js (fuel / separated live here, in the sim)
   scene:      target for the trajectory-prediction line                                        */
let stages = null, scene = null;
let hooks = null, audio = null, vehicleOps = null;

export function initPhysics(deps) {
  stages = deps.stages; scene = deps.scene;
  hooks = deps.hooks; audio = deps.audio; vehicleOps = deps.vehicleOps;
  predLine.frustumCulled = false; scene.add(predLine);
}

/* ---------------- state ---------------- */
let state = 'pad';               // pad | flying | won | lost
let engineOn = false, throttle = 0, targetThrottle = 0;
let sasOn = false, sasRetro = false, simTime = 0, warpIdx = 0;
let maxQ = 0, loggedStageOut = [false, false, false], flightStarted = false;
let tliLogged = false, loiLogged = false, impactWarn = '';
let turnHintLogged = false, loggedMaxQ = false;
const UP_REF = new THREE.Vector3(0, 0, 1);
export const S = { pos: PAD_POS.clone(), v: PAD_ANGULAR.clone(), q: new THREE.Quaternion().setFromUnitVectors(UP_REF, PAD_UP) };
export const keys = Object.create(null);
/* true flight controls: body-frame angular velocity driven by commanded torque        */
export const omega = new THREE.Vector3();
let I0 = null;                       // fully loaded reference inertia, recomputed each mission
let trail = [];
let distFlown = 0;
let sasHoldTime = 0;

export const getState = () => state;
export const setState = v => { state = v; };
export const getEngineOn = () => engineOn;
export const getThrottle = () => throttle;
export const getTargetThrottle = () => targetThrottle;
export const setTargetThrottle = v => { targetThrottle = v; };
export const getSimTime = () => simTime;
/* Put the mission clock somewhere else. Only used by the debug teleport handle, which otherwise
   could not reproduce a recorded moment: the Moon's position, and therefore the whole translunar
   geometry, is a function of simTime. */
export const setSimTime = t => { simTime = t; };
export const getWarpIndex = () => warpIdx;
export const setWarpIndex = i => { warpIdx = i; };
export const getSasOn = () => sasOn;
export const getSasRetro = () => sasRetro;
export const setSas = (on, retro = false) => { sasOn = on; sasRetro = retro; };
export const getMaxQ = () => maxQ;
export const getDistFlown = () => distFlown;
export const addDistFlown = d => { distFlown += d; };
export const getTrail = () => trail;
export const pushTrail = p => { trail.push(p.clone()); if (trail.length > 400) trail.shift(); };

export function cycleWarp(delta) {
  if (delta > 0) warpIdx = Math.min(WARPS.length - 1, warpIdx + 1);
  else warpIdx = Math.max(0, warpIdx - 1);
  hooks.addLog(`TIME WARP ×${WARPS[warpIdx]}`);
}

export function toggleSas() {
  sasOn = !sasOn;
  hooks.addLog(`SAS ${sasOn ? (sasRetro ? 'RETROGRADE HOLD' : 'PROGRADE HOLD') : 'OFF'}`);
}
export function toggleSasRetro() {
  sasRetro = !sasRetro;
  if (sasOn) hooks.addLog(`SAS → ${sasRetro ? 'RETROGRADE' : 'PROGRADE'}`);
}

export function activeStage() { for (let i = 0; i < 3; i++) if (!stages[i].separated) return i; return -1; }
export function totalMass() { let m = CAPSULE_MASS; for (const st of stages) if (!st.separated) m += st.dry + st.fuel; return m; }   // tonnes
export function fwd() { return UP_REF.clone().applyQuaternion(S.q); }
export function isBurning() { const i = activeStage(); return engineOn && throttle > .01 && i >= 0 && stages[i].fuel > 0; }
export function airDensity(alt) { return alt > 420 ? 0 : RHO0 * Math.exp(-Math.max(0, alt) / ATMO_H); }
/* velocity relative to the rotating ground — what the telemetry and SAS actually care about */
export function surfaceVel(out = new THREE.Vector3()) {
  return out.copy(S.v).add(new THREE.Vector3(-EARTH_SPIN * S.pos.z, 0, EARTH_SPIN * S.pos.x));
}
/* Two velocity frames, because two bodies move under the vehicle.
   navVel    — what SAS and the prograde marker steer by: the inertial velocity near Earth (an
               orbit is inertial, and the ground-relative vector is ~0 at the pad — steering by
               it drags the trajectory out of its own launch plane), but the Moon-relative
               velocity inside the Moon's SOI, where the ground itself travels at 1.02 km/s and
               the inertial vector is not the velocity an engine is fighting.
   groundVel — velocity relative to the surface underneath: the co-rotating ground on Earth, the
               travelling Moon on the Moon. This is the speed the HUD reads and the speed a
               touchdown is judged by; judging contact by inertial speed would demand a vehicle
               standing still in the game frame, i.e. 1.02 km/s faster than the lunar surface. */
const _nv = new THREE.Vector3(), _mv = new THREE.Vector3(), _rad = new THREE.Vector3();
function overMoon() { moonPos(simTime, _moon); return S.pos.distanceTo(_moon) < SOI_M; }
export function navVel(out = new THREE.Vector3()) {
  if (overMoon()) { moonVel(simTime, _mv); return out.copy(S.v).sub(_mv); }
  return out.copy(S.v);
}
export function groundVel(out = new THREE.Vector3()) {
  if (overMoon()) { moonVel(simTime, _mv); return out.copy(S.v).sub(_mv); }
  return surfaceVel(out);
}
/* Unit "up" from whichever body is underneath — the attitude to hold when the velocity vector
   has no direction worth steering by (touchdown, hovering). */
export function bodyUp(out = new THREE.Vector3()) {
  if (overMoon()) return out.subVectors(S.pos, _moon).normalize();
  return out.copy(S.pos).normalize();
}

/* ---- moment of inertia from live mass distribution (build units, see vehicle.js) ---- */
const GEOM = [
  { L: 34, r: 6.2, zc: -20.5 },    // S-1 booster
  { L: 22, r: 5.2, zc: 7.5 },      // S-2 upper
  { L: 19, r: 4.4, zc: 24.5 },     // CSM service body + cone
  { L: 8,  r: 2.0, zc: 33.5 },     // capsule lump
];
function inertiaAxes() {
  let m = CAPSULE_MASS, mz = CAPSULE_MASS * GEOM[3].zc;
  for (let k = 0; k < 3; k++) if (!stages[k].separated) { const mk = stages[k].dry + stages[k].fuel; m += mk; mz += mk * GEOM[k].zc; }
  const zc = mz / m;
  let py = CAPSULE_MASS * ((GEOM[3].zc - zc) ** 2 + GEOM[3].L ** 2 / 12 + GEOM[3].r ** 2 / 4);
  let roll = CAPSULE_MASS * GEOM[3].r ** 2 / 2;
  for (let k = 0; k < 3; k++) if (!stages[k].separated) {
    const mk = stages[k].dry + stages[k].fuel, gm = GEOM[k];
    py += mk * ((gm.zc - zc) ** 2 + gm.L * gm.L / 12 + gm.r * gm.r / 4);
    roll += mk * gm.r * gm.r / 2;
  }
  return { py, roll };
}
export function getControlAuthority() { const I = inertiaAxes(); return { py: I0 ? I0.py / I.py : 1, roll: I0 ? I0.roll / I.roll : 1 }; }
const UP_Z = new THREE.Vector3(0, 0, 1);
const _ax = new THREE.Vector3(), _dq = new THREE.Quaternion();
const MAX_RATE_PY = 0.45, MAX_RATE_ROLL = 1.0;        // rad/s ceilings on body rates

export function toggleIgnite() {
  const i = activeStage();
  if (i < 0) { hooks.addLog('NO ENGINE LEFT — ALL STAGES SEPARATED', 'bad'); return; }
  if (stages[i].fuel <= 0) { hooks.addLog(`STAGE ${i + 1} DRY — PRESS X TO SEPARATE IT`, 'warn'); return; }
  if (i === 0 && engineOn) { hooks.addLog('SOLID BOOSTER BURNS AT FULL THROTTLE TO DEPLETION', 'warn'); return; }
  engineOn = !engineOn;
  if (engineOn) { targetThrottle = 1; throttle = Math.max(throttle, i === 0 ? 1 : 0.6); audio.engine(true); }
  else hooks.addLog('ENGINE FLAMEOUT');
}

export function separateStage() {
  if (state !== 'flying') return;
  const i = activeStage();
  if (i < 0) return;
  const st = stages[i];
  if (st.fuel > 1) hooks.addLog(`STAGE ${i + 1} SEPARATED WITH ${Math.round(st.fuel / SPECS[i].fuel * 100)}% PROPELLANT LEFT`, 'warn');
  else hooks.addLog(`STAGE ${i + 1} SEPARATED — ${SPECS[Math.min(i + 1, 2)].name} IS NOW FLYING`, 'good');
  st.separated = true; st.fuel = 0;
  const mesh = st.meshes;
  vehicleOps.detachStage(mesh, S.pos, S.q);
  const worldPos = S.pos.clone();
  const lat = new THREE.Vector3(1, 0, 0).applyQuaternion(S.q);
  vehicleOps.addDebris({ mesh, vel: S.v.clone().addScaledVector(lat, 0.03).addScaledVector(PAD_UP, -0.005),
    angVel: new THREE.Vector3(Math.random() * 0.6, Math.random() * 0.6, Math.random() * 0.6), age: 0 });
  for (let k = 0; k < 26; k++) vehicleOps.spawnParticle(worldPos,
    S.v.clone().addScaledVector(lat, 0.02 + Math.random() * 0.05).add(new THREE.Vector3().randomDirection().multiplyScalar(0.015)), 1.2 + Math.random(), [1, .8, .4]);
  audio.thud();
  engineOn = false; targetThrottle = 0; throttle = 0;
}

/* ---------------- physics ---------------- */
export function gravityAt(p, out, t = simTime) {
  out.copy(p).multiplyScalar(-MU_E / Math.pow(p.length(), 3));
  moonPos(t, _moon);
  _md.subVectors(p, _moon);
  out.addScaledVector(_md, -MU_M / Math.pow(_md.length(), 3));
  return out;
}
const _g = new THREE.Vector3(), _d = new THREE.Vector3(), _moon = new THREE.Vector3(), _md = new THREE.Vector3(), _sv = new THREE.Vector3(), _up = new THREE.Vector3();
const _spinQ = new THREE.Quaternion();
export function accelAt(p, v, mass, thrustAcc, t = simTime) {
  gravityAt(p, _d, t);
  const r = p.length(), alt = r - RE;
  if (alt < 420) {                                  // atmosphere rides on the planet's spin
    const vrel = _g.copy(v).add(new THREE.Vector3(-EARTH_SPIN * p.z, 0, EARTH_SPIN * p.x));   // ω(0,1,0) × r
    const rho = airDensity(alt);
    const vrelKms = vrel.length();
    const vrelMps = vrelKms * 1000;
    // a(km/s²) = ½·ρ(kg/m³)·A(m²)·v(km/s)² / mass(t)
    _d.addScaledVector(vrel, -0.5 * rho * CD_AREA * vrelKms / mass);
    const q = 0.5 * rho * vrelMps * vrelMps; if (q > maxQ && flightStarted) maxQ = q;
  } else _g.set(0, 0, 0);
  if (thrustAcc) _d.add(thrustAcc);
  return _d;
}

export function physStep(dt) {
  if (keys['shift']) targetThrottle = Math.min(1, targetThrottle + 0.6 * dt);
  if (keys['control']) targetThrottle = Math.max(0, targetThrottle - 0.6 * dt);
  const dThr = targetThrottle - throttle;
  throttle += THREE.MathUtils.clamp(dThr, -0.25 * dt, 0.25 * dt);

  if (state !== 'pad' && state !== 'flying') return;
  const i = activeStage();
  if (i === 0 && !stages[0].separated && engineOn) targetThrottle = 1;   // solid booster: full throttle or nothing
  if (!engineOn && targetThrottle > 0.05 && i >= 0 && stages[i].fuel > 0) {
    engineOn = true; audio.engine(true);        // raising the throttle lights the engine, KSP-style
  }
  const burning = engineOn && throttle > 0.01 && i >= 0 && stages[i].fuel > 0;
  let thrustAcc = null;
  // hold-down clamps: kN / t = m/s²
  simTime += dt;
  if (state === 'pad') {
    /* The vehicle is welded to LC-39, and LC-39 is a child of the spinning Earth mesh.
       While hold-down clamps the rocket it must ride the planet's rotation, otherwise the
       pad sweeps out from under it and the vehicle visibly slides off the mount. */
    if (i < 0 || !burning || SPECS[i].thrust * throttle / totalMass() <= 9.81) {
      _spinQ.setFromAxisAngle(SPIN_AXIS, EARTH_SPIN * dt);
      S.pos.applyQuaternion(_spinQ);
      S.q.premultiply(_spinQ);
      S.v.crossVectors(SPIN_AXIS, S.pos).multiplyScalar(EARTH_SPIN);
      omega.set(0, 0, 0);
      return;
    }
  }
  if (burning) {
    const sp = SPECS[i];
    stages[i].fuel = Math.max(0, stages[i].fuel - sp.thrust * throttle / (sp.isp * 9.81) * dt);   // t/s
    thrustAcc = fwd().multiplyScalar(sp.thrust * throttle / totalMass() / 1000);                  // km/s²
    if (stages[i].fuel === 0 && !loggedStageOut[i]) {
      loggedStageOut[i] = true; engineOn = false; targetThrottle = 0;
      if (i === 0) {                            // solid boosters shed themselves at burnout
        separateStage();                        // logs "STAGE 1 SEPARATED — S-2 SATURN II IS NOW FLYING"
        engineOn = true; targetThrottle = 1; throttle = 1;
        hooks.addLog('S-2 SATURN II IGNITES AUTOMATICALLY — TRIM WITH ⇧ / CTRL', 'good');
        audio.engine(true);
      } else hooks.addLog(`${sp.name} DEPLETED — PRESS X TO DROP IT`, 'warn');
    }
  }
  const mass = totalMass();
  const a = accelAt(S.pos, S.v, mass, thrustAcc);
  S.v.addScaledVector(a, dt);
  S.pos.addScaledVector(S.v, dt);

  // ---- true flight controls: keys command torque; ω integrates against live inertia ----
  const I = inertiaAxes();
  if (!I0) I0 = { py: I.py, roll: I.roll };
  const ratio = I0.py / I.py, ratioR = I0.roll / I.roll;
  const altE = S.pos.length() - RE;
  const surf = surfaceVel(_sv);        // the air moves with the planet: aero and prograde are ground-relative
  const surfMps = surf.length() * 1000;
  let qNorm = 0;
  if (altE < 420) qNorm = Math.min(1.6, 0.5 * airDensity(altE) * surfMps * surfMps / 40000);   // dynamic pressure, normalised
  const pitchIn = (keys['w'] ? 1 : 0) - (keys['s'] ? 1 : 0) + (keys['arrowup'] ? 1 : 0) - (keys['arrowdown'] ? 1 : 0);
  const yawIn = (keys['a'] ? 1 : 0) - (keys['d'] ? 1 : 0) + (keys['arrowleft'] ? 1 : 0) - (keys['arrowright'] ? 1 : 0);
  const rollIn = (keys['e'] ? 1 : 0) - (keys['q'] ? 1 : 0);
  const manual = pitchIn !== 0 || yawIn !== 0 || rollIn !== 0;
  omega.x += pitchIn * 0.12 * ratio * dt;                          // commanded angular acceleration
  omega.y += yawIn * 0.12 * ratio * dt;
  omega.z += rollIn * 0.25 * ratioR * dt;
  if (manual && sasOn) sasHoldTime = 0;                            // hands-on overrides SAS briefly

  if (sasOn && !manual) {                                          // SAS: rate servo toward the reference
    sasHoldTime = Math.min(6, sasHoldTime + dt);
    /* Below a few km the ground-relative velocity is a few m/s and is dominated by the
       attitude error itself, so chasing "prograde" is a self-reinforcing loop: the nose
       tips, the velocity tips with it, SAS chases it further. Real launch vehicles hold
       the local vertical until the gravity turn has something to work with. */
    /* Prograde SAS must be the *inertial* velocity vector. Ground-relative "prograde"
       is meaningless at liftoff (the pad is moving 408 m/s) and drags the trajectory
       out of the launch plane as the vehicle climbs out of the rotating atmosphere. */
    let dir;
    if (sasRetro) {
      dir = navVel(_nv);
      if (dir.lengthSq() < 2.5e-5) dir = bodyUp(_rad);      // terminal descent: no velocity vector worth fighting, hold the local vertical
      else dir.negate();
    }
    else if (simTime < TURN.t0) dir = _up.copy(S.pos);            // hold the local vertical
    else if (simTime < TURN.t0 + TURN.ramp) {                     // programmed gravity turn
      /* The nose is swept from vertical toward the launch-plane east direction, but never
         faster than the remaining radial acceleration allows: pitching over before the
         horizontal speed is near orbital just spends fuel holding the vehicle up, and the
         trajectory falls back. thMax is where the radial acceleration goes to zero. */
      const thProg = TURN.max * Math.min(1, (simTime - TURN.t0) / TURN.ramp);
      _up.copy(S.pos).normalize();
      const r = S.pos.length();
      const vRad = S.v.dot(_up);
      const vTan2 = S.v.lengthSq() - vRad * vRad;
      const tacc = thrustAcc ? thrustAcc.length() : 0;             // km/s²
      const radAcc = MU_E / (r * r) - vTan2 / r;                   // km/s²
      const thMax = tacc > 1e-3 ? Math.acos(THREE.MathUtils.clamp(radAcc / tacc, 0, 1)) : 0;
      const th = Math.min(thProg, thMax);
      _md.copy(PAD_EAST).addScaledVector(_up, -PAD_EAST.dot(_up)).normalize();
      dir = _up.clone().multiplyScalar(Math.cos(th)).addScaledVector(_md, Math.sin(th));
    } else dir = navVel(_md);
    if (dir.lengthSq() > 1e-4) {
      const tq = new THREE.Quaternion().setFromUnitVectors(UP_Z, dir.normalize());
      const errB = S.q.clone().invert().multiply(tq);              // pointing error in body frame
      if (errB.w < 0) errB.set(-errB.x, -errB.y, -errB.z, -errB.w);  // Quaternion has no multiplyScalar
      errB.normalize();
      const angle = 2 * Math.acos(THREE.MathUtils.clamp(errB.w, -1, 1));
      if (angle > 1e-3) {
        const axis = _ax.set(errB.x, errB.y, errB.z);
        if (axis.lengthSq() > 1e-9) axis.normalize(); else axis.set(1, 0, 0);
        const want = Math.min(0.85 * MAX_RATE_PY, 1.6 * angle);
        const k = Math.min(0.9, 1.2 * ratio * dt);
        omega.x += (axis.x * want - omega.x) * k;
        omega.y += (axis.y * want - omega.y) * k;
        omega.z += (axis.z * want - omega.z) * k;
      }
    }
  }

  // aerodynamics: fin damping opposes the rate; tail fins weathervane the nose into the flow
  const dpy = 0.6 * (1 + 2.6 * qNorm), drl = 0.25 * (1 + 2.6 * qNorm);
  omega.x *= Math.max(0, 1 - dpy * dt);
  omega.y *= Math.max(0, 1 - dpy * dt);
  omega.z *= Math.max(0, 1 - drl * dt);
  if (qNorm > 0.02 && surf.lengthSq() > 1e-8) {
    const vb = _g.copy(surf).applyQuaternion(S.q.clone().invert()).normalize();
    const ax = _ax.set(0, 0, 1).cross(vb);
    const m = ax.length();
    if (m > 1e-4) omega.addScaledVector(_ax.multiplyScalar(1 / m), 0.05 * qNorm * m * dt);
  }

  omega.x = THREE.MathUtils.clamp(omega.x, -MAX_RATE_PY, MAX_RATE_PY);
  omega.y = THREE.MathUtils.clamp(omega.y, -MAX_RATE_PY, MAX_RATE_PY);
  omega.z = THREE.MathUtils.clamp(omega.z, -MAX_RATE_ROLL, MAX_RATE_ROLL);
  if (omega.lengthSq() > 1e-12) {
    const rate = omega.length();
    S.q.multiply(_dq.setFromAxisAngle(_ax.copy(omega).multiplyScalar(1 / rate), rate * dt));
  }
  S.q.normalize();

  // liftoff bookkeeping
  if (!flightStarted) {
    const alt0 = S.pos.length() - RE;
    if (alt0 > (PAD_POS.length() - RE) + 0.15 && thrustAcc && thrustAcc.length() > 9.81e-3) {
      flightStarted = true; state = 'flying';
      hooks.addLog('LIFTOFF — THE TOWER CLEARS', 'good');
    }
  } else if (state === 'flying') {
    checkImpact(); checkMissionEvents();
  }
}

function checkImpact() {
  if (state !== 'flying') return;
  moonPos(simTime, _moon);
  const rM = S.pos.distanceTo(_moon);
  if (rM <= RM + RHALF) return impact(true, rM);
  if (S.pos.length() <= RE + RHALF) return impact(false, S.pos.length());
}
function impact(onMoon, dist) {
  const speed = groundVel(_nv).length();         // km/s, relative to the surface being hit
  const disp = speed * 1000;                    // m/s
  if (onMoon && speed <= LAND_SAFE) {
    state = 'won'; vehicleOps.setVisible(true);
    hooks.addLog(`TOUCHDOWN — ${disp.toFixed(1)} m/s. THE MOON IS OURS.`, 'good');
    audio.win();
    hooks.showEndOverlay('TOUCHDOWN ON THE MOON',
      `The CSM rests on the lunar surface at <b>${disp.toFixed(1)} m/s</b> after a ${fmtDuration(simTime)} mission, all three stages spent along the way. ${disp < 16 ? 'A textbook landing.' : 'Close to the soft-landing limit — push lower next time.'}`,
      'FLY AGAIN');
    return;
  }
  explode();
  if (onMoon) {
    state = 'lost';
    hooks.addLog(`HARD IMPACT ON THE MOON AT ${disp.toFixed(0)} m/s — MISSION LOST`, 'bad');
    hooks.showEndOverlay('MOON IMPACT', `The ${activeStage() === 2 ? 'CSM' : 'vehicle'} struck the lunar surface at ${disp.toFixed(0)} m/s. Land softer than 32 m/s — start the braking burn early, at the edge of the dashed sphere.`, 'RETRY');
  } else {
    if (speed <= SAFE_EARTH) {
      state = 'lost';
      hooks.addLog(`SPLASHDOWN — returned safely, but the Moon was the target`, 'warn');
      hooks.showEndOverlay('HOME AGAIN', `A safe splashdown back on Earth after ${fmtDuration(simTime)}. The Moon is still waiting — try a higher apoapsis next flight.`, 'RETRY');
    } else {
      state = 'lost';
      hooks.addLog(`IMPACT WITH EARTH AT ${disp.toFixed(0)} m/s — MISSION LOST`, 'bad');
      hooks.showEndOverlay('RE-ENTRY DISASTER', `The vehicle hit the atmosphere at ${disp.toFixed(0)} m/s. ${disp > 4000 ? 'Nothing survives that.' : 'Ease the descent — burn retrograde before the ground arrives.'}`, 'RETRY');
    }
  }
}
function explode() {
  const c = S.pos.clone();
  for (let k = 0; k < 240; k++) {
    const dir = new THREE.Vector3().randomDirection().multiplyScalar(0.02 + Math.random() * 0.09);
    vehicleOps.spawnParticle(c, dir.add(S.v.clone().multiplyScalar(.3)), 1.5 + Math.random() * 1.5, [1, .55 + Math.random() * .35, .2]);
  }
  vehicleOps.setVisible(false); audio.explosion();
}

function fmtDuration(s) {
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h} h ${m} min` : `${m} min ${Math.round(s % 60)} s`;
}

export function orbitalElements(rVec, v, mu, R_body) {
  const r = rVec.length();
  const E = v.lengthSq() / 2 - mu / r, h = _g.crossVectors(rVec, v).length();
  const e = Math.sqrt(Math.max(0, 1 + 2 * E * h * h / (mu * mu)));
  const a = -mu / (2 * E);
  const pe = a * (1 - e) - R_body;
  const ap = E >= 0 ? Infinity : a * (1 + e) - R_body;
  return { pe, ap, a, e, escape: E >= 0 };
}

function checkMissionEvents() {
  moonPos(simTime, _moon);
  const r = S.pos.length(), rM = S.pos.distanceTo(_moon);
  const dom = rM < SOI_M ? 'moon' : 'earth';
  if (dom === 'earth') {
    const el = orbitalElements(S.pos, S.v, MU_E, RE);
    if (!tliLogged && (el.ap >= MOON_DIST - SOI_M || el.escape)) { tliLogged = true; hooks.addLog('TRANSLUNAR INJECTION ACHIEVED — COAST TO THE MOON', 'good'); }
  } else if (!loiLogged) {
    loiLogged = true; hooks.addLog('LUNAR SPHERE OF INFLUENCE — PREPARE RETROGRADE BRAKING (V, then P, then ignite)', 'good');
  }
  if (!loggedMaxQ && maxQ > 30000) { loggedMaxQ = true; hooks.addLog('MAX-Q — EASE THE THROTTLE IF YOU LIKE THE PAINT'); }
  if (!turnHintLogged && r - RE > 120) {
    turnHintLogged = true;
    hooks.addLog('NOW PITCH TOWARD THE MOON (MAP) — OR PRESS P FOR PROGRADE SAS', 'good');
  }
}

/* ---------------- trajectory prediction ---------------- */
const PRED_MAX = 900;
const predGeo = new THREE.BufferGeometry();
const predPos = new Float32Array(PRED_MAX * 3), predCol = new Float32Array(PRED_MAX * 3);
predGeo.setAttribute('position', new THREE.BufferAttribute(predPos, 3));
predGeo.setAttribute('color', new THREE.BufferAttribute(predCol, 3));
predGeo.setDrawRange(0, 0);
export const predLine = new THREE.Line(predGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .75 }));

export function clearPredictor() { predGeo.setDrawRange(0, 0); }

export function predict() {
  const i = activeStage();
  const burning = engineOn && throttle > 0.01 && i >= 0 && stages[i].fuel > 0;
  const sp = burning ? SPECS[i] : null;
  let fuel = burning ? stages[i].fuel : 0;
  const p = S.pos.clone(), v = S.v.clone(), g = new THREE.Vector3(), m = new THREE.Vector3();
  let n = 0, impactType = null, impactT = 0;
  let t = simTime;
  for (let s = 0; s < 20000 && n < PRED_MAX - 1; s++) {
    const alt = Math.min(p.length() - RE, p.distanceTo(moonPos(t, m)) - RM);
    const speed = v.length();
    // keep the step short enough that the arc stays smooth, long enough to cover a multi-hour coast
    const dt = THREE.MathUtils.clamp(Math.min(alt, speed * 40, 3000) * 0.006, 0.2, 20);
    let mass = totalMass(), thAcc = null;
    if (sp && fuel > 0) {
      fuel = Math.max(0, fuel - sp.thrust * throttle / (sp.isp * 9.81) * dt);
      thAcc = fwd().multiplyScalar(sp.thrust * throttle / mass / 1000);
    }
    gravityAt(p, g, t);
    const altE = p.length() - RE;
    if (altE < 420) {
      const rho = airDensity(altE);
      g.addScaledVector(v, -0.5 * rho * CD_AREA * v.length() / mass);
    }
    if (thAcc) g.add(thAcc);
    v.addScaledVector(g, dt); p.addScaledVector(v, dt); t += dt;
    if (s % 6 === 0) {
      predPos.set([p.x, p.y, p.z], n * 3);
      predCol.set([0.30, 0.85, 0.5], n * 3); n++;
    }
    const rM = p.distanceTo(m);
    if (rM <= RM + RHALF) { impactType = 'moon'; impactT = t - simTime; break; }
    if (p.length() <= RE + RHALF) { impactType = 'earth'; impactT = t - simTime; break; }
    if (p.length() > 900000 || rM > 900000) break;
  }
  if (impactType && (impactT < 3000 || impactType === 'moon')) {
    predPos.set([p.x, p.y, p.z], n * 3); predCol.set([1, .22, .18], n * 3); n++;
    predPos.set([p.x, p.y, p.z], n * 3); predCol.set([1, .22, .18], n * 3); n++;
    const msg = `IMPACT PREDICTED: ${impactType === 'moon' ? 'MOON' : 'EARTH'} IN ${Math.round(impactT / 60)} min`;
    if (msg !== impactWarn) impactWarn = msg;
    hooks.setWarn(msg);
  } else { impactWarn = ''; hooks.setWarn(null); }
  predGeo.setDrawRange(0, n);
  predGeo.attributes.position.needsUpdate = predGeo.attributes.color.needsUpdate = true;
}

/* ---------------- mission reset (sim side) ---------------- */
export function resetSim() {
  stages.forEach((st, idx) => {
    st.separated = false; st.fuel = SPECS[idx].fuel; loggedStageOut[idx] = false;
  });
  S.pos.copy(PAD_POS); S.v.copy(PAD_ANGULAR); S.q.setFromUnitVectors(UP_REF, PAD_UP);
  engineOn = false; throttle = targetThrottle = 0;
  sasOn = false; sasRetro = false; simTime = 0; warpIdx = 0; maxQ = 0;
  tliLogged = loiLogged = loggedMaxQ = turnHintLogged = false; impactWarn = ''; distFlown = 0; trail = [];
  flightStarted = false; state = 'pad'; omega.set(0, 0, 0); I0 = null;
}

/* teleport() starts the flight directly, bypassing the liftoff guard */
export function markTeleported() { flightStarted = true; state = 'flying'; }
