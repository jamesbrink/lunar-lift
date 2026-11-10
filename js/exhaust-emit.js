import * as THREE from 'three';
import { SPECS, VS, RE, RM, EARTH_SPIN, moonPos } from './constants.js';
import { airDensity, getSimTime } from './physics.js';
import * as WORLD from './world.js';
import { pPos, pVel, pR, pLife, pAge, pInv, pHeat, pMode, pSmoke, pMoon, pPal, pTh, allocSlot, spawnParticle, ship, moonP, moonV, SOI2,
  plumeDebug, SM_SPRAY, SM_TRAIL, SM_STEAM } from './exhaust-pool.js';

/* Where parcels come from: the engines' exit planes, the smoke trail a kerosene stage leaves in air,
   the deluge steam at ignition, and the dust a lunar burn cuts out of the ground. js/exhaust-sim.js
   moves what is born here.

   Exhaust velocity is the rocket equation's ve = Isp·g0, exactly what js/physics.js spends when it
   burns propellant, so the plume and the acceleration come from one number. Parcels are born on the
   bell exit discs of the vehicle geometry with the bell's own divergence half-angle. Throttle moves
   the physics, not the sprite: exit velocity scales as 0.45+0.55·th and the emission rate with
   throttle, so at 40 % the plume is shorter because the parcels leave slower, fewer are born, and
   they die sooner. */

/* Engine exit tables, straight off the built geometry, in build units. `dir` is the axis the flow
   leaves along (outboard F-1s cant 0.1 rad outward, matching their gimbal trim); `th` is each
   bell's divergence half-angle from lip radius and bell length — atan((1.17−0.42)/2.6) ≈ 0.28 for
   the F-1, atan((0.70−0.30)/1.9) ≈ 0.21 for the J-2, atan((0.85−0.32)/1.7) ≈ 0.30 for the S-IVB.
   `ve` is Isp·g0 in km/s — 2.98 / 4.07 / 4.12 — the same number physics.js divides thrust by to
   spend propellant. u1/u2 span the exit plane. */
const _ba = new THREE.Vector3(), _bb = new THREE.Vector3();
function bellA(x, y, z, dx, dy, dz, rb, th) {
  _ba.set(dx, dy, dz).normalize();
  _bb.set(Math.abs(_ba.z) > 0.9 ? 1 : 0, 0, Math.abs(_ba.z) > 0.9 ? 0 : 1);   // helper axis, never parallel to dir
  _bb.crossVectors(_ba, _bb).normalize();
  _ba.crossVectors(_bb, _ba).normalize();
  return { x, y, z, dx, dy, dz, rb, th, u1x: _bb.x, u1y: _bb.y, u1z: _bb.z, u2x: _ba.x, u2y: _ba.y, u2z: _ba.z };
}
export const BELL_SETS = [
  { ve: SPECS[0].isp * 9.81 / 1000, rate: 620, pal: 0, trail: 60, tailZ: -42, hullR: 3.63, bells: (() => {
      const a = [bellA(0, 0, -42, 0, 0, -1, 1.19, 0.28)];
      for (let i = 0; i < 4; i++) {
        const an = i * Math.PI / 2 + Math.PI / 4, c = Math.cos(an), s = Math.sin(an);
        /* exit centre: bell centre -40.7 shifted half a bell length along the canted axis,
           bolt circle r 2.35 pushed out by the same cant */
        a.push(bellA(c * (2.35 + 1.3 * Math.sin(0.1)), s * (2.35 + 1.3 * Math.sin(0.1)), -40.7 - 1.3 * Math.cos(0.1),
                     c * Math.sin(0.1), s * Math.sin(0.1), -Math.cos(0.1), 1.15, 0.28));
      }
      return a; })() },
  { ve: SPECS[1].isp * 9.81 / 1000, rate: 320, pal: 1, trail: 0, tailZ: -11.8, hullR: 3.57, bells: (() => {
      const a = [bellA(0, 0, -11.8, 0, 0, -1, 0.72, 0.21)];
      for (let i = 0; i < 4; i++) {
        const an = i * Math.PI / 2 + Math.PI / 4, c = Math.cos(an), s = Math.sin(an);
        a.push(bellA(c * 1.44, s * 1.44, -11.8, 0, 0, -1, 0.70, 0.21));
      }
      return a; })() },
  { ve: SPECS[2].isp * 9.81 / 1000, rate: 240, pal: 1, trail: 0, tailZ: 6.8, hullR: 2.42, bells: [bellA(0, 0, 6.8, 0, 0, -1, 0.85, 0.30)] },
];

/* Emission bookkeeping. `rate` is parcels/s at full throttle — rendering resolution, not mass flow
   (that lives in js/physics.js). `trail` is the rate of long-lived smoke puffs a stage lays behind it
   in air; hydrogen leaves none. */
let emitAcc = 0, trailAcc = 0, steamAcc = 0;
let bellCursor = 0;
let lastSpawnT = 0;                       // sim-time seconds; emission charges against the mission clock
const _sp = new THREE.Vector3(), _svv = new THREE.Vector3(), _ax = new THREE.Vector3(), _ty = new THREE.Vector3(), _up = new THREE.Vector3();

export function resetEmit() { emitAcc = trailAcc = steamAcc = 0; bellCursor = 0; lastSpawnT = 0; lastFanT = -99; }

/* One frame of emission for a burning stage. Runs on SIMULATED seconds: the clock advanced
   (frame × warp, or a whole ff() jump) since the last call, and the exhaust must be dense per metre
   flown, not per frame rendered. A jump past the cap thins the plume instead of banking a backlog.
   `since` is seconds since this burn lit: the first moment of an engine start is water and steam,
   and the fire's share of the parcels comes up behind it. `reach` is where the drawn flame ends, km
   aft of the exit plane — the trail starts there. */
export function emitExhaust(idx, pos, quat, vel, throttle, since, reach) {
  const set = BELL_SETS[idx];
  if (!set) { plumeDebug.causeBell++; return; }
  const t = getSimTime();
  const sdt = lastSpawnT > 0 ? Math.min(1, Math.max(0, t - lastSpawnT)) : 1 / 60;
  lastSpawnT = t;
  moonPos(t, moonP);
  const onMoon = pos.distanceToSquared(moonP) < SOI2;
  const alt = pos.length() - RE;
  /* Earth-side, free exhaust is only a plume where air holds it together: it is drawn fading out
     between 28 and 50 km (js/exhaust-draw.js) and not simulated at all above 52. */
  if (!onMoon && alt > 52) { emitAcc = trailAcc = 0; return; }
  const start = idx === 0 ? THREE.MathUtils.smoothstep(since, 0.25, 1.1) : 1;
  /* Over Earth a nozzle parcel only matters while it can reach the ground: in sea-level air the jet is
     stopped within a few tens of metres, so once the vehicle is a few hundred metres up none of them
     arrives, and the visible exhaust is the drawn flame and the trail. They are not born above that. */
  const low = onMoon ? 1 : 1 - THREE.MathUtils.smoothstep(alt - groundAlt(pos), 0.25, 0.45);
  if (low > 0) spawnPlume(set, pos, quat, vel, throttle * start, sdt * low, onMoon); else emitAcc = 0;
  if (!onMoon) {
    if (set.trail) spawnTrail(set, pos, quat, vel, throttle, sdt, alt, reach);
    if (idx === 0 && since < STEAM_FOR) spawnSteam(pos, since, sdt);
  }
}
const _gd = new THREE.Vector3();
function groundAlt(pos) {
  const fn = WORLD.fineGroundHeight || WORLD.groundHeight;
  const v = typeof fn === 'function' ? fn(_gd.copy(pos)) : 0;
  return v === v ? v : 0;
}
/* Engine off: a relight after a coast must not bank a second of backlog. */
export function emitIdle() { emitAcc = trailAcc = steamAcc = 0; lastSpawnT = getSimTime(); }

/* The smoke column. Exhaust that has left the flame has given its speed to the air, so a trail puff
   is born where the fire ends, nearly at rest in the AIR's frame (the atmosphere rides the planet's
   spin, as js/physics.js drags the vehicle with), with a little of the jet's push left in it. It is
   one puff every 2.5 m of ground-relative flight up to the stage's `trail` rate: a vehicle standing on
   the pad lays none — the cloud there is deflected exhaust and steam — and a fast one lays them as
   far apart as the pool affords. Life shortens as the air thins, because the puff is drawn by
   entrainment and there is less and less to entrain. */
function spawnTrail(set, pos, quat, vel, throttle, simDt, alt, reach) {
  const rhoN = airDensity(Math.max(0, alt)) / airDensity(0);
  const wx = EARTH_SPIN * pos.z, wz = -EARTH_SPIN * pos.x;       // the air's inertial velocity here
  const gs = Math.hypot(vel.x - wx, vel.y, vel.z - wz) * 1000;   // m/s through the air
  trailAcc += Math.min(set.trail, gs / 2.5) * throttle * simDt;
  let n = trailAcc | 0; trailAcc -= n;
  if (n > 40) n = 40;
  if (n === 0) return;
  _ax.set(0, 0, -1).applyQuaternion(quat);                        // the way the exhaust leaves
  const span = simDt / n;
  for (let c = 0; c < n; c++) {
    const tau = (c + Math.random()) * span;                       // see spawnPlume: one frame is not one instant
    const back = -set.tailZ * VS + reach * (0.6 + 0.4 * Math.random());
    _sp.copy(pos).addScaledVector(vel, -tau).addScaledVector(_ax, back);
    const kick = 0.02 + 0.03 * Math.random();
    _svv.set(wx + _ax.x * kick + (Math.random() - .5) * 0.016, _ax.y * kick + (Math.random() - .5) * 0.016,
             wz + _ax.z * kick + (Math.random() - .5) * 0.016);
    spawnParticle(_sp, _svv, (6 + 3 * Math.random()) * (0.35 + 0.65 * Math.min(1, rhoN * 6)), TRAIL_COLOUR,
      3.5 + 2.5 * Math.random(), SM_TRAIL);
  }
}
const TRAIL_COLOUR = [0.80, 0.78, 0.74];

/* Ignition. Before a Saturn V shows any fire, the trench throws out the deluge water as steam, both
   ways along the trench (the pad's own y axis — js/pad.js runs it north-south through the launcher).
   Visual only: js/physics.js lights the stage at full thrust on the same step. */
const STEAM_FOR = 2.6;
/* Near the smoke's own tone: at pure white the steam read as two foreign cotton balls parked in the
   beige pad cloud. */
const STEAM_COLOUR = [0.95, 0.94, 0.91];
function spawnSteam(pos, since, simDt) {
  const m = WORLD.padMatrix();
  if (!m) return;
  _up.copy(pos).normalize();
  if (pos.length() - RE > 0.3) return;                            // an air start has no trench under it
  _ty.setFromMatrixColumn(m, 1).normalize();
  steamAcc += 70 * (1 - since / STEAM_FOR) * simDt;
  let n = steamAcc | 0; steamAcc -= n;
  if (n > 20) n = 20;
  const wx = EARTH_SPIN * pos.z, wz = -EARTH_SPIN * pos.x;
  for (let c = 0; c < n; c++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    /* Born all along each half of the trench and thrown at a spread of speeds, so it leaves as a
       sheet that keeps travelling. Born at one spot at one speed it stopped as one clump per
       trench mouth and sat there for its whole life — the 'two static clouds' after liftoff. */
    const out = (9 + 34 * Math.random()) * VS, v = 0.03 + 0.11 * Math.random();
    _sp.copy(_up).multiplyScalar(RE + 0.003 + 0.004 * Math.random()).addScaledVector(_ty, side * out);
    _ax.crossVectors(_ty, _up).multiplyScalar((Math.random() - .5) * 0.045);
    _sp.addScaledVector(_ax, 0.5);
    _svv.set(wx, 0, wz).addScaledVector(_ty, side * v).add(_ax).addScaledVector(_up, 0.004 + 0.01 * Math.random());
    spawnParticle(_sp, _svv, 2.6 + 2.6 * Math.random(), STEAM_COLOUR, 2.5 + 4 * Math.random(), SM_STEAM);
  }
}

/* Nozzle-exit emission, charged with the simulated seconds the frame represents and then capped —
   the plume thins under extreme warp rather than falling further and further behind. */
function spawnPlume(set, pos, quat, vel, throttle, simDt, onMoon) {
  const veEff = set.ve * (0.45 + 0.55 * throttle);     // throttle sets exit velocity, not sprite size
  emitAcc += set.rate * throttle * simDt;              // parcels/s: the mass flow at rendering resolution
  let n = emitAcc | 0; emitAcc -= n;
  if (n > 240) n = 240;                     // a whole second charged in one frame (warp) thins instead of flooding the pool
  /* review3/04/06: ±74 m/s per axis of turbulence at the exit scattered the column into a
     300 m-wide confetti cone — consecutive parcels left the SAME streamline 25 m apart sideways
     within 0.2 s, which no sane sprite can bridge. The bell divergence (b.th ≈ 0.28 rad ≈ 16°)
     is the real cone; this jitter only has to keep it from looking like a solid sheet —
     halved to ±37 m/s (Moon keeps its own 0.02, the certified Apollo spray). */
  const jit = veEff * (onMoon ? 0.02 : 0.025);
  const bells = set.bells, nb = bells.length;
  /* One frame charges n parcels, and they all left the nozzle at different instants of the interval
     the frame represents. Emitting them together put a fresh clump at the vehicle every 16 ms while
     the vehicle itself moved on, so the ascent trail came out as a ringed fir tree — one visible
     shell per frame, evenly spaced by the frame rate. Parcel c therefore belongs to the moment
     `tau` seconds ago: back-project the exit point along the velocity, and let age, remaining life
     and heat start as they would have, so the stream is continuous. */
  const span = simDt / n;
  const rope = !onMoon && pos.length() - RE < 40;   // ascent-rope regime — see stepParcel's growth gate
  for (let c = 0; c < n; c++) {
    const tau = (c + Math.random()) * span;
    const b = bells[(bellCursor++) % nb];
    const fr = Math.sqrt(Math.random());               // uniform over the exit disc
    const ph = Math.random() * Math.PI * 2, cx = Math.cos(ph), sx = Math.sin(ph);
    const rx = b.u1x * cx + b.u2x * sx, ry = b.u1y * cx + b.u2y * sx, rz = b.u1z * cx + b.u2z * sx;
    const f = fr * b.rb;
    /* geometric expansion along the bell's divergence half-angle, growing with radial position
       on the lip (a hollow cone would look wrong; a real exit plane fills the angle linearly) */
    const spread = b.th * fr * (0.9 + Math.random() * 0.3);
    const wx = b.dx + rx * spread, wy = b.dy + ry * spread, wz = b.dz + rz * spread;
    const il = 1 / Math.sqrt(wx * wx + wy * wy + wz * wz);
    const v = veEff * (0.92 + Math.random() * 0.16);
    _svv.set(wx * il, wy * il, wz * il).multiplyScalar(v).applyQuaternion(quat);
    _sp.set((b.x + rx * f) * VS, (b.y + ry * f) * VS, (b.z + rz * f) * VS).applyQuaternion(quat).add(pos)
      .addScaledVector(vel, -tau);
    const i = allocSlot(), i3 = i * 3;
    pMode[i] = 1; pSmoke[i] = 0; pMoon[i] = onMoon ? 1 : 0; pPal[i] = set.pal;
    pPos[i3] = _sp.x; pPos[i3 + 1] = _sp.y; pPos[i3 + 2] = _sp.z;
    pVel[i3] = _svv.x + vel.x + (Math.random() - .5) * jit;
    pVel[i3 + 1] = _svv.y + vel.y + (Math.random() - .5) * jit;
    pVel[i3 + 2] = _svv.z + vel.z + (Math.random() - .5) * jit;
    /* `rate` is a rendering-resolution knob, not mass flow (that lives in js/physics.js), so dropping
       the throttle drops the parcel count and the trail came out as separated beads at 40 %. Give the
       survivors proportionally more radius: the same exhaust column, drawn with fewer sprites.
       The base was raised 0.8→1.6 m for review3/04/06: with the sprite now band-quantised (crisp
       disc out to 0.63 of its quad instead of a glowing point with a gradient skirt), the old
       birth radius put hard gaps between consecutive silhouettes — at the S-IC's 900/s the parcels
       leave 3.2 m apart at 2.9 km/s, and a banded silhouette is only ≈3× the parcel radius, so
       anything under ~1.5 m draws as a string of confetti, not a column. Overlap is finished off
       by stepParcel's early-growth boost below. */
    pR[i] = (1.6 + Math.random() * 1.4) * (1 + (1 - throttle) * 1.3);
    /* low throttle also shortens the parcel's life — slow flow does not carry soot to orbit.
       On the Moon the multiplier buys the long, bright, lingering spray of Apollo 11's ascent. */
    const life = (1.1 + Math.random() * 1.2) * (0.6 + 0.4 * throttle) * (onMoon ? 2.2 : 1);
    /* Below 40 km the trail is the whole ascent read (review2/04), and the back-projection above is
       the one place that could still starve it: tau grows with simDt, so a 1 s frame at warp billed
       the oldest parcels up to 1 s of age at birth and they died before they were ever drawn. The
       rope regime floors REMAINING life at 0.9 s — age and pInv stay honest, so the fade shape is
       untouched; only an early death is refused. */
    pLife[i] = rope ? Math.max(0.9, life - tau) : life - tau;
    pInv[i] = 1 / life; pAge[i] = tau;
    pHeat[i] = Math.max(0, 1 - tau * 2.4);               // the same cooling rate stepParcel applies
    pTh[i] = 0;
  }
}

/* What a lunar burn does to the ground. The deflected gas itself runs out as a low sheet
   (js/exhaust-sim.js); this adds the dust it cuts loose: a fan of ground-launched parcels (SM_SPRAY)
   on explicit ballistic arcs — elevation 2°…30° cubic-dense at the flat end, ±30° of azimuth about
   the way the ground turned the jet, launch speed and count scaled to the engine's height, birth
   scatter inside the jet's footprint. Throttled on SIM seconds, not on hit counts: in a hover every
   substep carries dozens of ground contacts and an unthrottled spawn would eat the pool. The clock is
   frozen across a frame's substeps, so the throttle is per rendered frame whatever the warp; a
   reset()/teleport clock rewind re-arms it.
   There used to be a second event, dark "scorch" patches pinned under the engine. On an airless body
   they read as combustion smoke, twice, in two palettes; drawn as solid puffs they were boulders. */
const SPRAY_COLOUR = [0.96, 0.93, 0.87];      // dust: paler than the brightest painted regolith, like DUST in exhaust-draw.js
let lastFanT = -99;
export function ejectaEvents(gx, gy, gz, nx, ny, nz, rx, ry, rz) {
  const t = getSimTime();
  if (t < lastFanT) lastFanT = -99;
  if (t - lastFanT < 0.16) return;
  const tl = Math.sqrt(rx * rx + ry * ry + rz * rz);
  // ground-plane basis at the contact: t along the deflected flow, h ⊥ t in the tangent plane
  let vn = rx * nx + ry * ny + rz * nz;
  let tx = rx - vn * nx, ty = ry - vn * ny, tz = rz - vn * nz;
  let td = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (td < 1e-9) { tx = -ny; ty = nx; tz = 0; td = Math.sqrt(tx * tx + ty * ty); }
  if (td < 1e-9) { tx = 1; ty = 0; tz = 0; td = 1; }
  const q = 1 / td; tx *= q; ty *= q; tz *= q;
  let hx = ty * nz - tz * ny, hy = tz * nx - tx * nz, hz = tx * ny - ty * nx;
  const hl = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
  hx /= hl; hy /= hl; hz /= hl;
  /* Engine height above the ground underneath, metres: the one number that sets BOTH how much
     dust is cut and how far it can be thrown (surface momentum flux ∝ 1/footprint-area). The
     round-5 review: at ~9 m the parcels sprinted to the horizon as an even scatter of uniform
     bokeh discs ("not anchored to the engine, no ballistic arcs"), and at 200 m the sheet was
     nearly absent. Same defect both times: speed rode the deflected jet's own tl (2.4-4.5 km/s
     before the cap — the measured figure below) so every parcel drew the far field, and the
     count was a constant 5/0.16 s whatever the altitude. Both now scale with the engine. */
  const altM = ship.live ? Math.max(4, (ship.pos.distanceTo(moonP) - RM) * 1000) : 1200;
  if (tl > 1e-9) {
    lastFanT = t;
    const nF = Math.max(3, Math.min(11, Math.round(11 * 160 / (altM + 110))));   // 10 @ 9 m, 8 @ 200 m, 3 ≥ ~3.7 km
    const vmax = 0.045 + 0.009 * Math.sqrt(altM);   // km/s: 72 @ 9 m, 187 @ 200 m, 330 @ 1 km
    const rf = (altM * Math.tan(0.30) + 6) * 0.001; // jet footprint radius (bell half-angle + jitter), km
    for (let c = 0; c < nF; c++) {
      /* Launch state sampled from a cone about the exhaust axis as the ground reflected it —
         that reflection IS t, the deflected flow (groundHit turns the jet tangentially and
         keeps 0.45 of it here) — ±30° in azimuth. Every parcel therefore leaves on a ballistic
         arc (apex v²sin²β/2g): the old launch had vn ≤ 1.5 m/s — an apex under 0.7 m, no arc to
         see, just a disc crawling sideways; the 10-68° law that replaced it put the field in the
         air (see the beta note below). */
      const phi = (Math.random() - 0.5) * (Math.PI / 3);
      const cp = Math.cos(phi), spn = Math.sin(phi);
      const tpx = tx * cp + hx * spn, tpy = ty * cp + hy * spn, tpz = tz * cp + hz * spn;
      const u = Math.random();
      /* The 1.5 km/s sub-orbital cap is CERTIFIED and stays: above ~1.6 km/s the convex ground
         falls away at v²/2R and the parcel outruns its own contact (measured: uncapped fans hit
         tl 2.4-4.5 km/s and gained 8 m in the first second). The new speed law never asks for
         more than vmax ≤ 0.59 km/s inside any plausible burn height (128 km/sqrt… beyond the
         game's own ceiling), and min() keeps the cap explicit for whoever scales vmax next. */
      const vv = Math.min(1.5, vmax * (0.14 + 0.86 * u * u * u));   // steep cubic: median 0.25·vmax
      /* Elevation 2°…30°, cubic-dense at the flat end (median 5.5°, p90 21°). The previous law
         (10° + 58°·r²) drew a MEDIAN of 24.5° — with the cubic speed law that put the common
         parcel on an apex of tens of metres and the fast ones (v·sinβ = 27 m/s at 68°) on
         1.4 km arcs: the 6 m capture frame showed the field as cream bokeh drifting at CAMERA
         height around the vehicle, the same defect review 4 called horizon scatter, just
         gathered closer. Apollo's dust was a low radial sheet hugging the ground — apex is
         v²sin²β/2g_moon with g = 1.62, and 30° cubic caps the median apex at ~1 m with the
         top parcel (65 m/s @ 29°) at ~350 m, 1.7 km out, where it reads as distance, not fog. */
      const beta = (2 + 28 * Math.pow(Math.random(), 3)) * Math.PI / 180;
      const cb = Math.cos(beta), sb = Math.sin(beta);
      /* birth scatter inside the footprint, denser toward the axis (r ∝ √u over the disc):
         near-engine density comes from where parcels are BORN now, not from a uniform point
         smeared outward by a uniform speed. */
      const jr = rf * Math.sqrt(Math.random()) * 0.6, ja = Math.random() * Math.PI * 2;
      const cj = Math.cos(ja), sj = Math.sin(ja);
      _sp.set(gx + (tpx * cj + hx * sj) * jr + nx * 0.001,
              gy + (tpy * cj + hy * sj) * jr + ny * 0.001,
              gz + (tpz * cj + hz * sj) * jr + nz * 0.001);
      _svv.set(moonV.x + (tpx * cb + nx * sb) * vv,
               moonV.y + (tpy * cb + ny * sb) * vv,
               moonV.z + (tpz * cb + nz * sb) * vv);
      /* 0.5-2.2× size spread about the 3 m base (median 1.1×): uniform discs were half of why the
         sheet read as lens bokeh — bokeh is uniform by definition. */
      const sm = 0.5 + 1.7 * Math.pow(Math.random(), 1.5);
      spawnParticle(_sp, _svv, 1.6 + Math.random() * 1.4, SPRAY_COLOUR, 3 * sm, SM_SPRAY);
    }
  }

}
