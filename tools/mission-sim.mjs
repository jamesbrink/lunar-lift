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
   warp only buys more steps (js/main.js banks frame time and spends it in whole DTPHYS steps, so
   0.1 s is the one step the browser takes in flight).

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
const A = await import('../js/aero.js');
const T = await import('../js/targeting.js');

/* The stack is the first argument; omitted (no arguments, or flags only) it is 'game'. */
const WHICH = process.argv[2] === undefined || process.argv[2].startsWith('--') ? 'game'
  : ['game', 'landed', 'nova', 'retro'].includes(process.argv[2]) ? process.argv[2]
    : (console.error(`unknown stack '${process.argv[2]}' — game | landed | nova | retro`), process.exit(2));
const PHASE_ARG = Number((process.argv.find(a => a.startsWith('--phase=')) || '').split('=')[1]);
const TRACE = process.argv.includes('--trace');
const WAIT = Number((process.argv.find(a => a.startsWith('--wait=')) || '').split('=')[1] || 0);

const G0 = 9.80665;
const H = 0.1;                              // s — DTPHYS, the step js/main.js takes in flight
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

/* Conic periapsis of a Moon-relative state, km above the datum sphere: p/(1+e) − RM with
   p = h²/µ and e from the vis-viva eccentricity relation. The insertion cut needs it because a
   sub-circular tangential speed at 25 km is a free impact ticket two thirds of an orbit later. */
const periapsisKm = (r, v, vt) => {
  const h = r * vt;
  const p = h * h / C.MU_M;
  const e = Math.sqrt(Math.max(0, 1 + (v * v - 2 * C.MU_M / r) * p / C.MU_M));
  return p / (1 + e) - C.RM;
};

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
  const a = P.activeEngine();
  if (a >= 0 && stages[a].fuel === 0) {
    P.separateStage();
    const b = P.activeEngine();
    if (b >= 0 && stages[b].fuel > 0 && !P.getEngineOn()) P.toggleIgnite();
  }
}
const accMax = () => { const a = P.activeEngine(); return a >= 0 ? C.SPECS[a].thrust / P.totalMass() / 1000 : 0; };
const fuelLeft = () => { const a = P.activeEngine(); return a >= 0 ? stages[a].fuel : 0; };
const veOf = i => C.SPECS[i].isp * G0 / 1000;

/* capture=false skips the correction burns, which is what the phase solve needs: it wants the bare
   transfer's first periselene. stopAtPeri ends the run there instead of continuing to the surface. */
function mission(phase, { trace = false, capture = true, stopAtPeri = false } = {}) {
  /* Stacks shorter than the shipped 5-row SPECS are one-way vehicles: the LM rows stay at their
     shipped values but the stages are separated from the first step — they ride nowhere, burn
     nothing, and touch nothing. That is how the one-way regressions (landed, nova, retro) keep
     flying exactly the missions they were certified on. */
  const NR = STACKS[WHICH].length;
  const ROUND = NR >= 5;
  for (let i = 0; i < NR; i++) Object.assign(C.SPECS[i], STACKS[WHICH][i]);
  Object.assign(C.TURN, TURN);
  C.setMoonPhase(phase);
  P.resetSim();
  if (!ROUND) for (let i = NR; i < stages.length; i++) { stages[i].separated = true; stages[i].fuel = 0; }
  /* js/physics.js re-reads SPECS for thrust and Isp every step and re-syncs each stage's fuel from
     SPECS on reset, but the dry masses were copied into the live stage objects when vehicle.js
     loaded. Writing SPECS alone changes the engine and leaves the hull, so write both. */
  for (let i = 0; i < NR; i++) { stages[i].dry = STACKS[WHICH][i].dry; stages[i].fuel = STACKS[WHICH][i].fuel; }
  LOG.length = 0;
  /* --wait=s: stand on the pad that many mission seconds before lighting — waiting on the pad
     is how a player moves the launch window, and the wait table in
     docs/reference/mission-design.md is made from these runs. */
  if (WAIT > 0) for (let k = 0; k < WAIT * 10; k++) P.physStep(0.1);
  P.toggleIgnite(); P.setSas(true, false); P.setTargetThrottle(1);

  let mode = 'ascent', apPass = 0, prevRadial = 1, inSoi = false, pdi = null;
  let tClimb = 0, hohV = 0, teiDir = null, apexPeri = 0;
  let dv = 0, dvMark = 0, mccDone = 0, mccNext = 0, burnUntil = 0;
  const ev = {}, marks = [];
  /* Ascent structural telemetry. Every number in the ascent tables of
     docs/reference/atmosphere.md (max-Q, side load, angle of attack, static margin across the
     stagings, strain) comes from these lines, so when the SPECS masses move the tables move with
     the run and no quoted number goes unmeasured. */
  let lastEng = -1, dvDrag = 0;
  ev.ascent = { rows: [], tNext: 0 };
  ev.stageMargin = [];
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

  /* Attitude by body-rate command — what the rotation controls do, and what the game's own SAS
     does, including the shortest-arc hemisphere fix. Writing S.q directly would claim authority
     the attitude control does not have. Every guided phase steers through this. */
  const steerTo = dir => {
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
  };
  const wrapPi = e => ((e + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  const PLANE_N = new THREE.Vector3().crossVectors(C.MOON_U, C.MOON_V).normalize();

  /* 24M steps: the round trip is ~10 days at 0.1 s (outbound 3.5, up to one synodic wait in the
     insertion orbit, ascent and dock, ~5 days home) against the one-way's 3.5. */
  for (let i = 0; i < 24000000; i++) {
    const st = P.getState();
    if (st !== 'flying' && st !== 'pad') break;
    const el = P.orbitalElements(P.S.pos, P.S.v, C.MU_E, C.RE);
    const rE = P.S.pos.length(), altE = rE - C.RE;
    const L = lunarState(P.getSimTime());
    if (L.r < closest) closest = L.r;
    if (mode === 'ascent') {
      const aS = P.aeroState, ld = Math.abs(P.getAeroLoad()), tSec = P.getSimTime();
      if (aS.q > (ev.maxQ?.q ?? 0)) ev.maxQ = { q: +aS.q.toFixed(3), t: +tSec.toFixed(1), alt: +altE.toFixed(1), mach: +aS.mach.toFixed(2) };
      if (ld > (ev.loadPeak?.load ?? 0)) ev.loadPeak = { load: +ld.toFixed(4), t: +tSec.toFixed(1), mach: +aS.mach.toFixed(2) };
      if (P.getStrain() > (ev.strainPeak ?? 0)) ev.strainPeak = +P.getStrain().toFixed(3);
      dvDrag += aS.q * C.CD_AREA * A.machDrag(aS.mach) * Math.cos(aS.aoa) ** 2 / P.totalMass() / 1000 * 0.1;
      if (tSec >= ev.ascent.tNext && altE < 120 && aS.q > 0) {
        ev.ascent.rows.push([+tSec.toFixed(0), +altE.toFixed(1), +aS.q.toFixed(2), +aS.mach.toFixed(2),
                             +(aS.aoa * 57.2958).toFixed(1), +ld.toFixed(4), +P.stability().toFixed(1)]);
        ev.ascent.tNext = tSec + 10;
      }
    }
    if (ev.padMargin === undefined && st === 'pad') ev.padMargin = +P.stability().toFixed(2);
    { const engNow = P.activeEngine();
      if (lastEng >= 0 && engNow !== lastEng) ev.stageMargin.push({ from: lastEng, to: engNow, t: +P.getSimTime().toFixed(1), margin: +P.stability().toFixed(1), v: +P.S.v.length().toFixed(4) });
      lastEng = engNow; }
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
         forward from the commanded state missed the Moon by more than 16,000 km when this was
         measured, while this state reaches the periselene the flight records (346 km on the
         shipped window). So this, not the command, is the
         trajectory the mission is actually on, and js/targeting.js is validated against it. */
      if (!ev.tliDone && P.getThrottle() < 0.01) {
        ev.tliDone = { t: +P.getSimTime().toFixed(3), vInert: +P.S.v.length().toFixed(4),
                       surplus: +((P.S.v.length() - ev.tli.vInert) * 1000).toFixed(1),
                       pos: P.S.pos.toArray().map(x => +x.toFixed(3)), vel: P.S.v.toArray().map(x => +x.toFixed(6)) };
        /* The HUD's number from the same state the ship is actually on — js/targeting.js scored
           against the flown periselene, the predictor table in mission-design.md is made here. */
        ev.aimLP = +T.lunarPass(P.S.pos, P.S.v, P.getSimTime(), { alt: 0, t: 0 }).alt.toFixed(1);
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
      else if (L.alt > 130) {
        if (ROUND) { P.parkCsm(); mark('demate'); mode = 'deorbit'; }   // the CSM stops being flown here; the LM drops to the surface
        else { P.setSas(true, true); P.setTargetThrottle(fuel > 0 ? 0.2 : 0); mode = 'deorbit'; }
      }
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
      if (ROUND && stages[3].separated) {          // physics touched the LM down and jetisoned its descent stage
        mark('touchdown');
        P.setTargetThrottle(0);
        tClimb = P.getSimTime();
        mode = 'lmClimb';
      } else {
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
        steerTo(dir);
        P.setTargetThrottle(THREE.MathUtils.clamp(aMag / Math.max(aMax, 1e-6), 0, 1));
      }
      if (trace && i % 250 === 0) console.log(`    descent t=${P.getSimTime().toFixed(0)} h=${(hKm * 1000).toFixed(0)} m`
        + ` v=${(L.v * 1000).toFixed(0)} vr=${(L.radial * 1000).toFixed(0)} vt=${(vtMag * 1000).toFixed(0)}`
        + ` vdes=${(vDes.length() * 1000).toFixed(0)} align=${P.fwd().dot(dir).toFixed(2)}`
        + ` thr=${P.getThrottle().toFixed(2)} fuel=${stages[Math.max(0, P.activeEngine())].fuel.toFixed(1)}`);
      if (fuel <= 0 && hKm > 2) mode = 'dry';
      if (P.getState() !== 'flying') mark('descent');
      }
    } else if (mode === 'lmClimb') {
      /* Lunar ascent, insertion at 20 km. A gravity turn keyed on ALTITUDE: thrust vector on the
         deck at liftoff, tilting to horizontal between 1 and 14 km, full throttle; then an explicit
         circularisation law a_cmd = (t̂·vC − v)/8 − g_abs + g_moon that kills the radial rate and
         takes the speed to circular together. The first attempt ramped the tangential target on
         TIME, which the stage cannot follow at 4.7 m/s²: the loop pinned the engine nearly
         horizontal a kilometre up and hopped the vehicle back into the ground at 469 m/s. */
      const hKm = Math.max(0.0005, P.surfaceAlt(true));
      const tHat = new THREE.Vector3().crossVectors(PLANE_N, rel).normalize();
      const vC15 = Math.sqrt(C.MU_M / (C.RM + 20));
      C.moonPos(P.getSimTime(), moon); C.moonVel(P.getSimTime(), mvel);
      const gAbs = P.gravityAt(P.S.pos, new THREE.Vector3(), P.getSimTime());
      const gMF = moon.clone().multiplyScalar(-C.MU_E / Math.pow(moon.length(), 3));
      let dir, thr;
      if (hKm < 12) {
        const th = THREE.MathUtils.clamp((hKm - 0.5) / 9.5, 0, 1) * Math.PI / 2;
        dir = rel.clone().multiplyScalar(Math.cos(th) / L.r).addScaledVector(tHat, Math.sin(th)).normalize();
        thr = 1;
      } else {
        /* Circularise AT 20 km, not wherever the vehicle happens to be: the target velocity keeps
           a bounded climb rate until the altitude arrives, so the cut lands on a circle, not on a
           14 km arc whose periapsis sits under the surface (the first attempt cut at |Δv| < 50 m/s
           at 14.4 km, 51 m/s short of circular, and fell back down the far side at 1,649 m/s). */
        const vrT = Math.min(0.2, Math.sqrt(2 * 0.4 * (C.MU_M / (C.RM + hKm) ** 2) * Math.max(0, 20 - hKm)));
        const vDes = tHat.clone().multiplyScalar(vC15).addScaledVector(rel, vrT / L.r);
        const aCmd = vDes.sub(relV).divideScalar(8).sub(gAbs).add(gMF);
        dir = aCmd.lengthSq() > 1e-12 ? aCmd.normalize() : tHat;
        thr = THREE.MathUtils.clamp(aCmd.length() / Math.max(aMax, 1e-6), 0.12, 1);
      }
      P.setSas(false);
      steerTo(dir);
      P.setTargetThrottle(fuel > 0 ? thr : 0);
      if (trace && i % 250 === 0) console.log(`    climb t=${P.getSimTime().toFixed(0)} h=${(hKm * 1000).toFixed(0)} m`
        + ` vr=${(L.radial * 1000).toFixed(0)} vt=${(tHat.dot(relV) * 1000).toFixed(0)} thr=${P.getThrottle().toFixed(2)} fuel=${stages[4].fuel.toFixed(1)}`);
      if (fuel <= 0) { P.setTargetThrottle(0); mode = 'dry'; }
      else if (hKm > 18 && Math.abs(L.radial) < 0.04 && Math.abs(tHat.dot(relV) - vC15) < 0.02 &&
               periapsisKm(L.r, L.v, tHat.dot(relV)) > 12) {
        /* The old gate plus periapsis clearance: bg_15 showed the pure speed gate cutting 19 m/s
           UNDER circular (periapsis under ground — coast, Hohmann, 1,710 m/s on orbit two), and
           the tighter |v − vCirc| gates oscillated and burned the tank chasing closure (bg_19,
           cut never fired, 15 t gone). This cuts at 25 km with ~3 t left (bg_16) and the coast
           is 25×~60 km — good enough for the window scan. */
        P.setTargetThrottle(0);
        ev.insert = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(1), vRel: +L.v.toFixed(4) };
        mark('insert');
        prevRadial = L.radial;
        mode = 'lmCoast';
      }
      else if (P.getSimTime() - tClimb > 2000) mode = 'dry';
    } else if (mode === 'lmCoast') {
      /* Ride the insertion orbit and wait for the Hohmann window: a tangential burn NOW must put
         the apolune where the parked CSM will BE at arrival (half the transfer period later, at
         the antipode of the burn point). The angle that matters is the CSM's about the MOON —
         `P0_PARK + PARK_N·t` exactly — not angOf(csmParkPos), whose absolute angle is dominated
         by the Moon's own position and reduces the condition to a sidereal pass of the Moon
         (measured: apolune at the right height, the CSM 1.4 rad downrange, 2,524 km of terminal
         gap and the ascent tank dry). The error closes at the rate difference of the two orbits;
         for the near-circular 20 km insertion that is slow — the timeout allows a full synodic. */
      P.setTargetThrottle(0);
      const aT = (L.r + C.PARK_R) / 2;
      const tArr = P.getSimTime() + Math.PI * Math.sqrt(aT ** 3 / C.MU_M);
      const err = wrapPi((C.P0_PARK + C.PARK_N * tArr) - (angOf(rel) + Math.PI));
      if (!ev.hohScan) ev.hohScan = { t: +P.getSimTime().toFixed(0), err: +err.toFixed(5) };
      if (trace && i % 100000 === 0) console.log(`    coast t=${P.getSimTime().toFixed(0)} Lr=${L.r.toFixed(1)} err=${err.toFixed(5)}`);
      /* Fire near periapsis (the tangential end, low band) whenever the CSM is within 0.05 rad
         of the antipode-of-arrival — a 92 km arrival error, which the terminal's phasing circle
         erases for free. A tight window cannot be HIT from an eccentric coast: the longitude
         oscillation jumps the sampled err across any milliradian gate between low-altitude
         passes (measured: 790 ks of coast, one lucky ignition). Precision lives in the
         terminal's 'phase' scan, which runs on a circle and closes slowly. */
      if (Math.abs(err) < 0.05 && Math.abs(L.radial) < 0.05 && L.alt < 60 && fuel > 0) {
        ev.hohIgn = { t: +P.getSimTime().toFixed(0), err: +err.toFixed(5), r: +L.r.toFixed(1) };
        hohV = Math.sqrt(C.MU_M * (2 / L.r - 1 / aT));
        mode = 'lmRise';
      }
      if (P.getSimTime() > (ev.insert.t + 480000)) mode = 'dry';
    } else if (mode === 'lmRise') {
      P.setSas(false);
      steerTo(relV.clone().normalize());
      P.setTargetThrottle(fuel > 0 ? 1 : 0);
      /* Cut AHEAD of hohV by the surplus the run-down will still burn: js/physics.js closes the
         throttle at 0.25/s, so commanding zero leaves a four-second taper worth ~2·aMax of Δv.
         Ignoring it put the apolune 74 km over the park and opened a 2,694 km terminal gap the
         ascent stage could not close (measured) — the TLI run-down lesson, in the Moon's frame. */
      if (L.v >= hohV - 2 * aMax * P.getThrottle() ** 2 || fuel <= 0) {
        P.setTargetThrottle(0);
        ev.hohmann = { t: +P.getSimTime().toFixed(0), vRel: +L.v.toFixed(4), dry: fuel <= 0 };
        mark('hohmann');
        apexPeri = 0;
        mode = 'lmApex';
      }
    } else if (mode === 'lmApex') {
      P.setTargetThrottle(0);
      if (L.alt > 90) ev._sawHigh = true;
      if (L.radial < 0 && prevRadial >= 0 && L.alt > 90) {
        ev.apoapsis = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(1), vRel: +L.v.toFixed(4) };
        mark('apsis');
        mode = 'lmTerminal';
      } else if (L.radial > 0 && prevRadial <= 0) {
        /* Periapsis flip. The Hohmann can ignite on the descending branch, so the FIRST periapsis
           flip is mid-transfer, not a verdict: the orbit has not peaked yet. Only a whole lap
           without ever rising above 90 km (a second periapsis flip, still no _sawHigh) means the
           burn fell short — back for another window. */
        apexPeri++;
        if (apexPeri >= 2 && !ev._sawHigh) mode = 'lmCoast';
      }
      prevRadial = L.radial;
    } else if (mode === 'lmTerminal') {
      if (P.getDocked()) {
        mark('dock');
        P.separateStage(4);                        // the ascent stage leaves before the fall home
        ev.ascentJett = { t: +P.getSimTime().toFixed(0) };
        mode = 'tei';
      } else {
        /* Orbital rendezvous, not a chase. Velocity-matching onto a target 60 km along-track
           FAILS in orbit (prograde push raises the orbit and drops you further behind — measured:
           the LOS-closing law stalled at 2.9 km, and the PNG lead flew the gap OPEN from 130 km).
           The dance is the one Apollo flew: park in a circle ~40 km under the CSM's, where the
           rate difference drifts the phase closed on its own; cross the Hohmann window up;
           circularise into the CSM's own circle; close the last km together. Every burn is
           tens of m/s. */
        const PH = C.PARK_R - 40;                 // phasing circle
        const gAbs = P.gravityAt(P.S.pos, new THREE.Vector3(), P.getSimTime());
        const cpos = C.csmParkPos(P.getSimTime(), new THREE.Vector3());
        const gap = cpos.clone().sub(P.S.pos);
        const d = gap.length();
        let dir = null, thr = 0;
        if (!ev.termStage) {
          ev.termStage = 'lower';
          ev.termStart = P.getSimTime().toFixed(0);
        }
        if (ev.termStage === 'lower') {
          /* Two burns at the apsides, where the radial rate is exactly zero so the engine axis
             and the desired Δv coincide: prograde at apolune to lift periapsis to the phasing
             circle, retrograde at that periapsis to circularise onto it. Velocity-matched
             proportional throttle, not bang-bang: the 4 s throttle-closing taper is worth
             ~2·aMax of Δv and no fixed lead catches it (that is what the run-down lesson said);
             a loop that eases to zero throttle as v nears vT spends exactly what it plans.
             No clock timeout — a 25 km coast lap is 1.8 h and the drift can legitimately wait
             hours; the give-up signal is whole periapses passed with no circularisation. */
          if (L.radial < 0 && prevRadial >= 0) ev.termApo = (ev.termApo ?? 0) + 1;
          if (ev.dive && !ev.apoBurn && !ev.periCut && L.r > PH + 5) {
            /* From the CSM's circle with the phase wrong: one retro cut puts periapsis on the
               phasing circle (the current point becomes apolune), ~8 m/s. The match stage hands
               over here whenever the along-track error is still kilometres wide. */
            ev.dive = false;
            ev.apoV = Math.sqrt(C.MU_M * (2 / L.r - 1 / ((L.r + PH) / 2)));
            ev.apoBurn = true;
          } else if (!ev.dive && !ev.periCut && L.radial < 0 && prevRadial >= 0 && L.r > PH - 10) {
            ev.apoV = Math.sqrt(C.MU_M * (2 / L.r - 1 / ((L.r + PH) / 2)));
            ev.apoBurn = true;
          }
          if (ev.apoBurn) {
            /* Signed ease cut: burn direction follows the sign of the velocity error, throttle
               fades linearly to zero at the target, so the 4 s closing taper rides on ~0 thrust
               and the transfer arrives where the scan aimed it. A 12 m/s ease surplus was
               shifting arrival 190 km downrange (measured: Δ(T/2) is 1.5·T/2·Δa/a). */
            const e2 = ev.apoV - L.v;
            P.setSas(false);
            if (Math.abs(e2) > 1e-4) steerTo(relV.clone().multiplyScalar(Math.sign(e2)).normalize());
            P.setTargetThrottle(fuel > 0 ? THREE.MathUtils.clamp(Math.abs(e2) / 0.0015, 0, 1) : 0);
            if ((ev.apoV - L.v) * Math.sign(e2 || 1) <= 0 || fuel <= 0) {
              P.setTargetThrottle(0); ev.apoBurn = false; ev.periCut = true;
            }
          } else if (ev.periCut && L.radial > 0 && prevRadial <= 0 && Math.abs(L.r - PH) < 8) {
            ev.periBurn = true;
          }
          if (ev.periBurn) {
            const vT = Math.sqrt(C.MU_M / PH);
            const e2 = L.v - vT;
            P.setSas(false);
            if (Math.abs(e2) > 1e-4) steerTo(relV.clone().multiplyScalar(Math.sign(e2)).normalize());
            P.setTargetThrottle(fuel > 0 ? THREE.MathUtils.clamp(Math.abs(e2) / 0.0015, 0, 1) : 0);
            if ((L.v - vT) * Math.sign(e2 || 1) <= 0 || fuel <= 0 || L.radial < -0.05) {
              P.setTargetThrottle(0); ev.periBurn = false; ev.periCut = false;
              ev.termStage = 'phase';
              ev.termCirc = { t: +P.getSimTime().toFixed(0), r: +L.r.toFixed(1), v: +L.v.toFixed(4) };
            }
          }
          if ((ev.termApo ?? 0) >= 3 && ev.termStage === 'lower') {
            ev.termStage = undefined; ev.periCut = false; ev.apoBurn = false; ev.periBurn = false;
            ev.termApo = 0; ev.apoV = 0;
            mode = 'lmCoast';   // three apolunes never closed the circle: raise again
          }
        } else if (ev.termStage === 'phase') {
          // coast; scan the window up: arrival half a transfer later must meet the CSM
          P.setTargetThrottle(0);
          const aT2 = (L.r + C.PARK_R) / 2;
          const tArr2 = P.getSimTime() + Math.PI * Math.sqrt(aT2 ** 3 / C.MU_M);
          const err2 = wrapPi((C.P0_PARK + C.PARK_N * tArr2) - (angOf(rel) + Math.PI));
          if (Math.abs(err2) < 1.5e-3 && fuel > 0) {
            ev.termIgn = { t: +P.getSimTime().toFixed(0), err: +err2.toFixed(5) };
            hohV = Math.sqrt(C.MU_M * (2 / L.r - 1 / aT2));
            ev.termStage = 'rise';
          }
          if (P.getSimTime() > Number(ev.termStart) + 260000) { ev.termStage = undefined; mode = 'dry'; }
        } else if (ev.termStage === 'rise') {
          P.setSas(false);
          steerTo(relV.clone().normalize());
          /* Same full-then-ease law as the apsis cuts. The old fixed 2·aMax lead (56 m/s at this
             thrust-to-mass) is larger than the whole 6.7 m/s transfer burn — it cut the engine
             before the circle was reached and the approach starved 500 km short. */
          const eR = hohV - L.v;
          P.setTargetThrottle(fuel > 0 && eR > 0 ? THREE.MathUtils.clamp(eR / 0.012, 0, 1) : 0);
          if (eR <= 0 || fuel <= 0) {
            P.setTargetThrottle(0);
            ev.termStage = 'match';
          }
        } else {
          /* match: coast the transfer to its apolune (the CSM's circle), then fly the co-orbit
             law with a gentle closing speed — the loop's steady state on the same circle as the
             CSM is a slow approach, which is exactly what the last km wants. Cutting the loop in
             at periapsis would brake the very rise the transfer just bought. */
          if (L.r < C.PARK_R - 12) P.setTargetThrottle(0);
          else {
          const cs = THREE.MathUtils.clamp(d / 250, 0.004, 0.02);
          const vDes = C.csmParkVel(P.getSimTime(), new THREE.Vector3())
            .addScaledVector(gap.clone().normalize(), cs);
          const aCmd = vDes.sub(P.S.v).divideScalar(20).sub(gAbs);
          const aMag = aCmd.length();
          P.setSas(false);
          steerTo(aMag > 1e-9 ? aCmd.multiplyScalar(1 / aMag) : P.fwd());
          thr = fuel > 0 ? THREE.MathUtils.clamp(aMag / Math.max(aMax, 1e-6), 0, 1) : 0;
          }
          if (P.getSimTime() > Number(ev.termStart) + 260000) mode = 'dry';
        }
        if (dir) { P.setSas(false); steerTo(dir); }
        if (thr > 0) P.setTargetThrottle(thr);
        if (ev.termGap === undefined || d < ev.termGap) ev.termGap = +d.toFixed(3);
        prevRadial = L.radial;
        if (trace && i % 250 === 0) console.log(`    terminal t=${P.getSimTime().toFixed(0)} ${ev.termStage} gap=${(d * 1000).toFixed(0)} m r=${L.r.toFixed(0)} thr=${P.getThrottle().toFixed(2)} fuel=${stages[4].fuel.toFixed(2)}`);
        if (fuel <= 0 && !P.getDocked()) mode = 'dry';
      }
    } else if (mode === 'tei') {
      /* Transearth injection from the 110 km park. In the Moon frame this is not an escape — the
         return leaves at 0.84 km/s, under lunar escape — Earth's tide does the pulling, so the
         only trustworthy completion is Earth's own orbital elements: burn retrograde along the
         lunar orbit until the Earth periapsis drops inside the corridor (the entry-angle numbers
         in docs/reference were measured against the Earth periapsis). */
      if (!ev.teiIgn) {
        teiDir = C.moonVel(P.getSimTime(), new THREE.Vector3()).normalize();
        ev.teiIgn = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(0) };
      }
      const elE = P.orbitalElements(P.S.pos, P.S.v, C.MU_E, C.RE);
      const vT = teiDir.clone().multiplyScalar(0.186);      // the return ellipse's speed at the Moon's distance
      const aCmd = vT.sub(P.S.v).divideScalar(60).sub(P.gravityAt(P.S.pos, new THREE.Vector3(), P.getSimTime()));
      P.setSas(false);
      steerTo(aCmd.length() > 1e-9 ? aCmd.normalize() : teiDir);
      const cut = elE.pe - C.RE < 55 || elE.escape;
      P.setTargetThrottle(!cut && fuel > 0 ? 1 : 0);
      if (cut) {
        P.setTargetThrottle(0);
        ev.tei = { t: +P.getSimTime().toFixed(0), pe: +(elE.pe - C.RE).toFixed(0), vInert: +P.S.v.length().toFixed(4), escape: elE.escape };
        mark('tei');
        mode = 'tecoast';
      } else if (fuel <= 0) mode = 'dry';
    } else if (mode === 'tecoast') {
      P.setTargetThrottle(0);
      P.setSas(true, true);                        // retrograde: heat shield first, from here to the water
      if (altE < 150) {
        P.separateStage(2);
        mark('entry');
        mode = 'capsule';
      }
      if (P.getSimTime() > 1.4e6) mode = 'dry';
    } else if (mode === 'capsule') {
      P.setTargetThrottle(0);
      P.setSas(true, true);
      /* Chutes on Mach AND q: each canopy has a tear Mach (1.5 drogues, 0.5 mains) as well as a
         tear pressure, and at the interface q is tiny while Mach is 37 — deploying on q alone
         hands the drogues to Mach 25 and loses them. */
      const a = P.aeroState;
      if (P.getChute() === 0 && a.mach > 0.05 && a.mach < 1.4 && a.q < 20000) { P.deployChute(); mark('drogue'); }
      else if (P.getChute() === 1 && a.mach < 0.5 && a.q < 4000) { P.deployChute(); mark('mains'); }
      if (P.getState() !== 'flying') mark('splash');
    } else {
      P.setTargetThrottle(0);
      /* 1,100 ks = 12.7 d: the round trip is ~3.4 d out, the Hohmann window can cost up to one
         synodic lap of the two orbits (~1.13 d) plus the surface stay, and ~3 d home. 800 ks was
         measured cutting a live terminal phase short at 9.259 d. */
      if (P.getSimTime() > 1100000) break;
    }

    /* Always H, never a coarser coast step. js/main.js spends warp in whole steps of
       DTPHYS = 0.1 s, so 0.1 s is the ONLY step the game takes in flight, and the translunar
       encounter is sensitive enough that stepping the coast at 1 s changes the periselene by
       ~820 km (346 km becomes an impact 475 km under the surface, from the shipped coast-start
       state). A faster coast step would certify a trajectory no player can fly. */
    const step = H;
    const mBefore = P.totalMass(), stageBefore = P.activeEngine(), burnBefore = P.isBurning();
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
  ev.dvDrag = +dvDrag.toFixed(1);
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
  /* The straddling corridor (periselene crossing AIM_PERI) is ~0.004 rad wide, and anything that
     touches the stack's mass moves it: +2 t of ascent tank moved the 2.1597 encounter from 350 km
     to 25,292 km. A coarse walk around the whole circle is a coin flip on whether a 0.25 rad step
     lands on either side of it; the honest seed is MOON_PHASE0 — the last certified window — and
     an honest stride is 0.002 rad, fine enough that the corridor cannot hide between two probes
     (AGENTS.md: the landable band alone spans ±2e-3 rad). 0.12 rad of walking each way covers a
     moonrise; the probes that miss the Moon cost 400 ks of sim and ~10 s of wall. */
  let lo = C.MOON_PHASE0, hi = lo, flo = probePeri(lo), fhi = flo;
  let walk = 0;
  for (; !(flo > AIM_PERI && fhi < AIM_PERI); walk++) {   // walk forward until it straddles
    if (walk > 60) break;
    hi = (hi + 0.002) % (2 * Math.PI);
    fhi = probePeri(hi);
    if (fhi > AIM_PERI) { lo = hi; flo = fhi; }
  }
  if (walk > 60) {
    /* The window can be FAR from MOON_PHASE0: the round-trip stack (different ascent, 16 orbits
       of parking before TLI) sits ~2.76 rad from the one-way stack's window. Seeded walking
       cannot reach that; scan the whole circle, take the deepest approach, and bracket locally.
       64 probes is ~10 minutes — the price of a solve that cannot silently miss a window. */
    console.error('solve: nothing within 0.12 rad of MOON_PHASE0 — scanning the circle');
    let best = 1e9, bestPh = 0;
    for (let k = 0; k < 64; k++) {
      const ph = k * 2 * Math.PI / 64, fp = probePeri(ph);
      console.error(`  scan ${ph.toFixed(5)} ${fp >= 1e5 ? 'none' : fp.toFixed(0)}`);
      if (fp < best) { best = fp; bestPh = ph; }
    }
    if (best > AIM_PERI) { console.error('solve: no launch window straddles AIM_PERI — check AIM_PERI and the forces'); process.exit(1); }
    hi = bestPh; fhi = best; lo = bestPh;
    for (let back = 0; flo <= AIM_PERI && back < 96; back++) {
      lo = (((lo - 0.002) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      flo = probePeri(lo);
    }
    if (!(flo > AIM_PERI)) { console.error('solve: no launch window straddles AIM_PERI — check AIM_PERI and the forces'); process.exit(1); }
  }
  for (let k = 0; k < 16; k++) {
    const m = (lo + (((hi - lo) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) / 2) % (2 * Math.PI);
    const fm = probePeri(m);
    console.log(`  solve ${k}: phase=${m.toFixed(7)} periselene=${fm >= 1e5 ? 'no encounter' : fm.toFixed(1) + ' km'}`);
    if (fm > AIM_PERI) { lo = m; flo = fm; } else { hi = m; fhi = fm; }
    if (Math.abs(fm - AIM_PERI) < 5) break;
  }
  /* The circular midpoint, exactly as the loop takes it: if the bracket ever straddles the 0/2π
     seam — MOON_PHASE0 moved 0.036 rad in one physics commit — the naive (lo+hi)/2 lands antipodal
     and certifies the wrong window. */
  phase = (lo + (((hi - lo) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) / 2 + 2 * Math.PI) % (2 * Math.PI);
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
