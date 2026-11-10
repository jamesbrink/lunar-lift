import * as THREE from 'three';
import { RE, RM, MU_E, MU_M, SOI_M, MOON_DIST, PAD_UP, PAD_POS, WARPS, SPECS, CAPSULE_MASS, LAND_SAFE, moonPos } from './constants.js';
import { stages } from './saturn.js';
import { S, getState, getSimTime, getEngineOn, getThrottle, getWarpIndex, getSasOn, getSasRetro, getDistFlown, getMaxQ, getTrail, activeStage, orbitalElements, getControlAuthority, groundVel, bodyUp, navVel, surfaceAlt, aeroState, getAeroLoad, getRcsAssist, LOAD_LIMIT_STACK, LOAD_LIMIT_CSM } from './physics.js';
import { getCamMode } from './camera.js';
import { CORRIDOR } from './targeting.js';
import { drawn } from './predictor.js';
import * as WORLD from './world.js';
import { initNavball, updateNavball } from './navball.js';
import { aim } from './targeting.js';

const $ = id => document.getElementById(id);

let mm = null, mg = null;

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

export function hideOverlay() { $('overlay').classList.add('hidden'); }
export function clearLog() { $('log').innerHTML = ''; }

export function endOverlay(title, body, btn) {
  const stats = `MET ${fmtMET(getSimTime())}   ·   ${Math.round(getDistFlown()).toLocaleString()} km flown   ·   max-Q ${(getMaxQ() / 1000).toFixed(1)} kPa`;
  $('overlayText').innerHTML = `<div class="brief">${body}</div><div class="stats">${stats}</div>`;
  $('overlayCard').querySelector('h1').firstChild.textContent = title;
  $('bigBtn').textContent = btn;
  $('overlay').classList.remove('hidden');
}

/* The one line under the clock: what to do now, with the key that does it. Derived from the same
   state the readouts show — nothing here is scripted to a clock, so it is right for any flight. */
const K = k => `<kbd>${k}</kbd>`;
function nextStep({ state, engineOn, live, i, dry, altE, alt, nearMoon, el, radial, speed }) {
  if (state === 'pad') return engineOn ? ['Engines building thrust — hold on', 'ok']
    : [`${K('SPACE')} ignite · then ${K('P')} lets SAS fly the ascent`];
  if (state !== 'flying') return [''];
  if (dry) return i === 2 ? ['Out of propellant — you are a passenger now', 'bad'] : [`Tank empty — ${K('X')} drop the stage`, 'warn'];
  if (nearMoon) {
    const vs = -radial * 1000;
    if (el.escape || el.pe > 0 && !el.escape && el.ap > SOI_M) return [`Capture: ${K('V')} retrograde, ${K('P')} SAS, burn at the lowest point (${Math.round(el.pe)} km)`];
    if (el.pe > 0) return [`In lunar orbit — burn retrograde to drop periapsis below the surface`, 'ok'];
    if (alt > 30) return [`Descent: stay retrograde (${K('V')} ${K('P')}); start braking by ~30 km up`];
    return vs > LAND_SAFE * 1000 ? [`BRAKE — ${vs.toFixed(0)} m/s down, touch under ${LAND_SAFE * 1000} m/s`, 'bad']
      : [`Good descent: ${vs.toFixed(0)} m/s — keep it under ${LAND_SAFE * 1000} m/s and upright`, 'ok'];
  }
  if (altE < 120 && el.ap < 140) return getSasOn() ? ['SAS is flying the gravity turn — watch apoapsis climb', 'ok']
    : [`${K('P')} SAS flies the gravity turn — or pitch east by hand with ${K('D')}`];
  if (el.escape || el.ap > MOON_DIST * 0.9) {
    if (!isFinite(aim.altKm)) return [`Translunar — ${K('M')} map; computing your lunar aim…`];
    if (aim.altKm < 0) return ['Lunar aim is an IMPACT — trim with a short retrograde burn', 'bad'];
    return aim.corridor ? [`On course: ${Math.round(aim.altKm)} km lunar pass — warp with ${K(']')} and coast`, 'ok']
      : [`Lunar pass ${Math.round(aim.altKm).toLocaleString()} km — want ${CORRIDOR.lo}–${CORRIDOR.hi}: trim pro/retrograde`, 'warn'];
  }
  if (el.pe < 140) return live ? [`Keep burning prograde until periapsis clears 150 km (now ${el.pe < 0 ? 'below ground' : Math.round(el.pe) + ' km'})`]
    : [`Not in orbit yet — burn prograde (${K('P')} + ${K('⇧')}) near apoapsis to raise periapsis`, 'warn'];
  return live ? [`Translunar burn — hold prograde until apoapsis reaches the Moon (${Math.round(el.ap).toLocaleString()} km)`]
    : [`Parking orbit ✓ — at periapsis, burn prograde (${K('P')} + ${K('⇧')}) to reach the Moon · ${K('M')} map`, 'ok'];
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
  $('tAlt').textContent = alt < 10 ? `${Math.round(alt * 1000).toLocaleString()} m` : `${alt.toFixed(alt < 100 ? 1 : 0)} km`;
  /* The speed worth reading changes with where you are: over the ground while there is ground to
     hit or air to push through, around the body once you are in orbit of it. */
  const rel = groundVel(new THREE.Vector3());
  const orbital = !nearMoon && altE > 120;
  const speed = orbital ? navVel(new THREE.Vector3()).length() : rel.length();
  $('tVelL').textContent = orbital ? 'orbital speed' : nearMoon ? 'surface speed' : 'ground speed';
  $('tVel').textContent = `${Math.round(speed * 1000).toLocaleString()} m/s`;
  const radial = rel.dot(bodyUp(new THREE.Vector3()));
  $('tVs').textContent = `${radial >= 0 ? '+' : '−'}${Math.abs(radial * 1000).toFixed(0)} m/s`;
  const inAir = aeroState.q > 50 && state === 'flying';
  $('air').classList.toggle('on', inAir);
  if (inAir) {
    const load = getAeroLoad(), aoa = aeroState.aoa * 57.2958;
    $('aMach').textContent = aeroState.mach.toFixed(2);
    $('aQ').textContent = `${(aeroState.q / 1000).toFixed(1)} kPa`;
    $('aAoa').textContent = `${aoa.toFixed(0)}°`;
    $('aLoad').textContent = `${load.toFixed(2)} g`;
    const lim = activeStage() === 2 || activeStage() < 0 ? LOAD_LIMIT_CSM : LOAD_LIMIT_STACK;
    $('aLoad').className = load > 0.6 * lim ? 'bad' : load > 0.25 * lim ? 'warn' : '';
    $('aAoa').className = aoa > 15 && aeroState.q > 2000 ? 'warn' : '';
  }
  const i = activeStage();
  const live = engineOn && throttle > .01 && i >= 0 && stages[i].fuel > 0;
  // accel and the duplicated throttle bar left the telemetry card (KSP-simplified HUD); the
  // centre-bottom throttle widget below is the one readout for that number now.
  $('thrBig').innerHTML = `${Math.round(throttle * 100)}<span>%</span>`;
  $('thrGauge').firstElementChild.style.height = `${throttle * 100}%`;
  $('thrGauge').classList.toggle('live', live);
  const es = $('engState');
  es.textContent = live ? `${Math.round(SPECS[i].thrust * throttle).toLocaleString()} kN`
    : (engineOn ? 'IGNITING…' : 'ENGINE OFF');
  es.classList.toggle('live', live);
  $('met').textContent = fmtMET(getSimTime());
  $('warpInd').textContent = $('vWarp').textContent = `×${WARPS[getWarpIndex()]}`;
  $('vCam').textContent = getCamMode().toUpperCase();

  /* Elements must be computed in one frame: near the Moon the position is lunar-relative, so the
     velocity has to be too. Passing inertial S.v with a Moon-centred position made the Ap/Pe
     readout wrong by the Moon's own 1,023 m/s — an "ESCAPE" reading while in a bound 200 km orbit. */
  const el = orbitalElements(nearMoon ? new THREE.Vector3().subVectors(S.pos, moon) : new THREE.Vector3().copy(S.pos),
    navVel(new THREE.Vector3()), nearMoon ? MU_M : MU_E, nearMoon ? RM : RE);
  $('oBody').textContent = nearMoon ? 'MOON' : 'EARTH';
  const km = n => !isFinite(n) ? 'ESCAPE' : n < 0 ? 'IMPACT' : n >= 1000000 ? (n / 1000).toFixed(1) + ' Mm' : Math.round(n).toLocaleString() + ' km';
  $('oPe').textContent = km(el.pe); $('oAp').textContent = km(el.ap);
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
    aimEl.textContent = Math.round(aim.altKm).toLocaleString() + ' km in ' + fmtMET(aim.tMet - getSimTime());
    aimEl.className = (aim.corridor ? 'ok' : 'bad') + (aim.status === 'running' ? ' run' : '');
  }
  $('oSas').textContent = getSasOn() ? 'ON' : 'OFF'; $('mSas').classList.toggle('on', getSasOn());
  $('mDirV').textContent = getSasRetro() ? 'RETRO' : 'PRO'; $('mDir').classList.toggle('on', getSasOn());
  $('mRcsV').textContent = getRcsAssist() ? 'ON' : 'OFF'; $('mRcs').classList.toggle('on', getRcsAssist());
  const dry = i >= 0 && stages[i].fuel <= 0;
  $('mStageV').textContent = i >= 0 ? (dry ? 'DROP' : SPECS[i].name.split(' ')[0]) : '—';
  $('mStage').classList.toggle('alert', dry && state === 'flying');
  const auth = getControlAuthority().py;
  $('oCtrl').textContent = '×' + (auth > 9.95 ? '9.9' : auth.toFixed(1));

  /* Delta-v left in each stage: the rocket equation over what that stage still holds, carrying
     everything stacked above it. Vacuum Isp, so the first stage reads a little generous. */
  const dvs = [0, 0, 0];
  for (let k = 2, above = CAPSULE_MASS; k >= 0; k--) {
    if (stages[k].separated) continue;
    const m1 = above + stages[k].dry, m0 = m1 + stages[k].fuel;
    dvs[k] = SPECS[k].isp * 9.80665 * Math.log(m0 / m1); above = m0;
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

  $('desc').style.display = 'none';      // the descent call-out lives in the guide line now
  /* 'pad' state persists through the first ~10 s of the pillar burn (it flips when the tower
     clears), so the state alone re-printed "PRESS SPACE TO IGNITE" under a rocket at 100 % —
     caught in the round-6 blast frame. The hint is for an engine that has not been lit. */
  const g = nextStep({ state, engineOn, live, i, dry, altE, alt, nearMoon, el, radial, speed: rel.length() });
  $('guideText').innerHTML = g[0]; $('guide').className = 'hud onmap ' + (g[1] || '');
  $('guide').style.display = state === 'won' || state === 'lost' ? 'none' : 'flex';

  // trajectory warning already handled in predict()
  updateNavball();
}

/* ---------------- orbital map (M): looking down the spin axis (x–z plane) ----------------
   One renderer, driven entirely by the canvas's live client size × dpr, so the same code
   serves any viewport — the old fixed 252×150 minimap constants are gone. */
export function toggleMapView() {
  const on = document.body.classList.toggle('map');
  addLog(`MAP: ${on ? 'ORBITAL' : 'FLIGHT'}`);
}

const mmState = { scale: 1, cx: 0, cz: 0, w: 0, h: 0, label: '' };

function chooseView(rE, rM, moon) {
  const { w, h } = mmState;
  if (rE > 120000 && rM > SOI_M) {
    mmState.cx = moon.x / 2; mmState.cz = moon.z / 2;
    mmState.scale = (w - 48) / (MOON_DIST + 2 * SOI_M);
    mmState.label = 'system';
  } else if (rM < SOI_M) {
    mmState.cx = moon.x; mmState.cz = moon.z;
    mmState.scale = (h - 48) / (2 * Math.max(3000, rM));
    mmState.label = 'lunar';
  } else {
    mmState.cx = 0; mmState.cz = 0;
    mmState.scale = (h - 48) / (2 * Math.max(9000, rE));
    mmState.label = 'earth orbit';
  }
}
const px = (x, z) => [mmState.w / 2 + (x - mmState.cx) * mmState.scale, mmState.h / 2 - (z - mmState.cz) * mmState.scale];

/* Bodies: the map is a chart of the equatorial plane (px maps world x and z, centred on the body's
   centre), so it is a view from above the north pole seen straight down. That has a consequence for the
   painted disc: `px` plots a surface point at radius R·cos(lat) — the pad, whose up-vector is 28.4° off
   the spin axis, lands at 0.88 R, not at the rim — which is exactly the orthographic polar projection.
   Blitting an equirect strip across the disc cannot agree with it: the strip puts latitude on the
   vertical axis while the chart puts world z there, so the vehicle marker slides across the wrong
   coastline (measured with the strip: at spin 90.3° the pad marker sat beside Greenland while Florida
   was 90° away). So the sprite is built as a proper polar disc: screen angle ↔ world longitude, radius ↔
   cos(lat), north pole at the centre, and the mesh's spin folded in because the painted canvas is welded
   to the mesh. Pixels are nearest-neighbour with a 2x2 box average against a cached copy of the source,
   rebuilt only when the size bucket or the spin (quantised to ~0.5°) changes — a 512² build costs a few
   milliseconds, never a per-frame cost.

   The fiction that remains is the one the chart always had: the southern hemisphere is behind the disc,
   so this is a north-up polar map, and everything the mission actually does (an equatorial launch, a
   near-equatorial coast out to the Moon) happens near the rim. */
const _discs = new Map();
const _srcs = new Map();
function sourcePixels(key, src) {
  let e = _srcs.get(key);
  /* The cache entry belongs to a specific canvas object, not to the body name. The painted
     surface is authored asynchronously (toonmap's `painted` map is set on a promise landing),
     so the name→pixels mapping is only as fresh as the object the first drawMap happened to
     catch; any swapped-in canvas behind the same key would otherwise feed the map its stale —
     possibly pre-paint black — copy for the whole session (the review session measured
     paintedCanvas litFrac 1.000 while #mapCanvas never left 0.000). Re-copy whenever the
     object identity changes; identical object, no cost. */
  if (!e || e.src !== src) {
    const scratch = document.createElement('canvas');
    scratch.width = src.width; scratch.height = src.height;
    const sc = scratch.getContext('2d');
    sc.drawImage(src, 0, 0);
    e = { src, d: sc.getImageData(0, 0, src.width, src.height).data, w: src.width, h: src.height };
    _srcs.set(key, e);
  }
  return e;
}

function buildPolarDisc(key, src, size, spin) {
  const srcD = sourcePixels(key, src), sw = srcD.w, sh = srcD.h;
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size), px = img.data, R = size / 2;
  for (let py = 0; py < size; py++) {
    const dy = py + 0.5 - R;
    for (let pxi = 0; pxi < size; pxi++) {
      const dx = pxi + 0.5 - R, r = Math.hypot(dx, dy) / R;
      if (r > 1) continue;
      const lon = Math.atan2(-dy, dx) + spin;                       // world → mesh longitude
      const lat = Math.acos(THREE.MathUtils.clamp(r, 0, 1));        // north pole at the centre
      let u = ((lon / 6.283 + 0.5) % 1 + 1) % 1;
      let v = (Math.acos(0) - lat) / Math.PI;                       // (90° - lat)/180
      let tx = Math.floor(u * sw), ty = Math.floor(v * sh);
      tx = Math.min(sw - 2, Math.max(0, tx)); ty = Math.min(sh - 2, Math.max(0, ty));
      const o = (ty * sw + tx) * 4, i = (py * size + pxi) * 4;
      for (let ch = 0; ch < 3; ch++)
        px[i + ch] = (srcD.d[o + ch] + srcD.d[o + 4 + ch] + srcD.d[o + sw * 4 + ch] + srcD.d[o + sw * 4 + 4 + ch]) >> 2;
      px[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function paintBody(key, sx, sy, R, spin, sunAng) {
  const src = typeof WORLD.planetCanvas === 'function' ? WORLD.planetCanvas(key) : null;
  if (src && src.width > 1 && src.height > 1 && R >= 3) {
    let e = _discs.get(key);
    if (!e) { e = { c: null, lon: NaN, src: null }; _discs.set(key, e); }
    const d = Math.max(16, Math.min(512, Math.ceil(R * 2 / 16) * 16));
    const lonQ = Math.round(spin * 200) / 200;                     // ~0.5° of spin
    /* e.src !== src: a swapped painted canvas must rebuild the disc even when the spin bucket
       is unchanged — the same stale-cache class sourcePixels just lost its key to. */
    if (!e.c || e.c.width !== d || e.lon !== lonQ || e.src !== src) { e.c = buildPolarDisc(key, src, d, spin); e.lon = lonQ; e.src = src; }
    mg.drawImage(e.c, sx - R, sy - R, R * 2, R * 2);
  } else {
    mg.fillStyle = key === 'earth' ? '#2f6ca8' : '#c9cbd2';
    mg.beginPath(); mg.arc(sx, sy, R, 0, 6.283); mg.fill();
  }
  if (sunAng !== null && R >= 3) {   // hard cel terminator: two flat rects under a circular clip, no gradient
    mg.save();
    mg.beginPath(); mg.arc(sx, sy, R, 0, 6.283); mg.clip();
    mg.translate(sx, sy); mg.rotate(sunAng);                     // +x points sunward
    mg.fillStyle = 'rgba(4,7,14,.42)'; mg.fillRect(-R, -R, R, 2 * R);
    mg.fillStyle = 'rgba(4,7,14,.16)'; mg.fillRect(0, -R, Math.max(2, R * .06), 2 * R);   // dusk band on the day side
    mg.restore();
  }
  mg.strokeStyle = 'rgba(5,9,15,.9)'; mg.lineWidth = 1.5;        // crisp cel outline ring
  mg.beginPath(); mg.arc(sx, sy, Math.max(R - .75, .75), 0, 6.283); mg.stroke();
}

/* The predicted path — the map's hero line. js/predictor.js publishes what the 3D ribbon is
   showing this frame as world-frame points (the ship first, then everything still ahead of it).
   Pe/Ap ticks are the first local min/max of range-to-centre along that polyline — the charted
   twins of the numbers updateHUD already prints, no orbit re-solved here. */
function drawPred(cen) {
  const n = drawn.n;
  if (n < 2) return;
  const p = drawn.pos;
  mg.beginPath();
  for (let i = 0; i < n; i++) {
    const [x, y] = px(p[i * 3], p[i * 3 + 2]);
    i ? mg.lineTo(x, y) : mg.moveTo(x, y);
  }
  mg.strokeStyle = 'rgba(77,217,128,.16)'; mg.lineWidth = 7; mg.stroke();      // halo pass
  mg.strokeStyle = 'rgba(122,236,166,.95)'; mg.lineWidth = 1.6; mg.stroke();   // bright core
  if (drawn.impact) {             // the path ends on a surface: its last stretch is drawn red
    mg.strokeStyle = '#ff6a5c'; mg.lineWidth = 1.6; mg.beginPath();
    for (let i = Math.max(0, n - 4); i < n; i++) {
      const [x, y] = px(p[i * 3], p[i * 3 + 2]);
      i > n - 4 ? mg.lineTo(x, y) : mg.moveTo(x, y);
    }
    mg.stroke();
  }
  const cx = cen ? cen.x : 0, cz = cen ? cen.z : 0;
  const rad = i => Math.hypot(p[i * 3] - cx, p[i * 3 + 2] - cz);
  let peI = -1, apI = -1;
  for (let i = 1; i < n - 1 && (peI < 0 || apI < 0); i++) {
    const r0 = rad(i - 1), r1 = rad(i), r2 = rad(i + 1);
    if (peI < 0 && r1 <= r0 && r1 < r2) peI = i;
    if (apI < 0 && r1 >= r0 && r1 > r2) apI = i;
  }
  const tick = (i, txt) => {
    const wx = p[i * 3] - cx, wz = p[i * 3 + 2] - cz;
    const l = Math.hypot(wx, wz) || 1, ux = wx / l, uz = wz / l;
    const [x, y] = px(p[i * 3], p[i * 3 + 2]);
    mg.strokeStyle = '#8fdcff'; mg.lineWidth = 1.2; mg.beginPath();
    mg.moveTo(x - uz * 5, y + ux * 5); mg.lineTo(x + uz * 5, y - ux * 5);   // perpendicular to the radius
    mg.stroke();
    mg.fillStyle = '#8fdcff';
    mg.fillText(txt, x + ux * 12 - 5, y - uz * 12 + 4);
  };
  if (peI >= 0) tick(peI, 'Pe');
  if (apI >= 0 && apI !== peI) tick(apI, 'Ap');
}

/* scale bar instead of a bare px-to-km number: 1/2/5×10ⁿ km at roughly 140 px */
function scaleBar(s, h) {
  const t = 140 / s;
  const p = Math.pow(10, Math.floor(Math.log10(t)));
  const m = t / p;
  const km = (m >= 3.5 ? 10 : m >= 1.5 ? 5 : m >= .7 ? 2 : 1) * p;
  const L = km * s, x = 10, y = h - 12;
  mg.strokeStyle = 'rgba(150,165,190,.85)'; mg.lineWidth = 1;
  mg.beginPath(); mg.moveTo(x, y - 4); mg.lineTo(x, y); mg.lineTo(x + L, y); mg.lineTo(x + L, y - 4); mg.stroke();
  mg.fillText(`${Math.round(km).toLocaleString()} km`, x, y - 7);
}

export function drawMap() {
  const w = mm.clientWidth, h = mm.clientHeight;
  if (!w || !h) return;                       // display:none while the map is closed
  mmState.w = w; mmState.h = h;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (mm.width !== bw || mm.height !== bh) { mm.width = bw; mm.height = bh; }   // backing store only changes on resize
  mg.setTransform(dpr, 0, 0, dpr, 0, 0);      // everything below draws in CSS pixels
  mg.font = '11px ui-monospace,monospace';    // chart labels and ticks alike

  const moon = moonPos(getSimTime(), new THREE.Vector3());
  const rE = S.pos.length(), rM = S.pos.distanceTo(moon);
  const nearMoon = rM < SOI_M;
  chooseView(rE, rM, moon);
  const s = mmState.scale;
  mg.clearRect(0, 0, w, h);

  // lunar sphere of influence
  const [mx, my] = px(moon.x, moon.z);
  mg.strokeStyle = 'rgba(150,165,190,.3)'; mg.setLineDash([4, 6]);
  mg.beginPath(); mg.arc(mx, my, SOI_M * s, 0, 6.283); mg.stroke();
  mg.setLineDash([]);

  // SUN_DIR is exported by world.js; the discs get their cel terminator from it.
  // Map plane = x–z, screen y is −z.
  const sd = WORLD.SUN_DIR;
  const sunAng = sd && sd.isVector3 ? Math.atan2(-sd.z, sd.x) : null;
  const [ex, ey] = px(0, 0);
  /* Disc texture phase: the polar sprite needs the body's current spin so the painted surface turns with
     the mesh, otherwise coastlines drift out from under everything plotted in world coordinates. */
  const bodySpin = k => (typeof WORLD.bodySpin === 'function' ? WORLD.bodySpin(k) : 0);
  paintBody('earth', ex, ey, RE * s, bodySpin('earth'), sunAng);
  paintBody('moon', mx, my, RM * s, bodySpin('moon'), sunAng);

  // launch site — PAD_POS is where LC-39 is at MET 0; the planet, and the pad welded to it, turn by
  // bodySpin, so plotting the raw constant leaves the marker 90° behind the real site after six hours.
  if (mmState.label === 'earth orbit') {
    mg.fillStyle = '#d94f2b';
    const a = bodySpin('earth'), ca = Math.cos(a), sa = Math.sin(a);
    const [padx, pady] = px(ca * PAD_POS.x + sa * PAD_POS.z, -sa * PAD_POS.x + ca * PAD_POS.z);
    mg.beginPath(); mg.arc(padx, pady, 3, 0, 6.283); mg.fill();
  }

  // flown trail — deliberately subordinate to the prediction
  mg.strokeStyle = 'rgba(93,220,154,.32)'; mg.lineWidth = 1; mg.beginPath();
  getTrail().forEach((p, i) => { const [x, y] = px(p.x, p.z); i ? mg.lineTo(x, y) : mg.moveTo(x, y); });
  mg.stroke();

  drawPred(nearMoon ? moon : null);

  // vehicle + velocity vector (90 s of travel, so it reads as a heading at every zoom)
  const [rx, ry] = px(S.pos.x, S.pos.z);
  mg.fillStyle = '#8fdcff';
  mg.beginPath(); mg.arc(rx, ry, 4, 0, 6.283); mg.fill();
  mg.strokeStyle = '#8fdcff'; mg.lineWidth = 1.5; mg.beginPath(); mg.moveTo(rx, ry);
  mg.lineTo(rx + S.v.x * 90 * s * 1000, ry - S.v.z * 90 * s * 1000); mg.stroke();
  mg.lineWidth = 1;

  mg.fillStyle = 'rgba(150,165,190,.85)';
  mg.fillText('EARTH', ex - 22, ey + 18); mg.fillText('MOON', mx - 19, my - 9);
  mg.fillText(mmState.label, 10, h - 26);
  scaleBar(s, h);
}

export function initHUD({ resetMission }) {
  buildStagePips();
  mm = $('mapCanvas'); mg = mm.getContext('2d');   // backing store is sized per frame in drawMap
  initNavball($('navball'), $('orbit'));
  $('bigBtn').addEventListener('click', () => resetMission());
  $('helpBtn').addEventListener('click', () => $('helpCard').classList.toggle('on'));
  /* Every chip is the key it names: clicking sends that key through the same handler. */
  for (const b of document.querySelectorAll('button[data-key]')) b.addEventListener('click', () => {
    dispatchEvent(new KeyboardEvent('keydown', { key: b.dataset.key }));
    dispatchEvent(new KeyboardEvent('keyup', { key: b.dataset.key }));
    b.blur();
  });
}
