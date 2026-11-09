import * as THREE from 'three';
import { RE, RM, WARPS, DTPHYS, PAD_POS, moonPos } from './constants.js';
import { initWorld, spinBodies, syncTime, updateSky, updateSunShadow } from './world.js';
import { stages, initVehicle, initNavVectors, updateNavVectors, spawnParticle, addDebris, detachStage, setVisible, updateParticles, updateDebris, updateBurnVisuals, clearDebris, resetStages, lesGroup } from './vehicle.js';
import { S, keys, initPhysics, getState, getSimTime, setSimTime, getEngineOn, getThrottle, getWarpIndex, setWarpIndex, setTargetThrottle, getSasOn, setSas, cycleWarp, toggleSas, toggleSasRetro, activeStage, fwd, isBurning, accelAt, physStep, predict, toggleIgnite, separateStage, separateLES, addDistFlown, pushTrail, resetSim, clearPredictor, markTeleported, predLine, omega, getControlAuthority, navVel, groundVel } from './physics.js';
import { camera, initCamera, cycleCamera, updateCamera, resetCameraView, setCamMode, setCamDist, resizeCamera, getCamDist } from './camera.js';
import { initHUD, addLog, updateHUD, drawMap, toggleMapView, endOverlay, setWarn, hideOverlay, clearLog } from './hud.js';
import { audioInit, audioEngine, audioThud, audioExplosion, audioWin, updateEngineGain } from './audio.js';
import { updateAim, resetAim } from './targeting.js';

/* ---------------- renderer / scene ---------------- */
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
/* Flat output, hard shadows. ACES filmic was compressing and desaturating everything, which is what
   turned the ocean charcoal; cel shading wants the palette exactly as authored. BasicShadowMap gives
   the crisp terminator edge and cloud shadows that the soft filter was blurring away. */
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04060b);
scene.fog = new THREE.FogExp2(0x04060b, 0);
const _gv = new THREE.Vector3();   // scratch for the per-frame ground-speed read

/* ---------------- overlays / flow ---------------- */
function resetMission() {
  clearDebris();
  resetStages();
  resetSim();
  syncTime(getSimTime());   // resetSim zeroes the mission clock; the bodies have to move back too
  resetCameraView();
  hideOverlay();
  document.body.classList.remove('map');   // a reset returns to the flight screen, even from the map
  clearLog();
  clearPredictor();
  resetAim();
  setWarn(null);
  audioEngine(false);
  addLog('MISSION RESET — PAD-READY');
}

/* ---------------- wiring ---------------- */
let audioArmed = false;
initWorld(scene);
initVehicle(scene);
initNavVectors(scene);
initPhysics({
  scene,
  stages,
  hooks: { addLog, showEndOverlay: endOverlay, setWarn },
  audio: { engine: audioEngine, thud: audioThud, explosion: audioExplosion, win: audioWin },
  vehicleOps: { spawnParticle, addDebris, detachStage, setVisible, les: lesGroup },
});
initCamera(canvas, addLog);
initHUD({ resetMission });

addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k) || (k === ']' || k === '[')) e.preventDefault();
  if (e.repeat) return; keys[k] = true;
  if (!audioArmed) { audioArmed = true; audioInit(); }          // browsers gate sound on a user gesture
  const mode = getState();
  if (mode === 'won' || mode === 'lost') {
    if (k === 'enter' || k === ' ') resetMission();
    return;
  }
  if (k === ' ') toggleIgnite();
  else if (k === 'x') separateStage();
  else if (k === 'p') toggleSas();
  else if (k === 'v') toggleSasRetro();
  else if (k === ']') cycleWarp(1);
  else if (k === '[') cycleWarp(-1);
  else if (k === 'c') cycleCamera();
  else if (k === 'm') toggleMapView();
  else if (k === 'r') resetMission();
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

/* ---------------- main loop ---------------- */
let last = performance.now(), prevPos = PAD_POS.clone();
let predTick = 0, trailTick = 0;

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dtReal = Math.min(.1, (now - last) / 1000); last = now;
  try {

  if (getState() === 'pad' || getState() === 'flying') {
    const simDt = dtReal * WARPS[getWarpIndex()];
    // ceil + max(1, …): a frame shorter than DTPHYS (any display above 100 Hz) used to
    // round to 0 substeps, so at ×1 physics never ran while the visuals kept spinning.
    const steps = Math.max(1, Math.min(600, Math.ceil(simDt / DTPHYS)));
    const h = simDt / steps;
    for (let s = 0; s < steps; s++) physStep(h);
    if (getState() === 'flying') addDistFlown(S.pos.distanceTo(prevPos));
    prevPos.copy(S.pos);
    spinBodies(simDt);

    if (getState() === 'flying') { trailTick += dtReal; if (trailTick > 0.5) { trailTick = 0; pushTrail(S.pos); } }

    // visuals follow physics
    updateBurnVisuals({ pos: S.pos, quat: S.q, vel: S.v, throttle: getThrottle(), activeIdx: activeStage(), burn: isBurning(), fwd, omega });
    updateNavVectors(S.pos, fwd(), navVel(), isBurning(), getCamDist(), groundVel(_gv));
    updateDebris(simDt, accelAt);
    updateEngineGain(isBurning(), Math.max(0, S.pos.length() - RE));
    predTick += dtReal; if (predTick > .35) { predTick = 0; if (getState() === 'flying') predict(); }
    updateAim();   // predicted lunar aim; spends a fixed step budget per frame and self-throttles
  }
  updateParticles(Math.min(1, dtReal * WARPS[getWarpIndex()]));
  updateCamera(dtReal);
  updateHUD(dtReal);
  updateSky(S.pos);
  updateSunShadow(S.pos);
  drawMap();
  renderer.render(scene, camera);
  } catch (err) {
    if (!window.__frameErr) { window.__frameErr = true; console.error('LUNAR LIFT frame error:', err); }
  }
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  resizeCamera();
  renderer.setSize(innerWidth, innerHeight);
});

/* ---------------- debug/test handle ---------------- */
window.game = {
  state: () => ({ state: getState(), simTime: getSimTime(), altE: S.pos.length() - RE,
    radialE: S.v.dot(new THREE.Vector3().copy(S.pos).normalize()),
    moon: moonPos(getSimTime(), new THREE.Vector3()).toArray(),
    altM: S.pos.distanceTo(moonPos(getSimTime(), new THREE.Vector3())) - RM,
    radialM: S.v.dot(new THREE.Vector3().subVectors(S.pos, moonPos(getSimTime(), new THREE.Vector3())).normalize()),
    speed: S.v.length(), fuel: stages.map(s => s.fuel), separated: stages.map(s => s.separated),
    engineOn: getEngineOn(), throttle: getThrottle(), sasOn: getSasOn(), warp: WARPS[getWarpIndex()],
    omega: [omega.x, omega.y, omega.z], authority: getControlAuthority().py }),
  ignite: toggleIgnite, stage: separateStage, jettisonLES: separateLES, setSas,
  warp: m => { setWarpIndex(WARPS.indexOf(m)); }, camera: n => { setCamMode(n); },
  ff(sec) { let left = sec; while (left > 1e-9) { const h = Math.min(DTPHYS, left); physStep(h); left -= h; } syncTime(getSimTime()); },
  setThrottle(v) { setTargetThrottle(v); },
  nudge(ax, ay, az) { omega.set(ax, ay, az); },
  teleport(pos, vel, t) { markTeleported(); resetAim(); S.pos.set(...pos); S.v.set(...vel); if (t !== undefined) setSimTime(t); syncTime(getSimTime()); prevPos.copy(S.pos); omega.set(0, 0, 0); },
  reset: resetMission,
  _cam: camera, _pred: predLine, setCam: d => { setCamDist(d); },
};
