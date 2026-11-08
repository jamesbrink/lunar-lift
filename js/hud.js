import * as THREE from 'three';
import { RE, RM, MU_E, MU_M, SOI_M, MOON_DIST, PAD_UP, PAD_POS, WARPS, SPECS, moonPos } from './constants.js';
import { stages } from './vehicle.js';
import { S, getState, getSimTime, getEngineOn, getThrottle, getWarpIndex, getSasOn, getSasRetro, getDistFlown, getMaxQ, getTrail, activeStage, totalMass, orbitalElements, getControlAuthority, airDensity, surfaceVel } from './physics.js';
import { initNavball, updateNavball } from './navball.js';

const $ = id => document.getElementById(id);

let mm = null, mg = null;

export function addLog(msg, cls = '') {
  const el = document.createElement('div'); el.className = 'logline ' + cls; el.textContent = msg;
  const box = $('log'); box.prepend(el);
  while (box.children.length > 5) box.lastChild.remove();
  el.addEventListener('animationend', () => el.remove());
}

export function buildStagePips() {
  const box = $('stagePips'); box.innerHTML = '';
  stages.forEach((st, i) => {
    const row = document.createElement('div'); row.className = 'stageRow'; row.id = 'pip' + i;
    row.innerHTML = `<span class="pip"></span><span class="bar"><i style="width:100%"></i></span><span class="name">${SPECS[i].name}</span>`;
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

let hudTick = 0;

export function updateHUD(dt) {
  hudTick += dt; if (hudTick < 0.1) return; hudTick = 0;
  const state = getState(), engineOn = getEngineOn(), throttle = getThrottle();
  const moon = moonPos(getSimTime(), new THREE.Vector3());
  const rE = S.pos.length(), rM = S.pos.distanceTo(moon);
  const altM = rM - RM, altE = rE - RE;
  const nearMoon = rM < SOI_M;
  const alt = nearMoon ? altM : altE;
  // KSP-style: inside the Earth's sphere we read speed relative to the rotating ground
  const rel = nearMoon ? S.v : surfaceVel(new THREE.Vector3());
  const speed = rel.length();
  $('tAlt').textContent = `${Math.max(0, alt).toFixed(alt < 100 ? 1 : 0)} km`;
  $('tVel').textContent = `${(speed * 1000).toFixed(0)} m/s ${nearMoon ? '' : 'ground'}`;
  const radial = rel.dot(new THREE.Vector3().subVectors(S.pos, nearMoon ? moon : S.pos).normalize());
  $('tVs').textContent = `${(radial * 1000).toFixed(0)} m/s`;
  const i = activeStage();
  const live = engineOn && throttle > .01 && i >= 0 && stages[i].fuel > 0;
  const thrustG = live ? SPECS[i].thrust * throttle / totalMass() / 9.81 : 0;   // kN/t = m/s²
  $('tG').textContent = `${thrustG.toFixed(2)} g`;
  $('tThr').textContent = `${Math.round(throttle * 100)}%`;
  $('thrBar').style.width = `${throttle * 100}%`;
  $('thrBig').innerHTML = `${Math.round(throttle * 100)}<span> %</span>`;
  $('thrGauge').firstChild.style.width = `${throttle * 100}%`;
  const es = $('engState');
  es.textContent = live ? `MAIN ENGINE ${Math.round(SPECS[i].thrust * throttle)} kN`
    : (engineOn ? 'IGNITING…' : 'FLAMEOUT');
  es.classList.toggle('live', live);
  $('met').textContent = fmtMET(getSimTime());
  $('warpInd').textContent = `×${WARPS[getWarpIndex()]}`;

  const el = orbitalElements(nearMoon ? new THREE.Vector3().subVectors(S.pos, moon) : new THREE.Vector3().copy(S.pos),
    S.v, nearMoon ? MU_M : MU_E, nearMoon ? RM : RE);
  $('oBody').textContent = nearMoon ? 'MOON' : 'EARTH';
  const km = n => !isFinite(n) ? 'ESCAPE' : n < 0 ? 'IMPACT' : n >= 1000000 ? (n / 1000).toFixed(1) + ' Mm' : Math.round(n).toLocaleString() + ' km';
  $('oPe').textContent = km(el.pe); $('oAp').textContent = km(el.ap);
  $('oMoon').textContent = Math.round(rM).toLocaleString() + ' km' + (nearMoon ? ' · SOI' : '');
  $('oSas').textContent = getSasOn() ? (getSasRetro() ? 'RETRO' : 'PRO') : 'off';
  const auth = getControlAuthority().py;
  $('oCtrl').textContent = '×' + (auth > 9.95 ? '9.9' : auth.toFixed(1));
  $('tRho').textContent = airDensity(altE) > 1e-6 ? `${airDensity(altE).toFixed(3)} kg/m³` : 'vacuum';
  $('tQ').textContent = `${(getMaxQ() / 1000).toFixed(1)} kPa`;

  stages.forEach((st, idx) => {
    const row = $('pip' + idx); const fill = row.querySelector('i');
    row.classList.toggle('gone', st.separated);
    row.classList.toggle('active', idx === i && !st.separated);
    const frac = st.separated ? 0 : st.fuel / SPECS[idx].fuel;
    fill.style.width = `${frac * 100}%`;
    fill.classList.toggle('low', frac < .35);
  });
  const hint = $('stageHint');
  if (i >= 0 && !stages[i].separated && stages[i].fuel <= 0) hint.textContent = `⚠ ${SPECS[i].name} is dry — press X`;
  else if (i >= 0 && stages[i].fuel / SPECS[i].fuel < .2) hint.textContent = `${SPECS[i].name} propellant low`;
  else hint.textContent = nearMoon && altM < 500 ? `descent ${(-radial * 1000).toFixed(0)} m/s — land under 32` : '';

  const desc = $('desc');
  if (nearMoon && altM < 400 && state === 'flying') {
    desc.style.display = 'block';
    const vs = -radial * 1000;
    desc.innerHTML = vs > 0
      ? `<span style="color:${vs > 120 ? 'var(--err)' : vs > 32 ? 'var(--warn)' : 'var(--ok)'}">DESCENT ${vs.toFixed(0)} m/s — LIMIT 32 m/s</span>`
      : `ALTITUDE ${altM.toFixed(0)} km`;
  } else desc.style.display = 'none';
  $('igniteHint').style.display = (state === 'pad') ? 'block' : 'none';

  // trajectory warning already handled in predict()
  updateNavball();
}

/* ---------------- minimap: looking down the spin axis (x–z plane) ---------------- */
let mapMode = 'auto';
export function toggleMapView() {
  mapMode = mapMode === 'auto' ? 'system' : 'auto';
  addLog(`MAP: ${mapMode.toUpperCase()}`);
}

const MM_W = 252, MM_H = 150;
const mmState = { scale: 1, cx: 0, cz: 0, label: '' };

function chooseView(rE, rM, moon) {
  if (mapMode === 'system' || (rE > 120000 && rM > SOI_M)) {
    mmState.cx = moon.x / 2; mmState.cz = moon.z / 2;
    mmState.scale = (MM_W - 24) / (MOON_DIST + 2 * SOI_M);
    mmState.label = 'system';
  } else if (rM < SOI_M) {
    mmState.cx = moon.x; mmState.cz = moon.z;
    mmState.scale = (MM_H - 24) / (2 * Math.max(3000, rM));
    mmState.label = 'lunar';
  } else {
    mmState.cx = 0; mmState.cz = 0;
    mmState.scale = (MM_H - 24) / (2 * Math.max(9000, rE));
    mmState.label = 'earth orbit';
  }
}
const px = (x, z) => [MM_W / 2 + (x - mmState.cx) * mmState.scale, MM_H / 2 - (z - mmState.cz) * mmState.scale];

export function drawMap() {
  const moon = moonPos(getSimTime(), new THREE.Vector3());
  const rE = S.pos.length(), rM = S.pos.distanceTo(moon);
  chooseView(rE, rM, moon);
  const s = mmState.scale;
  mg.clearRect(0, 0, MM_W, MM_H);

  // lunar sphere of influence
  const [mx, my] = px(moon.x, moon.z);
  mg.strokeStyle = 'rgba(150,165,190,.3)'; mg.setLineDash([3, 4]);
  mg.beginPath(); mg.arc(mx, my, SOI_M * s, 0, 6.283); mg.stroke();
  mg.setLineDash([]);

  const [ex, ey] = px(0, 0);
  mg.fillStyle = '#2f6ca8'; mg.beginPath(); mg.arc(ex, ey, RE * s, 0, 6.283); mg.fill();
  mg.fillStyle = '#c9cbd2'; mg.beginPath(); mg.arc(mx, my, RM * s, 0, 6.283); mg.fill();

  // launch site
  if (mmState.label === 'earth orbit') {
    mg.fillStyle = '#d94f2b';
    mg.beginPath(); mg.arc(px(PAD_POS.x, PAD_POS.z)[0], px(PAD_POS.x, PAD_POS.z)[1], 2, 0, 6.283); mg.fill();
  }

  // trajectory so far
  mg.strokeStyle = 'rgba(93,220,154,.55)'; mg.beginPath();
  getTrail().forEach((p, i) => { const [x, y] = px(p.x, p.z); i ? mg.lineTo(x, y) : mg.moveTo(x, y); });
  mg.stroke();

  // vehicle + velocity vector
  const [rx, ry] = px(S.pos.x, S.pos.z);
  mg.fillStyle = '#8fdcff';
  mg.beginPath(); mg.arc(rx, ry, 3, 0, 6.283); mg.fill();
  mg.strokeStyle = '#8fdcff'; mg.beginPath(); mg.moveTo(rx, ry);
  mg.lineTo(rx + S.v.x * 90 * s * 1000, ry - S.v.z * 90 * s * 1000); mg.stroke();

  mg.fillStyle = 'rgba(150,165,190,.85)'; mg.font = '9px ui-monospace,monospace';
  mg.fillText('EARTH', ex - 16, ey + 14); mg.fillText('MOON', mx - 14, my - 6);
  mg.fillText(`${mmState.label} · 1 px = ${Math.round(1 / s).toLocaleString()} km`, 6, MM_H - 8);
}

export function initHUD({ resetMission }) {
  buildStagePips();
  mm = $('minimap'); mg = mm.getContext('2d');
  initNavball($('navball'), $('orbit'));
  { const dpr = Math.min(devicePixelRatio, 2); mm.width = MM_W * dpr; mm.height = MM_H * dpr; mm.style.width = MM_W + 'px'; mm.style.height = MM_H + 'px'; mg.scale(dpr, dpr); }
  $('bigBtn').addEventListener('click', () => resetMission());
  $('helpBtn').addEventListener('click', () => $('helpCard').classList.toggle('on'));
}
