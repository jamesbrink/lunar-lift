import * as THREE from 'three';
import { VS, RE, RM, moonPos } from './constants.js';
import { rocketGroup, stages, lesGroup, bellMetal } from './saturn.js';
import { airDensity, getSimTime } from './physics.js';
import * as WORLD from './world.js';
import { nAlive, resetPool, spawnParticle, ship, plumeDebug, SM_SMOKE, SM_SEAM, SM_FLASH } from './exhaust-pool.js';
import { BELL_SETS, emitExhaust, emitIdle, resetEmit } from './exhaust-emit.js';
import { stepExhaust } from './exhaust-sim.js';
import { initExhaustDraw, fillExhaust, clearExhaustDraw } from './exhaust-draw.js';
import { buildFlames, updateFlames, flameReach } from './flame.js';

/* The vehicle as the rest of the game sees it: the hardware's pose each frame, staging and the
   debris it leaves, and the one entry point that turns "this stage is burning" into fire and smoke.
   The exhaust itself is four modules this one conducts —
     js/flame.js         the drawn flames (a shader on a mesh per stage)
     js/exhaust-pool.js  the parcel pool and the spawnParticle contract js/physics.js calls
     js/exhaust-emit.js  where parcels are born: nozzles, smoke trail, ignition steam, lunar ejecta
     js/exhaust-sim.js   how they move: drag, gravity, the trench, the hull
     js/exhaust-draw.js  how they are drawn: shaded puffs and additive lights, half resolution
   — and none of it feeds back into js/physics.js. */
export { spawnParticle, plumeDebug };
export { parcelAudit, sprayCensus } from './exhaust-pool.js';

let scene = null;
const RHO_SEA = airDensity(0);
const ZERO_V = new THREE.Vector3();
buildFlames(stages);

/* Is there any exhaust to draw? The half-resolution FX pass (with its depth prepass of the whole
   opaque scene) is skipped when there is not. */
export const plumeLive = () => nAlive > 0;

/* Called once per rendered frame with the simulated dt for that frame (main.js: min(1, real × warp)). */
export function updateParticles(dt) {
  stepExhaust(dt);
  fillExhaust();
}

/* ---------------- debris (separated stages) ---------------- */
export const debris = [];   // {mesh, vel, angVel, age}

export function initVehicle(target) {
  scene = target;
  scene.add(rocketGroup);
  initExhaustDraw(scene);
}

export function setVisible(visible) {
  rocketGroup.visible = visible;
  ship.live = visible;     // after the explosion there is no hull to collide with, only wreckage
}

export function detachStage(mesh, pos, quat) {
  rocketGroup.remove(mesh);
  mesh.position.copy(pos); mesh.quaternion.copy(quat); mesh.scale.setScalar(VS);
  scene.add(mesh);
}

export function addDebris(entry) {
  debris.push(entry);
  /* Staging-seam puffs (review3/05/06 ask): the trail flag marks exactly one event in this
     game — separateStage hands over a flying booster (separateLES and the explosion never set
     it). A real separation seam bursts a short ring of grey smoke with the flash and the
     sparks; 6-10 puffs, 0.4-0.8 s, dark and LOW ALPHA (SM_SEAM's fillBuffers pass), drawn as
     silhouettes against the flash rather than more glowing beads. They stay SMALL in vacuum
     by construction: growth rides the certified airDensity gate (at the 67 km staging altitude
     ρ≈0 caps them at a few tenths of m/s over a 0.5 s life), and the ±3 m birth scatter plus
     5-13 m/s spread keeps them at the seam instead of orbiting it. */
  if (entry.trail) {
    /* Light burst FIRST ("the flash is a lumpy soot-egg … and no light burst"): 4 tiny additive-white parcels
       (SM_FLASH), 2.2-3.8 m → 15-27 m discs, lives 0.20-0.28 s. They peak at 22 ms — before the
       seam puffs' 0.10 s fade-in lets any smoke exist — and are gone by 0.28 s. Then the smoke:
       6-10 puffs, now at 0.13 coverage and 1.8-3.8 m births (was 0.22 / 2.5-4.5) so they ring
       the seam instead of becoming the "lumpy soot-egg with two detached balls" the review saw. */
    for (let k = 0; k < 4; k++) {
      _trailRnd.randomDirection();
      _sp.copy(entry.mesh.position).addScaledVector(_trailRnd, 0.0012 + Math.random() * 0.0012);
      _svv.copy(entry.vel).addScaledVector(_trailRnd, 0.001);
      spawnParticle(_sp, _svv, 0.20 + Math.random() * 0.08, [1, 1, 1], 2.2 + Math.random() * 1.6, SM_FLASH);
    }
    const n = 6 + ((Math.random() * 5) | 0);           // 6..10
    for (let k = 0; k < n; k++) {
      _trailRnd.randomDirection();
      _sp.copy(entry.mesh.position).addScaledVector(_trailRnd, 0.003);
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
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i]; d.age += simDt;
    const a = accelAt(d.mesh.position, d.vel, 8, null);
    d.vel.addScaledVector(a, simDt); d.mesh.position.addScaledVector(d.vel, simDt);
    d.mesh.rotation.x += d.angVel.x * simDt; d.mesh.rotation.y += d.angVel.y * simDt;
    if (d.trail) {
      const fall = Math.hypot(d.vel.x, d.vel.y, d.vel.z);
      /* Air-gated: a debris trail is smoke, and smoke needs air. The separation itself happens
         at the edge of space, where the honest event is the flash (physics.js) and tumbling
         metal, not a ribbon — the ribbon appears on the way down. */
      const alt = d.mesh.position.length() - RE;
      const rho = alt < 420 ? airDensity(alt) : 0;
      if (rho > 0.004) {
        d.smokeAcc = (d.smokeAcc || 0) + simDt;
        const period = Math.max(0.033, 11 / Math.max(1, fall * 1000));   // ≥11 m apart, ≤30/s
        while (d.smokeAcc >= period) {
          d.smokeAcc -= period;
          const spd = THREE.MathUtils.clamp(fall * 1000 / 700, 0.3, 3);
          _trailPos.copy(d.mesh.position);
          _trailVel.copy(d.vel).multiplyScalar(0.12).addScaledVector(
            _trailRnd.randomDirection(), 0.004);
          spawnParticle(_trailPos, _trailVel, 2.6 + Math.random() * 1.6, TRAIL_COLOUR,
            (6 + Math.random() * 8) * spd, SM_SMOKE);
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
      const fn = WORLD.moonGroundHeight;
      down = _dm.length() <= RM + (typeof fn === 'function' ? fn(_dm.clone()) || 0 : 0);
    }
    if (down) {
      for (let k = 0; k < 14; k++) {
        _trailVel.copy(d.vel).multiplyScalar(0.02).addScaledVector(_trailRnd.randomDirection(), 0.012);
        spawnParticle(d.mesh.position, _trailVel, 2.5 + Math.random() * 2, IMPACT_COLOUR, 5 + Math.random() * 6, SM_SMOKE);
      }
    }
    if (down || d.age > 400 || rE > 60000 && rE < 300000) { scene.remove(d.mesh); debris.splice(i, 1); }
  }
}
const TRAIL_COLOUR = [0.82, 0.83, 0.86];
const IMPACT_COLOUR = [0.80, 0.76, 0.68];
const _dm = new THREE.Vector3(), _dmo = new THREE.Vector3();
function reliefE(p) {
  const fn = WORLD.fineGroundHeight || WORLD.groundHeight;
  const v = typeof fn === 'function' ? fn(_dm.copy(p)) : 0;
  return v === v ? v : 0;
}
const SEAM_COLOUR = [0.32, 0.33, 0.36];   // staging-seam smoke: dark grey against the flash
const _trailPos = new THREE.Vector3(), _trailVel = new THREE.Vector3(), _trailRnd = new THREE.Vector3();
const _sp = new THREE.Vector3(), _svv = new THREE.Vector3();

export function clearDebris() {
  debris.forEach(d => scene.remove(d.mesh)); debris.length = 0;
}

export function resetStages() {
  /* A new mission starts with clean air. Stale smoke from the previous attempt would hang over
     the pad for its whole remaining life otherwise. */
  resetPool(); resetEmit(); clearExhaustDraw();
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
    ship.tailZ = 6.8; ship.hullR = 1.39 * VS;     // the SM/CM stub after everything else flew
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
  if (on) emitExhaust(activeIdx, pos, quat, vel, throttle, since, flameReach(activeIdx, throttle, VS));
  else emitIdle();
}
