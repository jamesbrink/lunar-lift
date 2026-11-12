import * as THREE from 'three';
import { G0, RE, RM, MU_E, MU_M, SOI_M, MOON_DIST, WARPS, SPECS, CAPSULE_MASS, LAND_SAFE, SAFE_EARTH, TLI_LEAD, MOON_RATE, MOON_U, MOON_V, moonPos } from './constants.js';
import { stages } from './saturn.js';
import { S, getState, getSimTime, getEngineOn, getThrottle, getWarpIndex, getSasOn, getSasRetro, getDistFlown, getMaxQ, activeEngine, orbitalElements, groundVel, bodyUp, navVel, surfaceAlt, aeroState, getAeroLoad, getRcsAssist, getHold, getStrain, getChute, getHeat, getCooking, isCapsule, getCsmParked, getDocked, getLandedOnMoon, HEAT_SHIELD, CHUTE, totalMass, landing, LOAD_LIMIT_STACK, LOAD_LIMIT_CSM } from './physics.js';
import { getCamMode, getMapFocus } from './camera.js';
import { isMuted } from './audio.js';
import { initNavball, updateNavball } from './navball.js';
import { aim, CORRIDOR } from './targeting.js';

const $ = id => document.getElementById(id);

/* Toast state machine. The old path was one 9 s `logfade` per element: 70→100 % of the keyframes
   is opacity 1→0, so every toast sat visible-but-mid-alpha for 2.7 s (measured: 10 of 40
   250 ms-sampled frames contained a strictly-mid-alpha child), the stack cap was 3, and nothing
   bounded a toast across a phase boundary — 'MISSION RESET — PAD-READY' was still on screen at
   68 km ascent under a 3-banner pileup. New lifecycle, all state on the element (dataset/class),
   DOM is the single store:
     live          ≤ TOAST_MAX at all times; the oldest live line is removed SAME FRAME on
                   overflow (no fade-out on eviction — removal is instantaneous).
     expire        after TOAST_LIFE the line gets class 'out'; CSS fades it in TOAST_FADE ms
                   and the animationend handler removes it in the same task the fade hits 0,
                   so a half-alpha element lives ≤ .16 s (was ≤ 2.7 s).
     transition    ignite/staging/SOI flips (detected in updateHUD) purge every line older than
                   TOAST_GRACE with same-frame removal. The grace window keeps the line the
                   transition itself logs — physics.js logs on the event tick and updateHUD
                   samples at 10 Hz, so the transition message is always younger than ~100 ms. */
const TOAST_LIFE = 4500;   // ms at full opacity
const TOAST_FADE = 160;    // ms fade-out; matches the .logline.out keyframe duration
const TOAST_MAX = 2;       // live banner cap
const TOAST_GRACE = 350;   // ms; messages younger than this survive a transition purge

export function addLog(msg, cls = '') {
  const el = document.createElement('div');
  el.className = 'logline ' + cls;
  el.textContent = msg;
  el.dataset.born = String(performance.now());
  el.addEventListener('animationend', e => { if (e.animationName === 'logfadeout') el.remove(); });
  const box = $('log');
  box.prepend(el);
  const live = [...box.children].filter(c => !c.classList.contains('out'));
  while (live.length > TOAST_MAX) live.pop().remove();
}

function purgeToasts() {
  const box = $('log'), now = performance.now();
  for (const c of [...box.children]) if (now - +c.dataset.born > TOAST_GRACE) c.remove();
}

function sweepToasts() {   // called every frame from updateHUD, ahead of its 10 Hz gate
  const box = $('log'), now = performance.now();
  for (const c of box.children) {
    const age = now - +c.dataset.born;
    if (c.classList.contains('out')) {
      if (age > TOAST_LIFE + TOAST_FADE + 400) c.remove();   // animationend backstop (hidden tab)
    } else if (age > TOAST_LIFE) c.classList.add('out');
  }
}

export function buildStagePips() {
  const box = $('stagePips'); box.innerHTML = '';
  stages.forEach((st, i) => {
    const row = document.createElement('div'); row.className = 'stageRow'; row.id = 'pip' + i;
    row.innerHTML = `<span class="pip"></span><span class="name">${SPECS[i].name}</span><span class="bar"><i style="width:100%"></i></span><span class="dv"></span>`;
    box.appendChild(row);
  });
}

/* MET is mission-elapsed time in real seconds */
export function fmtMET(t) {
  const s = Math.max(0, Math.round(t));
  return [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map(n => String(n).padStart(2, '0')).join(':');
}

export function setWarn(text) {
  const el = $('warn');
  if (text === null) { el.style.display = 'none'; return; }
  el.style.display = 'block'; el.textContent = text;
}

export function hideOverlay() { $('overlay').classList.add('hidden'); $('again').style.display = 'none'; }
export function clearLog() { $('log').innerHTML = ''; }

export function endOverlay(title, body, btn) {
  const rating = getState() === 'won' ? debrief() : '';
  const stats = `MET ${fmtMET(getSimTime())}   ·   ${Math.round(getDistFlown()).toLocaleString()} km flown   ·   max-Q ${(getMaxQ() / 1000).toFixed(1)} kPa`;
  $('overlayText').innerHTML = `<div class="brief">${body}</div>${rating}<div class="stats">${stats}</div>`;
  $('overlayCard').querySelector('h1').firstChild.textContent = title;
  $('bigBtn').textContent = btn;
  $('overlay').classList.remove('hidden');
}

/* The one line under the clock: what to do now, with the key that does it. Derived from the same
   state the readouts show — nothing here is scripted to a clock, so it is right for any flight. */
const K = k => `<kbd>${k}</kbd>`;
function nextStep({ state, engineOn, live, i, dry, altE, alt, nearMoon, el, radial, speed, parked, docked, moonLanded }) {
  if (state === 'pad') return engineOn ? ['Liftoff — climb straight, the tower is right beside you', 'ok']
    : [`${K('SPACE')} ignite · then ${K('P')} lets SAS fly the ascent`];
  if (state !== 'flying') return [''];
  if (i < 0 && !nearMoon) {                       // the command module alone: coming home
    const q = aeroState.q, ch = getChute();
    if (getCooking() > 0.05) return [`HEAT SHIELD FORWARD — ${K('V')} ${K('P')} retrograde, now`, 'bad'];
    if (ch === 2) return [`Under the mains — ${Math.abs(radial * 1000).toFixed(0)} m/s down, splashdown limit ${SAFE_EARTH * 1000} m/s`, 'ok'];
    if (ch < 0) return ['Parachutes are gone — nothing left to slow you', 'bad'];
    if (altE > 120) return el.pe > 60 ? [`Capsule only. To come home: retrograde burn is gone — you need a path that meets the air (periapsis ${Math.round(el.pe)} km)`, 'warn']
      : [`Re-entry ahead — heat shield first: ${K('V')} ${K('P')} retrograde before the air; ${K('G')} is for later`];
    if (ch === 1) return q < CHUTE.mains.tear * 0.8 && altE < 6 ? [`${K('G')} MAIN PARACHUTES — now`, 'ok']
      : [`Drogues out — mains (${K('G')}) below 6 km and under ${CHUTE.mains.tear / 1000} kPa: now ${altE.toFixed(1)} km, ${(q / 1000).toFixed(1)} kPa`];
    if (q < CHUTE.drogue.tear * 0.8 && altE < 12 && radial < 0) return [`${K('G')} DROGUE CHUTES — now`, 'ok'];
    if (altE > 12 && altE <= 120 && getHeat() <= HEAT_SHIELD) return [`Falling through ${altE.toFixed(0)} km — nothing to do yet: heat shield first, drogues (${K('G')}) below 12 km`];
    return getHeat() > HEAT_SHIELD ? [`Entry — heat shield is taking it. Ride it out; drogues under ${CHUTE.drogue.tear / 1000} kPa (now ${(q / 1000).toFixed(0)})`, 'warn']
      : [`Falling — drogues (${K('G')}) once under ${CHUTE.drogue.tear / 1000} kPa and below 12 km: now ${(q / 1000).toFixed(1)} kPa`];
  }
  if (dry) return i === 2 ? ['Out of propellant — you are a passenger now', 'bad'] : [`Tank empty — ${K('X')} drop the stage`, 'warn'];
  /* ---- the round trip, in the order the flight meets them ---- */
  if (nearMoon && !parked && !docked && i === 2 && !el.escape && el.pe > 100)
    return [`Lunar orbit ✓ — ${K('L')} demates the LM: the CSM stays parked up here, you take the lander down`, 'ok'];
  if (moonLanded) return [`${K('⇧')} open the throttle to lift off — then build speed ACROSS the ground: about 1,670 m/s at 20 km is orbit`, 'ok'];
  if (parked && i >= 3 && live && radial > -0.002)
    return [`Ascent — ${Math.round(Math.sqrt(Math.max(0, speed * speed - radial * radial)) * 1000).toLocaleString()} m/s across the ground; orbit is ~1,670. The CSM docks with you inside 1 km at under 50 m/s`, 'ok'];
  if (parked && i >= 3 && el.pe > 60)
    return [`Coasting at ${alt.toFixed(0)} km over the Moon — burn retrograde to go down to it, or find the parked CSM: within 1 km, under 50 m/s relative, the docks engage`, 'ok'];
  if (docked && nearMoon) {
    /* The way home, by what is still bolted on — the docked flag is sticky and the inbound
       prompts below (deorbit, capture) would talk a returning crew back out of their own TEI. */
    if (stages.length > 4 && !stages[4].separated) return live ? [`Cut the engine (${K('SPACE')}) and drop the ascent stage (${K('X')}) before the burn home — it is 4 t of dead weight`, 'warn']
      : [`Docked ✓ — ${K('X')} jettisons the ascent stage. Then ${K('P')} prograde to escape the Moon — burn so you leave BEHIND it, against its motion round the Earth`, 'ok'];
    if (el.escape) return live ? [`Escaping the Moon ✓ — cut the engine (${K('SPACE')}); trim the Earth periapsis once outside the Moon's sphere`, 'ok']
      : ['Leaving the Moon — coast out of its sphere, then check the Earth periapsis: under 60 km is the way home', 'ok'];
    if (el.pe > 0) return live ? ['Trans-Earth injection — keep burning prograde until you are escaping the Moon', 'ok']
      : [`${K('P')} prograde and burn to escape the Moon — leave BEHIND it, against its motion round the Earth, and the Earth periapsis falls`, 'ok'];
  }
  if (nearMoon) {
    const vs = -radial * 1000;
    if (el.escape || el.pe > 0 && !el.escape && el.ap > SOI_M) return [`Capture: ${K('V')} retrograde, ${K('P')} SAS, burn at the lowest point (${Math.round(el.pe)} km)`];
    if (el.pe > 0) return [`In lunar orbit — burn retrograde to drop periapsis below the surface`, 'ok'];
    /* The braking call. Stopping from `speed` at full thrust against lunar gravity takes
       v²/2(a − g) of path; the burn must start before the ground is that close. The margin shown
       is height in hand over that, so 'BRAKE NOW' is a real deadline and a late, hard burn — the
       cheapest landing there is — is something you can learn to fly instead of guess at. */
    const aMax = i >= 0 ? SPECS[i].thrust / totalMass() / 1000 : 0, gM = MU_M / (RM + alt) ** 2;
    const stop = aMax > gM ? speed * speed / (2 * (aMax - gM)) : Infinity;
    if (!live && vs > 5) {
      const margin = alt - stop * 1.15;
      if (!isFinite(stop)) return ['No thrust left to brake with', 'bad'];
      if (margin < 0) return [`BRAKE NOW — full throttle ${K('⇧')}, retrograde ${K('V')} ${K('P')}`, 'bad'];
      if (margin < Math.max(2, speed * 20)) return [`Brake in ${Math.max(0, margin / Math.max(vs / 1000, 1e-4)).toFixed(0)} s — retrograde ${K('V')} ${K('P')}, then ${K('⇧')}`, 'warn'];
      return [`Falling: ${alt.toFixed(alt < 10 ? 1 : 0)} km up, needs ${stop.toFixed(1)} km to stop — coast, stay retrograde`];
    }
    /* Burning with far more room than the stop needs is how a tank is emptied 900 km up: say so. */
    if (live && (vs <= 0 || alt > 2.5 * stop + 5)) return [`Periapsis is below the surface — cut the engine (${K('SPACE')}) and coast down; brake when this line says BRAKE NOW`, 'warn'];
    if (i >= 3 && live && alt < 0.03 && vs < LAND_SAFE * 1000) return [`Contact — cut the engine (${K('SPACE')}): the landing counts when it stops`, 'ok'];
    if (alt > 2) return [`Braking — ${Math.round(speed * 1000)} m/s to lose, ${stop.toFixed(1)} km needed of ${alt.toFixed(1)} km`, stop > alt ? 'bad' : 'ok'];
    return vs > LAND_SAFE * 1000 ? [`BRAKE — ${vs.toFixed(0)} m/s down, touch under ${LAND_SAFE * 1000} m/s`, 'bad']
      : [`Good descent: ${vs.toFixed(0)} m/s — keep it under ${LAND_SAFE * 1000} m/s and upright`, 'ok'];
  }
  if (altE < 120 && el.ap < 140 && !live) return [`Engine is off and you are not in orbit — ${K('SPACE')} to relight`, 'bad'];
  if (altE < 120 && el.ap < 140 && getSasOn() && getSasRetro()) return [`SAS is aiming RETROGRADE — ${K('V')} to point it prograde`, 'warn'];
  if (altE < 120 && el.ap < 140) return getSasOn() ? ['SAS is flying the gravity turn — watch apoapsis climb', 'ok']
    : [`${K('P')} SAS flies the gravity turn — or pitch east by hand with ${K('D')}`];
  if (el.escape || el.ap > MOON_DIST * 0.9) {
    /* The pass figure is live, engine lit or not (js/targeting.js): while burning it is the pass you
       would get by cutting NOW, which is how the burn is ended — on the number, not on a guess. */
    const pass = aim.altKm, txt = !isFinite(pass) ? '…' : pass < 0 ? 'IMPACT' : Math.round(pass).toLocaleString() + ' km';
    const rMoon = S.pos.distanceTo(moonPos(getSimTime(), new THREE.Vector3()));
    if (isFinite(aim.tMet) && aim.tMet - getSimTime() < 300 && rMoon > SOI_M && !live)
      return [`The Moon is behind you — closest pass was ${txt}. ${K('R')} restarts the mission`, 'bad'];
    if (live && getSasOn() && !getSasRetro() && !aim.corridor) return [`Translunar burn — SAS guidance cuts the engine on the lunar pass (now ${txt}) · apoapsis ${el.escape ? 'ESCAPE' : Math.round(el.ap).toLocaleString() + ' of 384,400 km'}`, 'ok'];
    if (live) return aim.corridor ? [`CUT THE ENGINE NOW — ${K('SPACE')} — lunar pass ${txt} is in the corridor`, 'ok']
      : [`Translunar burn — pass if you cut now: ${txt} (want ${CORRIDOR.lo}–${CORRIDOR.hi}) · apoapsis ${el.escape ? 'ESCAPE' : Math.round(el.ap).toLocaleString() + ' of 384,400 km'}`, pass < 0 || el.escape ? 'bad' : ''];
    if (aim.corridor) return [`On course: ${txt} lunar pass — warp with ${K(']')} and coast`, 'ok'];
    const t = aim.trim, how = Math.abs(t) < 0.3 ? '' : ` — trim ${t > 0 ? 'PROGRADE' : 'RETROGRADE'} about ${Math.abs(t) < 10 ? Math.abs(t).toFixed(1) : Math.round(Math.abs(t))} m/s (${t > 0 ? K('P') : K('V') + ' ' + K('P')}, a touch of ${K('⇧')}, watch this number)`;
    return [`Lunar pass ${txt} — want ${CORRIDOR.lo}–${CORRIDOR.hi}${how || ': too far off for a small trim'}`, pass < 0 ? 'bad' : 'warn'];
  }
  if (el.pe < 140) return live ? [`Keep burning prograde until periapsis clears 150 km (now ${el.pe < 0 ? 'below ground' : Math.round(el.pe) + ' km'})`]
    : [`Not in orbit yet — burn prograde (${K('P')} + ${K('⇧')}) near apoapsis to raise periapsis`, 'warn'];
  return live ? (el.ap < 2000 && tliWait() > 240 && tliWait() < 2400 ? [`In orbit ✓ — cut the engine (${K('SPACE')}): the Moon is not in position yet`, 'warn'] : [`Translunar burn — hold prograde until apoapsis reaches the Moon (${Math.round(el.ap).toLocaleString()} km)`])
    : tliCue();
}

/* Debrief: a landing is graded on what a pilot controls. Touchdown speed and tilt are the skill,
   propellant left is the efficiency; stars are thresholds, the score breaks ties, and the best
   score is kept in this browser so there is a number to beat. */
function debrief() {
  const { speed, tilt, fuel, home, flyby, landedOnMoon } = landing;
  if (home) return `<div class="rating"><div class="stars">${landedOnMoon ? '★★★' : flyby ? '★★' : '★'}<i>${landedOnMoon ? '' : flyby ? '★' : '★★'}</i></div><div class="marks">${speed.toFixed(1)} m/s splashdown${landedOnMoon ? ' · walked on the Moon and came back' : flyby ? ' · lunar flyby' : ''}</div><div class="marks dim">${landedOnMoon ? 'The full round trip.' : '★★★ is a landing on the Moon.'}</div></div>`;
  const stars = 1 + (speed <= 12 && tilt <= 20 ? 1 : 0) + (speed <= 4 && tilt <= 8 ? 1 : 0);
  const score = Math.max(0, Math.round(1000 - 25 * speed - 6 * tilt + 40 * fuel));
  let best = 0;
  try { best = +localStorage.getItem('lunarlift.best') || 0; if (score > best) localStorage.setItem('lunarlift.best', score); } catch { /* private window */ }
  const line = score > best && best ? `NEW BEST — was ${best.toLocaleString()}` : best ? `best ${Math.max(best, score).toLocaleString()}` : 'first landing on record';
  return `<div class="rating"><div class="stars">${'★'.repeat(stars)}<i>${'★'.repeat(3 - stars)}</i></div>`
    + `<div class="score">${score.toLocaleString()} <small>${line}</small></div>`
    + `<div class="marks">${speed.toFixed(1)} m/s · ${tilt.toFixed(0)}° tilt · ${fuel.toFixed(1)} t left</div>`
    + `<div class="marks dim">${stars < 3 ? (speed > 4 ? '★★★ needs 4 m/s or softer' : '★★★ needs 8° or straighter') : 'Now do it with more propellant left.'}</div></div>`;
}

/* Seconds until the Moon leads the ship by TLI_LEAD along the orbit — when to light the translunar
   burn. The lead closes at the ship's angular rate less the Moon's. */
function tliWait() {
  const ang = v => Math.atan2(v.dot(MOON_V), v.dot(MOON_U));
  const moon = moonPos(getSimTime(), new THREE.Vector3());
  const r2 = S.pos.lengthSq(), w = new THREE.Vector3().crossVectors(S.pos, S.v).length() / r2 - MOON_RATE;
  const lead = ((ang(moon) - ang(S.pos) - TLI_LEAD) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return w > 0 ? lead / w : Infinity;
}
function tliCue() {
  const s = tliWait();
  if (!isFinite(s)) return [`Parking orbit ✓ — burn prograde (${K('P')} + ${K('⇧')}) to reach the Moon`, 'ok'];
  /* The window is a moment, and the burn is long: 'now' is the last minute before it and the first after. */
  const period = 2 * Math.PI / (new THREE.Vector3().crossVectors(S.pos, S.v).length() / S.pos.lengthSq() - MOON_RATE);
  if (s < 45 || s > period - 30) return [`TRANSLUNAR BURN NOW — ${K('P')} prograde, ${K('⇧')} full throttle, until apoapsis reaches the Moon`, 'ok'];
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return [`Parking orbit ✓ — translunar burn in ${m}:${String(sec).padStart(2, '0')} (${K('P')} prograde, then ${K('⇧')}) · warp with ${K(']')}`, s < 120 ? 'warn' : ''];
}

/* Milestones, graded as they happen — the landing is not the only thing a pilot did well or badly.
   Orbit: by the CSM propellant it cost to get there (the certified ascent arrives with 124 t).
   Injection: by where the cut left the lunar pass. Each is announced once per flight. */
const done = { orbit: false, tli: false };
export function resetMilestones() { done.orbit = done.tli = false; }
function milestones({ state, nearMoon, el, live }) {
  if (state !== 'flying' || nearMoon) return;
  if (!done.orbit && !el.escape && el.pe >= 140 && el.ap < MOON_DIST * 0.5) {
    done.orbit = true;
    const csm = stages[2].separated ? 0 : stages[2].fuel, stars = csm >= 118 ? 3 : csm >= 95 ? 2 : 1;
    addLog(`ORBIT ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)} — ${Math.round(el.pe)} × ${Math.round(el.ap).toLocaleString()} km with ${csm.toFixed(0)} t of CSM propellant`, 'good');
  }
  if (!done.tli && !live && (el.escape || el.ap > MOON_DIST * 0.9) && isFinite(aim.altKm) && aim.status === 'done') {
    done.tli = true;
    const p = aim.altKm, stars = aim.corridor ? (p > 200 && p < 500 ? 3 : 2) : p >= 0 && p < 5000 ? 1 : 0;
    addLog(`INJECTION ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)} — lunar pass ${p < 0 ? 'IMPACT' : Math.round(p).toLocaleString() + ' km'}${aim.corridor ? '' : ' — needs a trim'}`, stars >= 2 ? 'good' : 'warn');
  }
}

let hudTick = 0;
let prevFlight = '', prevSoi = null, prevSep = -1;   // toast-purge transition sentinels

export function updateHUD(dt) {
  sweepToasts();
  hudTick += dt; if (hudTick < 0.1) return; hudTick = 0;
  const state = getState(), engineOn = getEngineOn(), throttle = getThrottle();
  const moon = moonPos(getSimTime(), new THREE.Vector3());
  const rE = S.pos.length(), rM = S.pos.distanceTo(moon);
  const altM = rM - RM, altE = rE - RE;
  const nearMoon = rM < SOI_M;
  /* Major phase transitions — ignite (pad → flying), any stage separation, any SOI crossing —
     drop every toast the previous phase left behind (see the state machine above). Detected
     from the same 10 Hz sample that updates the readouts; the first tick only records state. */
  const sepMask = stages.reduce((m, st, k) => m | (st.separated << k), 0);
  if ((prevFlight && state !== prevFlight) || (prevSoi !== null && nearMoon !== prevSoi)
    || (prevSep >= 0 && sepMask !== prevSep)) purgeToasts();
  prevFlight = state; prevSoi = nearMoon; prevSep = sepMask;
  /* Altitude is the height of the lowest attached point over the ground underneath — the number
     contact is judged by (js/physics.js surfaceAlt) — in metres once that is what matters. */
  const alt = Math.max(0, surfaceAlt(nearMoon));
  $('tAlt').textContent = alt < 10 ? `${Math.round(alt * 1000).toLocaleString()} m` : alt < 100 ? `${alt.toFixed(1)} km` : `${Math.round(alt).toLocaleString()} km`;
  /* The speed worth reading changes with where you are: over the ground while there is ground to
     hit or air to push through, around the body once you are in orbit of it. */
  const rel = groundVel(new THREE.Vector3());
  const orbital = !nearMoon && altE > 120;
  const speed = state === 'won' ? 0 : orbital ? navVel(new THREE.Vector3()).length() : rel.length();     // down is down: no frozen last reading
  $('tVelL').textContent = orbital ? 'orbital speed' : nearMoon ? 'surface speed' : 'ground speed';
  $('tVel').textContent = `${Math.round(speed * 1000).toLocaleString()} m/s`;
  const radial = state === 'won' ? 0 : rel.dot(bodyUp(new THREE.Vector3()));
  $('tVs').textContent = `${radial >= 0 ? '+' : '−'}${Math.abs(radial * 1000).toFixed(0)} m/s`;
  const inAir = aeroState.q > 50 && state === 'flying';
  $('air').classList.toggle('on', inAir);
  if (inAir) {
    const load = getAeroLoad(), aoa = aeroState.aoa * 57.2958;
    $('aMach').textContent = aeroState.mach.toFixed(2);
    $('aQ').textContent = `${(aeroState.q / 1000).toFixed(1)} kPa`;
    $('aAoa').textContent = `${aoa.toFixed(0)}°`;
    $('aLoad').textContent = `${load.toFixed(2)} g`;
    const lim = activeEngine() === 2 || activeEngine() < 0 ? LOAD_LIMIT_CSM : LOAD_LIMIT_STACK;
    $('aLoad').className = load > lim || getStrain() > 0.05 ? 'bad' : load > 0.4 * lim ? 'warn' : '';
    $('aAoa').className = aoa > 15 && aeroState.q > 2000 ? 'warn' : '';
  }
  const i = activeEngine();
  const live = engineOn && throttle > .01 && i >= 0 && stages[i].fuel > 0;
  $('thrBig').innerHTML = `${Math.round(throttle * 100)}<span>%</span>`;
  $('thrGauge').firstElementChild.style.height = `${throttle * 100}%`;
  $('thrGauge').classList.toggle('live', live);
  const es = $('engState');
  es.textContent = live ? `${Math.round(SPECS[i].thrust * throttle).toLocaleString()} kN`
    : (engineOn ? 'IGNITING…' : 'ENGINE OFF');
  es.classList.toggle('live', live);
  $('met').textContent = fmtMET(getSimTime());
  const wp = WARPS[getWarpIndex()];
  $('warpInd').textContent = $('vWarp').textContent = wp === 0 ? 'PAUSED' : wp === 1 ? 'REAL TIME' : wp < 1 ? `SLOW ×${wp}` : `×${wp}`;
  $('clock').classList.toggle('paused', wp === 0);
  $('vCam').textContent = getCamMode().toUpperCase();
  $('vSound').textContent = isMuted() ? 'OFF' : 'ON';

  /* Elements must be computed in one frame: near the Moon the position is lunar-relative, so the
     velocity has to be too. Passing inertial S.v with a Moon-centred position made the Ap/Pe
     readout wrong by the Moon's own 1,023 m/s — an "ESCAPE" reading while in a bound 200 km orbit. */
  const el = orbitalElements(nearMoon ? new THREE.Vector3().subVectors(S.pos, moon) : new THREE.Vector3().copy(S.pos),
    navVel(new THREE.Vector3()), nearMoon ? MU_M : MU_E, nearMoon ? RM : RE);
  $('oBody').textContent = nearMoon ? 'MOON' : 'EARTH';
  const km = n => !isFinite(n) ? 'ESCAPE' : n < 0 ? 'IMPACT' : n >= 1000000 ? (n / 1000).toFixed(1) + ' Mm' : Math.round(n).toLocaleString() + ' km';
  /* Standing on the pad there is no orbit to describe: 'apoapsis 0 km, periapsis IMPACT' is noise. */
  const grounded = state === 'pad' || state === 'won';
  $('oPe').textContent = grounded ? '—' : km(el.pe); $('oAp').textContent = grounded ? '—' : km(el.ap);
  $('oMoon').textContent = Math.round(rM).toLocaleString() + ' km' + (nearMoon ? ' · SOI' : '');
  /* Predicted closest lunar approach, from js/targeting.js. The translunar aim is worth about
     130 km of periselene per 1e-3 rad of launch phase and periselene decides whether the landing is
     soft, so this is the number a human has to steer by. Green inside the corridor the mission has
     actually been flown to a soft touchdown in (js/targeting.js CORRIDOR); dim while the look-ahead propagation is
     still running, which it is for most of a frame at high warp. */
  const aimEl = $('oAim');
  if (!isFinite(aim.altKm)) { aimEl.textContent = aim.status === 'na' ? '—' : 'scanning…'; aimEl.className = aim.status === 'na' ? '' : 'run'; }
  else if (aim.altKm < 0) { aimEl.textContent = 'IMPACT in ' + fmtMET(aim.tMet - getSimTime()); aimEl.className = 'impact'; }
  else {
    aimEl.textContent = Math.round(aim.altKm).toLocaleString() + ' km · ' + fmtMET(aim.tMet - getSimTime());
    aimEl.className = aim.corridor ? 'ok' : 'bad';
  }
  $('oSas').textContent = getSasOn() ? 'ON' : 'OFF'; $('mSas').classList.toggle('on', getSasOn());
  $('mDirV').textContent = getSasRetro() ? 'RETRO' : 'PRO'; $('mDir').classList.toggle('on', getSasOn());
  $('mHoldV').textContent = getHold() ? 'ON' : 'OFF'; $('mHold').classList.toggle('on', getHold());
  $('vFocus').textContent = getMapFocus().toUpperCase();
  $('mRcsV').textContent = getRcsAssist() ? 'ON' : 'OFF'; $('mRcs').classList.toggle('on', getRcsAssist());
  const dry = i >= 0 && stages[i].fuel <= 0;
  $('mStageV').textContent = i >= 0 ? (dry ? 'DROP' : SPECS[i].name.split(' ')[0]) : '—';
  const ch = getChute();
  $('mChute').style.display = isCapsule() ? 'flex' : 'none'; $('mStage').style.display = isCapsule() ? 'none' : 'flex';
  $('mChuteV').textContent = ch < 0 ? 'TORN' : ch === 0 ? 'STOWED' : ch === 1 ? 'DROGUE' : 'MAINS';
  $('mChute').classList.toggle('on', ch > 0); $('mChute').classList.toggle('alert', ch < 0);
  $('mStage').classList.toggle('alert', dry && state === 'flying');

  /* Delta-v left in each stage: the rocket equation over what that stage still holds, carrying
     everything stacked above it. Vacuum Isp, so the first stage reads a little generous. While the
     CSM is parked its crew is in the LM, not stacked above the service engine, so the parked stage
     carries nothing — and it holds nothing up, so the LM's figures do not count it either. */
  const parked = getCsmParked();
  const dvs = stages.map(() => 0);
  let above = CAPSULE_MASS;
  for (let k = stages.length - 1; k >= 0; k--) {
    if (stages[k].separated) continue;
    const carries = parked && k === 2 ? 0 : above;
    dvs[k] = SPECS[k].isp * G0 * Math.log((carries + stages[k].dry + stages[k].fuel) / (carries + stages[k].dry));
    if (!(parked && k === 2)) above += stages[k].dry + stages[k].fuel;
  }
  stages.forEach((st, idx) => {
    const row = $('pip' + idx); const fill = row.querySelector('i');
    row.classList.toggle('gone', st.separated);
    row.classList.toggle('active', idx === i && !st.separated);
    const frac = st.separated ? 0 : st.fuel / SPECS[idx].fuel;
    fill.style.width = `${frac * 100}%`;
    fill.classList.toggle('low', frac < .35);
    row.querySelector('.dv').textContent = st.separated ? '' : `${Math.round(dvs[idx]).toLocaleString()} m/s`;
  });
  $('dvTotal').textContent = `Δv ${Math.round(dvs.reduce((a, c, k) => a + (stages[k].separated ? 0 : c), 0)).toLocaleString()} m/s`;
  const hint = $('stageHint');
  if (i >= 0 && !stages[i].separated && stages[i].fuel <= 0) hint.textContent = `⚠ ${SPECS[i].name} is dry — press X`;
  else if (i >= 0 && stages[i].fuel / SPECS[i].fuel < .2) hint.textContent = `${SPECS[i].name} propellant low`;
  else hint.textContent = '';

  /* 'pad' state persists through the first seconds of the burn (it flips when the tower clears),
     so nextStep keys its ignite hint on the engine, not on the state alone. */
  milestones({ state, nearMoon, el, live });
  const g = nextStep({ state, engineOn, live, i, dry, altE, alt, nearMoon, el, radial, speed: rel.length(), parked, docked: getDocked(), moonLanded: getLandedOnMoon() });
  $('guideText').innerHTML = g[0]; $('guide').className = 'hud onmap ' + (g[1] || '');
  $('guide').style.display = state === 'won' || state === 'lost' ? 'none' : 'flex';

  updateNavball();
}

/* M: the map is the real scene seen from the map camera (js/camera.js, js/mapview.js) — the flight
   instruments step aside, the flight and orbit panels stay. */
export function toggleMapView() {
  const on = document.body.classList.toggle('map');
  addLog(on ? 'MAP — drag to rotate · wheel to zoom · F changes focus' : 'FLIGHT VIEW');
  return on;
}

export function initHUD({ resetMission }) {
  buildStagePips();
  initNavball($('navball'), $('orbit'));
  $('bigBtn').addEventListener('click', () => resetMission());
  /* The card covers the thing you just did. LOOK AROUND puts it away and leaves the camera and the
     map live; R (or the chip) restarts. */
  $('lookBtn').addEventListener('click', () => { $('overlay').classList.add('hidden'); $('again').style.display = 'flex'; });
  $('again').addEventListener('click', () => resetMission());
  $('helpBtn').addEventListener('click', () => $('helpCard').classList.toggle('on'));
  /* Every chip is the key it names: clicking sends that key through the same handler. */
  for (const b of document.querySelectorAll('button[data-key]')) b.addEventListener('click', () => {
    dispatchEvent(new KeyboardEvent('keydown', { key: b.dataset.key }));
    dispatchEvent(new KeyboardEvent('keyup', { key: b.dataset.key }));      // focus stays on the chip: keyboard users keep their place
  });
}
