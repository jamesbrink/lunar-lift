import * as THREE from 'three';
import { RE, MU_E, MOON, RM, MU_M, SOI_M, PAD_UP, PAD_POS, RHALF, ATMO_H, RHO0, CD_AREA, WARPS, VSCALE, TSCALE, LAND_SAFE_M, SAFE_EARTH, SPECS, CAPSULE_MASS } from './constants.js';

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
let state = 'briefing';        // briefing | pad | flying | won | lost
let engineOn = false, throttle = 0, targetThrottle = 0;
let sasOn = false, sasRetro = false, simTime = 0, warpIdx = 0;
let maxQ = 0, loggedStageOut = [false, false, false], flightStarted = false;
let tliLogged = false, loiLogged = false, impactWarn = '';
let turnHintLogged = false, loggedMaxQ = false;
export const S = { pos: PAD_POS.clone(), v: new THREE.Vector3(), q: new THREE.Quaternion() };
export const keys = Object.create(null);
let trail = [];
let distFlown = 0;
let sasHoldTime = 0;
let earthSpin = 0.004;

export const getState = () => state;
export const setState = v => { state = v; };
export const getEngineOn = () => engineOn;
export const getThrottle = () => throttle;
export const getTargetThrottle = () => targetThrottle;
export const setTargetThrottle = v => { targetThrottle = v; };
export const getSimTime = () => simTime;
export const getWarpIndex = () => warpIdx;
export const setWarpIndex = i => { warpIdx = i; };
export const getSasOn = () => sasOn;
export const getSasRetro = () => sasRetro;
export const setSas = (on, retro = false) => { sasOn = on; sasRetro = retro; };
export const getMaxQ = () => maxQ;
export const getDistFlown = () => distFlown;
export const addDistFlown = d => { distFlown += d; };
export const getTrail = () => trail;
export const pushTrail = p => { trail.push(p); if (trail.length > 90) trail.shift(); };

export function cycleWarp(delta) {
  if (delta > 0) { warpIdx = Math.min(WARPS.length - 1, warpIdx + 1); }
  else { warpIdx = Math.max(0, warpIdx - 1); }
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
export function totalMass() { let m = CAPSULE_MASS; for (const st of stages) if (!st.separated) m += st.dry + st.fuel; return m; }
export function fwd() { return new THREE.Vector3(0, 0, 1).applyQuaternion(S.q); }
export function isBurning() { const i = activeStage(); return engineOn && throttle > .01 && i >= 0 && stages[i].fuel > 0; }

export function toggleIgnite() {
  const i = activeStage();
  if (i < 0) { hooks.addLog('NO ENGINE LEFT — ALL STAGES SEPARATED', 'bad'); return; }
  if (stages[i].fuel <= 0) { hooks.addLog(`STAGE ${i + 1} DRY — PRESS X TO SEPARATE IT`, 'warn'); return; }
  engineOn = !engineOn;
  if (engineOn) { targetThrottle = Math.max(targetThrottle, 1); throttle = Math.max(throttle, 0.6); audio.engine(true); }
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
  vehicleOps.addDebris({ mesh, vel: S.v.clone().addScaledVector(lat, 7).addScaledVector(PAD_UP, -1),
    angVel: new THREE.Vector3(Math.random() * 1.5, Math.random() * 1.5, Math.random() * 1.5), age: 0 });
  for (let k = 0; k < 26; k++) vehicleOps.spawnParticle(worldPos,
    S.v.clone().addScaledVector(lat, 6 + Math.random() * 14).addScaledVector(new THREE.Vector3().randomDirection(), 5), 1.2 + Math.random(), [1, .8, .4]);
  audio.thud();
  engineOn = false; targetThrottle = 0; throttle = 0;
}

/* ---------------- physics ---------------- */
export function gravityAt(p, out) {
  out.copy(p).multiplyScalar(-MU_E / Math.pow(p.length(), 3));
  const d = new THREE.Vector3().subVectors(p, MOON);
  out.addScaledVector(d, -MU_M / Math.pow(d.length(), 3));
  return out;
}
const _g = new THREE.Vector3(), _d = new THREE.Vector3();
export function accelAt(p, v, mass, thrustAcc) {
  gravityAt(p, _d);
  const r = p.length(), alt = r - RE;
  if (alt < 420) {                                  // atmosphere rides on the Earth's spin axis
    const vrel = _g.copy(v).add(new THREE.Vector3(-earthSpin * p.y, earthSpin * p.x, 0));
    const rho = RHO0 * Math.exp(-Math.max(0, alt) / ATMO_H);
    const k = 0.5 * CD_AREA * rho * vrel.length() / mass;
    _d.addScaledVector(vrel, -k);
    const q = 0.5 * rho * vrel.lengthSq(); if (q > maxQ && flightStarted) maxQ = q;
  } else _g.set(0, 0, 0);
  if (thrustAcc) _d.add(thrustAcc);
  return _d;
}

export function physStep(dt) {
  if (keys['shift']) targetThrottle = Math.min(1, targetThrottle + 1.7 * dt);
  if (keys['control']) targetThrottle = Math.max(0, targetThrottle - 1.7 * dt);
  const dThr = targetThrottle - throttle;
  throttle += THREE.MathUtils.clamp(dThr, -2.6 * dt, 2.6 * dt);

  if (state !== 'pad' && state !== 'flying') return;
  const i = activeStage();
  if (!engineOn && targetThrottle > 0.05 && i >= 0 && stages[i].fuel > 0) {
    engineOn = true; audio.engine(true);        // raising the throttle lights the engine, KSP-style
  }
  const burning = engineOn && throttle > 0.01 && i >= 0 && stages[i].fuel > 0;
  let thrustAcc = null;
  if (state === 'pad' && (i < 0 || !burning || SPECS[i].thrust * throttle / totalMass() <= 9.81)) return;   // hold-down clamps
  if (burning) {
    const sp = SPECS[i];
    stages[i].fuel = Math.max(0, stages[i].fuel - sp.thrust * throttle / sp.isp * dt);
    thrustAcc = fwd().multiplyScalar(sp.thrust * throttle / totalMass());
    if (stages[i].fuel === 0 && !loggedStageOut[i]) {
      loggedStageOut[i] = true; engineOn = false; targetThrottle = 0;
      hooks.addLog(`${sp.name} DEPLETED — PRESS X TO DROP IT`, 'warn');
    }
  }
  const mass = totalMass();
  const a = accelAt(S.pos, S.v, mass, thrustAcc);
  S.v.addScaledVector(a, dt);
  S.pos.addScaledVector(S.v, dt);

  // steering (rates in rad/s)
  const steer = new THREE.Vector3(
    (keys['w'] ? 1 : 0) - (keys['s'] ? 1 : 0) + (keys['arrowup'] ? 1 : 0) - (keys['arrowdown'] ? 1 : 0),
    (keys['a'] ? 1 : 0) - (keys['d'] ? 1 : 0) + (keys['arrowleft'] ? 1 : 0) - (keys['arrowright'] ? 1 : 0),
    (keys['e'] ? 1 : 0) - (keys['q'] ? 1 : 0));
  steer.x *= 0.45; steer.y *= 0.35; steer.z *= 0.65;
  if (steer.lengthSq() > 0) {
    const ang = steer.length() * dt;
    S.q.multiply(new THREE.Quaternion().setFromAxisAngle(steer.normalize(), ang));
    if (sasOn) sasHoldTime = 0;                    // hands-on overrides SAS briefly
  } else if (sasOn) {
    sasHoldTime = Math.min(6, sasHoldTime + dt);
    const dir = sasRetro ? S.v.clone().negate() : S.v.clone();
    if (dir.lengthSq() > 1e-6) {
      const tq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize());
      S.q.slerp(tq, Math.min(1, 0.6 * dt));
    }
  }
  S.q.normalize();
  simTime += dt;

  // liftoff bookkeeping
  if (!flightStarted) {
    const alt0 = S.pos.length() - RE;
    if (alt0 > (PAD_POS.length() - RE) + 0.4 && thrustAcc && thrustAcc.length() > 9.81) {
      flightStarted = true; state = 'flying';
      hooks.addLog('LIFTOFF — THE TOWER CLEARS', 'good');
    }
  } else if (state === 'flying') {
    checkImpact(); checkMissionEvents();
  }
}

function checkImpact() {
  if (state !== 'flying') return;
  const rM = S.pos.distanceTo(MOON);
  if (rM <= RM + RHALF) return impact(true, rM);
  if (S.pos.length() <= RE + RHALF) return impact(false, S.pos.length());
}
function impact(onMoon, dist) {
  const speed = S.v.length();                    // both bodies are static in this sim
  const disp = speed * VSCALE;
  if (onMoon && speed <= LAND_SAFE_M) {
    state = 'won'; vehicleOps.setVisible(true);
    hooks.addLog(`TOUCHDOWN — ${disp.toFixed(1)} m/s. THE MOON IS OURS.`, 'good');
    audio.win();
    hooks.showEndOverlay('TOUCHDOWN ON THE MOON',
      `The CSM rests on the lunar surface at <b>${disp.toFixed(1)} m/s</b>, all three stages spent along the way. ${disp < 16 ? 'A textbook landing.' : 'Close to the soft-landing limit — push lower next time.'}`,
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
      hooks.showEndOverlay('HOME AGAIN', `A safe splashdown back on Earth. The Moon is still waiting — try a higher apoapsis next flight.`, 'RETRY');
    } else {
      state = 'lost';
      hooks.addLog(`IMPACT WITH EARTH AT ${disp.toFixed(0)} m/s — MISSION LOST`, 'bad');
      hooks.showEndOverlay('RE-ENTRY DISASTER', `The vehicle hit the atmosphere at ${disp.toFixed(0)} m/s. ${disp > 400 ? 'Nothing survives that.' : 'Ease the descent — burn retrograde before the ground arrives.'}`, 'RETRY');
    }
  }
}
function explode() {
  const c = S.pos.clone();
  for (let k = 0; k < 240; k++) {
    const dir = new THREE.Vector3().randomDirection().multiplyScalar(20 + Math.random() * 90);
    vehicleOps.spawnParticle(c, dir.add(S.v.clone().multiplyScalar(.3)), 1.5 + Math.random() * 1.5, [1, .55 + Math.random() * .35, .2]);
  }
  vehicleOps.setVisible(false); audio.explosion();
}

export function orbitalElements(rVec, v, mu, R_body) {
  const r = rVec.length();
  const E = v.lengthSq() / 2 - mu / r, h = _g.crossVectors(rVec, v).length();
  const e = Math.sqrt(Math.max(0, 1 + 2 * E * h * h / (mu * mu)));
  const a = -mu / (2 * E);
  const pe = a * (1 - e) - R_body;
  const ap = E >= 0 ? Infinity : a * (1 + e) - R_body;
  return { pe, ap, escape: E >= 0 };
}

function checkMissionEvents() {
  const r = S.pos.length(), rM = S.pos.distanceTo(MOON);
  const dom = rM < SOI_M ? 'moon' : 'earth';
  if (dom === 'earth') {
    const el = orbitalElements(S.pos, S.v, MU_E, RE);
    if (!tliLogged && (el.ap >= 12000 || el.escape)) { tliLogged = true; hooks.addLog('TRANSLUNAR INJECTION ACHIEVED — COAST TO THE MOON', 'good'); }
  } else if (!loiLogged) {
    loiLogged = true; hooks.addLog('LUNAR SPHERE OF INFLUENCE — PREPARE RETROGRADE BRAKING (V, then P, then ignite)', 'good');
  }
  if (!loggedMaxQ && maxQ > 8) { loggedMaxQ = true; hooks.addLog('MAX-Q — EASE THE THROTTLE IF YOU LIKE THE PAINT'); }
  if (!turnHintLogged && r - RE > 240) {
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
  const p = S.pos.clone(), v = S.v.clone(), g = new THREE.Vector3();
  let n = 0, impactType = null, impactT = 0;
  let t = 0;
  for (let s = 0; s < 9000 && n < PRED_MAX - 1; s++) {
    const alt = Math.min(p.length() - RE, p.distanceTo(MOON) - RM);
    const dt = THREE.MathUtils.clamp(Math.max(alt, 2) * 0.004, 0.03, 0.9);
    let mass = totalMass(), thAcc = null;
    if (sp && fuel > 0) { fuel = Math.max(0, fuel - sp.thrust * throttle / sp.isp * dt); thAcc = fwd().multiplyScalar(sp.thrust * throttle / mass); }
    gravityAt(p, g);
    const altE = p.length() - RE;
    if (altE < 420) {
      const rho = RHO0 * Math.exp(-Math.max(0, altE) / ATMO_H);
      const vr = v.length(); const k = 0.5 * CD_AREA * rho * vr / mass;
      g.addScaledVector(v, -k);
    }
    if (thAcc) g.add(thAcc);
    v.addScaledVector(g, dt); p.addScaledVector(v, dt); t += dt;
    if (s % 6 === 0) {
      predPos.set([p.x, p.y, p.z], n * 3);
      predCol.set([0.30, 0.85, 0.5], n * 3); n++;
    }
    const rM = p.distanceTo(MOON);
    if (rM <= RM + RHALF) { impactType = 'moon'; impactT = t; break; }
    if (p.length() <= RE + RHALF) { impactType = 'earth'; impactT = t; break; }
    if (p.length() > 60000 || rM > 60000) break;
  }
  if (impactType && (impactT < 400 || impactType === 'moon')) {
    predPos.set([p.x, p.y, p.z], n * 3); predCol.set([1, .22, .18], n * 3); n++;
    predPos.set([p.x, p.y, p.z], n * 3); predCol.set([1, .22, .18], n * 3); n++;
    const msg = `IMPACT PREDICTED: ${impactType === 'moon' ? 'MOON' : 'EARTH'} IN ${Math.round(impactT * TSCALE)} s`;
    if (msg !== impactWarn) { impactWarn = msg; }
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
  S.pos.copy(PAD_POS); S.v.set(0, 0, 0); S.q.identity();
  engineOn = false; throttle = targetThrottle = 0;
  sasOn = false; sasRetro = false; simTime = 0; warpIdx = 0; maxQ = 0;
  tliLogged = loiLogged = loggedMaxQ = turnHintLogged = false; impactWarn = ''; distFlown = 0; trail = [];
  flightStarted = false; state = 'pad';
}

/* teleport() starts the flight directly, bypassing the liftoff guard */
export function markTeleported() { flightStarted = true; state = 'flying'; }
