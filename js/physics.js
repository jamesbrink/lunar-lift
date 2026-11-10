import * as THREE from 'three';
import { airDensity, aeroForce, aeroState, ATMO_TOP, CN_BODY, machDrag, soundSpeed } from './aero.js';
import { padHit, ARM_TIME } from './colliders.js';
import { RE, MU_E, RM, MU_M, SOI_M, PAD_UP, PAD_POS, PAD_ANGULAR, VS, CD_AREA, WARPS, LAND_SAFE, SAFE_EARTH, SPECS, CAPSULE_MASS, EARTH_SPIN, SPIN_AXIS, PAD_EAST, MOON_DIST, TURN, moonPos, moonVel } from './constants.js';

/* ---------------- injected dependencies (see initPhysics) ----------------
   hooks:      addLog(msg, cls), showEndOverlay(title, body, btn)
   audio:      engine(on), thud(), explosion(), win()
   vehicleOps: spawnParticle(pos, vel, life, color), addDebris(entry), detachStage(mesh, pos, quat), setVisible(visible)
   stages:     the stage records built by vehicle.js (fuel / separated live here, in the sim)
   relief:     optional terrain height lookups, so contact happens on the ground that is drawn
*/
let stages = null;
let hooks = null, audio = null, vehicleOps = null, relief = null;
export function initPhysics(deps) {
  stages = deps.stages;
  hooks = deps.hooks; audio = deps.audio; vehicleOps = deps.vehicleOps;
  relief = deps.relief || null;      // { earth(dir), moon(dir) } → km of terrain above the datum sphere; none headless
}

/* ---------------- state ---------------- */
let state = 'pad';               // pad | flying | won | lost
let engineOn = false, throttle = 0, targetThrottle = 0;
let sasOn = false, sasRetro = false, simTime = 0, warpIdx = 0;
let maxQ = 0, loggedStageOut = [false, false, false], flightStarted = false;
let tliLogged = false, loiLogged = false;
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
let rcsAssist = true, aeroLoad = 0;
/* What the touchdown was, for the debrief: m/s, degrees from vertical, tonnes left, seconds. */
export const landing = { speed: 0, tilt: 0, fuel: 0, time: 0, home: false, flyby: false };
/* Lateral aerodynamic load the airframe survives, in g. Set against the measured nominal ascent
   (see docs/reference/atmosphere.md): the stack is a pressure-stabilised tank and folds early. */
export const LOAD_LIMIT_STACK = 0.5, LOAD_LIMIT_CSM = 6;
export const getAeroLoad = () => aeroLoad;
export const getRcsAssist = () => rcsAssist;
export function toggleRcsAssist() { rcsAssist = !rcsAssist; hooks.addLog(`RCS STABILITY ASSIST ${rcsAssist ? 'ON' : 'OFF — ROTATION IS NOW UNDAMPED'}`); }

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
export const setSas = (on, retro = false) => { sasOn = on; sasRetro = retro; if (on) holdOn = false; };
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

/* Attitude hold: stop every rotation and keep the nose where it is. The same rate servo as SAS,
   aimed at a remembered attitude instead of the velocity vector; steering by hand moves the
   remembered attitude with you, so letting go of the keys is what stops the ship. */
let holdOn = false;
const holdQ = new THREE.Quaternion();
export const getHold = () => holdOn;
export function toggleHold() {
  holdOn = !holdOn;
  if (holdOn) { sasOn = false; holdQ.copy(S.q); }
  hooks.addLog(holdOn ? 'ATTITUDE HOLD — ROTATION STOPPED' : 'ATTITUDE HOLD OFF');
}

export function toggleSas() {
  sasOn = !sasOn; if (sasOn) holdOn = false;
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
export { airDensity, aeroState };
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

/* ---- contact geometry ----
   S.pos is the middle of the FULL stack, and stays there after staging, so "the vehicle has reached
   the ground" cannot be a test on S.pos: it used to be `r <= R + 37 u`, which lands a full stack
   on its engine bells and leaves a lone CSM — whose tail is 6.8 u ABOVE S.pos — hanging 61 m over
   the Moon at the moment it is judged to have touched down. Contact is the lowest attached point
   meeting the terrain underneath. Stations are js/saturn.js's, in build units. */
const TAIL_Z = [-42, -11.8, 6.8], CM_TAIL_Z = 26.0, NOSE_Z = 28.7;   // 26.0: the heat shield's face
const _cu = new THREE.Vector3();
export function tailStation() { const i = activeStage(); return i >= 0 ? TAIL_Z[i] : CM_TAIL_Z; }
/* km from the lowest attached point down to the surface of the Moon (onMoon) or the Earth. */
export function surfaceAlt(onMoon = overMoon()) {
  if (onMoon) { moonPos(simTime, _moon); _cu.subVectors(S.pos, _moon); } else _cu.copy(S.pos);
  const r = _cu.length(); _cu.multiplyScalar(1 / r);
  const c = _fw.copy(UP_REF).applyQuaternion(S.q).dot(_cu);          // cos of the tilt from vertical
  const i = activeStage(), rad = i < 0 ? 1.33 : i === 2 ? 2.2 : 3.57;
  const low = (Math.min(tailStation() * c, NOSE_Z * c) - rad * Math.sqrt(Math.max(0, 1 - c * c))) * VS;   // lowest point of a tilted cylinder, km above S.pos
  const sphere = r - (onMoon ? RM : RE) + low;
  if (!relief || sphere > 30) return sphere;                         // no relief lookup while it cannot matter
  return sphere - (onMoon ? relief.moon(_cu) : relief.earth(_cu));
}

/* ---- mass and aerodynamic geometry of the hardware still attached ----
   One table for both, in build units along the vehicle axis (1 u = 1.4 m; js/saturn.js draws the
   same stations: S-1 tail at z −42, S-2 tail −11.8, CSM tail 6.8, apex 28.7). L and r are each
   segment's length and radius, zc its middle. */
const GEOM = [
  { L: 30.2, r: 3.57, zc: -26.9 },   // S-1 booster: 42 m long, 10 m across
  { L: 18.6, r: 3.57, zc: -2.5 },    // S-2 upper
  { L: 15.9, r: 2.2,  zc: 14.75 },   // CSM service body + adapter
  { L: 6,    r: 1.4,  zc: 25.7 },    // command module
];
const U_M = 1.4;                                       // metres per build unit
const FIN_AREA = 20, FIN_Z = -38;                      // m² of effective fin planform per plane, and its station
const BLUNT_CA = 1.1;                                  // a capsule alone flies as a blunt body
const CA_STACK = CD_AREA / (Math.PI * (GEOM[0].r * U_M) ** 2);   // so the full stack nose-on is CD_AREA
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
  return { py, roll, zc };                             // t·u², t·u², u
}
/* Reference area, planform and its centroid, fins — for whatever is still bolted on. `jA` is the
   planform's second moment about the station z0 (m⁴), which is what pitch damping scales with. */
const _shape = { aRef: 0, ca: CA_STACK, aPlan: 0, zPlan: 0, aFin: 0, zFin: FIN_Z };
function aeroShape() {
  let rMax = GEOM[3].r, aPlan = 0, az = 0;
  for (let k = 0; k < 4; k++) if (k === 3 || !stages[k].separated) {
    const g = GEOM[k], a = g.L * 2 * g.r;
    aPlan += a; az += a * g.zc; rMax = Math.max(rMax, g.r);
  }
  const bare = activeStage() < 0;
  _shape.aRef = Math.PI * (rMax * U_M) ** 2;
  _shape.ca = bare ? BLUNT_CA : CA_STACK;
  _shape.aPlan = aPlan * U_M * U_M; _shape.zPlan = az / aPlan;
  _shape.aFin = bare ? 3 : stages[0].separated ? 0 : FIN_AREA;      // a blunt cone trails its apex: a 'fin' AHEAD of the CG
  _shape.zFin = bare ? NOSE_Z : FIN_Z;
  return _shape;
}
function planformMoment(z0) {
  let j = 0;
  for (let k = 0; k < 4; k++) if (k === 3 || !stages[k].separated) {
    const g = GEOM[k]; j += g.L * 2 * g.r * ((g.zc - z0) ** 2 + g.L * g.L / 12);
  }
  return j * U_M ** 4;
}
/* Static margin in metres: how far the centre of pressure sits BEHIND the centre of mass for a
   small angle of attack. Positive weathervanes; negative diverges. Moves forward-heavy as tanks drain. */
export function stability() {
  const sh = aeroShape(), I = inertiaAxes();
  const nb = CN_BODY * sh.aRef, nf = 3 * sh.aFin;
  return nb + nf > 0 ? -((nb * (sh.zPlan - I.zc) + nf * (sh.zFin - I.zc)) / (nb + nf)) * U_M : 0;
}
export function getControlAuthority() { const I = inertiaAxes(); return { py: I0 ? I0.py / I.py : 1, roll: I0 ? I0.roll / I.roll : 1 }; }
const UP_Z = new THREE.Vector3(0, 0, 1);
const _ax = new THREE.Vector3(), _dq = new THREE.Quaternion();
const MAX_RATE_PY = 0.45, MAX_RATE_ROLL = 1.0;        // rad/s ceilings on body rates

/* ---------------- the command module alone: heat shield and parachutes ----------------
   Once every stage is gone (X on the CSM) what flies is a 10 t blunt cone, and coming home is its
   own piece of flying:
     heat    the proxy is sqrt(rho)·v³ (rho kg/m³, v km/s — the shape of stagnation heating).
             Above HEAT_SHIELD only a heat shield survives it, and only shield-first: anything
             still wearing a stage, or a capsule flying nose-first, cooks in HEAT_TIME seconds.
             A bare capsule is aerodynamically stable shield-first (aeroShape gives it a forward
             'fin') and rights itself in time from orbital speed; from lunar-return speed the
             heat arrives before the air has turned it (measured: burned up 23 s after interface
             at 11 km/s), so retrograde has to be held BEFORE the atmosphere.
     chutes  G deploys the drogues, G again the mains. Each has a dynamic pressure it tears at, so
             the order and the timing are the pilot's: drogues once q is under 20 kPa, mains once
             the drogues have you under 4 kPa. Mains set the capsule down at about 8 m/s; the
             splashdown limit is SAFE_EARTH. */
export const HEAT_SHIELD = 4, HEAT_TIME = 3;
export const CHUTE = { drogue: { area: 30, tear: 20000, mach: 1.5 }, mains: { area: 2300, tear: 4000, mach: 0.5 } };   // CdA m², q Pa
/* What a crew survives: G_LIMIT sustained for G_TIME. Sets the floor of the entry corridor — come
   in too steep and the air stops you faster than people can take; too shallow and you skip out. */
export const G_LIMIT = 16, G_TIME = 2;
let gLoad = 0, gOver = 0;
export const getG = () => gLoad;
/* Swing arms: 0 across the stack, 1 swung clear. They start to move at ignition and take
   ARM_TIME; until they are most of the way round they are solid (js/colliders.js). */
let armSwing = 0;
/* Mission time at which the hold-down let go. The pitch program runs on time SINCE then: waiting
   on the pad is how the launch window is moved, and a program on the mission clock tipped a
   late launch into the swing arms half a second after ignition. */
let tRelease = null;
export const getArmSwing = () => armSwing;
let chute = 0, chuteOpen = 0, heat = 0, cooking = 0;       // chute: 0 stowed, 1 drogue, 2 mains, -1 torn
export const getChute = () => chute;
export const getChuteOpen = () => chuteOpen;               // 0..1 inflation of the current canopy
export const getHeat = () => heat;                         // the proxy, live
export const getCooking = () => cooking / HEAT_TIME;       // 0 fine … 1 gone
export const isCapsule = () => activeStage() < 0;
export function deployChute() {
  if (state !== 'flying') return;
  if (!isCapsule()) { hooks.addLog('PARACHUTES ARE ON THE COMMAND MODULE — DROP THE CSM FIRST (X)', 'warn'); return; }
  if (chute < 0) { hooks.addLog('PARACHUTES ARE GONE', 'bad'); return; }
  if (chute >= 2) return;
  if (aeroState.q < 20) { hooks.addLog('NO AIR TO OPEN A PARACHUTE IN', 'warn'); return; }
  const next = chute === 0 ? CHUTE.drogue : CHUTE.mains;
  const what = chute === 0 ? 'DROGUES' : 'MAIN PARACHUTES';
  /* Three ways to lose a canopy on the way out: too much dynamic pressure, too fast for fabric to
     inflate at all (q alone lets a drogue out at 10 km/s in thin air), or into the entry plasma. */
  const why = aeroState.q > next.tear ? `${(aeroState.q / 1000).toFixed(1)} kPa, LIMIT ${next.tear / 1000} kPa`
    : aeroState.mach > next.mach ? `MACH ${aeroState.mach.toFixed(1)}, LIMIT ${next.mach}`
    : heat > 0.5 ? 'BURNED AWAY IN THE ENTRY HEAT' : '';
  if (why) {
    chute = -1; chuteOpen = 0;
    hooks.addLog(`${what} LOST — ${why}`, 'bad');
    audio.thud(); return;
  }
  chute++; chuteOpen = 0;
  hooks.addLog(chute === 1 ? 'DROGUE CHUTES OUT' : 'MAIN PARACHUTES OUT', 'good');
  audio.thud();
}

export function toggleIgnite() {
  const i = activeStage();
  if (i < 0) { hooks.addLog('NO ENGINE LEFT — ALL STAGES SEPARATED', 'bad'); return; }
  if (stages[i].fuel <= 0) { hooks.addLog(`STAGE ${i + 1} DRY — PRESS X TO SEPARATE IT`, 'warn'); return; }
  if (i === 0 && engineOn) { hooks.addLog('SOLID BOOSTER BURNS AT FULL THROTTLE TO DEPLETION', 'warn'); return; }
  engineOn = !engineOn;
  if (engineOn) { targetThrottle = 1; throttle = Math.max(throttle, i === 0 ? 1 : 0.6); audio.engine(true); }
  else { targetThrottle = 0; throttle = 0; hooks.addLog('ENGINE SHUT DOWN'); }   // or the throttle setting relights it next step
}

/* Launch escape tower. SP-4029's Apollo 11 timeline puts the jettison at GET 000:03:17.9, high above
   the atmosphere; this keys on altitude instead of the clock so it stays correct under time warp and
   whatever throttle line the player flies. It waits for the S-IC to be gone, because the tower stops
   being useful only once the stage it was covering has fallen away.
   Deliberately visual: no mass is shed. SPECS is quoted ground truth in docs/reference/spacecraft.md
   and the tower is ~0.14% of the stack, so moving it would perturb the certified mission for nothing. */
export const LES_ALT = 90;                                      // km, Apollo 11 jettison is near 95 km
let lesSeparated = false;
export const isLESGone = () => lesSeparated;

export function separateLES() {
  if (state !== 'flying' || lesSeparated || !stages[0].separated || !vehicleOps.les) return;
  lesSeparated = true;
  const worldPos = S.pos.clone();
  const up = fwd();
  vehicleOps.detachStage(vehicleOps.les, S.pos, S.q);
  vehicleOps.addDebris({ mesh: vehicleOps.les, vel: S.v.clone().addScaledVector(up, 0.012),
    angVel: new THREE.Vector3(0.5, 0.15, 0.15), age: 0 });
  for (let k = 0; k < 16; k++) vehicleOps.spawnParticle(worldPos,
    S.v.clone().addScaledVector(up, 0.008 + Math.random() * 0.03)
      .add(new THREE.Vector3().randomDirection().multiplyScalar(0.012)), 0.5 + Math.random() * 0.5, [0.92, 0.93, 0.98], 7 + Math.random() * 6, 1);
  hooks.addLog('LAUNCH ESCAPE TOWER JETTISONED', 'good');
  audio.thud();
}

export function separateStage() {
  if (state !== 'flying') return;
  const i = activeStage();
  if (i < 0) return;
  const st = stages[i];
  if (st.fuel > 1 && i < 2) hooks.addLog(`STAGE ${i + 1} SEPARATED WITH ${Math.round(st.fuel / SPECS[i].fuel * 100)}% PROPELLANT LEFT`, 'warn');
  else hooks.addLog(i === 2 ? 'CSM DROPPED — THE COMMAND MODULE FLIES ALONE' : `STAGE ${i + 1} SEPARATED — ${SPECS[i + 1].name} IS NOW FLYING`, 'good');
  st.separated = true; st.fuel = 0;
  const mesh = st.meshes;
  vehicleOps.detachStage(mesh, S.pos, S.q);
  const worldPos = S.pos.clone();
  const lat = new THREE.Vector3(1, 0, 0).applyQuaternion(S.q);
  vehicleOps.addDebris({ mesh, vel: S.v.clone().addScaledVector(lat, 0.03).addScaledVector(PAD_UP, -0.005),
    angVel: new THREE.Vector3(Math.random() * 0.6, Math.random() * 0.6, Math.random() * 0.6), age: 0, trail: 1 });
  for (let k = 0; k < 26; k++) vehicleOps.spawnParticle(worldPos,
    S.v.clone().addScaledVector(lat, 0.02 + Math.random() * 0.05).add(new THREE.Vector3().randomDirection().multiplyScalar(0.015)), 0.6 + Math.random() * 0.5, [1, .8, .4], 10 + Math.random() * 8, 0);
  /* The 26 soft puffs alone read as "a single small soft white ellipse, no debris or spark"
     (review2/14). A real separation event also throws hot hardware: 9 spark parcels — smoke = 0
     so they draw additive like the explosion's sparks, 2 m at birth, 1.4–2.0 s — spread radially
     in the separation PLANE (⊥ the stack axis: `lat` and axis×lat are an orthonormal pair there)
     at 20–50 m/s, the range the CSM's push-off motors + spring blowout actually clears the
     interstage ring by. */
  {
    const axis = fwd();
    const e2 = new THREE.Vector3().crossVectors(axis, lat);
    for (let k = 0; k < 9; k++) {
      const th = Math.random() * Math.PI * 2;
      const spd = 0.02 + Math.random() * 0.03;
      vehicleOps.spawnParticle(worldPos,
        S.v.clone().addScaledVector(lat, Math.cos(th) * spd).addScaledVector(e2, Math.sin(th) * spd),
        1.4 + Math.random() * 0.6, [1, .95, .85], 2, 0);
    }
  }
  audio.thud();
  engineOn = false; targetThrottle = 0; throttle = 0;
}

/* ---------------- physics ---------------- */
export function gravityAt(p, out, t = simTime) {
  out.copy(p).multiplyScalar(-MU_E / Math.pow(p.length(), 3));
  moonPos(t, _moon);
  _md.subVectors(p, _moon);
  out.addScaledVector(_md, -MU_M / Math.pow(_md.length(), 3));
  /* The frame is Earth-centred, and the Earth is itself falling toward the Moon at MU_M/d² =
     3.3e-5 m/s². A frame that accelerates owes its contents the opposite of that — the indirect
     term of the three-body problem. Without it the Earth is nailed to the origin and only the
     ship feels the Moon, which is not Newton's third law. */
  out.addScaledVector(_moon, -MU_M / Math.pow(_moon.length(), 3));
  return out;
}
const _g = new THREE.Vector3(), _d = new THREE.Vector3(), _moon = new THREE.Vector3(), _md = new THREE.Vector3(), _sv = new THREE.Vector3(), _up = new THREE.Vector3();
const _spinQ = new THREE.Quaternion(), _fw = new THREE.Vector3(), _tq = new THREE.Vector3(), _qi = new THREE.Quaternion();
const _aero = new THREE.Vector3();
/* Nose-on drag of the hardware now attached, as an acceleration added to `out` — for anything that
   predicts a coast (js/targeting.js) and must not disturb the live aero readout. */
export function coastDrag(out, p, v, mass = totalMass()) {
  const alt = p.length() - RE;
  if (alt >= ATMO_TOP) return out;
  const vx = v.x - EARTH_SPIN * p.z, vy = v.y, vz = v.z + EARTH_SPIN * p.x, sp = Math.hypot(vx, vy, vz);
  const sh = aeroShape(), k = -0.5 * airDensity(alt) * sh.aRef * sh.ca * machDrag(sp / soundSpeed(alt)) * sp / mass;
  out.x += vx * k; out.y += vy * k; out.z += vz * k;
  return out;
}
/* `axis` is the unit nose vector of the thing being accelerated; without one (debris) the air
   sees a tumbling lump and only drags it. */
export function accelAt(p, v, mass, thrustAcc, t = simTime, axis = null) {
  gravityAt(p, _d, t);
  const alt = p.length() - RE;
  if (alt < ATMO_TOP) {                             // atmosphere rides on the planet's spin
    const vrel = _g.set(v.x - EARTH_SPIN * p.z, v.y, v.z + EARTH_SPIN * p.x);   // v − ω(0,1,0) × r
    aeroForce(_aero, vrel, alt, axis, axis ? aeroShape() : null);
    _d.addScaledVector(_aero, 1 / mass);
    if (axis && aeroState.q > maxQ && flightStarted) maxQ = aeroState.q;
  } else if (axis) aeroForce(_aero, _g.set(0, 0, 0), alt, axis, null);   // zeroes the readout
  if (thrustAcc) _d.add(thrustAcc);
  return _d;
}

export function physStep(dt) {
  if (keys['shift']) targetThrottle = Math.min(1, targetThrottle + 0.6 * dt);
  if (keys['control']) targetThrottle = Math.max(0, targetThrottle - 0.6 * dt);
  if (engineOn && stages && !stages[0].separated && (state === 'pad' || state === 'flying')) targetThrottle = 1;   // a solid has no throttle
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
  if (engineOn || flightStarted) armSwing = Math.min(1, armSwing + dt / ARM_TIME);
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
  if (tRelease === null) tRelease = simTime - dt;
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
  const a = accelAt(S.pos, S.v, mass, thrustAcc, simTime, _fw.copy(UP_REF).applyQuaternion(S.q));
  S.v.addScaledVector(a, dt);
  const altNow = S.pos.length() - RE;
  if (altNow < 150) {
    const air = _sv.set(-EARTH_SPIN * S.pos.z, 0, EARTH_SPIN * S.pos.x).negate();     // the air's own velocity
    const vr = _g.copy(S.v).sub(air), sp = vr.length(), rho = airDensity(altNow);
    if (chute > 0) {
      /* A canopy is stiff: mains at 70 m/s relax the airspeed at 14/s, and an explicit step of
         0.1 s overshoots through zero. Solved implicitly instead — dv/dt = −k·v² over the step is
         v/(1 + k·v·dt) exactly — so it is stable at any warp. Inflation takes 2.5 s. */
      chuteOpen = Math.min(1, chuteOpen + dt / 2.5);
      const c = chute === 1 ? CHUTE.drogue : CHUTE.mains;
      const k = 0.5 * rho * (c.area * chuteOpen + (chute === 2 ? CHUTE.drogue.area * (1 - chuteOpen) : 0)) / mass;
      vr.multiplyScalar(1 / (1 + k * sp * dt));
      S.v.copy(air).add(vr);
      if (aeroState.q > 1.4 * c.tear) {
        chute = -1; chuteOpen = 0;
        hooks.addLog('PARACHUTES TORN AWAY BY THE AIRSTREAM', 'bad'); audio.thud();
      }
    }
    /* Felt acceleration: everything but gravity. Air on the hull plus the canopy's pull. */
    gLoad = (_aero.length() / mass + Math.abs(sp - vr.length()) / dt) * 1000 / 9.81;
    gOver = gLoad > G_LIMIT ? gOver + dt : Math.max(0, gOver - dt);
    if (gOver >= G_TIME && state === 'flying' && !thrustAcc) { S.pos.addScaledVector(S.v, dt); return crushed(); }
    heat = Math.sqrt(rho) * sp * sp * sp;
    const shielded = i < 0 && _fw.dot(vr) < -0.6 * sp;             // capsule, apex trailing
    cooking = heat > HEAT_SHIELD && !shielded ? cooking + dt : Math.max(0, cooking - dt);
    if (cooking >= HEAT_TIME && state === 'flying') { S.pos.addScaledVector(S.v, dt); return burnUp(i < 0); }
  } else { heat = 0; cooking = 0; gLoad = 0; gOver = 0; }
  S.pos.addScaledVector(S.v, dt);

  // ---- true flight controls: keys command torque; ω integrates against live inertia ----
  const I = inertiaAxes();
  if (!I0) I0 = { py: I.py, roll: I.roll };
  const ratio = I0.py / I.py, ratioR = I0.roll / I.roll;
  const altE = S.pos.length() - RE;
  if (!lesSeparated && altE > LES_ALT) separateLES();
  const pitchIn = (keys['w'] ? 1 : 0) - (keys['s'] ? 1 : 0);          // the arrow keys belong to the camera
  const yawIn = (keys['a'] ? 1 : 0) - (keys['d'] ? 1 : 0);
  const rollIn = (keys['e'] ? 1 : 0) - (keys['q'] ? 1 : 0);
  const manual = pitchIn !== 0 || yawIn !== 0 || rollIn !== 0;
  omega.x += pitchIn * 0.12 * ratio * dt;                          // commanded angular acceleration
  omega.y += yawIn * 0.12 * ratio * dt;
  omega.z += rollIn * 0.25 * ratioR * dt;
  if (manual && sasOn) sasHoldTime = 0;                            // hands-on overrides SAS briefly

  if (chute > 0 && aeroState.q > 5) {                              // the canopy hauls the apex round to trail
    const vs = surfaceVel(_nv);
    if (vs.lengthSq() > 1e-10) servo(_sq.setFromUnitVectors(UP_Z, vs.normalize().negate()), Math.min(ratio, 20), dt);
  }
  const hung = chute > 0 && aeroState.q > 5;                       // under a canopy the canopy steers, not SAS
  if (holdOn && manual) holdQ.copy(S.q);
  if (holdOn && !manual && !hung) servo(holdQ, ratio, dt);
  if (sasOn && !manual && !hung) {                                          // SAS: rate servo toward the reference
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
      /* In the air the velocity that matters is over the ground (inertial is 409 m/s of planet
         spin under a parachute); under 10 m/s there is no vector worth fighting — and nothing
         the servo below will act on — so hold the local vertical. */
      dir = !overMoon() && S.pos.length() - RE < 120 ? surfaceVel(_nv) : navVel(_nv);
      if (dir.lengthSq() < 1e-4) dir = bodyUp(_rad);
      else dir.negate();
    }
    else if (simTime - tRelease < TURN.t0) dir = _up.copy(S.pos);            // hold the local vertical
    else if (simTime - tRelease < TURN.t0 + TURN.ramp) {                     // programmed gravity turn
      /* The nose is swept from vertical toward the launch-plane east direction, but never
         faster than the remaining radial acceleration allows: pitching over before the
         horizontal speed is near orbital just spends fuel holding the vehicle up, and the
         trajectory falls back. thMax is where the radial acceleration goes to zero. */
      const thProg = TURN.max * Math.min(1, (simTime - tRelease - TURN.t0) / TURN.ramp);
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
    if (dir.lengthSq() > 1e-4) servo(_sq.setFromUnitVectors(UP_Z, dir.normalize()), ratio, dt);
  }

  /* Rates. In vacuum nothing stops a rotation but a thruster, so the only damping there is the
     RCS stability assist — a control system, on by default, that T switches off for a vehicle
     that keeps whatever spin it was given. */
  if (rcsAssist) {
    omega.x *= Math.max(0, 1 - 0.6 * dt);
    omega.y *= Math.max(0, 1 - 0.6 * dt);
    omega.z *= Math.max(0, 1 - 0.25 * dt);
  }
  /* In air the normal force (already in the trajectory, via accelAt above) also has a moment about
     the centre of mass: body terms at the planform centroid, fins at the tail. kN·m over t·m² is
     rad/s². Rotation in a cross-flow is resisted in proportion to q/V times the planform's second
     moment — the pitch damping of a slender body. */
  if (aeroState.q > 0.5) {
    const Ipy = I.py * U_M * U_M;                                  // t·m²
    const armB = (_shape.zPlan - I.zc) * U_M, armF = (_shape.zFin - I.zc) * U_M;   // m, + is ahead of the CG
    const moment = (aeroState.nBody * armB + aeroState.nFin * armF) * 1000;          // kN·m
    _tq.crossVectors(_fw, aeroState.dir).applyQuaternion(_qi.copy(S.q).invert());    // body frame
    const acc = THREE.MathUtils.clamp(moment / Ipy, -2, 2);
    omega.x += _tq.x * acc * dt; omega.y += _tq.y * acc * dt;
    const vAir = Math.max(30, aeroState.mach * 300);                // m/s
    const damp = aeroState.q * CN_BODY * planformMoment(I.zc) / (vAir * Ipy * 1000);   // 1/s
    omega.x *= Math.max(0, 1 - damp * dt);
    omega.y *= Math.max(0, 1 - damp * dt);
    /* Bending. The normal force is carried by the airframe as a side load; a stack is a thin tank
       wall and a bare CSM is not. */
    aeroLoad = (aeroState.nBody + aeroState.nFin) * 1000 / mass / 9.81;   // lateral g
    const limit = i === 2 || i < 0 ? LOAD_LIMIT_CSM : LOAD_LIMIT_STACK;
    if (state === 'flying' && overstressed(aeroLoad, limit, dt)) return breakup();
  } else { aeroLoad = 0; strain = Math.max(0, strain - 0.5 * dt); }

  omega.x = THREE.MathUtils.clamp(omega.x, -MAX_RATE_PY, MAX_RATE_PY);
  omega.y = THREE.MathUtils.clamp(omega.y, -MAX_RATE_PY, MAX_RATE_PY);
  omega.z = THREE.MathUtils.clamp(omega.z, -MAX_RATE_ROLL, MAX_RATE_ROLL);
  if (omega.lengthSq() > 1e-12) {
    const rate = omega.length();
    S.q.multiply(_dq.setFromAxisAngle(_ax.copy(omega).multiplyScalar(1 / rate), rate * dt));
  }
  S.q.normalize();

  /* The launch complex is solid. Checked from the moment the hold-down lets go — the first 150 m,
     before 'flying' is declared, is exactly where the tower is. A launch vehicle does not bounce:
     contact with steel is the end of the flight. */
  if (S.pos.length() - RE < 1) {
    const hit = padHit(S.pos, _fw.copy(UP_REF).applyQuaternion(S.q), simTime, tailStation(), NOSE_Z, armSwing < 0.6);
    if (hit) return collide(hit);
  }

  // liftoff bookkeeping
  if (!flightStarted && S.pos.length() < PAD_POS.length() - 0.004) {
    /* Let go of the pad and came back down, or tipped over before clearing it: that is a flight,
       and the ground is there. (It used to stay 'pad' — which tests no ground — and a stack
       steered over at ignition tunnelled two kilometres into the Earth.) */
    flightStarted = true; state = 'flying'; checkImpact();
    if (state !== 'flying') return;
  }
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

/* Rate servo: turn toward attitude `tq` at a rate proportional to the error, shortest way round. */
const _sq = new THREE.Quaternion(), _eq = new THREE.Quaternion();
function servo(tq, ratio, dt) {
  const errB = _eq.copy(S.q).invert().multiply(tq);              // pointing error in body frame
  if (errB.w < 0) errB.set(-errB.x, -errB.y, -errB.z, -errB.w);  // Quaternion has no multiplyScalar
  errB.normalize();
  const angle = 2 * Math.acos(THREE.MathUtils.clamp(errB.w, -1, 1));
  const k = Math.min(0.9, 1.2 * ratio * dt);
  if (angle <= 1e-3) { if (holdOn) omega.multiplyScalar(1 - k); return; }
  const axis = _ax.set(errB.x, errB.y, errB.z);
  if (axis.lengthSq() > 1e-9) axis.normalize(); else axis.set(1, 0, 0);
  const want = Math.min(0.85 * MAX_RATE_PY, 1.6 * angle);
  omega.x += (axis.x * want - omega.x) * k;
  omega.y += (axis.y * want - omega.y) * k;
  omega.z += (axis.z * want - omega.z) * k;
}

function checkImpact() {
  if (state !== 'flying') return;
  moonPos(simTime, _moon);
  if (S.pos.distanceTo(_moon) < RM + 40) { if (surfaceAlt(true) <= 0) impact(true); }
  else if (S.pos.length() < RE + 40 && surfaceAlt(false) <= 0) impact(false);
}
function impact(onMoon) {
  const i = activeStage();
  const speed = groundVel(_nv).length();         // km/s, relative to the surface being hit
  const disp = speed * 1000;                    // m/s
  const upright = fwd().dot(bodyUp(_rad)) > 0.5;           // within 60° of vertical: it stays standing
  if (onMoon && speed <= LAND_SAFE && !upright) {
    explode(); state = 'lost';
    hooks.addLog(`TOUCHDOWN AT ${disp.toFixed(1)} m/s — ON ITS SIDE. MISSION LOST`, 'bad');
    hooks.showEndOverlay('TIPPED OVER', `Slow enough at ${disp.toFixed(1)} m/s, but the CSM met the Moon ${Math.round(Math.acos(fwd().dot(bodyUp(_rad))) * 57.2958)}° from vertical. Hold retrograde (V + P) all the way down: at touchdown that is straight up.`, 'RETRY');
    return;
  }
  if (onMoon && speed <= LAND_SAFE) {
    landing.speed = disp; landing.tilt = Math.acos(Math.min(1, fwd().dot(bodyUp(_rad)))) * 57.2958;
    landing.fuel = stages[2].separated ? 0 : stages[2].fuel; landing.time = simTime; landing.home = false;
    state = 'won'; vehicleOps.setVisible(true);
    hooks.addLog(`TOUCHDOWN — ${disp.toFixed(1)} m/s. THE MOON IS OURS.`, 'good');
    audio.win();
    hooks.showEndOverlay('TOUCHDOWN ON THE MOON',
      `The CSM rests on the lunar surface at <b>${disp.toFixed(1)} m/s</b> after a ${fmtDuration(simTime)} mission, all three stages spent along the way. ${disp < 5 ? 'A textbook landing.' : disp < 15 ? 'Firm, but she stands.' : 'Close to the limit — brake earlier next time.'}`,
      'FLY AGAIN');
    return;
  }
  explode();
  if (onMoon) {
    state = 'lost';
    hooks.addLog(`HARD IMPACT ON THE MOON AT ${disp.toFixed(0)} m/s — MISSION LOST`, 'bad');
    hooks.showEndOverlay('MOON IMPACT', `The ${activeStage() === 2 ? 'CSM' : 'vehicle'} struck the lunar surface at ${disp.toFixed(0)} m/s. Land softer than 32 m/s — start the braking burn early, at the edge of the dashed sphere.`, 'RETRY');
  } else {
    if (speed <= SAFE_EARTH && i < 0) {
      state = 'won'; vehicleOps.setVisible(true);
      landing.speed = disp; landing.tilt = 0; landing.fuel = 0; landing.time = simTime; landing.home = true; landing.flyby = loiLogged;
      hooks.addLog(`SPLASHDOWN — ${disp.toFixed(1)} m/s UNDER ${chute === 2 ? 'THREE GOOD MAINS' : 'WHAT WAS LEFT'}`, 'good');
      audio.win();
      hooks.showEndOverlay(loiLogged ? 'AROUND THE MOON AND HOME' : 'SPLASHDOWN',
        `The command module is down at <b>${disp.toFixed(1)} m/s</b> after ${fmtDuration(simTime)}. ${loiLogged ? 'You went to the Moon and brought the crew back.' : 'The crew is safe. The Moon is still up there.'}`, 'FLY AGAIN');
    } else {
      state = 'lost';
      hooks.addLog(`IMPACT WITH EARTH AT ${disp.toFixed(0)} m/s — MISSION LOST`, 'bad');
      hooks.showEndOverlay(disp > 1000 ? 'RE-ENTRY DISASTER' : 'HARD LANDING', i < 0
        ? `The capsule hit at ${disp.toFixed(0)} m/s. Drogues (G) once the air has slowed you under ${CHUTE.drogue.tear / 1000} kPa, mains (G again) under ${CHUTE.mains.tear / 1000} kPa — down at under ${SAFE_EARTH * 1000} m/s.`
        : `The vehicle hit the ground at ${disp.toFixed(0)} m/s. Only the command module comes home: drop the rest (X) and open the parachutes (G).`, 'RETRY');
    }
  }
}
/* Structural failure policy: accumulated strain. Over the limit, strain grows with how far over
   (load/limit − 1) per second; under it, it relaxes at 0.5/s. The airframe goes at strain 0.6 —
   1.5× the limit held for 1.2 s, or 2× for 0.6 s — and at once above 3×. So a spike while you
   wrestle the nose back is survivable and the HUD's red side-load readout is a warning you can
   act on, but a stack held broadside through max-Q is still lost. */
let strain = 0;
export const getStrain = () => strain / STRAIN_FAIL;      // 0 sound … 1 gone
const STRAIN_FAIL = 0.6;
function overstressed(load, limit, dt) {
  if (load > 3 * limit) return true;
  strain = load > limit ? strain + (load / limit - 1) * dt : Math.max(0, strain - 0.5 * dt);
  return strain >= STRAIN_FAIL;
}

function collide(what) {
  const v = groundVel(_nv).length() * 1000;
  explode(); state = 'lost'; flightStarted = true;
  hooks.addLog(`COLLISION WITH ${what} AT ${v.toFixed(0)} m/s — VEHICLE LOST`, 'bad');
  hooks.showEndOverlay('COLLISION', `The vehicle struck <b>${what.toLowerCase()}</b> at ${v.toFixed(0)} m/s. Climb straight until the tower is below you — SAS (P) holds the vertical for the first 55 seconds — and steer east, away from it.`, 'RETRY');
}
function crushed() {
  explode(); state = 'lost';
  hooks.addLog(`${gLoad.toFixed(0)} g FOR ${G_TIME} s — NOBODY SURVIVES THAT`, 'bad');
  hooks.showEndOverlay('ENTRY TOO STEEP', `The air stopped the capsule at <b>${gLoad.toFixed(0)} g</b>; a crew takes ${G_LIMIT} for a moment. Come in shallower — a periapsis just inside the atmosphere, not a dive at it.`, 'RETRY');
}
function burnUp(capsule) {
  explode(); state = 'lost';
  hooks.addLog(capsule ? 'BURNED UP — THE HEAT SHIELD WAS NOT FACING THE AIRSTREAM' : 'BURNED UP ON ENTRY — ONLY THE COMMAND MODULE HAS A HEAT SHIELD', 'bad');
  hooks.showEndOverlay('BURNED UP', capsule
    ? 'The capsule met the atmosphere apex-first. Hold retrograde (V + P) before the air arrives: from orbit a bare command module rights itself in time, from the Moon it does not.'
    : 'Stages do not survive re-entry. Drop everything but the command module (X) before the atmosphere, and come in heat shield first.', 'RETRY');
}
function breakup() {
  explode(); state = 'lost';
  hooks.addLog(`AERODYNAMIC BREAKUP — ${aeroLoad.toFixed(1)} g SIDE LOAD AT MACH ${aeroState.mach.toFixed(1)}`, 'bad');
  hooks.showEndOverlay('AERODYNAMIC BREAKUP', `The airframe took <b>${aeroLoad.toFixed(1)} g</b> sideways at Mach ${aeroState.mach.toFixed(1)}, ${(aeroState.aoa * 57.2958).toFixed(0)}° off the airflow. Keep the nose on the velocity vector while the air is thick — SAS (P) does it for you.`, 'RETRY');
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
  if (!loggedMaxQ && maxQ > 30000 && activeStage() === 0) { loggedMaxQ = true; hooks.addLog('MAX-Q — EASE THE THROTTLE IF YOU LIKE THE PAINT'); }
  if (!turnHintLogged && r - RE > 120) {
    turnHintLogged = true;
    hooks.addLog('NOW PITCH TOWARD THE MOON (MAP) — OR PRESS P FOR PROGRADE SAS', 'good');
  }
}

/* ---------------- mission reset (sim side) ---------------- */
export function resetSim() {
  stages.forEach((st, idx) => {
    st.separated = false; st.fuel = SPECS[idx].fuel; loggedStageOut[idx] = false;
  });
  lesSeparated = false;
  S.pos.copy(PAD_POS); S.v.copy(PAD_ANGULAR); S.q.setFromUnitVectors(UP_REF, PAD_UP);
  engineOn = false; throttle = targetThrottle = 0;
  sasOn = false; sasRetro = false; simTime = 0; warpIdx = 0; maxQ = 0;
  tliLogged = loiLogged = loggedMaxQ = turnHintLogged = false; distFlown = 0; trail = [];
  flightStarted = false; state = 'pad'; omega.set(0, 0, 0); I0 = null; holdOn = false; armSwing = 0; tRelease = null; aeroState.q = aeroState.mach = aeroState.aoa = aeroState.nBody = aeroState.nFin = 0; gLoad = 0; gOver = 0; chute = 0; chuteOpen = 0; heat = 0; cooking = 0; rcsAssist = true; aeroLoad = 0; strain = 0;
}

/* teleport() starts the flight directly, bypassing the liftoff guard */
export function markTeleported() { flightStarted = true; state = 'flying'; tRelease = -1e9; armSwing = 1; }   // a teleported flight is long past its pitch program
