import * as THREE from 'three';
import { RE, RM, MU_E, MU_M, EARTH_SPIN, PAD_SCALE, PAD_UP, VS, moonPos, moonVel } from './constants.js';
/* The plume is a physics consumer, so it reads the sim's own numbers instead of restating them:
   airDensity is literally the function accelAt drags the vehicle with, so the smoke cannot disagree
   with the flight computer about where the air runs out. */
import { airDensity, getSimTime } from './physics.js';
import * as WORLD from './world.js';
import { pPos, pVel, pR, pLife, pAge, pInv, pHeat, pMode, pSmoke, pMoon, pTh, pColB, alive, nAlive, killSlot, ship, moonP, moonV,
  plumeDebug, SM_SEAM, SM_SPRAY, SM_FLASH, SM_TRAIL, SM_STEAM } from './exhaust-pool.js';
import { ejectaEvents } from './exhaust-emit.js';

/* ---------------- the exhaust's integrator ----------------
   Every parcel is a blob of gas with a life, a radius and a velocity. Nothing about the shape of the
   exhaust is keyframed: the pad blast, the ascent column and the lunar spray are all outcomes of one
   integration. Display-free: js/exhaust-draw.js reads the pool this writes.

   Drag: `airDensity()` is imported from physics.js, and the velocity is ground-relative exactly the
   way accelAt does it — the atmosphere rides the planet's spin, and a parked plume that believed it
   was moving through still air at 409 m/s would slide west across the pad. The drag itself is
   solved implicitly: the parcel velocity is multiplied by 1/(1+β·h), the exact linearised step of
   dv/dt = −βv with β = ½ρ|v_rel|·CdA/m folded into one ballistic coefficient. Explicit Euler
   cannot integrate β·h ≈ 3-6 per substep without oscillating; the implicit form cannot explode at
   any step size, which is what makes the time warp safe.
   The unforced consequences, which are the whole point: at the pad τ ≈ 10 ms so the flow dies
   inside ~50 m and everything visible is ground interaction; near 60 km τ is tens of seconds, so
   the exhaust flies nearly unimpeded and lays a long thin needle along the flight path; above
   ~100 km ρ is so thin the fan is collisionless and ballistic.

   Bodies: whichever mass is underneath supplies gravity and air, picked with the same SOI test
   physics.js uses. Inside the Moon's: MU_M and no atmosphere at all — which is why lunar burn
   exhaust travels far, settles slowly at 1.62 m/s², and gets a longer life multiplier here.

   Colliders, all analytic and all cheap:
     · ground of the body underneath, radial, plus js/world.js terrain *if* it ever grows a height
       getter (guarded — it exports none today, and a bare call would TypeError against a module
       that has never heard of it);
     · the LC-39 complex as exhaust sees it: a trench BOWL around the rocket (floor below r = RE —
       the bells dip into it), ringed by a low smooth berm out to the 455 u footprint. Flow falls
       into the bowl, is thrown along the rising walls (the column visibly buckles and widens as
       it clears the trench lip), and the berm keeps the near field dense before the apron
       escapes. The complex's 150 u bbox belongs to the masts and towers; standing the ground that
       high would float the blast 210 m above a 5.6 m deck, so thin towers stay uncollided.
     · the vehicle: one analytic cylinder along its own axis, from the active tail to the LES tip,
       so the deflectate washes around the hull instead of through it.

   A ground hit kills the inward radial component, keeps the tangential (that is the blast rolling
   sideways across the flame trench), converts a share of the impact speed into outward tangential
   flow plus a little lift — on Earth enough to billow the smoke up and over the pad; on the Moon
   lift ≈ 0.04, because 1.62 m/s² cannot billow and real lunar ascent footage is a flat radial
   spray sheet. The parcel grows and is marked smoky on impact. */


/* Sea-level density off the physics module's own exponential, so the ember quench normalises by the
   same number drag reads. */
const RHO_SEA = airDensity(0);
const MAX_SUB = 30;                       // dt/MAX_SUB ≈ 33 ms per substep at the 1 s clamp
const BAL0 = 0.018, BAL_CAP = 0.055;      // m²/kg normalised as BAL0/r² (r = parcel radius, m)
const R_CAP = 16;                         // m: entrainment ceiling. Density has to come from parcel COUNT;
                                        // at 38 m the few live parcels overlapped into soft lanterns around the pad
const BILLOW = 0.07;                       // share of deflected Earth parcels that become the lasting pad cloud
const BILLOW_COLOUR = [0.93, 0.91, 0.87];
const R_YOUNG = 9;                        // m: radius hold for deflected Earth parcels in their first 0.5 s —
                                        // the blast dome must form from entrained parcels, not instant inflation
const PAD_RP2 = (455 * PAD_SCALE) * (455 * PAD_SCALE);   // pad complex footprint, km²
/* Pad ground as the exhaust actually meets it: the flame trench is a bowl (its floor is BELOW the
   map sphere — the F-1 exit plane itself sits below it), and around the trench a low berm stands
   where the deflectors and crawler decks pile up. Both profiles are continuous at their rims, so
   the deflectate rides the bowl walls up and outward — the column visibly buckles and widens as it
   clears the trench — and the berm keeps the near field dense before the apron escapes. */
const TRP2 = (36 * PAD_SCALE) * (36 * PAD_SCALE);        // trench opening radius, km²
const TRENCH = 9 * PAD_SCALE;                            // trench floor depth below r = RE
const PAD_BERM = 40 * PAD_SCALE;                         // berm crest ≈ PAD_BERM/4 ≈ 14 m, smoothstep-free s·t cap
const ALT40_R2 = (RE + 40) * (RE + 40);  // r² gate for "below 40 km": the ascent-rope regime

/* Relief wiring. js/world.js's lookups are body-aware: fineGroundHeight for Earth (coarse relief
   plus the near-level detail the patch is built from) and moonGroundHeight for the Moon, whose
   relief grid is its drawn ground. Both return km above the reference sphere, which is exactly the
   unit this collider adds, and 0 while the field is unbuilt or when the direction misses. A
   non-finite answer is counted in plumeDebug.causeHeight, so "the exhaust looks wrong" arrives
   with a named cause. The per-parcel last-good cache (pTh) is the boot-order guard: before the fields exist a 0 is honest (the mesh
   is a smooth sphere at that moment), but once a parcel has sampled real relief a later 0 never
   drops it through a mountain — worst case a puff collides slightly early, conservative beats
   swallowed. Lunar relief runs −1.45..+2.0 km: without this, highland burns spray dust up to 2 km
   INSIDE the ground and crater burns spray it above a surface that is not there. */
const _tdir = new THREE.Vector3();
const _lv = new THREE.Vector3(), _lw = new THREE.Vector3();
let tick = 0;                              // substeps taken; staggers the relief lookups below
function reliefAt(dx, dy, dz, moon, i) {
  /* The lookup was the most expensive line in the exhaust (the profiler's top entry at full throttle
     on the pad). Relief does not change over the few metres a parcel moves in a substep, so a parcel
     past its first tenth of a second re-reads it one substep in four, staggered by slot. */
  if (pAge[i] > 0.1 && ((tick + i) & 3)) return pTh[i];
  const fn = moon ? WORLD.moonGroundHeight : WORLD.fineGroundHeight;
  _tdir.set(dx, dy, dz);                                  // uvAlong normalizes; NaN dirs miss → 0
  const v = fn(_tdir);
  if (!(v === v)) { plumeDebug.causeHeight++; return pTh[i]; }
  if (v !== 0) pTh[i] = v;                                // 0 = unbuilt/miss OR true sea level; keep the last good
  return pTh[i];
}

/* Scratch outputs of the ground response — no allocation anywhere in the hot loop. */
let _bx = 0, _by = 0, _bz = 0, _hit = 0;

/* Ground response, shared by both bodies. `n` is the outward surface normal at the parcel; `fr*`
   the surface's own velocity there (Earth's ground co-rotates, the Moon travels at moonVel — the
   same two frames physics.js's groundVel uses, for the same reason: relative to the wrong ground,
   a blast on the Moon would drift sideways at 1.02 km/s or a pad blast would slide west at 409 m/s). */
function groundHit(vx, vy, vz, nx, ny, nz, frx, fry, frz, moon) {
  let rx = vx - frx, ry = vy - fry, rz = vz - frz;
  const vn = rx * nx + ry * ny + rz * nz;
  _hit = 0;
  if (vn < 0) {
    let tx = rx - vn * nx, ty = ry - vn * ny, tz = rz - vn * nz;   // tangential: survives — it rolls
    let tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tl < 1e-6) {                                                // straight-on: any tangent will do
      tx = -ny; ty = nx; tz = 0; tl = Math.sqrt(tx * tx + ty * ty);
      if (tl < 1e-6) { tx = 1; ty = 0; tz = 0; tl = 1; }
    }
    const s = -vn;                                                  // impact speed into the surface
    const k = 1 / tl;
    /* Earth: the outward term multiplies the FULL jet speed, and at 0.55 the deflected sheet left
       the trench at 0.55 × 2.9 km/s = 1.6 km/s — it crossed the 700 m pad in half a second, so at
       any shutter time later than the first frame the blast read as NOTHING but a glow (measured
       live MET 2.5: deck clear, 1 229 parcels already 700 m out and 6 cm thin). A trench sheet is
       around Mach 1: 0.08 × 2.9 = 230 m/s leaves the pad still a wall of smoke. The Moon keeps
       0.75 — Apollo's vacuum ejecta really did run far, and frames 13/14 are certified on it. */
    const out = (moon ? 0.02 : 0.08) * s;                            // impact → outward flow
    /* Tangential bleed. It used to survive the hit whole — `tx * (1 + out·k)` — so deflectate left
       the trench at close to exhaust speed and painted a 200 m field of discrete glowing domes around
       the pad. Air, the trench walls and the berm do not allow that: the flow arrives supersonic and
       leaves as a ground-hugging sheet at a fraction of the speed. The Moon bled almost nothing (0.8)
       and the spray left frame in one breath: a translucent gradient cone with no surface event at
       all. 0.45 keeps a long Apollo-style throw but decelerates the dust
       enough that it crawls, piles and reads as ground interaction. */
    const keep = moon ? 0.10 : 0.12;
    /* Lift is bounded: real deflectate rises by entrainment, not by keeping 16% of Mach-9
       momentum — uncapped this launched the pad blast 2 km into the sky. */
    const up = Math.min(s * (moon ? 0.04 : 0.08), moon ? 0.006 : 0.05);
    /* All three components take the same factor. The bleed used to be written on `rx` alone, so a
       parcel deflected off the trench floor kept its full tangential speed in y and z and the pad
       got a field of discrete puffs flung outward at close to exhaust velocity — the `keep` value
       below had almost no effect, which is why tuning it appeared to do nothing. */
    const flow = keep + out * k;
    rx = tx * flow + nx * up;                                       // bled tangential + re-aimed impact + lift
    ry = ty * flow + ny * up;
    rz = tz * flow + nz * up;
    _hit = 1;
  }
  _bx = rx + frx; _by = ry + fry; _bz = rz + frz;
}

/* One parcel, one substep: body underneath → implicit drag → gravity → move → colliders →
   bookkeeping. Returns 1 when the parcel died. All units km / km/s / s except pR (metres). */
function stepParcel(i, h) {
  const i3 = i * 3;
  let px = pPos[i3], py = pPos[i3 + 1], pz = pPos[i3 + 2];
  let vx = pVel[i3], vy = pVel[i3 + 1], vz = pVel[i3 + 2];
  const moon = pMoon[i] === 1;

  if (moon) {
    /* No atmosphere at all: pure ballistics under MU_M, which is exactly why lunar exhaust
       reaches so far and settles so slowly. */
    let dx = px - moonP.x, dy = py - moonP.y, dz = pz - moonP.z;
    let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const g = MU_M / (d * d * d);
    vx -= dx * g * h; vy -= dy * g * h; vz -= dz * g * h;
    px += vx * h; py += vy * h; pz += vz * h;
    dx = px - moonP.x; dy = py - moonP.y; dz = pz - moonP.z;
    d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const gr = RM + reliefAt(dx, dy, dz, 1, i);
    if (d < gr) {
      const nx = dx / d, ny = dy / d, nz = dz / d;
      groundHit(vx, vy, vz, nx, ny, nz, moonV.x, moonV.y, moonV.z, 1);   // the ground travels with the Moon
      px = moonP.x + nx * gr; py = moonP.y + ny * gr; pz = moonP.z + nz * gr;
      if (_hit) {
        if (pMode[i] === 2 && pSmoke[i] === SM_SPRAY) {
          /* Ground-pinned extras settle WITHOUT bouncing. groundHit's straight-on fallback
             (tl < 1e-6) builds `tx = -ny; ty = nx` — a unit DIRECTION consumed as a VELOCITY —
             so anything landing exactly vertically gets the full keep(0.45) km/s tangential
             kick; measured: a scorch parcel crawled +376 m/s upslope, riding that fallback
             every step it re-settled. That fallback is a corner case for the certified blast
             flow and stays untouched; the correct response for a settling patch of dust is to
             cancel the into-ground velocity component and keep the tangential, position-snapped
             to the surface above. */
          let vrx = vx - moonV.x, vry = vy - moonV.y, vrz = vz - moonV.z;
          const vrn = vrx * nx + vry * ny + vrz * nz;
          if (vrn < 0) { vrx -= nx * vrn; vry -= ny * vrn; vrz -= nz * vrn; }
          vx = vrx + moonV.x; vy = vry + moonV.y; vz = vrz + moonV.z;
        } else {
        vx = _bx; vy = _by; vz = _bz;
        /* Regolith ejecta is pulverised cold rock, not flame, so heat drops below ember on first
           contact. Nothing else cools it here: the vacuum branch has no drag and its cooling term is
           barely half Earth's, so a deflected parcel used to run outward still incandescent for a
           second and a half and the surface event read as a shower of glowing sparks rather than the
           low grey sheet Apollo filmed. The band floor below turns it to dust from 20 ms. */
        if (!pSmoke[i]) pHeat[i] = Math.min(pHeat[i], 0.3);
        /* Reaching here excludes SM_SPRAY (settled above), so the smoke conversion and
           the ×1.25 contact inflation apply once per real deflection — a pinned patch can no
           longer balloon itself to the 16 m ceiling by re-contacting every step. ejectaEvents
           fires only on these real plume-deflection hits, never on settling. */
        pSmoke[i] = 1;                                    // deflected; age gate decides sheet vs dust
        /* The 16 m entrainment ceiling is an AIR rule — a smoke puff grows by dragging air with
           it, and there is no air here. Vacuum ejecta churns at fragment scale: capping the
           contact swell at 7 m is what the physics says, and it is also what the 9 m capture
           frame demanded: with the old ×1.25+0.2 walking to R_CAP, 450 live deflected parcels
           (parcelAudit) drifted between the descending vehicle and the chase camera as
           camera-facing 16 m discs — the lens-bokeh field, back in a paler
           palette. At 7 m and the shorter vacuum life below the near-camera coverage per parcel
           falls by ~4.5x and the sheet reads as ground-hugging dust again. */
        pR[i] = Math.min(7, pR[i] * 1.25 + 0.2);
        pLife[i] = Math.min(pLife[i], 1.9);
        ejectaEvents(px, py, pz, nx, ny, nz, _bx - moonV.x, _by - moonV.y, _bz - moonV.z);
        }
      }
    }
  } else {
    const r2 = px * px + py * py + pz * pz;
    const r = Math.sqrt(r2);
    const alt = r - RE;
    const buoy = pMode[i] === 2 && (pSmoke[i] === SM_TRAIL || pSmoke[i] === SM_STEAM);
    let floats = false;
    if (alt < 420) {
      const rho = airDensity(alt);
      if (rho > 0) {
        const ax = -EARTH_SPIN * pz, az = EARTH_SPIN * px;          // the atmosphere rides the spin
        let rx = vx + ax, ry = vy, rz = vz + az;
        const vMps = Math.sqrt(rx * rx + ry * ry + rz * rz) * 1000;
        if (buoy) {
          /* Trail smoke and steam are warm gas the air has already caught: they relax onto the
             air's own motion plus a slow rise, at a rate that falls with the density (same implicit
             step as the drag below, so warp cannot blow it up). No gravity acts on them while
             there is air to float in — see the gate under this block. */
          const rhoN = Math.min(1, rho / RHO_SEA * 4);
          const f = 1 / (1 + (pSmoke[i] === SM_STEAM ? 0.7 : 2.5) * rhoN * h);   // steam keeps its throw longer: it must roll out, not park
          const rise = (pSmoke[i] === SM_STEAM ? 0.009 : 0.0025) * (1 - f) / r;
          rx = rx * f + px * rise; ry = ry * f + py * rise; rz = rz * f + pz * rise;
          vx = rx - ax; vy = ry; vz = rz - az;
          floats = rhoN > 0.08;
        } else if (vMps > 1e-6) {
          let bal = BAL0 * (pMode[i] === 2 ? 6 : 1) / (pR[i] * pR[i]);
          /* Ground-marked smoke drags like the air-full puff it has become; a 1/r² law alone lets
             it coast at hundreds of m/s for its whole life, which reads as shrapnel, not soot.
             The SAME floor extends to every mode-1 parcel: a fresh jet that keeps
             2.9 km/s for a second and a half (the old regime — entrainment grows pR, and bal is
             1/r², so growth made the parcels FLY) stretched the ascent trail into a 2 km cone of
             dots ~75 m apart, which no 1600-parcel pool can fill. A real F-1 column couples to
             the air within a few hundred metres and piles into the rope the launch actually
             drags; the floor does exactly that — τ ≈ 0.1 s against the ground-slip at the pad's
             air, and nothing at all where there is no air (vacuum CSM stays ballistic, which is
             correct and is fixed instead by cooling to smoke). The pad's jet meets the trench
             floor within one or two substeps, before drag can shape it. */
          if (pMode[i] === 1) bal = Math.max(bal, 0.005);
          bal = Math.min(BAL_CAP, bal);
          const f = 1 / (1 + bal * rho * vMps * h);                 // exact linearised drag step
          const diss = (1 - f) * vMps;                              // m/s of slip shed → entrainment
          rx *= f; ry *= f; rz *= f;
          vx = rx - ax; vy = ry; vz = rz - az;
          pR[i] = Math.min(R_CAP, pR[i] + Math.min(14, diss * 0.016) * h);
        }
      }
    }
    if (!floats) {
      const g = MU_E / (r2 * r);
      vx -= px * g * h; vy -= py * g * h; vz -= pz * g * h;
    }
    px += vx * h; py += vy * h; pz += vz * h;

    /* Ground: the sphere, plus the LC-39 dome where its footprint applies. The quadratic cap is
       one dot product and one multiply, and it fades to exactly RE at the footprint rim so there
       is no step in the surface. The gate margin (0.6 km) exceeds the largest single-substep fall
       (~142 m at the clamp), so nothing can skip the test and the planet. */
    if (alt < 0.6) {
      const r2b = px * px + py * py + pz * pz;
      const rb = Math.sqrt(r2b);
      const up = px * PAD_UP.x + py * PAD_UP.y + pz * PAD_UP.z;
      const h2 = r2b - up * up;
      /* Bowl inside the trench opening (floor below r = RE — the bells dip into it), berm ring
         between the trench and the complex footprint, planet sphere everywhere else. Continuous
         at both rims by construction: each profile is zero at its own boundary. */
      let gr = RE;
      if (h2 < TRP2) gr = RE - TRENCH * (1 - h2 / TRP2);
      else if (h2 < PAD_RP2) gr = RE + PAD_BERM * ((h2 - TRP2) / (PAD_RP2 - TRP2)) * (1 - h2 / PAD_RP2);
      gr += reliefAt(px, py, pz, 0, i);
      if (rb < gr) {
        const nx = px / rb, ny = py / rb, nz = pz / rb;
        groundHit(vx, vy, vz, nx, ny, nz, EARTH_SPIN * pz, 0, -EARTH_SPIN * px, 0);
        px = nx * gr; py = ny * gr; pz = nz * gr;                   // it does not go through the pad
        if (_hit) {
          vx = _bx; vy = _by; vz = _bz;
          /* Every parcel meets "ground" within a step of birth — the F-1 plane sits below the
             trench floor, inside its own flame trench. pSmoke therefore marks "ground-deflected
             flow", not "soot": it drives the faster cooling, the entrainment swell and the drag
             floor, while the colour stays on the heat curve — the deflected sheet is flame until
             its own heat says smoke. */
          if (pMode[i] === 1 && !pSmoke[i] && Math.random() < BILLOW) {
            /* A share of the deflected parcels stop being fast flow and become the cloud that
               stays: a buoyant, long-lived billow that keeps the outward throw it was given and
               then climbs. Without these the pad cloud was only ever the last second of exhaust,
               and it was gone the moment the vehicle cleared the trench. */
            pMode[i] = 2; pSmoke[i] = SM_STEAM; pAge[i] = 0;
            pLife[i] = 4 + 4 * Math.random(); pInv[i] = 1 / pLife[i];
            pR[i] = 2.5 + 4 * Math.random(); pHeat[i] = 0;
            pColB[i3] = BILLOW_COLOUR[0]; pColB[i3 + 1] = BILLOW_COLOUR[1]; pColB[i3 + 2] = BILLOW_COLOUR[2];
          } else if (pMode[i] === 1) {
          /* One cut of life on first contact. Deflectate used to live its whole 3 s and the roll
             crept out to the horizon as a flat ground fog; the real blast cloud is a few hundred
             metres of churn around the pad that thins fast. Guarded on the flag so a parcel resting
             on the ground is not re-capped every step. */
          if (!pSmoke[i]) pLife[i] = Math.min(pLife[i], 1.15);
          /* Inside the trench itself the flow is still a coherent jet: hold the heat there so the
             pad keeps a bright fire under the vehicle, while the roll climbing out of it cools to
             cloud. Without this the whole event read as grey smoke with a few sparks.
             0.66, not 0.82: the hold sat ABOVE the incandescent band threshold (0.75), so every
             parcel resting in the trench drew band 0 at additive ≈ 1 and the order-free glow
             stacked into the blown-out white pillar the review measured punching up through the
             pad. Held below 0.75 it still reads as saturated flame orange, the
             20 ms band gate below turns resting parcels to cloud anyway, and the fire that
             remains visible is the young jet sheet plus the drawn cone. */
          if (h2 < TRP2) pHeat[i] = Math.max(pHeat[i], 0.66);
          pSmoke[i] = 1;
          pR[i] = Math.min(R_CAP, pR[i] * 1.6 + 0.6);
          }
        }
      }
    }
  }

  /* The vehicle's own hull: one cylinder in vehicle frame from the active tail to the LES tip,
     push out along the surface normal and damp-reflect the crossing velocity against the moving
     hull. The cheap bounding test rejects every parcel except the few dozen near the engines. */
  if (ship.live) {
    const hx = px - ship.pos.x, hy = py - ship.pos.y, hz = pz - ship.pos.z;
    if (hx * hx + hy * hy + hz * hz < 0.02) {
      _lv.set(hx, hy, hz).applyQuaternion(ship.quatI);
      const z = _lv.z / VS;
      if (z > ship.tailZ && z < ship.topZ) {
        const dl = Math.sqrt(_lv.x * _lv.x + _lv.y * _lv.y);
        const lim = ship.hullR + pR[i] * 0.001;
        if (dl < lim && dl > 1e-9) {
          const s = lim / dl;
          _lv.x *= s; _lv.y *= s;
          _lw.set(_lv.x, _lv.y, _lv.z).applyQuaternion(ship.quat);
          px = ship.pos.x + _lw.x; py = ship.pos.y + _lw.y; pz = ship.pos.z + _lw.z;
          _lw.set(_lv.x / dl, _lv.y / dl, 0).applyQuaternion(ship.quat);
          const rvx = vx - ship.vel.x, rvy = vy - ship.vel.y, rvz = vz - ship.vel.z;
          const vn = rvx * _lw.x + rvy * _lw.y + rvz * _lw.z;
          if (vn < 0) {                                             // 45% rebound, 55% absorbed
            vx = rvx - 1.45 * vn * _lw.x + ship.vel.x;
            vy = rvy - 1.45 * vn * _lw.y + ship.vel.y;
            vz = rvz - 1.45 * vn * _lw.z + ship.vel.z;
          }
        }
      }
    }
  }

  pPos[i3] = px; pPos[i3 + 1] = py; pPos[i3 + 2] = pz;
  pVel[i3] = vx; pVel[i3 + 1] = vy; pVel[i3 + 2] = vz;

  /* Bookkeeping: cooling, smoke growth, life. In vacuum nothing entrains and nothing cools fast,
     so the same numbers keep lunar parcels hot, small and flying several times longer. */
  if (pMode[i] === 1) {
    /* Radiation is the only cooling available in vacuum, but a vacuum plume that holds its fire for
       0.75 s at 2 km/s draws a kilometre of glowing beads behind the vehicle, and that light show is
       what the lunar surface event read as. Real exhaust in vacuum is faint — the visible event is
       the dust it lifts — so lunar parcels radiate away their incandescence faster than Earth parcels
       lose it to air.
       The bead problem was measured again AFTER the birth-size fix: the merge into smoke
       is what makes the column continuous, and parcels still took 0.62 s (Earth) / 0.46 s (Moon) to
       cool below the smoke threshold — at 2-3 km/s relative flow that is a 1.3-1.8 km streak of
       individual hot dots no sprite budget can fill (the drawn cone covers ~30 m). Cooling is now
       ~2× faster (Earth 1.25 → 2.4 /s, Moon 1.7 → 3.4/s, keeping the certified asymmetry that
       vacuum loses its fire FASTER): the incandescent/ember streak shrinks to a few hundred metres
       behind the drawn cone, and by then the early-growth boost has carried the parcel to ~4 m,
       whose smoke silhouette is ~16 m — overlapping the 3.2 m neighbour spacing several times. */
    pHeat[i] -= h * (moon ? 3.4 : 2.4) * (pSmoke[i] ? 2.2 : 1);
    /* The "ghost rocket": at MET+13 the tower region read as a second, intact vehicle wrapped
       in engine fire — 278 live parcels (measured, node harness, real ascent t=13 s) were still
       above the smoke threshold, because base cooling 2.4/s needs 0.33 s to get a parcel under
       heat 0.22 and at 900/s that is a third-of-a-second tail of ember discs at every altitude
       the trail ever touched. Two physical facts fix it: (1) embers quench by entraining COLD
       AIR — the rate must ride air density, which is what stepParcel's drag already reads — and
       (2) an ember that has survived to its second half has stopped mixing with the jet and is
       smoke on its way down. So: an age-ramped extra cooling weighted by ρ/ρ₀ (pad air: total
       ≈ 8.6/s → ember window ~0.1 s, measured hot count at real-ascent t=13: 278 → 77; 30 km up
       ρ/ρ₀=0.015 — the certified ascent rope above the atmosphere is untouched), a hard hue floor
       at 0.45 s, and a late-life decay that has the Earth-side population gone inside ~1.4 s of
       birth — the pad reads clear long before the 8 s the review asked for. */
    if (!moon) {
      const altE = Math.sqrt(px * px + py * py + pz * pz) - RE;
      const rhoN = altE < 420 ? airDensity(altE) / RHO_SEA : 0;
      pHeat[i] -= h * (rhoN * (5.5 + 3 * Math.max(0, pAge[i] - 0.12)) + 4 * Math.max(0, pAge[i] - 0.15));
      if (pAge[i] > 0.45 && pHeat[i] > 0.22) pHeat[i] = 0.22;
      if (pAge[i] > 0.85) pLife[i] -= h * (pAge[i] - 0.85) * 2;
    }
    /* Entrainment: ground-marked smoke swells fast — a Saturn's blast cloud doubles and redoubles
       in its first second, and a sprite that stays 2 m never dwarfs the crawler. Vacuum smoke
       (lunar dust) grows far less: there is no air to roll in. */
    /* Non-deflected exhaust entrains too: at 0.35 m/s the ascent trail was a string of separate beads
       rather than a column. Lunar parcels stay thin — a vacuum rolls in no air.
       Earth's figure used to be a flat 1.2 and the trail still degenerated into a thin squiggly
       thread at ~3 km. Cause, measured through the two growth terms: the drag-diss swell
       in the atmosphere branch is `min(14, diss·0.016)·h` and `diss` is the slip SHED per step, so it
       collapses once the parcel flow has decelerated toward the vehicle — which is exactly what
       happens above a few km, where the 900/s emission still spaces parcels only 0.11 m apart at
       100 m/s. Spacing never separated the trail; the swell collapsing did. So the baseline carries
       the rope on its own: 1.9 m/s below 40 km, where the column is the whole read. The bead-merge
       rule from AGENTS.md still holds at the top of the regime — at 720 m/s and 520/s, spacing is
       1.4 m against a 21 m sprite diameter. */
    /* The first 0.45 s of a NON-deflected parcel's life grows at 2.6× the rate below. The
       sprite is band-quantised now (hard silhouette), so the old growth left measurable gaps
       between consecutive silhouettes in the ascent column (seen as scattered dots at
       222 m/s, 2.7 parcels/m); the boost closes them where the column is newest and hottest,
       then hands off to the certified steady rates — the bead-merge rule quoted above is a
       steady-state number and is untouched. Deflected (pSmoke) parcels deliberately skip the
       boost: the pad sheet is tuned, and R_YOUNG below already fights the blast dome. */
    const early = pAge[i] < 0.45 ? 2.6 : 1;
    pR[i] = Math.min(R_CAP, pR[i] + (pSmoke[i] ? (moon ? 5 : 10)
                                             : (moon ? 0.4 : (px * px + py * py + pz * pz < ALT40_R2 ? 1.9 : 1.2)) * early) * h);
    /* The blast read as one giant blurred tan dome because the deflectate inflated
       to the 16 m ceiling within its first half-second — dome first, definition never. A young
       deflected parcel on Earth is now held at R_YOUNG for its first 0.5 s: the sheet climbing
       out of the trench stays a crisp column (its fire is the held trench heat + the drawn
       cone), and the dome is rebuilt from parcels that have already survived the young regime
       and entrain on their own. Lunar deflectate is exempt — the certified Apollo-style spray
       grows at its own 5 m/s — and so is everything older than 0.5 s. The 0.12 tangential
       bleed and the smoke-band age gate are untouched. */
    if (pSmoke[i] && !moon && pAge[i] < 0.5 && pR[i] > R_YOUNG) pR[i] = R_YOUNG;
  } else {
    /* Generic puffs: sparks keep their size; smoke-flagged ones entrain — but entrainment IS air.
       At 67 km staging there is nothing to roll in, and the ungated growth bloomed 26 puffs into
       kilometre-soft bokeh discs against the black: the reviewer's worst frame. The law now reads
       the same atmosphere the plume physics uses — full billow at the pad, ~nothing up high. */
    let grow = 2.4;
    if (pSmoke[i] === SM_SEAM) {
      /* Staging-seam puffs entrain exactly like certified smoke — the airDensity gate — but with
         a low ceiling: they read as dark silhouettes against the flash for 0.4-0.8 s, and at a
         67 km separation ρ≈0 keeps them at a few tenths of m/s. The ceiling matters down low:
         staging at the pad (the 'x' key) must not hand a young 14 m/s billow to a 0.5 s puff. */
      grow = moon ? 1.5 : 14 * THREE.MathUtils.clamp(
        airDensity(Math.sqrt(px * px + py * py + pz * pz) - RE) / 0.25, 0.02, 0.3);
    } else if (pSmoke[i] === SM_TRAIL || pSmoke[i] === SM_STEAM) {
      /* The column and the billow swell fast while they are young and mixing, then hold their
         shape — and only as fast as there is air to roll in. */
      const rho = moon ? 0 : airDensity(Math.sqrt(px * px + py * py + pz * pz) - RE);
      grow = (pSmoke[i] === SM_TRAIL ? (pAge[i] < 1.5 ? 6.5 : 1.6) : (pAge[i] < 1.2 ? 4.5 : 0.8)) * THREE.MathUtils.clamp(rho / 0.25, 0.05, 1);
    } else if (pSmoke[i] === SM_FLASH) {
      /* The staging flash stays SMALL: a light burst that billows is a smoke puff again. */
      grow = 0;
    } else if (pSmoke[i] === SM_SPRAY) {
      /* Lunar dust has no air to roll in: a slow creep is the honest ceiling. */
      grow = moon ? 1.8 : 6;
    } else if (pSmoke[i]) {
      if (moon) grow = 5;
      else {
        const rho = airDensity(Math.sqrt(px * px + py * py + pz * pz) - RE);
        grow = 14 * THREE.MathUtils.clamp(rho / 0.25, 0.03, 1);
      }
    }
    pR[i] = Math.min(R_CAP, pR[i] + grow * h);
  }
  pLife[i] -= h; pAge[i] += h;
  return pLife[i] <= 0 ? 1 : 0;
}

/* Called once per rendered frame with the simulated dt for that frame (main.js: min(1, real×warp)).
   Substepping: h ≈ 1/60 s keeps the step-by-motion under the plume's own depth so the ensemble
   reads as continuous flow. When the warp asks for more than MAX_SUB substeps the system accepts
   h ≈ 33 ms rather than fall behind the clock — at 1000× a 4 km/s parcel can tunnel the ~5 m hull
   radius in one step, the accepted trade; nothing explodes, because the drag update is implicit
   and the colliders are positional. */
export function stepExhaust(dt) {
  if (!(dt > 0)) return;
  const d = Math.min(1, dt);
  const steps = Math.max(1, Math.min(MAX_SUB, Math.ceil(d * 60)));
  const h = d / steps;
  const t = getSimTime();
  moonPos(t, moonP);
  moonVel(t, moonV);
  ship.quatI.copy(ship.quat).invert();
  for (let s = 0; s < steps; s++) {
    tick++;
    for (let k = nAlive - 1; k >= 0; k--)          // back-to-front: swap-remove keeps unvisited k valid
      if (stepParcel(alive[k], h)) killSlot(k);
  }
}
