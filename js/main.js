import * as THREE from 'three';
import { RE, RM, WARPS, DTPHYS, PAD_POS, SPECS, moonPos } from './constants.js';
import { initWorld, syncTime, updateSky, updateSunShadow, setWeatherVisible, getSpin, groundHeight, fineGroundHeight, moonGroundHeight } from './world.js';
import { stages, lesGroup } from './saturn.js';
import { initVehicle, spawnParticle, addDebris, detachStage, setVisible, updateParticles, updateDebris, updateBurnVisuals, clearDebris, resetStages, plumeLive } from './vehicle.js';
import { S, keys, initPhysics, getState, getSimTime, setSimTime, getEngineOn, getThrottle, getWarpIndex, setWarpIndex, setTargetThrottle, getTargetThrottle, getSasOn, setSas, cycleWarp, toggleSas, toggleSasRetro, activeStage, isBurning, accelAt, physStep, toggleIgnite, separateStage, separateLES, addDistFlown, resetSim, markTeleported, airDensity, groundVel, omega, getControlAuthority, toggleRcsAssist, toggleHold, deployChute, getArmSwing, guardWarp, aeroState, getAeroLoad, stability } from './physics.js';
import { camera, initCamera, cycleCamera, updateCamera, resetCameraView, setCamMode, setCamDist, setCamView, resizeCamera, setMap, isMap, cycleMapFocus } from './camera.js';
import { initMapView, updateMapView } from './mapview.js';
import { updateChutes } from './chutes.js';
import { updateGear } from './gear.js';
import { setOrigin } from './origin.js';
import { setArmSwing } from './pad.js';
import { initHUD, addLog, updateHUD, toggleMapView, endOverlay, setWarn, hideOverlay, clearLog } from './hud.js';
import { audioInit, audioEngine, audioThud, audioExplosion, audioWin, updateAudio } from './audio.js';
import { updateAim, resetAim } from './targeting.js';
import { initHalfRes, occlude, renderHalfRes } from './halfres.js';
import { initPredictor, predict, updatePredictor, clearPredictor, predLine } from './predictor.js';

/* ---------------- renderer / scene ---------------- */
const canvas = document.getElementById('gl');
/* Fail where the player can see it. No WebGL2 used to leave the HUD floating over a blank canvas
   with nothing said. */
function fatal(title, text) {
  const o = document.getElementById('overlay');
  o.classList.remove('hidden');
  o.querySelector('h1').firstChild.textContent = title;
  document.getElementById('overlayText').innerHTML = `<div class="brief">${text}</div>`;
  document.getElementById('bigBtn').style.display = 'none';
  window.__fatal = true;
}
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true }); }
catch (err) { fatal('CANNOT START', 'This game needs WebGL 2. Your browser or graphics driver did not provide it — try a current Chrome, Edge, Firefox or Safari with hardware acceleration switched on.'); throw err; }
/* Resolution is the one quality knob, and it turns itself: the frame is fill-bound (half the cost is
   pixels), so if frames run long for three seconds the drawing buffer drops a quarter-step of pixel
   ratio, down to 1. It never climbs back by itself — under vsync a fast frame and a barely-made
   frame look the same — but ?scale=<n> pins it, and a reload starts from the top again. */
const SCALE_PIN = Number(new URLSearchParams(location.search).get('scale'));
let pixelRatio = SCALE_PIN > 0 ? Math.min(SCALE_PIN, 3) : Math.min(devicePixelRatio, 2), slowFor = 0;
renderer.setPixelRatio(pixelRatio);
function adaptScale(dtReal) {
  if (SCALE_PIN > 0 || pixelRatio <= 1 || document.hidden) { slowFor = 0; return; }
  slowFor = dtReal > 0.024 ? slowFor + dtReal : Math.max(0, slowFor - dtReal * 2);     // slower than ~42 fps
  if (slowFor > 3) {
    slowFor = 0; pixelRatio = Math.max(1, pixelRatio - 0.25);
    renderer.setPixelRatio(pixelRatio); renderer.setSize(innerWidth, innerHeight);
    addLog(`RENDER SCALE ${pixelRatio.toFixed(2)} — KEEPING THE FRAME RATE`);
  }
}
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
  resetSim(); retrue();
  syncTime(getSimTime());   // resetSim zeroes the mission clock; the bodies have to move back too
  resetCameraView();
  hideOverlay();
  document.body.classList.remove('map');   // a reset returns to the flight screen, even from the map
  setMap(false);
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
  stages,
  hooks: { addLog, showEndOverlay: endOverlay },
  relief: { earth: fineGroundHeight, moon: moonGroundHeight },   // the functions the drawn patches are built from
  audio: { engine: audioEngine, thud: audioThud, explosion: audioExplosion, win: audioWin },
  vehicleOps: { spawnParticle, addDebris, detachStage, setVisible, les: lesGroup },
});
initPredictor({ scene, groundE: groundHeight, groundM: moonGroundHeight, setWarn });
initCamera(canvas, addLog);
scene.add(camera);                        // so it takes the floating-origin shift with everything else
initMapView(scene);
initHUD({ resetMission });
initHalfRes(scene, plumeLive);
occlude(scene);          // every opaque mesh built so far hides the half-resolution layer

addEventListener('keydown', e => {
  let k = e.key.toLowerCase();
  if (k === '}') k = ']'; else if (k === '{') k = '[';       // SHIFT is the throttle: warp must still work while it is held
  /* A focused chip or button takes SPACE and ENTER for itself, as any button does. */
  if (e.target && e.target.tagName === 'BUTTON' && (k === ' ' || k === 'enter')) return;
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', '-', '='].includes(k) || (k === ']' || k === '[')) e.preventDefault();
  if (e.repeat) return; keys[k] = true;
  if (!audioArmed) { audioArmed = true; audioInit(); }          // browsers gate sound on a user gesture
  const mode = getState();
  if (mode === 'won' || mode === 'lost') {
    if (k === 'enter' || k === ' ' || k === 'r') resetMission();
    return;
  }
  if (k === '?' || k === '/') { document.getElementById('helpCard').classList.toggle('on'); return; }
  if (k === 'escape' && document.getElementById('helpCard').classList.contains('on')) { document.getElementById('helpCard').classList.remove('on'); return; }
  /* Paused is for looking: the view, the map, the clock and the help work; the ship's switches wait. */
  if (WARPS[getWarpIndex()] === 0 && [' ', 'x', 'g', 'p', 'v', 'h', 't'].includes(k)) { addLog('PAUSED — ESC OR ] TO RESUME', 'warn'); return; }
  if (k === ' ') toggleIgnite();
  else if (k === 'x') dropStage();
  else if (k === 'p') toggleSas();
  else if (k === 'v') toggleSasRetro();
  else if (k === 't') toggleRcsAssist();
  else if (k === ']') cycleWarp(1);
  else if (k === '[') cycleWarp(-1);
  else if (k === 'c') cycleCamera();
  else if (k === 'm') setMap(toggleMapView());
  else if (k === 'f') cycleMapFocus();
  else if (k === 'h') toggleHold();
  else if (k === 'g') deployChute();
  else if (k === 'r') resetMission();
  else if (k === 'escape' || k === 'pause') { setWarpIndex(WARPS[getWarpIndex()] === 0 ? WARPS.indexOf(1) : 0); addLog(WARPS[getWarpIndex()] === 0 ? 'PAUSED — ESC TO RESUME' : 'RESUMED'); }
});
addEventListener('keyup', e => { const k = e.key.toLowerCase(); keys[k] = false; if (k === 'shift') keys['}'] = keys['{'] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

/* X drops a stage for good, and one slip of a finger used to throw away a burning S-1 with 74 % of
   its propellant. A stage that still holds more than 5 % wants X twice within two seconds. */
let xArmed = 0;
function dropStage() {
  const i = activeStage();
  if (getState() === 'flying' && i >= 0 && stages[i].fuel / SPECS[i].fuel > 0.05 && performance.now() - xArmed > 2000) {
    xArmed = performance.now();
    addLog(`${Math.round(stages[i].fuel / SPECS[i].fuel * 100)}% PROPELLANT STILL IN THIS STAGE — X AGAIN TO DROP IT ANYWAY`, 'warn');
    return;
  }
  xArmed = 0; separateStage();
}

/* ---------------- main loop ---------------- */
let last = performance.now(), prevPos = PAD_POS.clone();
let predTick = 0;
/* Between frames S holds the DRAWN state — the last two physics steps blended — and the mission
   clock reads the drawn instant, so everything that renders (camera, vehicle, HUD, Moon, weather)
   agrees with everything else. T is the true state; toTrue() puts it back before physics runs
   again. Anything that replaces the state from outside a frame (reset, teleport, ff) calls
   retrue() so its new state is not overwritten by a stale T. */
const T = { pos: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), t: 0 };
const P0 = { pos: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion() };
let bank = 0, shown = false, prevValid = false, lastDraw = 0;
function show(alpha) {
  T.pos.copy(S.pos); T.v.copy(S.v); T.q.copy(S.q); T.t = getSimTime();
  S.pos.lerpVectors(P0.pos, T.pos, alpha); S.v.lerpVectors(P0.v, T.v, alpha); S.q.slerpQuaternions(P0.q, T.q, alpha);
  setSimTime(T.t - (1 - alpha) * DTPHYS);
  shown = true;
}
function toTrue() { if (shown) { S.pos.copy(T.pos); S.v.copy(T.v); S.q.copy(T.q); setSimTime(T.t); shown = false; } }
function retrue() { shown = false; prevValid = false; bank = 0; lastDraw = getSimTime(); }
const _gv = new THREE.Vector3();

function frame() {
  if (window.__frameErr) return;
  requestAnimationFrame(frame);
  const now = performance.now();
  const dtReal = Math.min(.1, (now - last) / 1000); last = now;
  adaptScale(dtReal);
  try {

  /* Paused (warp 0): nothing advances — not the physics, the planets, the exhaust or the debris —
     but the camera, the map and the HUD stay live, so a pause is for looking around. */
  guardWarp();
  const paused = WARPS[getWarpIndex()] === 0;
  if (!paused) toTrue();
  if (!paused && (getState() === 'pad' || getState() === 'flying')) {
    const simDt = dtReal * WARPS[getWarpIndex()];
    /* THE STEP IS ALWAYS DTPHYS. Frame time is banked and spent in whole 0.1 s steps, so the
       trajectory is the same on a 60 Hz and a 144 Hz display, at x1 and at x1000, and it is the
       trajectory tools/mission-sim.mjs certifies. (It used to step at the frame time below x6 —
       1/60 s at x1 — and an independent review flew the certified window that way with the tool's
       own autopilot: Moon impact at 2,559 m/s instead of a 346 km pass.) What is DRAWN is the
       state blended between the last two steps (see show()), or a 10 Hz physics would stutter.
       At most 600 steps a frame; a frame too slow for the warp falls behind it.
       One exception: standing on the pad with the engines cold and the throttle shut, a step is
       an exact rotation with the planet at any size, so the frame is one step and x10000 is free. */
    const idle = getState() === 'pad' && !getEngineOn() && !keys['shift'] && getTargetThrottle() < 0.05;
    if (idle) { physStep(simDt); bank = 0; prevValid = false; }
    else {
      bank = Math.min(bank + simDt, 600 * DTPHYS);
      while (bank >= DTPHYS && (getState() === 'pad' || getState() === 'flying')) {
        P0.pos.copy(S.pos); P0.v.copy(S.v); P0.q.copy(S.q); prevValid = true;
        physStep(DTPHYS); bank -= DTPHYS;
      }
    }
    if (getState() === 'flying') addDistFlown(S.pos.distanceTo(prevPos));
    prevPos.copy(S.pos);
    if (!idle && prevValid && (getState() === 'pad' || getState() === 'flying')) show(bank / DTPHYS);
    /* One clock: the planets, the weather and the terrain lookups stand where the DRAWN instant
       puts them (world.js used to keep its own, advanced separately). */
    const tDraw = getSimTime(), stepped = Math.max(0, Math.min(tDraw - lastDraw, simDt + DTPHYS)); lastDraw = tDraw;
    syncTime(tDraw);

    // visuals follow physics
    updateBurnVisuals({ pos: S.pos, quat: S.q, vel: S.v, throttle: getThrottle(), activeIdx: activeStage(), burn: isBurning(), omega });
    updateDebris(stepped, accelAt);
    {
      const rho = airDensity(Math.max(0, S.pos.length() - RE)) / airDensity(0), sp = groundVel(_gv).length();
      updateAudio({ burning: isBurning(), throttle: getThrottle(), rho, q: Math.min(1, rho * sp * sp / 0.05) });
    }
    /* The path is re-integrated five times a second and DRAWN every frame (updatePredictor, below,
       once the camera has moved): the integration is the slow clock, the ribbon is not. */
    predTick += dtReal; if (predTick > .2) { predTick = 0; if (getState() === 'flying') predict(); }
    updateAim();   // predicted lunar aim; spends a fixed step budget per frame and self-throttles
  }
  else if (!paused) { syncTime(getSimTime()); }
  if (getState() === 'won' || getState() === 'lost') updateAudio({ burning: false, throttle: 0, rho: 0, q: 0 });   // no wind under the end card
  if (!paused) updateParticles(Math.min(1, dtReal * WARPS[getWarpIndex()]));
  updateCamera(dtReal, paused);
  if (paused) updateAudio({ burning: false, throttle: 0, rho: 0, q: 0 });   // and the engine is silent
  if (getState() === 'flying') updatePredictor(camera); else clearPredictor();
  updateHUD(dtReal);
  /* The sky belongs to where the EYE is: on the map that is space, whatever air the ship is in. */
  setWeatherVisible(!isMap() && !window.__noWeather);   // __noWeather: tools/flicker-test.mjs isolates the weather
  updateSky(isMap() ? camera.position : S.pos, camera.position);
  updateSunShadow(S.pos);
  updateMapView(isMap(), dtReal);
  updateChutes();
  updateGear();
  setArmSwing(getArmSwing());
  setOrigin(scene, camera.position, getSpin());   // draw from where the eye is, in the Earth's axes: js/origin.js
  renderHalfRes(renderer, scene, camera);   // weather and exhaust, at a quarter of the pixels
  renderer.render(scene, camera);
  } catch (err) {
    /* One exception used to freeze the picture for good with a single console line. */
    if (!window.__frameErr) { window.__frameErr = true; console.error('LUNAR LIFT frame error:', err); fatal('SOMETHING BROKE', `The game hit an error and stopped: <b>${String(err && err.message || err).slice(0, 160)}</b><br>Reload the page to fly again.`); }
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
  warp: m => { const k = WARPS.indexOf(m); if (k >= 0) setWarpIndex(k); }, camera: n => { setCamMode(n); }, map: on => { document.body.classList.toggle('map', on); setMap(on); },
  ff(sec) { toTrue(); let left = sec; while (left > 1e-9) { const h = Math.min(DTPHYS, left); physStep(h); left -= h; } retrue(); syncTime(getSimTime()); },
  setThrottle(v) { setTargetThrottle(v); },
  nudge(ax, ay, az) { omega.set(ax, ay, az); },
  teleport(pos, vel, t) { toTrue(); markTeleported(); resetAim(); S.pos.set(...pos); S.v.set(...vel); if (t !== undefined) setSimTime(t); syncTime(getSimTime()); prevPos.copy(S.pos); omega.set(0, 0, 0); retrue(); },
  reset: resetMission,
  _cam: camera, _pred: predLine, setCam: d => { setCamDist(d); }, setView: setCamView,
};
