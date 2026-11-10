import * as THREE from 'three';
import { VS, RE, RM, EARTH_SPIN, DTPHYS, MOON_RATE, moonPos, moonVel, csmParkPos, csmParkVel } from './constants.js';
import { rocketGroup, stages, lesGroup, bellMetal } from './saturn.js';
import { S, airDensity, getSimTime, getState, landing, getCsmParked } from './physics.js';
import { ATMO_TOP } from './aero.js';
import { TAIL_Z, R_SM_DRAWN } from './stations.js';
import * as WORLD from './world.js';
import { nAlive, alive, resetPool, spawnParticle as spawn, killKind, ship, plumeDebug, pPos, pVel, pAge, pMode, pSmoke, onRecycle, SM_SMOKE, SM_SEAM, SM_FLASH } from './exhaust-pool.js';
import { BELL_SETS, emitExhaust, emitIdle, resetEmit } from './exhaust-emit.js';
import { stepExhaust } from './exhaust-sim.js';
import { initExhaustDraw, fillExhaust, clearExhaustDraw, setFireLight } from './exhaust-draw.js';
import { buildFlames, updateFlames, flameReach, flameWidth, flameTint } from './flame.js';
import { initEntryFx, updateEntryFx, resetEntryFx } from './entry-fx.js';
import { initSplashFx, updateSplashFx, resetSplashFx } from './splash-fx.js';
import { initDustSheet, updateDustSheet, resetDustSheet } from './dust-sheet.js';

/* The vehicle as the rest of the game sees it: the hardware's pose each frame, staging and the
   debris it leaves, and the one entry point that turns "this stage is burning" into fire and smoke.
   The exhaust itself is four modules this one conducts —
     js/flame.js         the drawn flames (a shader on a mesh per stage)
     js/exhaust-pool.js  the parcel pool and the spawnParticle contract js/physics.js calls
     js/exhaust-emit.js  where parcels are born: nozzles, smoke trail, ignition steam, lunar ejecta
     js/exhaust-sim.js   how they move: drag, gravity, the trench, the hull
     js/exhaust-draw.js  how they are drawn: shaded puffs, flat lunar dust, hard-edged shards
   — plus two effects that are not exhaust at all and ride the same per-frame call:
     js/entry-fx.js      the bow shock, sheath and streak of atmospheric entry
     js/splash-fx.js     the splash at a water landing
     js/dust-sheet.js    the flat sheet of dust a lunar burn drives out along the ground
   None of it feeds back into js/physics.js. */
export { plumeDebug };
export { parcelAudit, sprayCensus } from './exhaust-pool.js';

let scene = null, wasHome = false, wasOver = false;
const RHO_SEA = airDensity(0);
const ZERO_V = new THREE.Vector3();
buildFlames(stages);

/* Is there any exhaust to draw? The half-resolution FX pass (with its depth prepass of the whole
   opaque scene) is skipped when there is not. */
export const plumeLive = () => nAlive > 0;

/* What js/physics.js calls for its sparks and puffs (js/main.js hands it over as vehicleOps).
   Physics spawns at the TRUE state, inside a 0.1 s step; the picture is the state blended between
   the last two steps, up to a step behind — 120 m at staging speed, 780 m in orbit — so a burst
   left where it was spawned stands off ahead of the vehicle it came from (measured at automatic
   staging: the sparks' first frame 18 m from the drawn stack's centre in two runs, by the luck of
   the frame's phase; 7 m, the hull's own push, with this).
   Everything spawned through here is therefore remembered until the next frame and moved by the
   difference between the vehicle as drawn and the vehicle as it was when they were spawned. */
const pend = [], pendRef = new THREE.Vector3(), seamOff = new THREE.Vector3();
let pendT = 0;
/* A pool-full spawn recycles a random live slot. If that slot was still owed its re-seat, the
   fresh parcel would take the delta a second time — drop it from pend at the moment of theft. */
onRecycle(i => { const k = pend.indexOf(i); if (k >= 0) pend.splice(k, 1); });
export function spawnParticle(pos, vel, life, color, size0, smoke) {
  const i = spawn(pos, vel, life, color, size0, smoke);
  if (pend.length === 0) { pendRef.copy(S.pos); pendT = getSimTime(); }
  if (pend.length < 400) pend.push(i);
  return i;
}
/* `dt` is what stepExhaust is about to advance them by: taken off first, so that after the step
   they stand exactly where the drawn vehicle is. Not after an ff() jump (the vehicle has gone), and
   not when the vehicle itself is gone (the camera stays on the true state). S is already this
   frame's DRAWN state — main.js blends it before updateParticles, ahead of updateBurnVisuals
   writing ship.pos — so settle reads S, the same pose the debris re-seat gets. */
function settle(dt, gone) {
  if (!gone && Math.abs(getSimTime() - pendT) <= DTPHYS * 1.01) {
    const sx = S.pos.x - pendRef.x, sy = S.pos.y - pendRef.y, sz = S.pos.z - pendRef.z;
    for (const i of pend) {
      if (pMode[i] !== 2 || pAge[i] !== 0) continue;
      const i3 = i * 3, k = pSmoke[i] === 0 ? 1 : 0;      // the staging sparks come from the seam, not the middle of the stack
      pPos[i3] += sx + k * seamOff.x - pVel[i3] * dt; pPos[i3 + 1] += sy + k * seamOff.y - pVel[i3 + 1] * dt; pPos[i3 + 2] += sz + k * seamOff.z - pVel[i3 + 2] * dt;
    }
  }
  pend.length = 0; seamOff.set(0, 0, 0);
}

/* Called once per rendered frame with the simulated dt for that frame (main.js: min(1, real × warp)). */
const heldV = new THREE.Vector3();
export function updateParticles(dt) {
  const st = getState(), over = st === 'won' || st === 'lost';
  /* The mission clock stops on an end card and the planets with it. What is left alive is then
     drawn in the frame of whatever the camera is left looking at: the ground, if the vehicle is on
     it or in it; the vehicle's own last motion, if it came apart in flight. See stepExhaust. */
  if (over && !wasOver) {
    if (S.pos.length() < RE + 1.5) heldV.set(EARTH_SPIN * S.pos.z, 0, -EARTH_SPIN * S.pos.x);
    else if (S.pos.distanceTo(moonPos(getSimTime(), _dmo)) < RM + 3) moonVel(getSimTime(), heldV);
    else heldV.copy(S.v);
  }
  wasOver = over;
  /* js/physics.js runs its explosion on every Earth contact before it decides the landing was
     safe (impact() calls explode() ahead of the splashdown branch), so a good splashdown used to
     throw 240 burning fragments out from the capsule: half of the yellow smear on the horizon of
     the reviewer's splash frame (the other half is the stopped clock, above). The capsule is
     whole; on the frame the mission is won at home those sparks are taken back before anything
     draws them. */
  const home = st === 'won' && landing.home;
  if (home && !wasHome) killKind(0);
  wasHome = home;
  const boom = boomAt.x === boomAt.x && !home;
  if (pend.length) settle(dt, boom || over);
  if (boom) explosion(boomAt);
  boomAt.x = NaN;
  stepExhaust(dt, over ? heldV : null);
  if (st !== 'flying') resetDustSheet();     // down, lost or back on the pad: no engine, no sheet
  updateEntryFx();
  updateSplashFx(dt);
  fillExhaust();
}

/* ---------------- debris (separated stages) ---------------- */
export const debris = [];   // {mesh, vel, angVel, age}

export function initVehicle(target) {
  scene = target;
  scene.add(rocketGroup);
  initExhaustDraw(scene);
  initEntryFx(scene); initSplashFx(scene); initDustSheet(scene);
}

export function setVisible(visible) {
  rocketGroup.visible = visible;
  ship.live = visible;     // after the explosion there is no hull to collide with, only wreckage
  /* js/physics.js hides the vehicle in exactly one place, its explosion, and throws 240 sparks
     there. The drawn event is decided a frame later (updateParticles), because the same call
     precedes a safe splashdown, which shows the vehicle again at once. */
  if (!visible) { boomAt.copy(S.pos); boomVel.copy(S.v); } else boomAt.x = NaN;
}

/* The explosion, drawn: three spiked flashes along what was the stack, the physics module's sparks
   as burning slivers, and a knot of dark smoke that billows only if there is air to billow in.
   All of it rides heldV — the ground's motion if the vehicle met the ground, its own if it came
   apart in flight. The sparks arrive from js/physics.js with 0.3 of the vehicle's INERTIAL velocity,
   which on the ground is 0.3 of the planet's spin: they left the crater at 286 m/s, always westward,
   and in flight fell behind at kilometres a second before a frame was drawn. Their scatter is
   kept and its base replaced. */
function explosion(at) {
  for (let k = 0; k < nAlive; k++) {
    const i = alive[k], i3 = i * 3;
    if (pMode[i] !== 2 || pSmoke[i] !== 0 || pAge[i] !== 0) continue;
    pVel[i3] += heldV.x - 0.3 * boomVel.x; pVel[i3 + 1] += heldV.y - 0.3 * boomVel.y; pVel[i3 + 2] += heldV.z - 0.3 * boomVel.z;
  }
  spawn(at, heldV, 0.32, [1, 1, 1], 90, SM_FLASH);
  for (let k = 0; k < 2; k++) {
    _sp.set(0, 0, (k ? 1 : -1) * (14 + 10 * Math.random()) * VS).applyQuaternion(ship.quat).add(at);
    spawn(_sp, heldV, 0.24 + 0.1 * k, [1, 1, 1], 50, SM_FLASH);
  }
  for (let k = 0; k < 18; k++) {
    _trailRnd.randomDirection();
    _sp.copy(at).addScaledVector(_trailRnd, 0.012 * Math.random());
    _svv.copy(heldV).addScaledVector(_trailRnd, 0.008 + 0.022 * Math.random());
    spawn(_sp, _svv, 2.2 + 2.2 * Math.random(), k % 3 ? BOOM_SMOKE : BOOM_SOOT, 5 + 5 * Math.random(), SM_SMOKE);
  }
}
const boomAt = new THREE.Vector3(NaN, 0, 0), boomVel = new THREE.Vector3(), BOOM_SMOKE = [0.36, 0.34, 0.34], BOOM_SOOT = [0.2, 0.19, 0.2];

export function detachStage(mesh, pos, quat) {
  rocketGroup.remove(mesh);
  mesh.position.copy(pos); mesh.quaternion.copy(quat); mesh.scale.setScalar(VS);
  scene.add(mesh);
}

/* The descent stage left standing at the landing site. The Moon moves through the game frame at
   ~1 km/s and turns under its regolith, so what stood there is not a debris record — debris is
   inertial, and the Moon walks away from it (it read as the LM vanishing and reappearing as a
   gold can, the descent stage sunk through terrain a kilometre a minute). A parked stage is
   anchored in the Moon-fixed frame exactly like js/physics.js's moonPerch and recomposed each
   frame from the same two numbers the picture uses: moonPos and the syncTime spin. */
export function parkStage(mesh, pos, quat) {
  rocketGroup.remove(mesh);
  mesh.scale.setScalar(VS);
  const q = _parkQ.setFromAxisAngle(_parkY, MOON_RATE * getSimTime());
  const rock = pos.clone().sub(moonPos(getSimTime(), _parkV)).applyQuaternion(q.clone().invert());
  moonParked.push({ mesh, rock, qo: quat.clone().premultiply(q.clone().invert()) });
  scene.add(mesh);
}
const moonParked = [];
const _parkY = new THREE.Vector3(0, 1, 0), _parkQ = new THREE.Quaternion(), _parkM = new THREE.Vector3();

export function addDebris(entry) {
  debris.push(entry);
  entry.ref = S.pos.clone(); entry.t0 = getSimTime();     // see updateDebris: the piece is re-seated on the drawn vehicle
  /* Staging. The trail flag marks exactly one event in this game — separateStage hands over a
     flying booster (separateLES and the explosion never set it) — and what is drawn for it is a cel
     flash at the seam: one spiked star, three flat drawings over a fifth of a second
     (js/exhaust-draw.js), drawn in a 44 m square against a 59 m stage, plus the sparks js/physics.js throws and
     a short ring of small dark puffs. It replaces four additive discs that, stacked with the
     physics module's 26 burst parcels (10-18 m radius, each drawn as a soft light five radii
     across), made a glowing ball bigger than the vehicle. The puffs stay small in vacuum by construction: their growth rides airDensity. */
  if (entry.trail) {
    const k = stages.findIndex(st => st.meshes === entry.mesh);
    const seam = k >= 0 && k < 2 ? BELL_SETS[k + 1].tailZ : 26;      // the next stage's exit plane, or the capsule's base
    _seam.set(0, 0, seam * VS).applyQuaternion(entry.mesh.quaternion).add(entry.mesh.position);
    spawnParticle(_seam, S.v, 0.2, [1, 1, 1], 44, SM_FLASH);
    seamOff.subVectors(_seam, S.pos);
    const n = 6 + ((Math.random() * 5) | 0);           // 6..10
    for (let j = 0; j < n; j++) {
      _trailRnd.randomDirection();
      _sp.copy(_seam).addScaledVector(_trailRnd, 0.003);
      _svv.copy(entry.vel).addScaledVector(_trailRnd, 0.005 + Math.random() * 0.008);
      spawnParticle(_sp, _svv, 0.4 + Math.random() * 0.4, SEAM_COLOUR, 1.8 + Math.random() * 2, SM_SEAM);
    }
  }
}

/* Debris falls under the same gravity the ship uses. trail-flagged pieces (staged boosters) also
   bleed a continuous smoke ribbon: the old staging event spawned one puff per frame at the release
   point, so the vehicle flew away and left a string of separate coins (the reviewer's "pearl
   chain"). A fed trail — one small parcel every ~11 m of fall — merges into a column the same way
   the plume does, and it dies with the debris rather than the burst. */
export function updateDebris(simDt, accelAt) {
  /* The left-behind descent stage rides the Moon, not the sky: recomposed from moonPos and the
     same MOON_RATE·t spin syncTime gives the drawn Moon, so it stands in the crater it landed in
     while the Moon moves through the game frame and turns under its regolith. */
  for (const p of moonParked) {
    const q = _parkQ.setFromAxisAngle(_parkY, MOON_RATE * getSimTime());
    p.mesh.position.copy(moonPos(getSimTime(), _parkV)).add(_parkM.copy(p.rock).applyQuaternion(q));
    p.mesh.quaternion.copy(p.qo).premultiply(q);
  }
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i]; d.age += simDt;
    /* A piece leaves at the true state and is first drawn beside a vehicle drawn up to a step
       behind it (see spawnParticle above): on its first frame it is moved by that difference. */
    if (d.ref) {
      if (ship.live && Math.abs(getSimTime() - d.t0) <= DTPHYS * 1.01)
        d.mesh.position.add(ship.pos).sub(d.ref).addScaledVector(d.vel, -simDt);
      d.ref = null;
    }
    /* A dropped stage is a body in the same gravity and the same air as the ship, stepped the same
       way (v += a dt, then p += v dt, forces at the step's own time) at the ship's own 0.1 s, however
       much mission time the frame covers (the step is part of the trajectory: AGENTS.md). It used to take ONE
       step of the whole frame — 16 s at x1000 — and was deleted after 400 s, so a stage left in
       orbit sank out of it and vanished (reported from play). */
    {
      const n = Math.max(1, Math.min(4000, Math.round(simDt / DTPHYS))), dt = simDt / n, t0 = getSimTime() - simDt;
      for (let k = 1; k <= n; k++) {
        const a = accelAt(d.mesh.position, d.vel, d.mass || 8, null, t0 + k * dt);
        d.vel.addScaledVector(a, dt); d.mesh.position.addScaledVector(d.vel, dt);
      }
    }
    d.mesh.rotation.x += d.angVel.x * simDt; d.mesh.rotation.y += d.angVel.y * simDt;
    if (d.trail) {
      const fall = Math.hypot(d.vel.x, d.vel.y, d.vel.z);
      /* Air-gated: a debris trail is smoke, and smoke needs air. The separation itself happens
         at the edge of space, where the honest event is the flash and tumbling metal, not a
         ribbon — the ribbon appears on the way down, below about 35 km (rho > 0.02). The gate was
         0.004, which is 48.7 km — exactly where the shipped ascent stages (48.7 to 49.0 km over
         the runs measured) — and a stage dropped any lower trailed puffs of up to 16 m radius,
         drawn 48 m across, behind a 59 m stage. */
      const alt = d.mesh.position.length() - RE;
      const rho = alt < ATMO_TOP ? airDensity(alt) : 0;
      if (rho > 0.02) {
        d.smokeAcc = (d.smokeAcc || 0) + simDt;
        const period = Math.max(0.033, 11 / Math.max(1, fall * 1000));   // ≥11 m apart, ≤30/s
        while (d.smokeAcc >= period) {
          d.smokeAcc -= period;
          const spd = THREE.MathUtils.clamp(fall * 1000 / 700, 0.3, 3);
          _trailPos.copy(d.mesh.position);
          _trailVel.copy(d.vel).multiplyScalar(0.12).addScaledVector(
            _trailRnd.randomDirection(), 0.004);
          spawn(_trailPos, _trailVel, 2.6 + Math.random() * 1.6, TRAIL_COLOUR,
            (3 + Math.random() * 3) * Math.min(spd, 1.6), SM_SMOKE);
        }
      } else d.smokeAcc = 0;
    }
    /* Debris stops at the ground: it used to fall through the planet until its 400 s age-out. Earth's
       surface is the sphere plus relief, the Moon's the same; a stage that arrives leaves one burst of
       dust and is removed. */
    const rE = d.mesh.position.length();
    let down = false;
    if (rE < RE + 3) down = rE <= RE + reliefE(d.mesh.position);
    else if (rE > 300000) {
      _dm.copy(d.mesh.position).sub(moonPos(getSimTime(), _dmo));
      down = _dm.length() <= RM + (WORLD.moonGroundHeight(_dm.clone()) || 0);
    }
    if (down) {
      for (let k = 0; k < 14; k++) {
        _trailVel.copy(d.vel).multiplyScalar(0.02).addScaledVector(_trailRnd.randomDirection(), 0.012);
        spawn(d.mesh.position, _trailVel, 2.5 + Math.random() * 2, IMPACT_COLOUR, 5 + Math.random() * 6, SM_SMOKE);
      }
    }
    /* It lives until it comes down, or is too far from the ship to be a pixel (5,000 km). */
    if (down || d.mesh.position.distanceToSquared(S.pos) > 25e6) { scene.remove(d.mesh); debris.splice(i, 1); }
  }
}
const TRAIL_COLOUR = [0.82, 0.83, 0.86];
const IMPACT_COLOUR = [0.80, 0.76, 0.68];
const _dm = new THREE.Vector3(), _dmo = new THREE.Vector3();
function reliefE(p) {
  const v = WORLD.fineGroundHeight(_dm.copy(p));
  return v === v ? v : 0;
}
const SEAM_COLOUR = [0.32, 0.33, 0.36];   // staging-seam smoke: dark grey against the flash
const _trailPos = new THREE.Vector3(), _trailVel = new THREE.Vector3(), _trailRnd = new THREE.Vector3();
const _sp = new THREE.Vector3(), _svv = new THREE.Vector3(), _seam = new THREE.Vector3();

export function clearDebris() {
  debris.forEach(d => scene.remove(d.mesh)); debris.length = 0;
  moonParked.forEach(p => scene.remove(p.mesh)); moonParked.length = 0;
}

/* The parked CSM is not integrated — js/physics.js keeps ONE state and its park orbit is the
   analytic csmParkPos. The drawing follows that line: out of rocketGroup, nose along the orbit,
   back the moment the docks engage. (resetStages also re-homes it; this covers dock, which does
   not pass through reset.) */
const _parkV = new THREE.Vector3(), _parkUp = new THREE.Vector3(0, 0, 1);
export function syncParkedCsm() {
  const m = stages[2].meshes;
  if (getCsmParked()) {
    if (m.parent !== scene) scene.add(m);
    csmParkPos(getSimTime(), m.position);
    csmParkVel(getSimTime(), _parkV);
    if (_parkV.lengthSq() > 1e-12) m.quaternion.setFromUnitVectors(_parkUp, _parkV.normalize());
    m.scale.setScalar(VS);
    m.visible = true;
  } else if (m.parent === scene) {
    rocketGroup.add(m);
    m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.setScalar(1);
  }
}

export function resetStages() {
  /* A new mission starts with clean air. Stale smoke from the previous attempt would hang over
     the pad for its whole remaining life otherwise. */
  resetPool(); resetEmit(); clearExhaustDraw(); resetEntryFx(); resetSplashFx(); resetDustSheet(); setFireLight(ZERO_V, 0, 0);
  pend.length = 0; boomAt.x = NaN; wasOver = wasHome = false;
  ship.live = true; burnT0 = -1;
  stages.forEach(st => {
    /* detachStage hands a dropped stage to the scene at scale VS; back under rocketGroup (itself VS)
       it must be 1 again, or the stage returns VS times too small to see. */
    st.meshes.visible = true; st.meshes.position.set(0, 0, 0); st.meshes.quaternion.identity(); st.meshes.scale.setScalar(1);
    rocketGroup.add(st.meshes);
  });
  /* A jettisoned LES has to fly home too: its children hold absolute build coords and the group
     rides at the local origin, so re-attaching is all the transform fixup needed. */
  if (lesGroup.parent !== stages[2].meshes) {
    lesGroup.position.set(0, 0, 0); lesGroup.quaternion.identity(); lesGroup.scale.setScalar(1);
    stages[2].meshes.add(lesGroup);
  }
  rocketGroup.visible = true;
  rocketGroup.quaternion.identity();
}

/* visuals follow physics: rocket transform, flames, exhaust emission */
let burnT0 = -1, burnIdx = -1;       // mission time this burn lit, and the stage that is burning it
const _hot = new THREE.Color(0xff7a2e), _cold = new THREE.Color(0x000000);
export function updateBurnVisuals({ pos, quat, vel, throttle, activeIdx, burn, omega }) {
  rocketGroup.position.copy(pos); rocketGroup.quaternion.copy(quat);
  const om = omega || ZERO_V;   // body-frame angular velocity (rad/s)
  ship.pos.copy(pos); ship.vel.copy(vel); ship.quat.copy(quat); ship.live = true;
  const bellSet = activeIdx >= 0 ? BELL_SETS[activeIdx] : undefined;
  if (bellSet) {
    ship.tailZ = bellSet.tailZ + 2;         // +2u: let the fresh flow leave the exit plane before the hull starts
    ship.hullR = bellSet.hullR * VS;
  } else {
    if (activeIdx >= 0) plumeDebug.causeBell++;   // an index nobody built: counted, not a crash
    ship.tailZ = TAIL_Z[2]; ship.hullR = R_SM_DRAWN * VS;     // the SM/CM stub after everything else flew
  }
  const t = getSimTime();
  const on = !!(burn && bellSet);
  if (!on || activeIdx !== burnIdx || t < burnT0) burnT0 = on ? t : -1;   // a new burn, a new stage, or a clock rewind
  burnIdx = on ? activeIdx : -1;
  const since = on ? t - burnT0 : 0;
  /* How much air the flame stands in: the square root of the density ratio from the physics module's
     own atmosphere. js/flame.js shapes the jet by it. */
  const vac = 1 - Math.sqrt(Math.min(1, airDensity(Math.max(0, pos.length() - RE)) / RHO_SEA));
  // the gimbal: the flame lags the turn, swinging opposite the body rate (clamped)
  updateFlames(activeIdx, on, throttle, vac, since, performance.now() / 1000,
    THREE.MathUtils.clamp(om.y, -1, 1) * 0.12, -THREE.MathUtils.clamp(om.x, -1, 1) * 0.12);
  /* A bell that is firing glows. All bells share one material; the others are inside interstages. */
  bellMetal.emissive.copy(on ? _hot : _cold).multiplyScalar(on ? 0.5 * Math.min(1, since * 2) : 1);
  if (on) {
    const reach = flameReach(activeIdx, throttle, VS);
    emitExhaust(activeIdx, pos, quat, vel, throttle, since, reach, flameWidth(activeIdx, VS));
    /* The fire as a light on the smoke: a third of the way down the flame from the exit plane. */
    _sp.set(0, 0, bellSet.tailZ * VS - reach * 0.3).applyQuaternion(quat).add(pos);
    setFireLight(_sp, flameTint(activeIdx), Math.min(1, since * 2) * (0.4 + 0.6 * throttle));
  } else { emitIdle(); setFireLight(pos, 0, 0); }
  _sp.set(0, 0, (bellSet ? bellSet.tailZ : 26) * VS).applyQuaternion(quat).add(pos);
  updateDustSheet(_sp, _svv.set(0, 0, -1).applyQuaternion(quat), on ? throttle : 0);
}
