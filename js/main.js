import * as THREE from 'three';
import { RE, RM, MOON, WARPS, DTPHYS, PAD_POS } from './constants.js';
import { initWorld, spinBodies, updateSky } from './world.js';
import { stages, initVehicle, spawnParticle, addDebris, detachStage, setVisible, updateParticles, updateDebris, updateBurnVisuals, clearDebris, resetStages } from './vehicle.js';
import { S, keys, initPhysics, getState, setState, getSimTime, getEngineOn, getThrottle, getWarpIndex, setWarpIndex, setTargetThrottle, getSasOn, setSas, cycleWarp, toggleSas, toggleSasRetro, activeStage, fwd, isBurning, accelAt, physStep, predict, toggleIgnite, separateStage, addDistFlown, pushTrail, resetSim, clearPredictor, markTeleported, predLine } from './physics.js';
import { camera, initCamera, cycleCamera, updateCamera, resetCameraView, setCamMode, setCamDist, resizeCamera } from './camera.js';
import { initHUD, addLog, updateHUD, drawMap, endOverlay, setWarn, hideOverlay, clearLog } from './hud.js';
import { audioInit, audioEngine, audioThud, audioExplosion, audioWin, updateEngineGain } from './audio.js';

/* ---------------- renderer / scene ---------------- */
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04060b);
scene.fog = new THREE.FogExp2(0x04060b, 0);

/* ---------------- overlays / flow ---------------- */
function startMission() {
  hideOverlay();
  if (getState() === 'briefing') setState('pad');
  audioInit();
  if (getState() === 'pad') addLog('VEHICLE IS PAD-READY — SPACE TO IGNITE, THEN HOLD ⇧');
}

function resetMission() {
  clearDebris();
  resetStages();
  resetSim();
  resetCameraView();
  hideOverlay();
  clearLog();
  clearPredictor();
  setWarn(null);
  audioEngine(false);
  addLog('MISSION RESET — PAD-READY');
}

/* ---------------- wiring ---------------- */
initWorld(scene);
initVehicle(scene);
initPhysics({
  scene,
  stages,
  hooks: { addLog, showEndOverlay: endOverlay, setWarn },
  audio: { engine: audioEngine, thud: audioThud, explosion: audioExplosion, win: audioWin },
  vehicleOps: { spawnParticle, addDebris, detachStage, setVisible },
});
initCamera(canvas, addLog);
initHUD({ startMission, resetMission });

addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k) || (k === ']' || k === '[')) e.preventDefault();
  if (e.repeat) return; keys[k] = true;
  const mode = getState();
  if (mode === 'briefing' || mode === 'won' || mode === 'lost') {
    if (k === 'enter' || k === ' ') { mode === 'briefing' ? startMission() : resetMission(); }
    return;
  }
  if (k === ' ') toggleIgnite();
  else if (k === 'x') separateStage();
  else if (k === 'p') toggleSas();
  else if (k === 'v') toggleSasRetro();
  else if (k === ']') cycleWarp(1);
  else if (k === '[') cycleWarp(-1);
  else if (k === 'c') cycleCamera();
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
    let steps = Math.min(600, Math.round(simDt / DTPHYS));
    const h = simDt / steps;
    for (let s = 0; s < steps; s++) physStep(h);
    if (getState() === 'flying') addDistFlown(S.pos.distanceTo(prevPos));
    prevPos.copy(S.pos);
    spinBodies(simDt);

    if (getState() === 'flying') { trailTick += simDt; if (trailTick > 0.8) { trailTick = 0; pushTrail(S.pos.clone()); } }

    // visuals follow physics
    updateBurnVisuals({ pos: S.pos, quat: S.q, vel: S.v, throttle: getThrottle(), activeIdx: activeStage(), burn: isBurning(), fwd });
    updateDebris(simDt, accelAt);
    updateEngineGain(isBurning(), Math.max(0, S.pos.length() - RE));
    predTick += dtReal; if (predTick > .35) { predTick = 0; if (getState() === 'flying') predict(); }
  }
  updateParticles(dtReal);
  updateCamera(dtReal);
  updateHUD(dtReal);
  updateSky(S.pos);
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
  state: () => ({ state: getState(), simTime: getSimTime(), altE: S.pos.length() - RE, altM: S.pos.distanceTo(MOON) - RM,
    radialM: S.v.dot(new THREE.Vector3().subVectors(S.pos, MOON).normalize()),
    speed: S.v.length(), fuel: stages.map(s => s.fuel), separated: stages.map(s => s.separated),
    engineOn: getEngineOn(), throttle: getThrottle(), sasOn: getSasOn() }),
  ignite: toggleIgnite, stage: separateStage, setSas,
  warp: m => { setWarpIndex(WARPS.indexOf(m)); }, camera: n => { setCamMode(n); },
  ff(sec) { let left = sec; while (left > 1e-9) { const h = Math.min(DTPHYS, left); physStep(h); left -= h; } },
  setThrottle(v) { setTargetThrottle(v); },
  teleport(pos, vel) { markTeleported(); S.pos.set(...pos); S.v.set(...vel); prevPos.copy(S.pos); },
  reset: resetMission, start: startMission,
  _cam: camera, _pred: predLine, setCam: d => { setCamDist(d); },
};
