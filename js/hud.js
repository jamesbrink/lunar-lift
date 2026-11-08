import * as THREE from 'three';
import { RE, RM, MU_E, MU_M, MOON, SOI_M, PAD_UP, WARPS, VSCALE, TSCALE, SPECS } from './constants.js';
import { stages } from './vehicle.js';
import { S, getState, getSimTime, getEngineOn, getThrottle, getWarpIndex, getSasOn, getSasRetro, getDistFlown, getMaxQ, getTrail, activeStage, totalMass, orbitalElements } from './physics.js';

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

export function fmtMET(t) {
  const s = Math.max(0, Math.round(t * TSCALE));
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
  const stats = `MET ${fmtMET(getSimTime())}   ·   distance flown ${(getDistFlown() / 1000).toFixed(1)}k km   ·   max-Q ${(getMaxQ() * 1000).toFixed(1)} kPa`;
  $('overlayText').innerHTML = `<div class="brief">${body}</div><div class="stats">${stats}</div>`;
  $('overlayCard').querySelector('h1').firstChild.textContent = title;
  $('bigBtn').textContent = btn;
  $('overlay').classList.remove('hidden');
}

let hudTick = 0;

export function updateHUD(dt) {
  hudTick += dt; if (hudTick < 0.1) return; hudTick = 0;
  const state = getState(), engineOn = getEngineOn(), throttle = getThrottle();
  const rE = S.pos.length(), rM = S.pos.distanceTo(MOON);
  const altM = rM - RM, altE = rE - RE;
  const nearMoon = rM < SOI_M;
  const alt = nearMoon ? altM : altE;
  $('tAlt').textContent = `${Math.max(0, alt).toFixed(0)} km`;
  const speed = S.v.length();
  $('tVel').textContent = `${(speed * VSCALE).toFixed(0)} m/s`;
  const radial = nearMoon ? S.v.dot(rM > 0 ? new THREE.Vector3().subVectors(S.pos, MOON).normalize() : PAD_UP)
                          : S.v.dot(new THREE.Vector3().copy(S.pos).normalize());
  $('tVs').textContent = `${(radial * VSCALE).toFixed(0)} m/s`;
  const i = activeStage();
  const thrustG = (engineOn && throttle > .01 && i >= 0 && stages[i].fuel > 0)
    ? SPECS[i].thrust * throttle / totalMass() / 9.81 : 0;
  $('tG').textContent = `${thrustG.toFixed(2)} g`;
  $('tThr').textContent = `${Math.round(throttle * 100)}%`;
  $('thrBar').style.width = `${throttle * 100}%`;
  $('thrBig').innerHTML = `${Math.round(throttle * 100)}<span> %</span>`;
  $('thrGauge').firstChild.style.width = `${throttle * 100}%`;
  const live = engineOn && throttle > .01 && i >= 0 && stages[i].fuel > 0;
  const es = $('engState');
  es.textContent = live ? `MAIN ENGINE ${Math.round(SPECS[i].thrust * throttle / 1000)} kN`
    : (engineOn ? 'IGNITING…' : 'FLAMEOUT');
  es.classList.toggle('live', live);
  $('met').textContent = fmtMET(getSimTime());
  $('warpInd').textContent = `×${WARPS[getWarpIndex()]}`;

  const el = orbitalElements(nearMoon ? new THREE.Vector3().subVectors(S.pos, MOON) : new THREE.Vector3().copy(S.pos),
    S.v, nearMoon ? MU_M : MU_E, nearMoon ? RM : RE);
  $('oBody').textContent = nearMoon ? 'MOON' : 'EARTH';
  const km = n => !isFinite(n) ? 'ESCAPE' : n < 0 ? 'IMPACT' : n >= 100000 ? (n / 1000).toFixed(1) + 'M km' : n.toFixed(0) + ' km';
  $('oPe').textContent = km(el.pe); $('oAp').textContent = km(el.ap);
  $('oMoon').textContent = km(rM) + (nearMoon ? ' · SOI' : '');
  $('oSas').textContent = getSasOn() ? (getSasRetro() ? 'RETRO' : 'PRO') : 'off';

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
  else hint.textContent = nearMoon && altM < 500 ? `descent ${(-radial * VSCALE).toFixed(0)} m/s — land under 32` : '';

  const desc = $('desc');
  if (nearMoon && altM < 400 && state === 'flying') {
    desc.style.display = 'block';
    const vs = -radial * VSCALE;
    desc.innerHTML = vs > 0
      ? `<span style="color:${vs > 120 ? 'var(--err)' : vs > 32 ? 'var(--warn)' : 'var(--ok)'}">DESCENT ${vs.toFixed(0)} m/s — LIMIT 32 m/s</span>`
      : `ALTITUDE ${altM.toFixed(0)} km`;
  } else desc.style.display = 'none';
  $('igniteHint').style.display = (state === 'pad') ? 'block' : 'none';

  // trajectory warning already handled in predict()
}

/* ---------------- minimap ---------------- */
const MM_S = 0.01416, MM_CX = 14, MM_CY = 75, MM_OFF = 1500;
// rotate the x–z flight plane so the Earth→Moon axis runs left-to-right on the map
const mmProj = p => [(p.x * 0.7071 - p.z * 0.7071 + MM_OFF) * MM_S + MM_CX, MM_CY - (p.x * 0.7071 + p.z * 0.7071) * MM_S];

export function drawMap() {
  mg.clearRect(0, 0, 252, 150);
  const [ex, ey] = mmProj(new THREE.Vector3(0, 0, 0));
  const [mx, my] = mmProj(MOON);
  mg.strokeStyle = 'rgba(150,165,190,.25)'; mg.setLineDash([3, 4]);
  mg.beginPath(); mg.arc(mx, my, SOI_M * MM_S, 0, 6.283); mg.stroke();
  mg.setLineDash([]);
  mg.fillStyle = '#2f6ca8'; mg.beginPath(); mg.arc(ex, ey, RE * MM_S, 0, 6.283); mg.fill();
  mg.fillStyle = '#c9cbd2'; mg.beginPath(); mg.arc(mx, my, RM * MM_S, 0, 6.283); mg.fill();
  // pad + trail
  mg.strokeStyle = 'rgba(93,220,154,.5)'; mg.beginPath();
  getTrail().forEach((p, i) => { const [x, y] = mmProj(p); i ? mg.lineTo(x, y) : mg.moveTo(x, y); });
  mg.stroke();
  // rocket marker
  const [rx, ry] = mmProj(S.pos);
  mg.fillStyle = '#8fdcff';
  mg.beginPath(); mg.arc(rx, ry, 2.6, 0, 6.283); mg.fill();
  mg.strokeStyle = '#8fdcff'; mg.beginPath(); mg.moveTo(rx, ry);
  mg.lineTo(rx + (S.v.x * 0.7071 - S.v.z * 0.7071) * MM_S * 90, ry - (S.v.x * 0.7071 + S.v.z * 0.7071) * MM_S * 90); mg.stroke();
  mg.fillStyle = 'rgba(150,165,190,.8)'; mg.font = '9px ui-monospace,monospace';
  mg.fillText('EARTH', ex - 14, ey + 26); mg.fillText('MOON', mx - 12, my - 8);
}

export function initHUD({ startMission, resetMission }) {
  buildStagePips();
  mm = $('minimap'); mg = mm.getContext('2d');
  { const dpr = Math.min(devicePixelRatio, 2); mm.width = 252 * dpr; mm.height = 150 * dpr; mm.style.width = '252px'; mm.style.height = '150px'; mg.scale(dpr, dpr); }
  $('bigBtn').addEventListener('click', () => { if (getState() === 'briefing') startMission(); else resetMission(); });
  $('helpBtn').addEventListener('click', () => $('helpCard').classList.toggle('on'));
}
