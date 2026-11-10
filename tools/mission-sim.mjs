/* LUNAR LIFT mission simulator — the answer to "is this mission completable, flown the way the
   game lets you fly it?"

   It drives the shipped modules (js/physics.js, js/vehicle.js, js/constants.js) with nothing but
   the controls a player has: SAS prograde/retrograde, throttle, staging, manual attitude through
   the body-rate channel, and warp-equivalent stepping. Nothing in this file runs in the game.

     node tools/mission-sim.mjs [game|landed|nova|retro] [--phase=<rad>] [--turn=steep] [--trace]

   Default stack is 'game': the specs as js/constants.js ships them, so a plain run verifies the
   vehicle people will actually fly. --phase pins the Moon's angle at MET 0 instead of solving it.

   'three' has to resolve; the game itself stays dependency-free (it loads Three from a CDN
   importmap), so install it for the tool only:  npm i --no-save three@0.187.0

   Units are the game's: km, s, tonnes, kN. simTime is real mission seconds — no time speed-up,
   warp only buys more substeps (js/main.js caps each substep at DTPHYS, so 0.1 s is the step the
   browser itself never exceeds).

   Phases and why each one is what it is:

     ascent     full throttle, prograde SAS, until perigee clears the air. Cutting the burn at
                "apoapsis reached" re-enters: at 5.9 km/s the opposite apsis is thousands of km
                inside the Earth.
     tli        at perigee, burn to the Hohmann-class speed whose apolune deliberately overshoots
                the lunar orbit. An exactly tangent transfer that comes up 2,000 km short never
                enters the sphere of influence, and no correction burn can fix a miss that big.
     mcc        aim the encounter with a few tens of m/s along-track, solved by finite difference
                on the game's own gravity. The launch phase fixes where the Moon is; the burn
                fixes when the transfer arrives.
     approach   cold coast to periselene. Braking from the edge of the SOI is how a flyby becomes
                a propellant shortage: the burn belongs at the bottom of the well.
     loi        retrograde at periselene down to circular speed.
     deorbit    one retrograde pulse; the burn point becomes the apocentre of an ellipse whose
                periselene sits in the descent corridor.
     pdi        powered descent initiation, where a ballistic drop during the braking time equals
                the height left.
     descent    guided terminal descent, envelope-bounded on altitude in both axes.

   Touchdown is the game's decision, not this file's: js/physics.js impact() compares groundVel()
   against LAND_SAFE (32 m/s) in the frame of the surface underneath.
*/
import * as THREE from 'three';

const P = await import('../js/physics.js');
const { stages } = await import('../js/saturn.js');
const C = await import('../js/constants.js');

const WHICH = ['game', 'landed', 'nova', 'retro'].includes(process.argv[2]) ? process.argv[2] : 'game';
const PHASE_ARG = Number((process.argv.find(a => a.startsWith('--phase=')) || '').split('=')[1]);
const TRACE = process.argv.includes('--trace');

const G0 = 9.80665;
const H = 0.1;                              // s — the step js/main.js never exceeds
const PARK_PE = 150, PARK_AP = 185;         // km — parking orbit targets
const AIM_PERI = 350;                       // km — periselene the window is solved for: the middle of the band flown to a
                                            //      soft landing (142-597 km), not its late edge — 110 km is a dry tank
const PE_TARGET = 20;                       // km — periselene of the descent ellipse
const PDI_ALT = 70;                         // km — powered descent initiation
const PDI_TAU = 2.5;                        // s  — guidance time constant
const REQUIRE = 15142;                      // m/s — tools/mission-math.py section 5, one-way to orbit
const IDEAL_TO_ORBIT = 8854;                // m/s — same source, the pad-to-185-km leg alone
const LOG = [];

P.initPhysics({
  scene: new THREE.Scene(), stages,
  hooks: { addLog: m => LOG.push(`${P.getSimTime().toFixed(0)}s ${m}`), setWarn: () => {}, showEndOverlay: () => {} },
  audio: { engine: () => {}, thud: () => {}, explosion: () => {}, win: () => {} },
  vehicleOps: { spawnParticle: () => {}, addDebris: () => {}, detachStage: () => {}, setVisible: () => {} },
});

/* Structural fraction dry/(dry+propellant) is held under 0.16 per stage, which is what real
   upper stages manage; stage 3's thrust is sized so its lunar thrust-to-weight at LOI mass lands
   between 1.2 and 2.2, because a lander that out-accelerates lunar gravity by 20x at its smallest
   lit throttle cannot be guided to a soft touch — it can only oscillate and burn the tank dry.
   The stack in js/constants.js is the one that satisfies every constraint in the header. */
const STACKS = {
  /* The stack the game actually ships, read straight out of js/constants.js before anything is
     overridden — the default so that running the tool verifies the shipped numbers. */
  game: C.SPECS.map(s => ({ dry: s.dry, fuel: s.fuel, thrust: s.thrust, isp: s.isp })),
  landed: [{ dry: 130, fuel: 1800, thrust: 46000, isp: 304 },
           { dry: 90, fuel: 1200, thrust: 16000, isp: 415 },
           { dry: 18, fuel: 185, thrust: 400, isp: 420 }],
  nova: [{ dry: 130, fuel: 3000, thrust: 70000, isp: 330 },
         { dry: 110, fuel: 1500, thrust: 22000, isp: 430 },
         { dry: 25, fuel: 700, thrust: 6000, isp: 460 }],
  /* What shipped before the verified stack: 2,400 + 700 + 400 t. Reaches the Moon and lunar orbit,
     then runs the tank dry on the descent — HARD IMPACT ON THE MOON AT 1264 m/s. */
  retro: [{ dry: 130, fuel: 2400, thrust: 46000, isp: 263 },
          { dry: 120, fuel: 700, thrust: 12000, isp: 340 },
          { dry: 20, fuel: 400, thrust: 3000, isp: 420 }],
};
/* The pitch program as js/constants.js ships it, so the default run tests the game rather than a
   copy of it. --turn=steep tries the reach-horizontal variant, which also completes the mission. */
const TURN = { ...C.TURN };
if ((process.argv.find(a => a.startsWith('--turn=')) || '').split('=')[1] === 'steep') Object.assign(TURN, { t0: 60, ramp: 200, max: Math.PI / 2 });
const AXIS_Z = new THREE.Vector3(0, 0, 1);   // js/physics.js thrust axis (UP_REF)
const MAX_RATE_PY = 0.45;                    // js/physics.js body-rate ceiling

const moon = new THREE.Vector3(), mvel = new THREE.Vector3();
const rel = new THREE.Vector3(), relV = new THREE.Vector3();
const angOf = v => Math.atan2(v.dot(C.MOON_V), v.dot(C.MOON_U));

/* Moon-relative state. The Moon travels at 1,023 m/s through the game frame, so nothing about
   lunar capture or descent can be judged from the inertial velocity. */
function lunarState(t) {
  C.moonPos(t, moon); C.moonVel(t, mvel);
  rel.subVectors(P.S.pos, moon);
  relV.subVectors(P.S.v, mvel);
  const r = rel.length(), v = relV.length(), eps = v * v / 2 - C.MU_M / r;
  return { r, v, alt: r - C.RM, eps, vCirc: Math.sqrt(C.MU_M / r), radial: rel.dot(relV) / r,
           closed: eps < 0, a: eps < 0 ? -C.MU_M / (2 * eps) : Infinity };
}

/* Look-ahead through the game's own gravity (js/physics.js gravityAt: Earth, parametric Moon).
   2 s is plenty for a gravity-only coast and keeps a 5-day look-ahead at a few tens of ms. */
function predictPeri(pos, v, t0, dvPrograde = 0) {
  const p = pos.clone(), u = v.clone(), a = new THREE.Vector3();
  if (dvPrograde) u.addScaledVector(u.clone().normalize(), dvPrograde);
  let best = { r: Infinity, t: t0 };
  const dt = 2;
  for (let n = 1; n <= 240000; n++) {
    const t = t0 + n * dt;
    P.gravityAt(p, a, t);
    u.addScaledVector(a, dt);
    p.addScaledVector(u, dt);
    C.moonPos(t, moon);
    const rM = p.distanceTo(moon);
    if (rM < best.r) best = { r: rM, t };
    if (n > 500 && p.length() > C.MOON_DIST * 1.15 && rM > best.r * 1.5) break;
  }
  return best;
}

function stageUp() {
  const a = P.activeStage();
  if (a >= 0 && stages[a].fuel === 0) {
    P.separateStage();
    const b = P.activeStage();
    if (b >= 0 && stages[b].fuel > 0 && !P.getEngineOn()) P.toggleIgnite();
  }
}
const accMax = () => { const a = P.activeStage(); return a >= 0 ? C.SPECS[a].thrust / P.totalMass() / 1000 : 0; };
const fuelLeft = () => { const a = P.activeStage(); return a >= 0 ? stages[a].fuel : 0; };
const veOf = i => C.SPECS[i].isp * G0 / 1000;

/* capture=false skips the correction burns, which is what the phase solve needs: it wants the bare
   transfer's first periselene. stopAtPeri ends the run there instead of continuing to the surface. */
function mission(phase, { trace = false, capture = true, stopAtPeri = false } = {}) {
  for (let i = 0; i < 3; i++) Object.assign(C.SPECS[i], STACKS[WHICH][i]);
  Object.assign(C.TURN, TURN);
  C.setMoonPhase(phase);
  P.resetSim();
  /* js/physics.js re-reads SPECS for thrust and Isp every step and re-syncs each stage's fuel from
     SPECS on reset, but the dry masses were copied into the live stage objects when vehicle.js
     loaded. Writing SPECS alone changes the engine and leaves the hull, so write both. */
  for (let i = 0; i < 3; i++) { stages[i].dry = STACKS[WHICH][i].dry; stages[i].fuel = STACKS[WHICH][i].fuel; }
  LOG.length = 0;
  P.toggleIgnite(); P.setSas(true, false); P.setTargetThrottle(1);

  let mode = 'ascent', apPass = 0, prevRadial = 1, inSoi = false, pdi = null;
  let dv = 0, dvMark = 0, mccDone = 0, mccNext = 0, burnUntil = 0;
  const ev = {}, marks = [];
  let closest = 1e9;
  const t0wall = Date.now();

  /* Delta-v, measured the way the game meters it: js/physics.js spends propellant at
     thrust/(Isp*g0) per second, which makes thrust = mdot*Isp*g0 an identity, so the rocket
     equation over each step is exact and independent of the step size. */
  const mark = name => {
    marks.push({ name, t: +P.getSimTime().toFixed(0), dv: Math.round((dv - dvMark) * 1000),
                 mass: Math.round(P.totalMass()), fuel: stages.map(s => s.fuel.toFixed(1)).join('/'),
                 altE: Math.round(P.S.pos.length() - C.RE), altM: Math.round(P.S.pos.distanceTo(moon) - C.RM) });
    dvMark = dv;
  };

  for (let i = 0; i < 12000000; i++) {
    const st = P.getState();
    if (st !== 'flying' && st !== 'pad') break;
    const el = P.orbitalElements(P.S.pos, P.S.v, C.MU_E, C.RE);
    const rE = P.S.pos.length(), altE = rE - C.RE;
    const L = lunarState(P.getSimTime());
    if (L.r < closest) closest = L.r;
    stageUp();
    const fuel = fuelLeft(), aMax = accMax();
    /* Apollo aimed its transfer past the Moon for exactly this reason. */
    const vT = Math.sqrt(C.MU_E * (2 / rE - 1 / ((rE + C.MOON_DIST * 1.012) / 2)));

    if (mode === 'ascent') {
      P.setSas(true, false);
      if (el.pe >= PARK_PE && el.ap >= PARK_AP) {
        P.setTargetThrottle(0);
        ev.orbit = { t: +P.getSimTime().toFixed(0), ap: +el.ap.toFixed(0), pe: +el.pe.toFixed(0), vInert: +P.S.v.length().toFixed(4) };
        mark('ascent');
        mode = 'tliwait';
      } else if (fuel <= 0) { P.setTargetThrottle(0); mode = 'dry'; }
      else P.setTargetThrottle(1);
    } else if (mode === 'tliwait') {
      P.setTargetThrottle(0);
      if (P.S.v.dot(P.S.pos) / rE < 0) apPass = apPass || P.getSimTime();
      if (apPass && altE < PARK_AP + 60 && fuel > 0) {
        /* lead: how far the Moon is ahead of the ship along the orbit at ignition, rad — the number
           js/hud.js's "translunar burn in mm:ss" cue counts down to (TLI_LEAD in js/constants.js). */
        C.moonPos(P.getSimTime(), moon);
        const lead = ((angOf(moon) - angOf(P.S.pos)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        ev.tliIgn = { t: +P.getSimTime().toFixed(0), vInert: +P.S.v.length().toFixed(4), lead: +lead.toFixed(4), altE: +altE.toFixed(0) };
        P.setSas(true, false); P.setTargetThrottle(1); mode = 'tli';
      } else if (P.getSimTime() > 40000) mode = 'dry';
    } else if (mode === 'tli') {
      P.setSas(true, false); P.setTargetThrottle(1);
      if (P.S.v.length() >= vT) {
        P.setTargetThrottle(0);
        const elT = P.orbitalElements(P.S.pos, P.S.v, C.MU_E, C.RE);
        ev.tli = { t: +P.getSimTime().toFixed(0), vInert: +P.S.v.length().toFixed(4),
                   dv: +(P.S.v.length() - ev.tliIgn.vInert).toFixed(4), ap: +elT.ap.toFixed(0), pe: +elT.pe.toFixed(0) };
        mark('tli');
        mode = 'mcc'; mccNext = P.getSimTime() + 600;
      } else if (fuel <= 0) { P.setTargetThrottle(0); mode = 'dry'; }
    } else if (mode === 'mcc' && !capture) {
      /* Targeting probe: no correction burns. Record the outbound crossing of the lunar orbit
         radius and the Moon's angular distance from it, then keep flying to periselene. */
      P.setTargetThrottle(0);
      if (ev.cross === undefined && rE > C.MOON_DIST && P.S.v.dot(P.S.pos) > 0) {
        C.moonPos(P.getSimTime(), moon);
        let e = angOf(P.S.pos) - angOf(moon);
        e = ((e + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        ev.cross = { t: +P.getSimTime().toFixed(0), err: +e.toFixed(6) };
      }
      if (L.radial > 0 && prevRadial <= 0 && L.r < C.SOI_M * 1.05) {
        ev.periselene = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(0), vRel: +L.v.toFixed(4) };
        if (stopAtPeri) break;
      }
      prevRadial = L.radial;
      if (P.getSimTime() > 400000) break;
    } else if (mode === 'mcc') {
      /* Throttle run-down. The cutoff above commands targetThrottle 0; the engine keeps pushing
         until the actual throttle reaches zero, and the surplus is not negligible — coasting
         forward from the commanded state misses the Moon by more than 16,000 km, while this state
         reaches the 203 km periselene that the flight records. So this, not the command, is the
         trajectory the mission is actually on, and js/targeting.js is validated against it. */
      if (!ev.tliDone && P.getThrottle() < 0.01) {
        ev.tliDone = { t: +P.getSimTime().toFixed(3), vInert: +P.S.v.length().toFixed(4),
                       surplus: +((P.S.v.length() - ev.tli.vInert) * 1000).toFixed(1),
                       pos: P.S.pos.toArray().map(x => +x.toFixed(3)), vel: P.S.v.toArray().map(x => +x.toFixed(6)) };
      }
      /* Aim. The transfer crosses the lunar orbit radius at a time set by its energy, and the
         Moon's position at that time is set by the launch phase. Along-track Δv moves the crossing
         time, so a small prograde/retrograde pulse closes the miss; the sensitivity comes from a
         finite difference of the forward model rather than a guessed sign. */
      P.setTargetThrottle(0);
      if (burnUntil > 0 && P.getSimTime() >= burnUntil) { P.setTargetThrottle(0); burnUntil = 0; mark('mcc'); }
      if (burnUntil === 0 && P.getSimTime() >= mccNext && fuel > 60 && mccDone < 4) {
        const now = predictPeri(P.S.pos, P.S.v, P.getSimTime());
        const errKm = (now.r - C.RM) - AIM_PERI;
        if (now.r > C.RM + 120 && now.r - C.RM < 2500) {
          /* The state at this instant is the one the game then coasts to the Moon, and the flight
             below proves where it goes (see ev.peri). pos/vel are recorded so the encounter can be
             reproduced — js/targeting.js is checked against exactly this. The TLI cutoff above is
             NOT such a state: the throttle is still running down, and roughly 3 m/s of leftover
             burn there moves the encounter by 20,000 km. */
          ev.aimed = { t: +P.getSimTime().toFixed(0), peri: +(now.r - C.RM).toFixed(0), burns: mccDone,
                       pos: P.S.pos.toArray().map(x => +x.toFixed(3)), vel: P.S.v.toArray().map(x => +x.toFixed(6)) };
          mark('mcc');
          mode = 'approach'; prevRadial = L.radial;
        } else {
          const probe = predictPeri(P.S.pos, P.S.v, P.getSimTime(), 0.010);
          const dPeri = (probe.r - now.r) / 0.010;
          if (Math.abs(dPeri) > 5) {
            const dvv = THREE.MathUtils.clamp(-errKm / dPeri, -0.03, 0.03);
            if (Math.abs(dvv) > 0.0005) {
              burnUntil = P.getSimTime() + Math.abs(dvv) / Math.max(aMax, 1e-4);
              P.setSas(true, dvv < 0); P.setTargetThrottle(0.25); mccDone++;
              ev['mcc' + mccDone] = { t: +P.getSimTime().toFixed(0), errKm: +errKm.toFixed(0), dv: +(dvv * 1000).toFixed(1),
                                      kmPerM_s: +(Math.abs(dPeri) / 1000).toFixed(2) };
            }
          }
        }
        mccNext = P.getSimTime() + 6000;
      }
      if (L.r < C.SOI_M && burnUntil === 0) { mode = 'approach'; prevRadial = L.radial; }
      if (P.getSimTime() > 500000) mode = 'dry';
    } else if (mode === 'approach') {
      P.setTargetThrottle(0);
      if (L.r < C.SOI_M) inSoi = true;
      if (L.radial > 0 && prevRadial <= 0 && inSoi) {
        ev.periselene = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(0), vRel: +L.v.toFixed(4),
                          vCirc: +L.vCirc.toFixed(4), vInf: +Math.sqrt(2 * Math.abs(L.eps)).toFixed(4),
                          dvToOrbit: +Math.max(0, L.v - L.vCirc).toFixed(4) };
        mode = L.closed ? 'orbitCheck' : 'loi';
      } else if (inSoi && L.r > C.SOI_M * 1.6) mode = 'bounce';
      prevRadial = L.radial;
    } else if (mode === 'loi') {
      /* Retrograde at periselene, throttled so the burn ends at circular speed instead of
         overshooting into an ellipse that falls back on the Moon. */
      const want = L.vCirc * 1.01, over = L.v - want;
      P.setSas(true, true);
      P.setTargetThrottle(fuel > 0 ? THREE.MathUtils.clamp(over / Math.max(aMax * H, 1e-9), 0.05, 1) : 0);
      if (fuel <= 0) { P.setTargetThrottle(0); mode = 'dry'; }
      else if (L.v <= want) {
        P.setTargetThrottle(0);
        ev.loi = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(0), vRel: +L.v.toFixed(4) };
        mark('loi');
        mode = 'orbitCheck';
      } else if (L.radial > 0 && L.alt > ev.periselene.altM + 200) { P.setTargetThrottle(0); mode = 'dry'; }
    } else if (mode === 'orbitCheck') {
      P.setTargetThrottle(0);
      if (!ev.parked) ev.parked = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(0), vRel: +L.v.toFixed(4), aMoon: +(L.closed ? L.a : Infinity).toFixed(0) };
      if (!L.closed) mode = 'loi';
      else if (L.alt > 130) { P.setSas(true, true); P.setTargetThrottle(fuel > 0 ? 0.2 : 0); mode = 'deorbit'; }
      else { pdi = { h: L.alt, prevV: null, tPrev: P.getSimTime() }; ev.descStart = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(1), vRel: +L.v.toFixed(4) }; mark('pdi'); mode = 'descend'; }
    } else if (mode === 'deorbit') {
      const aT = (L.r + C.RM + PE_TARGET) / 2;                 // burn point becomes the apocentre
      const vT2 = Math.sqrt(C.MU_M * (2 / L.r - 1 / aT));
      P.setSas(true, true);
      P.setTargetThrottle(fuel > 0 && L.v > vT2 ? 0.25 : 0);
      if (fuel <= 0) { P.setTargetThrottle(0); mode = 'dry'; }
      else if (L.v <= vT2) {
        P.setTargetThrottle(0);
        ev.deorbit = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(0), vRel: +L.v.toFixed(4),
                       coastH: +((2 * Math.PI * Math.sqrt(aT ** 3 / C.MU_M) / 2) / 3600).toFixed(1) };
        mark('deorbit');
        mode = 'toPeri'; prevRadial = L.radial;
      }
    } else if (mode === 'toPeri') {
      P.setSas(false);
      P.setTargetThrottle(0);
      if (L.radial < 0 && L.alt < PDI_ALT) {
        pdi = { h: L.alt, prevV: null, tPrev: P.getSimTime() };
        ev.descStart = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(1), vRel: +L.v.toFixed(4) };
        mark('pdi');
        mode = 'descend';
      }
      const periodM = L.closed ? 2 * Math.PI * Math.sqrt(L.a ** 3 / C.MU_M) : 1e6;
      if (P.getSimTime() - (ev.deorbit || ev.parked).t > periodM * 2 + 20000) mode = 'dry';
    } else if (mode === 'descend') {
      /* Guided terminal descent. a_cmd = (v_des − v)/tau + dv_des/dt − g_abs + g_moon, with the
         commanded velocity bounded by altitude in both axes:

             |v_r| <= min( sqrt(2 a_v h), 0.35, 0.06 h )      a_v = 0.35 a_max − g
             |v_t| <= min( |v_t|, sqrt(2 a_h h · 0.8), 0.05 h )

         Bounding on altitude rather than on a downrange aim point is what makes a terrain impact
         impossible by construction. An aim point sounds right and is not: recomputed from the
         current speed it never collapses, and the straight-line path to a point on a sphere meets
         the ground short of it — one attempt arrived at 1,000 m/s with a nominal guidance error of
         2 m/s^2. The dv_des/dt feedforward matters just as much: without it the loop is first order
         and trails its own target by a*tau, which in the last kilometre is the 20-40 m/s that
         reached the surface. */
      const rHat = rel.clone().normalize();
      const vRel = relV.clone();
      const vTan = vRel.clone().addScaledVector(rHat, -vRel.dot(rHat));
      const vtMag = vTan.length();
      /* Height of the engine bell over the surface — js/physics.js surfaceAlt, the same number contact
         is judged by. L.alt is the middle of the full stack, 9.5 m BELOW the lone CSM's tail. */
      const hKm = Math.max(0.0005, P.surfaceAlt(true));
      const gM = C.MU_M / (L.r * L.r);
      const aV = Math.max(0.35 * aMax - gM, 0.4 * gM);
      const aH = Math.max(0.40 * aMax, 0.5 * gM);
      const vrDes = -Math.min(Math.sqrt(2 * aV * hKm), 0.35, 0.06 * hKm * 1000);
      const vtDes = Math.min(vtMag, Math.sqrt(2 * aH * hKm * 0.8), 0.05 * hKm * 1000);
      const vDes = rHat.clone().multiplyScalar(vrDes);
      if (vtMag > 1e-6) vDes.addScaledVector(vTan, vtDes / vtMag);
      C.moonPos(P.getSimTime(), moon); C.moonVel(P.getSimTime(), mvel);
      const gAbs = P.gravityAt(P.S.pos, new THREE.Vector3(), P.getSimTime());
      const gMoonFrame = moon.clone().multiplyScalar(-C.MU_E / Math.pow(moon.length(), 3));
      const dVDes = pdi.prevV ? vDes.clone().sub(pdi.prevV).divideScalar(Math.max(1e-4, P.getSimTime() - pdi.tPrev))
                              : new THREE.Vector3();
      pdi.prevV = vDes.clone(); pdi.tPrev = P.getSimTime();
      const aCmd = vDes.clone().sub(vRel).divideScalar(PDI_TAU).add(dVDes).sub(gAbs).add(gMoonFrame);
      const aMag = aCmd.length();
      const dir = aMag > 1e-9 ? aCmd.clone().multiplyScalar(1 / aMag) : rHat;
      P.setSas(false);
      if (hKm * 1000 < 3) P.setTargetThrottle(0);                 // the last 3 m fall: 3 m/s
      else {
        /* Attitude by body-rate command — what the rotation controls do, and what the game's own
           SAS does, including the shortest-arc hemisphere fix. Writing S.q directly would claim
           authority the attitude control does not have. */
        const errB = P.S.q.clone().invert().multiply(new THREE.Quaternion().setFromUnitVectors(AXIS_Z, dir));
        if (errB.w < 0) errB.set(-errB.x, -errB.y, -errB.z, -errB.w);
        errB.normalize();
        const errAng = 2 * Math.acos(THREE.MathUtils.clamp(errB.w, -1, 1));
        if (errB.lengthSq() > 1e-10 && errAng > 1e-3) {
          const want = Math.min(0.85 * MAX_RATE_PY, 1.6 * errAng);
          const k = Math.min(0.9, 1.2 * H);
          const ax = new THREE.Vector3(errB.x, errB.y, errB.z).normalize();
          P.omega.x += (ax.x * want - P.omega.x) * k;
          P.omega.y += (ax.y * want - P.omega.y) * k;
          P.omega.z += (ax.z * want - P.omega.z) * k;
        } else P.omega.set(0, 0, 0);
        P.setTargetThrottle(THREE.MathUtils.clamp(aMag / Math.max(aMax, 1e-6), 0, 1));
      }
      if (trace && i % 250 === 0) console.log(`    descent t=${P.getSimTime().toFixed(0)} h=${(hKm * 1000).toFixed(0)} m`
        + ` v=${(L.v * 1000).toFixed(0)} vr=${(L.radial * 1000).toFixed(0)} vt=${(vtMag * 1000).toFixed(0)}`
        + ` vdes=${(vDes.length() * 1000).toFixed(0)} align=${P.fwd().dot(dir).toFixed(2)}`
        + ` thr=${P.getThrottle().toFixed(2)} fuel=${stages[2].fuel.toFixed(1)}`);
      if (fuel <= 0 && hKm > 2) mode = 'dry';
      if (P.getState() !== 'flying') mark('descent');
    } else {
      P.setTargetThrottle(0);
      if (P.getSimTime() > 800000) break;
    }

    /* Always H, never a coarser coast step. js/main.js splits warp into substeps capped at
       DTPHYS = 0.1 s, so 0.1 s is the ONLY step the game can produce, and the translunar encounter
       is sensitive enough that stepping the coast at 1 s changes the periselene by ~870 km — the
       whole difference between a nominal landing and a correction burn. A faster coast step would
       certify a trajectory no player can fly. */
    const step = H;
    const mBefore = P.totalMass(), stageBefore = P.activeStage(), burnBefore = P.isBurning();
    P.physStep(step);
    /* On the pad js/physics.js meters propellant while the launch clamp still holds the vehicle, so
       that propellant is a loss, not delta-v; counting it inflates the ascent by a few hundred m/s. */
    if (burnBefore && stageBefore >= 0 && st !== 'pad') {
      const mAfter = P.totalMass();
      if (mBefore > mAfter) dv += veOf(stageBefore) * Math.log(mBefore / mAfter);
    }
    if (trace && i % 500 === 499) {
      console.log(`  ${mode} t=${P.getSimTime().toFixed(0)} altE=${altE.toFixed(0)} apE=${isFinite(el.ap) ? el.ap.toFixed(0) : 'inf'}`
        + ` rM=${L.r.toFixed(0)} vRel=${(L.v * 1000).toFixed(0)} vSurf=${(P.groundVel(new THREE.Vector3()).length() * 1000).toFixed(0)}`
        + ` thr=${P.getThrottle().toFixed(2)} fuel=${stages.map(s => s.fuel.toFixed(0)).join('/')}`);
    }
  }
  if (mode === 'descend') mark('descent');   // the loop exits on impact/win; account the terminal burn
  ev.dvTotal = Math.round(dv * 1000);
  ev.wall = +((Date.now() - t0wall) / 1000).toFixed(1);
  return { state: P.getState(), mode, closest, t: P.getSimTime(), fuel: stages.map(s => s.fuel), ev, marks, log: LOG.slice() };
}

/* The launch phase is the only freedom in where the transfer goes, and near a lunar encounter it
   is monotonic: too little phase and the Moon is ahead, the miss is large and positive; too much
   and the trajectory meets the surface. So bisect on the first periselene altitude. 1 km of aim
   is 2.6e-6 rad of phase, which is why this is solved numerically rather than by eye. */
function probePeri(ph) {
  const q = mission(ph, { capture: false, stopAtPeri: true });
  if (q.ev.periselene) return q.ev.periselene.altM;
  return q.log.some(l => l.includes('IMPACT ON THE MOON')) ? -1e4 : 1e5;
}

/* Ideal staged budget: every gram through its own engine at full expansion, nothing spent on
   gravity, drag, steering or the landing reserve. Compare against REQUIRE; the difference is what
   the flight below has to pay for, and the reserve in it is what descent gets to use. */
function idealBudget(stack) {
  let m = C.CAPSULE_MASS;
  for (const x of stack) m += x.dry + x.fuel;
  const parts = [];
  for (let i = 0; i < stack.length; i++) {
    const m0 = m, m1 = m - stack[i].fuel;
    parts.push(stack[i].isp * G0 / 1000 * Math.log(m0 / m1));   // the stack's own Isp, not SPECS'
    m = m1 - (i < stack.length - 1 ? stack[i].dry : 0);
  }
  return { parts: parts.map(x => Math.round(x * 1000)), total: Math.round(parts.reduce((a, c) => a + c) * 1000) };
}

let b = C.CAPSULE_MASS; for (const x of STACKS[WHICH]) b += x.dry + x.fuel;
const budget = idealBudget(STACKS[WHICH]);
console.log(`stack=${WHICH} ignition=${b.toFixed(0)} t  pad TWR=${(STACKS[WHICH][0].thrust / b / 9.80665).toFixed(2)} g`
  + `  ideal budget=${budget.parts.join(' + ')} = ${budget.total} m/s  (all propellant, nothing wasted)`);
console.log(`one-way requirement to lunar orbit = ${REQUIRE} m/s  (mission-math.py section 5) -> ${(budget.total / REQUIRE).toFixed(2)}x`);

let phase = Number.isFinite(PHASE_ARG) ? PHASE_ARG : NaN;
if (!Number.isFinite(phase)) {
  let lo = 1.7595, hi = 2.2249, flo = probePeri(lo), fhi = probePeri(hi);
  while (!(flo > AIM_PERI && fhi < AIM_PERI)) {                 // walk the bracket until it straddles
    hi = (hi + 0.25) % (2 * Math.PI);
    fhi = probePeri(hi);
    if (fhi > AIM_PERI) { lo = hi; flo = fhi; }
  }
  for (let k = 0; k < 16; k++) {
    const m = (lo + (((hi - lo) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) / 2) % (2 * Math.PI);
    const fm = probePeri(m);
    console.log(`  solve ${k}: phase=${m.toFixed(7)} periselene=${fm >= 1e5 ? 'no encounter' : fm.toFixed(1) + ' km'}`);
    if (fm > AIM_PERI) { lo = m; flo = fm; } else { hi = m; fhi = fm; }
    if (Math.abs(fm - AIM_PERI) < 5) break;
  }
  phase = ((lo + hi) / 2 + 2 * Math.PI) % (2 * Math.PI);
}

const r = mission(phase, { trace: TRACE });
console.log(`\nphase=${phase.toFixed(7)} -> ${r.state} / ${r.mode}   closest Moon-centred range ${(r.closest / 1000).toFixed(1)}k km`
  + `   mission ${(r.t / 86400).toFixed(3)} d   wall ${r.ev.wall}s`);
console.log('\n--- delta-v by phase (rocket equation over the propellant each step spent) ---');
console.log('  phase        t(s)     dv m/s   mass t   fuel left');
for (const m of r.marks) console.log(`  ${m.name.padEnd(10)} ${String(m.t).padStart(8)} ${String(m.dv).padStart(10)} ${String(m.mass).padStart(8)}   ${m.fuel}`);
console.log(`  ${'TOTAL'.padEnd(10)} ${String(Math.round(r.t)).padStart(8)} ${String(r.ev.dvTotal).padStart(10)}`);
const asc = r.marks.find(m => m.name === 'ascent');
if (asc) console.log(`  ascent: flown ${asc.dv} m/s against the ${IDEAL_TO_ORBIT} m/s that mission-math.py section 5`
  + ` derives for the same manoeuvre with Apollo hardware -> ~${asc.dv - IDEAL_TO_ORBIT}`
  + ` m/s of gravity, drag and steering (Apollo 11's own derived band: 1469-1997)`);
console.log('\n--- events ---');
for (const [k, v] of Object.entries(r.ev)) console.log(`  ${k}: ${JSON.stringify(v)}`);
console.log(`\nRESULT ${r.state.toUpperCase()}  fuel left ${r.fuel.map(x => x.toFixed(1)).join('/')} t`);
/* The exit code is the verdict: the shipped stacks must WIN, the retro stack is kept as a recorded
   LOSS. --expect=won|lost|any overrides. A check that cannot fail is not a check. */
const EXPECT = (process.argv.find(a => a.startsWith('--expect=')) || '').split('=')[1] || (WHICH === 'retro' ? 'lost' : 'won');
process.exitCode = EXPECT === 'any' || r.state === EXPECT ? 0 : 1;
console.log('  log:', r.log.slice(-6).join('\n        '));
