import * as THREE from 'three';
import { RE, RM, WARPS, DTPHYS, PAD_POS, moonPos } from './constants.js';
import { initWorld, spinBodies, syncTime, updateSky, updateSunShadow, groundHeight, moonGroundHeight } from './world.js';
import { stages, lesGroup } from './saturn.js';
import { initVehicle, spawnParticle, addDebris, detachStage, setVisible, updateParticles, updateDebris, updateBurnVisuals, clearDebris, resetStages, plumeLive } from './vehicle.js';
import { S, keys, initPhysics, getState, getSimTime, setSimTime, getEngineOn, getThrottle, getWarpIndex, setWarpIndex, setTargetThrottle, getSasOn, setSas, cycleWarp, toggleSas, toggleSasRetro, activeStage, fwd, isBurning, accelAt, physStep, toggleIgnite, separateStage, separateLES, addDistFlown, pushTrail, resetSim, markTeleported, airDensity, groundVel, omega, getControlAuthority, toggleRcsAssist, aeroState, getAeroLoad, stability } from './physics.js';
import { camera, initCamera, cycleCamera, updateCamera, resetCameraView, setCamMode, setCamDist, resizeCamera } from './camera.js';
import { initHUD, addLog, updateHUD, drawMap, toggleMapView, endOverlay, setWarn, hideOverlay, clearLog } from './hud.js';
import { audioInit, audioEngine, audioThud, audioExplosion, audioWin, updateAudio } from './audio.js';
import { updateAim, resetAim } from './targeting.js';
import { initHalfRes, occlude, renderHalfRes } from './halfres.js';
import { initPredictor, predict, updatePredictor, clearPredictor, predLine } from './predictor.js';

/* ---------------- renderer / scene ---------------- */
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
/* Flat output. ACES filmic was compressing and desaturating everything, which is what turned the
   ocean charcoal; cel shading wants the palette exactly as authored.

   Shadows are PCF-filtered, not Basic. BasicShadowMap compared one texel, and the box tracking the
   vehicle is ±6 km at the pad — 5.9 m per texel at 2048² — so the launch tower's 2 m shadow arrived as
   a black staircase marching across the pad, worst at a low sun where it runs for kilometres. The
   thing the old comment was protecting is the *cloud* shade, which is not a shadow-map caster at all
   (js/clouds.js marches its own optical depth into the ground materials), so filtering the map
   cannot blur it away. What the cel look
   needs from the map is the terminator on the planet, and that comes from the ramp, not from the die.

   PCFShadowMap, not PCFSoftShadowMap: measured over 90 rAF deltas at the pad, the soft variant cost
   p90 17.9 ms against 17.1 here, and its wider kernel took the edge off the tower shadows that the
   drawn look wants to keep. logarithmicDepthBuffer is not an obstacle either way — the shadow compare
   uses vShadowCoord from the light's own projection, which the camera's depth encoding never touches. */
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04060b);
scene.fog = new THREE.FogExp2(0x04060b, 0);

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
initPhysics({
  scene,
  stages,
  hooks: { addLog, showEndOverlay: endOverlay },
  relief: { earth: groundHeight, moon: moonGroundHeight },
  audio: { engine: audioEngine, thud: audioThud, explosion: audioExplosion, win: audioWin },
  vehicleOps: { spawnParticle, addDebris, detachStage, setVisible, les: lesGroup },
});
initPredictor({ scene, groundE: groundHeight, groundM: moonGroundHeight, setWarn });
initCamera(canvas, addLog);
initHUD({ resetMission });
initHalfRes(scene, plumeLive);
occlude(scene);          // every opaque mesh built so far hides the half-resolution layer

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
  else if (k === 't') toggleRcsAssist();
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
const _gv = new THREE.Vector3();

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
    updateDebris(simDt, accelAt);
    {
      const rho = airDensity(Math.max(0, S.pos.length() - RE)) / airDensity(0), sp = groundVel(_gv).length();
      updateAudio({ burning: isBurning(), throttle: getThrottle(), rho, q: Math.min(1, rho * sp * sp / 0.05) });
    }
    /* The path is re-integrated five times a second and DRAWN every frame (updatePredictor, below,
       once the camera has moved): the integration is the slow clock, the ribbon is not. */
    predTick += dtReal; if (predTick > .2) { predTick = 0; if (getState() === 'flying') predict(); }
    updateAim();   // predicted lunar aim; spends a fixed step budget per frame and self-throttles
  }
  updateParticles(Math.min(1, dtReal * WARPS[getWarpIndex()]));
  updateCamera(dtReal);
  if (getState() === 'flying') updatePredictor(camera); else clearPredictor();
  updateHUD(dtReal);
  updateSky(S.pos, camera.position);
  updateSunShadow(S.pos);
  drawMap();
  renderHalfRes(renderer, scene, camera);   // weather and exhaust, at a quarter of the pixels
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
    omega: [omega.x, omega.y, omega.z], authority: getControlAuthority().py,
    aero: { q: aeroState.q, mach: aeroState.mach, aoa: aeroState.aoa, load: getAeroLoad(), margin: stability() } }),
  ignite: toggleIgnite, stage: separateStage, jettisonLES: separateLES, setSas,
  warp: m => { setWarpIndex(WARPS.indexOf(m)); }, camera: n => { setCamMode(n); },
  ff(sec) { let left = sec; while (left > 1e-9) { const h = Math.min(DTPHYS, left); physStep(h); left -= h; } syncTime(getSimTime()); },
  setThrottle(v) { setTargetThrottle(v); },
  nudge(ax, ay, az) { omega.set(ax, ay, az); },
  teleport(pos, vel, t) { markTeleported(); resetAim(); S.pos.set(...pos); S.v.set(...vel); if (t !== undefined) setSimTime(t); syncTime(getSimTime()); prevPos.copy(S.pos); omega.set(0, 0, 0); },
  reset: resetMission,
  _cam: camera, _pred: predLine, setCam: d => { setCamDist(d); },
};
