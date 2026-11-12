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
const NOPULSE = process.argv.includes('--nopulse');   /* measurement only: fly the raw transfer,
                                                         look at the aim readout, correct nothing */

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
  vehicleOps: { spawnParticle: () => {}, addDebris: () => {}, detachStage: () => {}, parkStage: () => {}, setVisible: () => {} },
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
         { dry: 25, fuel: 700, thrust: 6000, isp: 460 },
         /* The LM rows, as shipped: a 6,000 kN third stage is ~39 g_moon of thrust at landing
            mass — outside the 1.2–2.2 g_moon sizing this file's own note demands — so nova
            cannot be a one-way lander and never could. With the LM bolted on it is a round-trip
            stack, the descent belongs to the 380 kN stage, and the self-solve has a WIN to reach. */
         { dry: 5, fuel: 26, thrust: 380, isp: 380 },
         { dry: 4, fuel: 15, thrust: 180, isp: 380 }],
  /* What shipped before the verified stack: 2,400 + 700 + 400 t. Reaches the Moon and lunar orbit,
     then runs the tank dry on the descent — HARD IMPACT ON THE MOON AT 1266 m/s. */
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
     nothing, and touch nothing. That is how the one-way regressions (landed, retro) keep
     flying exactly the missions they were certified on; nova carries the LM rows and flies
     the round-trip chain. */
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

  let mode = 'ascent', prevRadial = 1, inSoi = false, pdi = null;
  let tClimb = 0, hohV = 0, apexPeri = 0, teiT0 = 0, teiTh = null, loiPeri = 0, loiPrevRad = 0;
  let teiAxis = null, teiDv0 = 0, teiAcc = 0, teiCorr = null, teiCorrDv = 0, teiCW = 0, teiIter = 0, teiCBurn = 0, teiFixSnap = null, teiFixAcc = 0, teiRN = 0;
  let dv = 0, dvMark = 0, mccDone = 0, mccNext = 0, mccT = 0, mccDv = 0, mccV0v = null, mccAx = null, mccBurn = 0;
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
  /* Closed-form velocity on the ENTRY CORRIDOR conic at radius r. The corridor is the state
     the entry cert lands from — −5.8° flight path at 122 km at 11.0 km/s (docs; centre of the
     −5.5…−6.5 band at that speed, SAFE_EARTH splash) — and its conic has pe +61 km and an
     apogee of 441,000 km. Above that apogee no corridor velocity exists: fall back to the
     consistent apogee-at-r graze (same closed form as before), which rolls continuously into
     the corridor as r drops below 441,000. h and E from the interface state; tangential plus
     inbound radial by vis-viva. T_rem by fixed point with gravity folded in. */
  const corridorVel = (r, dir, rh) => {
    const rI = C.RE + 122, vI = 11.0, gamI = 5.8 * Math.PI / 180;
    const h = rI * vI * Math.cos(gamI);
    const E = 0.5 * vI * vI - C.MU_E / rI;
    const raC = -C.MU_E / E - (C.RE + 61);
    const hor = dir.clone().addScaledVector(rh, -dir.dot(rh));
    if (hor.lengthSq() < 1e-9) hor.set(0, 0, 1).addScaledVector(rh, -rh.z);
    hor.normalize();
    if (r > raC) return hor.clone().multiplyScalar(Math.sqrt(2 * C.MU_E * (C.RE + 55) / (r * (C.RE + 55 + r))));
    const q = 2 * C.MU_E / r + 2 * E - h * h / (r * r);
    const vTs = h / r;
    return hor.multiplyScalar(vTs).addScaledVector(rh, -Math.sqrt(Math.max(0, q)));   // q IS the radial speed squared (h²/r² is already out of it)
  };
  const teiDv = () => {
    const g = P.gravityAt(P.S.pos, new THREE.Vector3(), P.getSimTime());
    const r = P.S.pos.length();
    const rh = P.S.pos.clone().multiplyScalar(1 / r);
    const dir = C.moonVel(P.getSimTime(), new THREE.Vector3()).normalize();
    const vT = corridorVel(r, dir, rh);
    const a = C.SPECS[2].thrust / P.totalMass() / 1000;
    let dv = null, Tr = 0;
    for (let k = 0; k < 8; k++) {
      dv = vT.clone().sub(P.S.v).sub(g.clone().multiplyScalar(Tr));
      Tr = dv.length() / a;
    }
    return { dv, vT: vT.length(), dir };
  };
  /* TEI is first a LUNAR ESCAPE, and that changes the target completely. Burning directly to
     the corridor's geocentric velocity while sitting 110 km over the Moon asks for a state
     the Moon will not release: v_rel 0.84 km/s at 1,847 km is lunar-specific energy −2.3 km²/s²
     — bound (measured: three such cuts never left 2,000 km of the Moon, and the closed-loop
     chase against that impossible target spent the tank at τ ≈ 0.02–0.15 for 500 s). So the
     burn aims the DEPARTURE HYPERBOLA: a Moon-relative asymptote equal to the CORRIDOR's
     relative velocity at lunar distance (w below, |w| ≈ 0.96, ~30° off −d̂). At 110 km that
     is v_rel ≈ 2.50 km/s (Apollo's TEI number to the km/s), and lunar gravity bends the
     asymptote toward itself by δ = 2·asin(1/e), e = 1 + r·v_inf²/μ ≈ 98° at these speeds —
     which is why the aim must be SOLVED, not offset. The midcourse taps then refine the
     geocentric corridor outside the sphere. */
  const teiEscape = () => {
    const mp = C.moonPos(P.getSimTime(), new THREE.Vector3());
    const mv = C.moonVel(P.getSimTime(), new THREE.Vector3());
    const rM = P.S.pos.clone().sub(mp);
    const rm = rM.length();
    const dhat = mv.clone().normalize();
    /* The asymptote wanted is the CORRIDOR's own relative velocity at lunar distance:
       w = corridorVel(raM) − moonVel (tangential 0.185 + inbound radial 0.475 → |w| ≈ 0.96,
       ~30° off −d̂). The old target −d̂ with |v_inf| from a bare 384,400-km graze (0.838)
       ignored the radial half of the corridor fall and aimed 30° low in the wrong plane of
       the problem — the correction after such an escape was always going to be big. */
    const raM = mp.length();
    const w = corridorVel(raM, dhat, mp.clone().multiplyScalar(1 / raM)).sub(mv);
    const vinfT = Math.max(0.3, w.length());
    const V = Math.sqrt(vinfT * vinfT + 2 * C.MU_M / rm);
    const rhat = rM.clone().normalize();
    const sq = rhat.clone().addScaledVector(dhat, -rhat.dot(dhat));
    const s = sq.lengthSq() > 1e-9 ? sq.normalize() : new THREE.Vector3(0, 1, 0);
    /* Aim solved, not guessed. The burn must leave the Moon on a hyperbola whose ASYMPTOTE is
       ŵ. A fixed ±δ offset guessed wrong aims below local horizontal into the Moon
       (measured: v_rel 1,629 → 2,272 m/s with rM falling 1,848 → 1,777 — impact at
       TEI ignition). So scan the in-plane aim and refine it against the closed-form asymptote
       (moonAsym), penalising any aim whose lunar periapsis is under the surface. */
    const neg_d = w.clone().normalize();
    /* θ moves only the DIRECTION of vT: |vM| = V is built so the lunar excess is exactly
       vinfT at every θ (energy, not a free parameter). So the cost is the asymptote angle,
       and corridor accuracy comes from the ITERATED midcourse taps outside the sphere,
       where the target moves 0.5 mm/s² and 1.6 m/s costs 40 km of periapsis. */
    const cost = th => {
      const vt = mv.clone().addScaledVector(dhat, -V * Math.cos(th)).addScaledVector(s, V * Math.sin(th));
      const vM = vt.clone().sub(mv);
      const rv = rM.dot(vM);                              // r·v, not its radial component: the eccentricity vector wants the dot product (moonAsym, below, has it right)
      const evec = rM.clone().multiplyScalar(vM.lengthSq() / C.MU_M - 1 / rm).addScaledVector(vM, -rv / C.MU_M);
      const e = evec.length();
      const h = new THREE.Vector3().crossVectors(rM, vM).length();
      const rp = h * h / C.MU_M / (1 + e);
      const u = moonAsym(P.S.pos, vt);
      const ang = u ? Math.acos(THREE.MathUtils.clamp(u.dot(neg_d), -1, 1)) : 3.2;
      return ang + (rp < C.RM + 3 ? 10 : 0);
    };
    let thBest = 0, cBest = 1e9;
    for (let k = 0; k <= 12; k++) {
      const th = -1.5 + k * 0.25;
      // Continuity: two mirror hyperbolae can share the asymptote; without this bias the
      // aim flips between them and the burn thrashes (dvLeft 419 m/s after 500 s, measured).
      const c = cost(th) + (teiTh === null ? 0 : 0.05 * Math.abs(th - teiTh));
      if (c < cBest) { cBest = c; thBest = th; }
    }
    for (let w = 0.25; w > 0.004; w *= 0.5) {
      const a1 = cost(thBest - w) + (teiTh === null ? 0 : 0.05 * Math.abs(thBest - w - teiTh));
      const a2 = cost(thBest + w) + (teiTh === null ? 0 : 0.05 * Math.abs(thBest + w - teiTh));
      if (a1 < cBest) { thBest -= w; cBest = a1; }
      else if (a2 < cBest) { thBest += w; cBest = a2; }
    }
    teiTh = thBest;
    cBest = cost(thBest);
    const vT = mv.clone().addScaledVector(dhat, -V * Math.cos(thBest)).addScaledVector(s, V * Math.sin(thBest));
    const g = P.gravityAt(P.S.pos, new THREE.Vector3(), P.getSimTime());
    let dv = null, Tr = 0;
    const a = C.SPECS[2].thrust / P.totalMass() / 1000;
    for (let k = 0; k < 8; k++) {
      dv = vT.clone().sub(P.S.v).sub(g.clone().multiplyScalar(Tr));
      Tr = dv.length() / a;
    }
    return { dv, V, vinfT, aim: cBest };
  };
  /* The escape asymptote of a Moon-relative hyperbolic state, as a game-frame unit vector.
     At infinity the position direction is r̂∞ = −ê/e ± √(1 − 1/e²)·(ĥ × ê) (conic equation at
     r → ∞: r̂∞ · ê = −1/e), and the velocity is parallel to it. The old version swapped the
     components ((e − 1/e) on the cross term, ±s on ê) — not even a unit vector (norm 1.12 at
     e = 1.5) and not the asymptote: the aim solver optimised that garbage for three rounds
     and every "aimErr" it reported measured nothing real. Sign + on the outgoing branch. */
  const moonAsym = (pos, vel) => {
    const rM = pos.clone().sub(C.moonPos(P.getSimTime(), new THREE.Vector3()));
    const vM = vel.clone().sub(C.moonVel(P.getSimTime(), new THREE.Vector3()));
    const r = rM.length(), rv = rM.dot(vM);
    const evec = rM.clone().multiplyScalar(vM.lengthSq() / C.MU_M - 1 / r).addScaledVector(vM, -rv / C.MU_M);
    const e = evec.length();
    if (e <= 1.02) return null;
    const hh = new THREE.Vector3().crossVectors(rM, vM).normalize();
    const ph = evec.clone().multiplyScalar(1 / e);
    const qh = new THREE.Vector3().crossVectors(hh, ph);
    const s = Math.sqrt(Math.max(0, 1 - 1 / (e * e)));
    return ph.multiplyScalar(-1 / e).addScaledVector(qh, rv >= 0 ? s : -s);
  };

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
      const vOrb = Math.sqrt(C.MU_E / (C.RE + PARK_AP));
      if (ROUND && P.activeEngine() === 2 && altE > 110) {
        /* Terminal insertion steering, ROUND-TRIP stack only. The TURN table tilts to its max
           tilt and holds it (js/physics.js is time-based), so the heavy 5-row stack's perigee
           never clears the ground while it burns: measured with the LM aboard, the conic gate
           below first became true at 9.894 km/s with apogee 25,885 km — a 150×25,885
           "parking" orbit whose perigee-pass TLI puts the closest flyby no nearer than
           3,599 km at any launch phase (64-point scan + 0.004-rad fine scan, Nov-26).
           Apollo's insertion guided to a flight path of zero at orbital speed: steer
           prograde-minus-radial (local horizontal) and cut at circular speed for the park.
           THE 4-ROW STACKS MUST NOT STEER: their certified profile is the unsteered TURN
           climb cutting on the conic at 151×760 km, v 7.3706 — steering flattens the climb
           and cuts at 151×676, v 7.3916 instead, which burns a transfer arriving 64,327 km
           from the Moon at the one-way window (measured Nov-26; the one-way regressions
           fly the TURN table's insertion, nothing else). */
        P.setSas(false);
        const up = P.S.pos.clone().normalize();
        const vr = P.S.v.dot(up);
        const dir = P.S.v.clone().addScaledVector(up, -vr).normalize();
        steerTo(dir);
        if (P.S.v.length() >= vOrb) {
          P.setTargetThrottle(0);
          const elO = P.orbitalElements(P.S.pos, P.S.v, C.MU_E, C.RE);
          ev.orbit = { t: +P.getSimTime().toFixed(0), ap: +elO.ap.toFixed(0), pe: +elO.pe.toFixed(0), vInert: +P.S.v.length().toFixed(4) };
          mark('ascent');
          mode = 'tliwait';
        } else P.setTargetThrottle(1);
      } else if (el.pe >= PARK_PE && el.ap >= PARK_AP) {
        P.setTargetThrottle(0);
        ev.orbit = { t: +P.getSimTime().toFixed(0), ap: +el.ap.toFixed(0), pe: +el.pe.toFixed(0), vInert: +P.S.v.length().toFixed(4) };
        mark('ascent');
        mode = 'tliwait';
      } else if (fuel <= 0) { P.setTargetThrottle(0); mode = 'dry'; }
      else P.setTargetThrottle(1);
    } else if (mode === 'tliwait') {
      P.setTargetThrottle(0);
      /* Ignite at the FIRST DESCENDING STEP, inside PARK_AP + 60 km — the old law exactly.
         (The 600-km variant delayed the 4-row stacks' ignition a thousand seconds past the
         cut — nearly circular parks cross 600 km far from apogee — and their lead swung
         to 4.65 rad, 377,500 km off the Moon. Measured Nov-26.) No lead wait: lead at a
         fixed decision point on a repeated orbit GROWS at the Moon's rate — coasting runs
         away from the lead, it does not wait it round; the launch phase is what buys it. */
      if (P.S.v.dot(P.S.pos) / rE < 0 && altE < PARK_AP + 60 && fuel > 0 && !ev.tliIgn) {
        C.moonPos(P.getSimTime(), moon);
        const lead = ((angOf(moon) - angOf(P.S.pos)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        ev.tliIgn = { t: +P.getSimTime().toFixed(0), vInert: +P.S.v.length().toFixed(4), lead: +lead.toFixed(4), altE: +altE.toFixed(0) };
        P.setSas(true, false); P.setTargetThrottle(1); mode = 'tli';
      } else if (mode === 'tliwait' && P.getSimTime() > 420000) mode = 'dry';
    } else if (mode === 'tli') {
      P.setSas(true, false); P.setTargetThrottle(1);
      /* Fixed-speed cutoff, checked every step: vT is 10.884 km/s here, one full-throttle
         S-IVB step is 0.34 m/s (~350 km of pass), so the cut itself is precise. Measured
         (Nov-26): a closed-loop lunarPass cutoff did WORSE — the prediction from a state
         minutes before a still-burning injection diverged from the flown trajectory by
         ~3,200 km of periselene (predicted 332, flew 3,498), because the engine keeps
         burning through the cut step. The cut is only trustworthy from a coasting state.
         What actually moved the encounter basin was the parking orbit (see the velocity
         cutoff in 'ascent'): from the proper 185 km park, this law aims the corridor. */
      /* Nova-only tail compensation: its third stage out-thrusts the game's 650 kN by 9x, so
         the ~2 s throttle ramp-down after the cut delivers ~2a ≈ 55 m/s on top of the target —
         enough near escape energy to turn the transfer into a 1.6-million-km graze that no
         phase hits (measured Nov-10: every scan point on the 5-row nova read no-encounter).
         Cut early by the ramp integral. The game stack's tail is ~10 m/s and its certified
         window is solved WITH it, so nothing but nova takes this term. */
      const vCut = vT - (WHICH === 'nova' ? 2 * C.SPECS[2].thrust / P.totalMass() / 1000 : 0);
      if (P.S.v.length() >= vCut) {
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
      if (process.env.DEBUGMCC && mccT > 0 && mccV0v) {
        const _pv = P.S.v.clone().normalize();
        console.log(`  pulse t=${P.getSimTime().toFixed(2)} thr=${P.getThrottle().toFixed(2)} dotFA=${P.fwd().dot(mccAx).toFixed(4)} dotFV=${P.fwd().dot(_pv).toFixed(4)} dotAV=${mccAx.dot(_pv).toFixed(4)} proj=${(P.S.v.clone().sub(mccV0v).dot(mccAx) * 1000).toFixed(1)}`);
      }
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
      if (mccT === 0) P.setTargetThrottle(0);
      /* Pulse END (integral completion, like TEI): stop at the asked Δv, and schedule the
         re-evaluation one coast step out. The old law asked the NEXT estimate 6,000 s later
         always — the 4-pulse budget could never see its own result. */
      if (mccT > 0) {
        /* Two-phase pulse, the TEI pattern (line ~982): ALIGN FIRST, then light and start the
           integral. The integral is of THRUST Δv (F·τ/m per step), never of |Δv|: measured
           Nov-26 on the wait-120 flight, a +2 m/s pulse at the deep coast burned 4.6 s while the
           throttle ramped (0.25/s) against ~4 m/s² of along-track gravity — the NET velocity
           change sat NEGATIVE for 2.2 s, the ramp overshot to full, and the vehicle received a
           ~22 m/s kick instead of 2. At 650 km/(m/s) that is the +14,000 km aim jump the old
           law kept blaming the model for. Gravity acts on the unburned trajectory identically;
           the state difference between the two is exactly the thrust integral. The cut pays the
           ramp-down lead 2·a·τ² (throttle falls at 0.25/s). */
        if (!mccV0v) {
          if (P.fwd().dot(mccAx) > 0.9995) {
            if (process.env.DEBUGMCC) console.log(`  ign t=${P.getSimTime().toFixed(1)} pos=[${P.S.pos.toArray().map(x => x.toFixed(4)).join(',')}] vel=[${P.S.v.toArray().map(x => x.toFixed(6)).join(',')}]`);
            mccV0v = P.S.v.clone(); mccBurn = 0; P.setTargetThrottle(1);
            if (!P.getEngineOn()) P.toggleIgnite();
          } else if (P.getSimTime() > mccT) {                  // slew never finished: skip this pulse
            P.setTargetThrottle(0); mccT = 0; mccNext = P.getSimTime() + 120;
          }
        } else {
          const aNow = C.SPECS[2].thrust / P.totalMass();     // kN/t = m/s²
          mccBurn += aNow * P.getThrottle() * H;              // m/s of thrust this step
          const lead = 2 * aNow * P.getThrottle() ** 2;       // m/s still to come when it ramps down
          if (mccBurn + lead >= mccDv * 1000 || P.getSimTime() > mccT || fuel <= 0) {
            if (process.env.DEBUGMCC) console.log(`  cut t=${P.getSimTime().toFixed(1)} burn=${mccBurn.toFixed(1)} ask=${(mccDv * 1000).toFixed(1)} thr=${P.getThrottle().toFixed(2)}`);
            P.setTargetThrottle(0); mccT = 0; mccNext = P.getSimTime() + 120; mark('mcc');
          }
        }
      }
      /* Correction burns run for the round-trip vehicle and for NOVA (3,000 t of propellant and
         an aim that reads −1 — a collision course — from its coast start: without pulses nova is
         LOST, and with HEAD's broken 0.25-throttle windows it was LOST too). The one-way
         `landed` stack at its certified window flies the raw transfer to a 346 km periselene
         already; giving it pulses burned it to 63,040 km and a LOST (Nov-26). */
      if (mccT === 0 && (WHICH === 'game' || WHICH === 'nova') && P.getSimTime() >= mccNext && fuel > 5 && mccDone < 8) {
        /* Predict with js/targeting.js lunarPass — the game's own cue, calibrated against the
           flown periselene (ev.aimLP matched the flown 25,292 km to 0.1 km). The old local
           predictPeri (2 s Euler) drifted ~2,460 km of periselene over a 3.5-day coast, so
           "aimed" at a predicted 359 km flew an actual 2,823 km (measured Nov-26). */
        const _lo = { alt: 0, t: 0 };
        const nowAlt = T.lunarPass(P.S.pos, P.S.v, P.getSimTime(), _lo).alt;
        const errKm = nowAlt - AIM_PERI;
        if (nowAlt > AIM_PERI - 150 && nowAlt < AIM_PERI + 150) {
          /* The state at this instant is the one the game then coasts to the Moon, and the flight
             below proves where it goes (see ev.peri). pos/vel are recorded so the encounter can be
             reproduced — js/targeting.js is checked against exactly this. The TLI cutoff above is
             NOT such a state: the throttle is still running down, and roughly 3 m/s of leftover
             burn there moves the encounter by 20,000 km. */
          ev.aimed = { t: +P.getSimTime().toFixed(0), peri: +nowAlt.toFixed(0), burns: mccDone,
                       pos: P.S.pos.toArray().map(x => +x.toFixed(3)), vel: P.S.v.toArray().map(x => +x.toFixed(6)) };
          mark('mcc');
          mode = 'approach'; prevRadial = L.radial;
        } else {
          /* BISECT the crossing instead of differentiating toward it. lunarPass's alt is a
             MINIMUM distance: near the Moon it is V-shaped in along-track Δv, with the bottom
             near zero (measured from the cert coast state: aim 357; +3 m/s → 4,006, −3 m/s →
             −1 — a hit). A gradient there reads ≈0 at the bottom and the wrong sign beside
             it, and the linear machine oscillated through the bottom forever (both wait
             flights and phases 2.164/2.174-2.176 lost that way). The V has two clean
             crossings of AIM_PERI, one on each flank; the flank is bracketed by candidates
             and halved. The anchor is the CURRENT state — the bisection solves for the Δv
             to burn NOW, never compounding half-flown corrections. */
          const p0 = P.S.pos.clone(), v0 = P.S.v.clone();
          const pr = v0.clone().normalize();
          const A = (dv) => T.lunarPass(p0, v0.clone().addScaledVector(pr, dv), P.getSimTime(), _lo).alt;
          const A0v = nowAlt;
          if (NOPULSE) console.log(`  look t=${P.getSimTime().toFixed(0)} aim=${A0v.toFixed(0)}`);
          const wantBelow = A0v > AIM_PERI;                 // which flank of the V we stand on
          let lo = 0, hi = 0, bestDv = 0, bestErr = Math.abs(A0v - AIM_PERI);
          for (const c of [0.002, -0.002, 0.006, -0.006, 0.02, -0.02, 0.06, -0.06, 0.15, -0.15, 0.3, -0.3]) {
            const a = A(c);
            if (process.env.DEBUGMCC) console.log(`  sc ${c.toFixed(4)} -> ${a.toFixed(0)}`);
            if (Math.abs(a - AIM_PERI) < bestErr) { bestErr = Math.abs(a - AIM_PERI); bestDv = c; }
            if ((a < AIM_PERI) === wantBelow) { hi = c; break; }  // crossed AIM_PERI: bracketed
            lo = c;                                               // still on our flank: extend from 0→c
          }
          let dvv = NaN;
          if (hi !== 0) {
            for (let it = 0; it < 8; it++) {
              const mid = (lo + hi) / 2;
              if ((A(mid) < AIM_PERI) !== wantBelow) lo = mid; else hi = mid;
            }
            dvv = (lo + hi) / 2;
          } else if (bestErr < Math.abs(A0v - AIM_PERI) - 5) {
            dvv = bestDv;                    // no crossing inside ±300 m/s: burn toward the best flank
          }
          if (process.env.DEBUGMCC) console.log(`  brk lo=${lo.toFixed(5)} hi=${hi.toFixed(5)} best=${bestDv.toFixed(5)} bestErr=${bestErr.toFixed(0)} A0=${A0v.toFixed(0)} wantBelow=${wantBelow} -> dvv=${Number.isFinite(dvv) ? (dvv * 1000).toFixed(2) : 'nan'}`);
          if (Number.isFinite(dvv) && Math.abs(dvv) > 0.0002 && !NOPULSE) {
            P.setSas(true, dvv < 0);
            mccV0v = null;                      // lights when fwd() reaches the axis, not before
            mccAx = pr.clone().multiplyScalar(dvv < 0 ? -1 : 1);
            mccDv = Math.abs(dvv); mccT = P.getSimTime() + 420; mccDone++;
            ev['mcc' + mccDone] = { t: +P.getSimTime().toFixed(0), errKm: +errKm.toFixed(0), dv: +(dvv * 1000).toFixed(1) };
          } else if (!ev.aimed && !NOPULSE) {
            /* Nothing left to fix with the machinery (bottom of the V above AIM_PERI, or
               already best): declare it and go — the flown encounter below is the verdict. */
            ev.aimed = { t: +P.getSimTime().toFixed(0), peri: +nowAlt.toFixed(0), burns: mccDone, best: true,
                         pos: P.S.pos.toArray().map(x => +x.toFixed(3)), vel: P.S.v.toArray().map(x => +x.toFixed(6)) };
            mark('mcc');
            mode = 'approach'; prevRadial = L.radial;
          }
        }
        mccNext = P.getSimTime() + 6000;
      }
      if (L.r < C.SOI_M && mccT === 0) { mode = 'approach'; prevRadial = L.radial; }
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
      /* Retrograde AT PERISELENE, across as many revolutions as the excess velocity needs.
         Two measured failures behind this shape (Nov-26, wait=3600): an always-armed law kept
         throttling up the climb-out and the cut test v ≤ vCirc(r)·1.01 happened to pass at
         5,805 km — a circular park 4,068 km over the surface, un-deorbitable by the law that
         makes the burn point the apocentre; and the same run's single-pass burn could not
         erase 710 m/s inside one 60 s periselene crossing. The burn is gated to
         alt ≤ periselene + 50 km so every impulse lands where the orbit can use it, the cut
         is only honoured inside that window, and the attempt counter gives up after 4 passes
         (fuel: 38 t on the CSM after TLI; 710 m/s is ~2 t). */
      const want = L.vCirc * 1.01;
      if (L.radial > 0 && loiPrevRad <= 0) loiPeri++;
      loiPrevRad = L.radial;
      const near = L.alt <= ev.periselene.altM + 50;
      P.setSas(true, true);
      P.setTargetThrottle(fuel > 0 && near ? THREE.MathUtils.clamp((L.v - want) / Math.max(aMax * H, 1e-9), 0.05, 1) : 0);
      if (fuel <= 0) { P.setTargetThrottle(0); mode = 'dry'; }
      else if (near && L.v <= want) {
        P.setTargetThrottle(0);
        ev.loi = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(0), vRel: +L.v.toFixed(4) };
        mark('loi');
        mode = 'orbitCheck';
      } else if (loiPeri >= 4 && L.radial > 0 && L.alt > ev.periselene.altM + 200) mode = 'dry';
    } else if (mode === 'orbitCheck') {
      P.setTargetThrottle(0);
      if (!ev.parked) ev.parked = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(0), vRel: +L.v.toFixed(4), aMoon: +(L.closed ? L.a : Infinity).toFixed(0) };
      if (!L.closed) mode = 'loi';
      else if (L.alt > 400) {
        /* Wait for periapsis before handing the LM to the surface. The deorbit law makes the
           BURN POINT the apocentre — from the ~370 km capture pass that is a 1.6 km/s entry the
           descent guidance absorbs (certified 3.8 m/s); fired instead at the 4,000 km top of a
           long capture ellipse (the wait=3600 flight, Nov-26) it is a 2.07 km/s entry at
           interface and the LM meets the Moon at 367 m/s with the tank run dry. If the capture
           ellipse itself never reaches the parking band (wait=3600 arrives BOUND at a 5,804 km
           periselene — no LOI burn is even asked for), drop its periapsis first: a retrograde
           burn can never lower the periapsis below the point you burn at, so the one burn that
           works is retrograde aloft, exactly what 'lowerPeri' does. The gate holds until the orbit
           presents a real parking altitude (≤ 400 km). */
        const vTan = Math.sqrt(Math.max(0, L.v * L.v - L.radial * L.radial));
        const ecc = Math.sqrt(Math.max(0, 1 + 2 * L.eps * (L.r * vTan) ** 2 / (C.MU_M * C.MU_M)));
        if (L.a * (1 - ecc) - C.RM > 400) mode = 'lowerPeri';
      }
      else if (L.alt > 130) {
        if (ROUND) { P.parkCsm(); mark('demate'); mode = 'deorbit'; }   // the CSM stops being flown here; the LM drops to the surface
        else { P.setSas(true, true); P.setTargetThrottle(fuel > 0 ? 0.2 : 0); mode = 'deorbit'; }
      }
      else { pdi = { h: L.alt, prevV: null, tPrev: P.getSimTime() }; ev.descStart = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(1), vRel: +L.v.toFixed(4) }; mark('pdi'); mode = 'descend'; }
    } else if (mode === 'lowerPeri') {
      /* Periapsis lowering (NOT the LM's insertion — that one owns ev.insert and the insert
         mark): retrograde until the capture ellipse's periapsis reaches the parking band
         (~350 km), which is where the certified descent machinery wants to be handed over.
         Cut on the PREDICTED periapsis (vis-viva + angular momentum, valid mid-burn), not on
         a radius. */
      const vTan = Math.sqrt(Math.max(0, L.v * L.v - L.radial * L.radial));
      const ecc = Math.sqrt(Math.max(0, 1 + 2 * L.eps * (L.r * vTan) ** 2 / (C.MU_M * C.MU_M)));
      const rp = L.a * (1 - ecc);
      P.setSas(true, true);
      P.setTargetThrottle(fuel > 0 && rp - C.RM > 350 ? 0.25 : 0);
      if (fuel <= 0) { P.setTargetThrottle(0); mode = 'dry'; }
      else if (rp - C.RM <= 350) {
        P.setTargetThrottle(0);
        ev.lowerPeri = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(0), vRel: +L.v.toFixed(4) };
        mark('lower');
        mode = 'orbitCheck';
      }
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
      /* Wait for the game to AWARD the landing. js/physics.js records TOUCHDOWN only on a
         contact step with the engine out (isBurning() false — :778: "the descent ends after
         the cutoff, a step or two down"), and landing.landedOnMoon is the sticky flag that
         awards; the law's 3 m cutoff supplies the engine-out. The earlier guards were wrong:
         stages[3]+surfaceAlt keyed on contact and recorded a touchdown the game never gave
         (measured: the stage-3 tank ran dry ~200 m up, stageUp re-ignited the ascent engine,
         and the gear met the deck with throttle 0.4 still ramping — physics deferred, the log
         had no TOUCHDOWN line, and ev.touchMoon printed the pristine 0.0/0.0 initial values);
         getLandedOnMoon keyed on the perch, which any powered step clears (js/physics.js:559).
         With the award as the gate, the fuel-out handoff lands itself: cutoff, the throttle
         ramps out through a few metres of hop, physics records TOUCHDOWN, and lmClimb lifts
         from the perch. */
      if (ROUND && P.landing.landedOnMoon) {
        ev.touchMoon = { t: +P.getSimTime().toFixed(0), v: P.landing.speed.toFixed(1), tilt: P.landing.tilt.toFixed(1) };  // the game's own scoring record, before splashdown overwrites it
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
        /* KNOWN, kept on purpose: normalize() works in place, so the length read on the next line
           is 1 and the throttle is 1 / aMax = full, always — this "controller" never eases off.
           Reading the magnitude first (the obvious fix) was measured: the shipped phase still
           wins (10.161 d) but 10 of the 15 neighbours 2.158..2.186 and the 300 s and 3,600 s pad
           waits then lose at lmApex. Everything downstream — the Hohmann scan, the apsis trim,
           the V-bar servo — was tuned on the insertion a full-throttle cut leaves. Fix the two
           together or not at all. */
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
      // The apsis edge belongs to the terminal machine's own detector; do not eat it here.
      if (mode !== 'lmTerminal') prevRadial = L.radial;
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
        const cpos = C.csmParkPos(P.getSimTime(), new THREE.Vector3());
        const gap = cpos.clone().sub(P.S.pos);
        const d = gap.length();
        if (!ev.termStage) {
          ev.termStage = 'lower';
          ev.termStart = P.getSimTime().toFixed(0);
        }
        /* Plane match, flown during the terminal machine before the closure is allowed to
           matter. The analytic CSM circle lives in the Moon's orbital plane (MOON_U × MOON_V);
           the LM's orbit after ascent carries the launch site's plane — measured tilts 0.3°
           (cert, docked without ever needing this stage) to 8.6° (wait=300) — and the two
           planes meet at a node where the closing speed is v·Δi: the first wait=120 attempt
           reached 91 m of the CSM at 98 m/s and the 50 m/s DOCK_SPEED gate refused it forever.
           AT the node the answer is exact and trivial: the position lies IN the park plane, so
           nulling the normal velocity puts the whole orbit there — Δv = −(v·n̂)·n̂. Off-node
           nothing converges; three failed designs were measured (Nov-26) before this: a single
           impulse frozen at latch lit ~90 s later (gravity curving under the slew made hash of
           the axis — and its first sign was inverted: 3.6° → 7.5°, doubling the tilt); an
           always-on ĥ-steering tracker pulsed ±0.06° through its whole 250 m/s allowance at
           max latitude, where a burn rotates h a little and the geometry gives it back; and a
           v'-projection tracker declared done at the latitude extremes where its own error
           vanishes at full tilt. So the machine waits, off the throttle and out of the
           substage chain's way only while actually burning, for the crossing every half
           revolution (≤3.5 ks), |lat| < 0.035 rad ≈ 2°. The 250 m/s allowance covers the 8.6°
           case (245 m/s); what it cannot buy is quoted in ev.pln and flown with. */
        if (!ev._nHat) ev._nHat = new THREE.Vector3().crossVectors(C.MOON_U, C.MOON_V).normalize();
        let plnBusy = false;
        if (!ev.plnDone) {
          const _rp = P.S.pos.clone().sub(C.moonPos(P.getSimTime(), new THREE.Vector3()));
          const _rv = P.S.v.clone().sub(C.moonVel(P.getSimTime(), new THREE.Vector3()));
          const _h = _rp.clone().cross(_rv).normalize();
          const tilt = Math.acos(THREE.MathUtils.clamp(_h.dot(ev._nHat), -1, 1));
          const lat = _rp.clone().normalize().dot(ev._nHat);           // sin(latitude vs park plane)
          if (tilt <= 0.007 || (ev.plnSpend || 0) >= 0.250 || fuel <= 0.25) {
            ev.plnDone = true;
            ev.plnIgniting = false;
            P.setTargetThrottle(0);   // the tracker owned the throttle; nobody else cuts it
            ev.pln = { t: +P.getSimTime().toFixed(0), dv: +((ev.plnSpend || 0) * 1000).toFixed(0), tilt: +(tilt * 57.3).toFixed(2) };
          } else if (Math.abs(lat) < 0.035) {
            /* Ignite only over a quiet throttle, but CONTINUE (state ev.plnIgniting) once lit:
               with the quiet test as the only gate the stage stopped minding its own burn as
               soon as the throttle ramped past it — an unmanaged full-throttle hold dumped
               2.9 t and swung the tilt 3.6° → 20.8° in 75 s with the meter reading zero
               (wait=120, Nov-26). Cut at |vN| < 6 m/s before the axis would flip through the
               zero crossing and oscillate. */
            const quiet = P.getThrottle() < 0.005 && !ev.apoBurn && !ev.periBurn && !ev.termHoming;
            if (ev.plnIgniting || quiet) {
              ev.plnIgniting = true;
              const vN = _rv.dot(ev._nHat);
              plnBusy = true;
              const ax = ev._nHat.clone().multiplyScalar(-Math.sign(vN || 1));
              P.setSas(false);
              steerTo(ax);
              const aligned = P.fwd().dot(ax) > 0.9995;
              if (Math.abs(vN) < 0.006 && aligned) {
                P.setTargetThrottle(0);
                if (P.getThrottle() < 0.05) ev.plnIgniting = false;
              } else {
                const thr = THREE.MathUtils.clamp((Math.abs(vN) - 0.003) / (0.5 * aMax), 0.04, 1);
                const burn = aligned && thr > 0.004;
                P.setTargetThrottle(burn ? thr : 0);
                ev.plnSpend = (ev.plnSpend || 0) + (burn ? aMax * P.getThrottle() * H : 0);
              }
            }
          } else if (ev.plnIgniting) {
            /* Node passed mid-burn: cut and take the next one half a revolution later. */
            P.setTargetThrottle(0);
            if (P.getThrottle() < 0.05) ev.plnIgniting = false;
          }
        }
        if (plnBusy) {
          /* The plane burn owns the frame. It never starts on top of another burn (the gate on
             the ignition below), and the apsidal machine never runs while it burns — a hijacked
             apolune boost was measured flying periselene under the surface (1,695 m/s impact,
             wait=300 Nov-26). Between node windows the chain flies its own business. */
          prevRadial = L.radial;
        } else {
        /* One axial burn primitive for the whole machine: align, burn along the ignition axis,
           throttle proportional to the Δv remaining with a cut lead that pays the throttle
           ramp-down. Both rate limits here are measured failures: a burn lit mid-slew spends
           propellant in a direction no Δv law accounts for (one 11 m/s apolune pro cut ran 42 s
           broadside, ate 2.5 t and LOWERED the orbit); and a bang-bang cut at this engine's
           thrust-to-mass (the ascent stage is 17 m/s², ten times Apollo's) cannot resolve the
           1-20 m/s rendezvous burns at all — with a 0.35·aMax dead zone every perch cut simply
           never ignited and the phase error froze at 20 km. A proportional throttle with a 0.04
           floor cuts at 2·aMax·τ², which is ≈ 0.05 m/s at small τ: fine burns become ignitable
           and land within ~±2 m/s; big ones ride τ=1 and keep the full-ramp lead. */
        const axisBurn = vT => {
          const pro = ev.burnDir !== undefined ? ev.burnDir : (Math.sign(vT - L.v) || 1);
          const want = relV.clone().multiplyScalar(pro).normalize();
          if (ev.burnDir === undefined) ev.burnDir = pro;
          const tau = P.getThrottle();
          const dvt = (vT - L.v) * pro;                                  // Δv remaining, signed
          const ramp = 2 * aMax * tau * tau + 0.0002;                    // what closing costs now (km/s)
          P.setSas(false);
          steerTo(want);
          const fine = dvt > ramp ? Math.max(0.04, (dvt - ramp) / (0.5 * aMax)) : 0;
          P.setTargetThrottle(fuel > 0 && fine > 0 && P.fwd().dot(want) > 0.9995 ? fine : 0);
          if (dvt <= ramp || fuel <= 0) { P.setTargetThrottle(0); ev.burnDir = undefined; return true; }
          return false;
        };
        if (ev.termStage === 'lower') {
          /* Two burns at the apsides, where the radial rate is exactly zero so the engine axis
             and the desired Δv coincide: prograde at apolune to lift periapsis toward the
             phasing circle, retrograde at that periapsis to circularise on whatever it reached
             (±80 km is fine — the match stage's V-bar servo drives the circle from there).
             No clock timeout: the give-up signal is three whole apolunes with no cut. */
          if (L.radial < 0 && prevRadial >= 0) ev.termApo = (ev.termApo ?? 0) + 1;
          if (!ev.periCut && !ev.apoBurn && L.radial < 0 && prevRadial >= 0 && L.r > PH - 10) ev.apoBurn = true;
          if (ev.apoBurn) {
            if (axisBurn(Math.sqrt(C.MU_M * (2 / L.r - 1 / ((L.r + PH) / 2))))) { ev.apoBurn = false; ev.periCut = true; }
          } else if (ev.periCut && L.radial > 0 && prevRadial <= 0 && L.r > PH - 80) {
            ev.periBurn = true;
          }
          if (ev.periBurn && axisBurn(Math.sqrt(C.MU_M / L.r))) {
            ev.periBurn = false; ev.periCut = false;
            ev.termStage = 'phase';
            ev.termCirc = { t: +P.getSimTime().toFixed(0), r: +L.r.toFixed(1), v: +L.v.toFixed(4) };
          }
          if ((ev.termApo ?? 0) >= 3 && ev.termStage === 'lower') {
            ev.termStage = undefined; ev.periCut = false; ev.apoBurn = false; ev.periBurn = false;
            ev.termApo = 0;
            mode = 'lmCoast';   // three apolunes never closed the circle: raise again
          }
        } else if (ev.termStage === 'phase') {
          // coast; scan the window up: arrival half a transfer later must meet the CSM
          P.setTargetThrottle(0);
          const aT2 = (L.r + C.PARK_R) / 2;
          const tArr2 = P.getSimTime() + Math.PI * Math.sqrt(aT2 ** 3 / C.MU_M);
          const err2 = wrapPi((C.P0_PARK + C.PARK_N * tArr2) - (angOf(rel) + Math.PI));
          if (Math.abs(err2) < 1.5e-3 && fuel > 0 && Math.abs(L.radial) < 0.02) {
            ev.termIgn = { t: +P.getSimTime().toFixed(0), err: +err2.toFixed(5) };
            hohV = Math.sqrt(C.MU_M * (2 / L.r - 1 / aT2));
            ev.termStage = 'rise';
          }
          if (P.getSimTime() > Number(ev.termStart) + 260000) { ev.termStage = undefined; mode = 'dry'; }
        } else if (ev.termStage === 'rise') {
          if (axisBurn(hohV)) {
            ev.termStage = 'match'; ev.fb = null;
            ev.termStart = P.getSimTime().toFixed(0);   // the clock restarts: the scan may have spent the budget
          }
        } else {
          /* V-bar closure, and it may only bite at the apsides. A tangential cut made anywhere
             else keeps the old radial velocity and drives the OPPOSITE periapsis deep — bg_33
             crashed into the Moon at 1700 m/s that way. At an apsis the axis is the orbit's own,
             so a cut there moves the opposite apsis exactly where vis-viva says, once a lap:
             choose the perch circle rT that closes the along-track error by drift (below the
             CSM when behind, above when ahead, closure time-constant 3000 s, 25 km cap — a
             750 s τ limit-cycled at ±10 km forever: this actuator fires once an apsis, ~590 s
             of delay, and a loop that fast with that much delay is marginally stable; measured)
             and set the OPPOSITE apsis to rT + 0.5·(rT − r) — a contraction, not a mirror: a
             mirrored aim (2·rT − r) reflects the apsis pair about rT forever, leaving a radial
             breathing that crosses the CSM circle at tens of m/s and never docks; half-throw
             decays both apsides into the perch over a few laps while the drift works the error.
             At periapsis that is legal when rT ≥ r
             (raise the apoapsis); at apoapsis when rT ≤ r (lower the periapsis); otherwise the
             lap coasts. The last 1.8 km is pure coast: closest approach is the perch depth
             itself, a few hundred metres, and physics docks there — under 1 km, single-digit
             m/s. A pass that misses reopens the error and the next apsis corrects it. The real
             LM flew this phase on its RCS for hours; the certifier needs the geometry patient. */
          P.setTargetThrottle(0);
          /* Terminal homing, the last few km. The apsidal depth law gets the pair to a few km but
             the flyby itself is a lottery: the two orbits meet at the plane-crossing node and
             whether the pass depth lands inside DOCK_DIST (1 km) depends on the breathing phase
             — the certified flight passed at 217 m; phases 2.165 and 2.176 froze at err −2.1 km
             and a 5 km gap, UNDER the law's dead band (the perch offset asked for there is below
             the ~2 m/s axisBurn cut resolution, so nothing bites) and above the old 3 km homing
             entry — 260 ks of budget, thr 0.00, 2.32 t unused (Nov-27). Entry is 6 km, backed
             out above 8. The law is the powered-descent one: a_vehicle = (v_des − v)/τ with
             v_des = CSM velocity + ĝ·rate (proportional, capped 20 m/s, under DOCK_SPEED 50) and
             the thrust command a_thr = a_vehicle − g — the first cut ADDED g (doubling the fall)
             and gated the burn on |a_thr| > 0.03 km/s², which no terminal command can reach
             (worst case ≈ 0.009), so that version never lit in any flight and every dock to
             date was a pure apsidal flyby. τ = 60 s: a hover at 1.6 m/s² sits above the 0.04
             throttle floor; the crossing costs ln(6/0.5)/0.012 ≈ 192 s × 1.6 m/s² ≈ 310 m/s of
             the ~2.2 km/s the ascent stage arrives with. */
          if (ev.plnDone && (ev.termHoming || d <= 6)) {
            ev.termHoming = true;   // sticky: the apsidal law below is the bootstrap, this is the
                                    // closer — handing back at d > 8 re-entered its dead band and
                                    // it limit-cycled the rest of the tank empty (2.176, Nov-27)
            /* A Hill (CWH) V-bar servo, continuous at 10 Hz — the apsidal depth law's actuator
               delay (~590 s per burn) is exactly what limit-cycled it ±300 km before, and its
               ~2 m/s cut resolution freezes the pair at 2–3.5 km of along-track error (phases
               2.165/2.176: gap 5 km, thr 0.00, 2.32 t unused to budget expiry, Nov-27).
               Entry is 6 km and LATCHED — once this is flying it never hands back.
               Behind goes LOWER and drifts up (z_cmd = −0.30·x, capped 3 km — the same drift
               the depth law used, ~5 m/s per km of perch); the radius itself is held by a PD
               on z (ω ≈ 0.035 rad/s, ζ ≈ 1: a 1 km radius error asks 1.2 m/s², a 20 m/s radial
               rate 1.4 m/s²), whose zero-thrust equilibrium IS the natural drift — nothing
               fights the orbit. The thrust axis is LOCAL VERTICAL ONLY: the previous law here
               (absolute-velocity homing, gravity added instead of subtracted, gated on an
               unreachable |a| > 0.03 km/s² — it never lit; and Nov-27's brief lit version
               rotated the plane tilt 0.29°→0.8° in a minute and emptied the stage) put thrust
               out of plane, and plane control belongs to the node law ALONE. Thrust stops
               inside 400 m; the physics dock gate is 1 km and 50 m/s, met on the drift.
               Cost ~0.3 t of the ascent stage's 3.1 t. */
            if (fuel > 0.05 && d > 0.4) {
              const rad = rel.clone().multiplyScalar(1 / Math.max(L.r, 1e-6));             // local vertical
              const errH = wrapPi((C.P0_PARK + C.PARK_N * P.getSimTime()) - angOf(rel));   // rad, + = CSM ahead
              const zcP = -THREE.MathUtils.clamp(errH * L.r * 0.30, -3, 3);                // km: behind → lower → faster
              // Radial PD ω ≈ 0.035 ζ ≈ 1 on (z − zcK), ż damping. Deliberately NO gravity-gradient
              // term: adding +3n²z moved the zero-thrust equilibrium off a natural orbit and the
              // PD then chased the off-orbit hold with real fuel — every mission dried in the
              // terminal within 150 s of homing entry (Nov-27, same day). The plain PD's
              // equilibrium IS a free drifting orbit, which is what the closure rides on.
              // In this three-body field (gravityAt carries Earth + Moon + the indirect term)
              // the drift of a near-Moon circle is NOT −1.5·n·Δr to first principles — measured:
              // the pair can sit near zero relative rate at z ≈ +0.9 km where the two-body law
              // promises 1.4 m/s (2.176 stall, raw errH traces). Everything here is therefore
              // closed-loop on the measured x below.
              const xkm = errH * L.r;
              if (Math.abs(xkm) > 60) ev.termHoming = false;   // run-away → apsidal law re-acquires
              if (ev._hT === undefined || P.getSimTime() <= ev._hT) { ev._hT = P.getSimTime(); ev._hX = xkm; ev._hXd = 0; }
              else {
                const dtm = P.getSimTime() - ev._hT, dxm = xkm - ev._hX;
                if (Math.abs(dxm) > 100) { ev._hX = xkm; ev._hT = P.getSimTime(); }         // wrapPi seam
                else {
                  ev._hXd += (dxm / dtm - ev._hXd) * Math.min(1, dtm / 50);
                  ev._hT = P.getSimTime(); ev._hX = xkm;
                }
              }
              // ── closure law: perch PD + FLOWN along-track rate ──
              // The field defeats every pure-altitude phasing law at SOME longitude, all
              // measured on this tree (Nov-27): co-rotation equilibria freeze a memoryless PD
              // (x +1.03 km, ż = 0, whole budget); the Earth-tidal term cancels ~7.6 m/s of
              // Kepler's rate at 2.168's longitude (zero drift ~5.8 km ABOVE the rail), so an
              // integral on the two-body sign diverges pinned at its clamps; and even an
              // integral whose sign is estimated from the field (ĝ = dẋ/dz by correlated
              // samples) stalls where the field's drift-vs-altitude is FLAT — z walked −3.5 →
              // −6.7 km with ẋ ≡ +0.1: at that longitude altitude has no authority at all.
              // The one actuator the field cannot take away is thrust: sustained along-track
              // Δv closes x as measured, whatever the field does. SIGN, measured, twice:
              // prograde RAISES the LM's angular rate at fixed radius, so it DECREASES
              // ẋ = r·d(θ_csm − θ_lm)/dt — controller at = (ẋ − ẋ_cmd)/60 s. Both sign
              // mistakes are in the history: (cmd − ẋ) ran ẋ to −487 m/s with 2.5 t gone;
              // −(ẋ − cmd) on a 20 s horizon rang the elastic and lost the cert phase in the
              // terminal. 60 s is slow for the elastic, fast for the lap.
              // ẋ_cmd = −0.001·x capped ±6 m/s (a 12 m/s cap overshot x = 0 at +6 m/s and
              // rang out to +3.8 km on entry); |at| ≤ 1 m/s² (2 m/s² at wide nose angles
              // lost the 0.9995 align gate and burned blind); the perch PD above still holds
              // z and supplies drift for free where the field cooperates. The I term
              // (per-second half a millimetre/second of ask per km of residual x, capped
              // ±1.5 m/s) is not polish — the pure rate loop settles into new hover points
              // where the commanded rate happens to match the field's drift: 2.168 converged
              // to x = +2.41 km, ẋ = −0.04 m/s, thr 0.00 and sat there 250 ks to a dry tank
              // (Nov-27, /tmp/ll168f.txt). Only memory walks out of a zero-error hold.
              const az = 0.0012 * (zcP - (L.r - C.PARK_R)) - 0.07 * L.radial;               // km/s²
              ev._hIe = (ev._hIe || 0) + xkm * 0.1 * 5e-4;                                  // m/s of ask
              const xcmd = THREE.MathUtils.clamp(-0.001 * xkm - THREE.MathUtils.clamp(ev._hIe, -1.5, 1.5) * 1e-3, -0.006, 0.006);
              const at = THREE.MathUtils.clamp((ev._hXd - xcmd) / 60, -0.001, 0.001);
              const av = rad.clone().multiplyScalar(az).addScaledVector(relV, at / Math.max(relV.length(), 1e-9));
              const am = av.length();
              if (process.env.DEBUGHOME && i % 250 === 0) console.log(`  HOME t=${P.getSimTime().toFixed(0)} d=${(d * 1000).toFixed(0)} x=${(xkm * 1000).toFixed(0)}m z=${((L.r - C.PARK_R) * 1000).toFixed(0)}m zc=${(zcP * 1000).toFixed(0)}m xdot=${(ev._hXd * 1000).toFixed(1)} az=${(az * 1000).toFixed(2)} at=${(at * 1000).toFixed(2)} thr=${P.getThrottle().toFixed(2)} fuel=${stages[4].fuel.toFixed(3)}`);
              // Deadband 0.2 m/s², NO 0.04 throttle floor (that floor is the descent law's):
              // pinned just above a smaller deadband the floor burned 0.4 m/s² — 25× lunar g —
              // continuously, and nose lag put enough of it along-track to wreck the phasing:
              // 2.7 t spent, x diverged −2 km → −85 km in 100 ks (2.176, Nov-27).
              if (am > 0.0002 || Math.abs(at) > 4e-5) {
                P.setSas(false);
                steerTo(av.clone().multiplyScalar(1 / am));
                P.setTargetThrottle(P.fwd().dot(av) / am > 0.9995
                  ? THREE.MathUtils.clamp(am / aMax, 0.004, 1) : 0);
              }
            }
          } else if (d > 1.8) {
            const err = wrapPi((C.P0_PARK + C.PARK_N * P.getSimTime()) - angOf(rel)) * L.r;   // km, + = CSM ahead
            /* gain 0.30 / floor 0.6 / cap 10. Three measured regimes, all on this one line:
               with 0.19/25 a rise arriving ~38 km out limit-cycled at ±300 km for the whole
               260 ks budget (actuator delay ~590 s per apsis); with 0.06/0.3 the closure froze at
               err ≈ 3.3 km — a 0.3 km perch depth is inside the ±2 m/s cut resolution, no drift
               ever established, and the pair coasted nose-to-nose 3 km apart to a dry tank
               (wait=120, Nov-26). The floor must be ABOVE the noise and BELOW DOCK_DIST (1 km):
               0.6 km is ~3.2 m/s, drifts 0.8 m/s, and the flyby itself passes inside the dock
               radius. Any certified dock must be re-observed with this line and its gap quoted. */
            const depth = THREE.MathUtils.clamp(Math.abs(err) * 0.30, 0.6, 10) * (err >= 0 ? 1 : -1);
            const rT = C.PARK_R - depth;
            const atPeri = L.radial > 0 && prevRadial <= 0;
            const atApo = L.radial < 0 && prevRadial >= 0;
            if ((atPeri && rT > L.r - 0.5) || (atApo && rT < L.r + 0.5)) { ev.fb = rT + 0.5 * (rT - L.r); ev.fbR = ev.fb; ev.v0 = L.v; }
            if (ev.fb !== null) {
              const vT = Math.sqrt(Math.max(1e-9, C.MU_M * (2 / L.r - 2 / (L.r + ev.fb))));
              if (axisBurn(vT)) { ev.fb = null; ev.lastBurn = { t: +P.getSimTime().toFixed(0), apsis: atPeri ? 'P' : 'A', rO: +ev.fbR.toFixed(1), dv: +((L.v - ev.v0) * 1000).toFixed(1) }; }
            }
            ev.lastErr = +err.toFixed(1); ev.lastRT = +rT.toFixed(1);
          }
          if (P.getSimTime() > Number(ev.termStart) + 260000) mode = 'dry';
        }
        }
        if (ev.termGap === undefined || d < ev.termGap) {
          ev.termGap = +d.toFixed(3);
          ev.termGapV = +(P.S.v.distanceTo(C.csmParkVel(P.getSimTime(), new THREE.Vector3())) * 1000).toFixed(1);
        }
        prevRadial = L.radial;
        if (trace && i % 250 === 0) console.log(`    terminal t=${P.getSimTime().toFixed(0)} ${ev.termHoming ? "home " : ""}${ev.termStage}${ev._nHat ? ` vN=${(P.S.v.dot(ev._nHat) * 1000).toFixed(0)} iH=${(() => { const _rp = P.S.pos.clone().sub(C.moonPos(P.getSimTime(), new THREE.Vector3())); const _rv = P.S.v.clone().sub(C.moonVel(P.getSimTime(), new THREE.Vector3())); return (Math.acos(THREE.MathUtils.clamp(_rp.clone().cross(_rv).normalize().dot(ev._nHat), -1, 1)) * 57.3).toFixed(2); })()}` : ""} gap=${(d * 1000).toFixed(0)} m r=${L.r.toFixed(0)} thr=${P.getThrottle().toFixed(2)} fuel=${stages[4].fuel.toFixed(2)} apo=${ev.termApo ?? 0} apob=${ev.apoBurn ? 1 : 0} pic=${ev.periCut ? 1 : 0} rad=${L.radial.toFixed(3)}${ev.lastErr !== undefined ? ` err=${ev.lastErr} rT=${ev.lastRT}${ev.lastBurn ? ` lastBurn=${JSON.stringify(ev.lastBurn)}` : ''}` : ''}`);
        if (fuel <= 0 && !P.getDocked()) { if (trace) console.log('  TERM-DRY t=' + P.getSimTime().toFixed(0) + ' fuel=' + fuel + ' stage=' + stages.map(st => st.fuel.toFixed(2)).join('/') + ' active=' + P.activeEngine()); mode = 'dry'; }
      }
    } else if (mode === 'tei') {
      const plan = teiEscape();
      if (!ev.teiIgn) {
        /* Ignite only where the asymptote actually points home: a probe (scan of every park
           phase, both senses, this math) measured aim < 12° with dv < 1.2 km/s over ~15° of
           parking phase, aim → 0° at the far-side point. The old dv-only gate ignited at a
           phase whose best-aim was 43.9° (bg_63 ev.teiIgn.aim) and every correction after
           that had to burn the difference away. */
        if (plan.dv.length() >= 1.3 || plan.aim > 0.06) {
          /* Wait with the nose already walking toward the burn axis: the flip of the docked
             stack (measured) ate the first 300 s of the burn when the gate opened cold. */
          P.setSas(false);
          steerTo(plan.dv);
          P.setTargetThrottle(0);
        } else {
          ev.teiIgn = { t: +P.getSimTime().toFixed(0), altM: +L.alt.toFixed(0), dv: +(plan.dv.length() * 1000).toFixed(0),
            aim: +(plan.aim * 57.2958).toFixed(1) };
          teiDv0 = plan.dv.length();
          /* Bias the fixed axis against lunar gravity DURING the burn: teiEscape solves an
             impulsive Δv, but 850 m/s takes ~80 s at 16 m/s² and lunar g (1.62) adds ~130 m/s
             while the engine runs — the un-biased axis flew aimErr 5.3° every time (bg_53→76),
             which is 78 m/s of correction the taps then could not afford. */
          const _mp = C.moonPos(P.getSimTime(), new THREE.Vector3()).sub(P.S.pos);
          const _rl = _mp.length();
          const _gv = _mp.multiplyScalar(C.MU_M / (_rl * _rl * _rl));
          const _Tb = teiDv0 / (C.SPECS[2].thrust / P.totalMass() / 1000);
          teiAxis = plan.dv.clone().addScaledVector(_gv, -0.6 * _Tb).normalize();
          teiAcc = 0;
          teiT0 = 0;    // burn-armed seconds, not wall time — the cut compares against 500
        }
      }
      if (ev.teiIgn) {
        /* FIXED axis, integral completion — measured ladder of this burn, all four rungs:
           - proportional throttle inside 1.6 m/s² lunar g: equilibriums (τ > 0.28 to hover),
             drinks the tank (twice);
           - live-reaimed full throttle, 0.9 gate: thrash (|dv| 543 after 61 ks, dry);
           - live-reaimed full throttle, 0.999 gate (bg_57): worse — 2,244 km/s equivalent
             burned, dry, never escaped: the solved target moves as the state moves and the
             nose chases it in circles;
           - fixed axis, latched at ignition (bg_56): CLEAN — 856 m/s in 77 s, escape, 18.4 t
             left. Its only failure was aim: 20.6° off −d̂, and the correction that should have
             fixed it was itself broken (throttle 0 for 400 s).
           So: fixed axis here; the aim comes from the ignition solve (whose error is the
           slew-rotation of the gravity bias — a few hundred m/s of sideways, which is exactly
           what the fixed-axis midcourse bang outside the sphere burns off). */
        const a = C.SPECS[2].thrust / P.totalMass() / 1000;   // km/s² — state is km
        const aligned = P.fwd().dot(teiAxis) > 0.9995;
        if (aligned) { teiT0 += H; teiAcc += a * P.getThrottle() * H; }
        const leak = 2 * a * P.getThrottle() ** 2 + 0.0004;    // ramp lag, km/s (bg_56's value)
        const cut = teiAcc >= teiDv0 - leak || fuel <= 0 || teiT0 > 500;
        P.setSas(false);
        steerTo(teiAxis);
        if (!P.getEngineOn()) P.toggleIgnite();
        P.setTargetThrottle(cut || !aligned ? 0 : 1);
        if (cut) {
          P.setTargetThrottle(0);
          const elE = P.orbitalElements(P.S.pos, P.S.v, C.MU_E, C.RE);
          const u = moonAsym(P.S.pos, P.S.v);
          const mpn = C.moonPos(P.getSimTime(), new THREE.Vector3());
          const wnow = corridorVel(mpn.length(), C.moonVel(P.getSimTime(), new THREE.Vector3()).normalize(),
            mpn.clone().multiplyScalar(1 / mpn.length())).sub(C.moonVel(P.getSimTime(), new THREE.Vector3())).normalize();
          ev.tei = { t: +P.getSimTime().toFixed(0), pe: +elE.pe.toFixed(0), vInert: +P.S.v.length().toFixed(4),
            escape: elE.escape, dv: +(teiAcc * 1000).toFixed(0), aim: +(teiDv0 * 1000).toFixed(0),
            aimErr: u ? +(Math.acos(THREE.MathUtils.clamp(u.dot(wnow), -1, 1)) * 180 / Math.PI).toFixed(1) : 'bound' };
          mark('tei');
          mode = 'tecoast';
        }
      }
    } else if (mode === 'teicorr') {
      /* The midcourse CORRECTION is a machine of taps, not one bang: each tap latches the
         present dv̂ (teiDv: graze-ellipse velocity at the vehicle, pe +55 km), burns that
         vector on the integral along the FIXED latched axis, coasts 150 s, re-solves, and
         taps again. One full-throttle bang cannot land the corridor: the pe sensitivity here
         is ~40 km per m/s, and at 60 t one 0.1 s step is already 1.6 m/s (bg_59 burned 550
         m/s in one bang and left an orbit that had still not arrived at the 26.6 d cap). Between taps the target moves 0.5 mm/s² — the state is
         nearly frozen, so re-aiming is cheap and each tap halves the error; the whip of
         chasing a LIVE dv̂ during a burn (three measured dry tanks) never happens because
         the axis never moves mid-tap. */
      const a = C.SPECS[2].thrust / P.totalMass() / 1000;
      /* Guards (measured Nov-26): below 200 km the taps kept re-latching where teiDv's graze
         conic diverges (dv readouts of 26,000 m/s) — hand back at the atmosphere; refuse any
         single tap over 500 m/s (>500 means the readout, not the sky); and cap the LADDER at
         450 m/s of ASKS total (teiFixAcc). The cap is a stability knob, measured both ways:
         raised to 1 km/s on the pre-awarded-touchdown chain the ladder never starved, but the
         Moon's tide re-kicks the corridor every ~27 ks forever and the cert phase burned
         1,751 m/s of corrections arriving 21.3 d out with 5 t aboard — safe, wasteful. At 0.45
         the certified chain lands in 10.1 d having spent 726 m/s, and every measured variant
         (fifteen corridor phases 2.158–2.186 rad, the steep table, 120 and 300 s pad waits)
         comes home on the same cap; the starvation the low cap CAN inflict — a ladder silenced
         mid-work with fuel aboard, a 25 g entry — is what the pre-fix chain did at wait=120. */
      if (altE < 200 || fuel <= 0) {
        if (!teiFixSnap) teiFixSnap = { t: +P.getSimTime().toFixed(0), dv: +(teiDv().dv.length() * 1000).toFixed(1), taps: teiIter };
        mode = 'tecoast';
      } else {
      P.setSas(false);
      if (teiCW > 0) {                                   // coast between taps
        teiCW--;
        P.setTargetThrottle(0);
      } else if (!teiCorr) {                             // latch the next tap (or hand back)
        const d2 = teiDv().dv;
        // Hand-back 5 m/s, 40 taps per pass, 450 m/s cumulative requested (teiFixAcc): the
        // measured winning ladder converges by ~10 taps far out and the certified chains ask
        // ≈ this much in total. The 1 km/s this briefly read while the sub-step throttle was
        // being fixed never starved anything, but it let the Moon's tide re-kick the corridor
        // into new taps forever (cert phase: 1,751 m/s of corrections, 21.3 d); 0.45 is the
        // number the shipped chains are certified at — the guard paragraph above carries both
        // measurements. The per-tap (0.5 km/s), per-pass (40 taps) and altitude (< 200 km)
        // guards are what stop a diverging readout, not this budget.
        // The floor used to read 4 m/s, which was unreachable by construction —
        // a full-throttle step is 7–9 m/s, so the last tap burned nothing and the ladder
        // locked at its residual (see the sub-step throttle below); 5 m/s is just above the
        // micro-tap's ~1.4× overshoot of a smallest-step ask. Earlier pe-based contracts all
        // failed three different ways (stranded at +148, ENTRY TOO STEEP at −143, tap locks
        // at the re-arm figure): the corridor |v| conic remains the only target whose ladder
        // has actually won.
        if (d2.length() <= 0.005 || teiIter >= 40 || fuel <= 0 || d2.length() > 0.5 || teiFixAcc > 0.45) {
          teiFixSnap = { t: +P.getSimTime().toFixed(0), dv: +(d2.length() * 1000).toFixed(1), taps: teiIter,
                         pe: +P.orbitalElements(P.S.pos, P.S.v, C.MU_E, C.RE).pe.toFixed(0) };
          mode = 'tecoast';
        } else {
          teiCorr = d2.clone().normalize(); teiCorrDv = d2.length(); teiAcc = 0; teiCBurn = 0; teiIter++; teiFixAcc += teiCorrDv;
          teiCorr._v0 = P.S.v.clone();
          if (process.env.TLTAP) console.error(`  tap ${teiIter} t=${P.getSimTime().toFixed(0)} rE=${altE.toFixed(0)} dv=${(teiCorrDv * 1000).toFixed(1)}`);
        }
      } else {
        const aligned = P.fwd().dot(teiCorr) > 0.995;
        if (aligned) teiAcc += a * P.getThrottle() * H;
        /* A tap asks for less than one full-throttle step (a·H ≈ 7–9 m/s at 66–90 t) whenever the
           ladder gets near the corridor — and full throttle CANNOT deliver that: the cut
           `acc ≥ dv − a·H` is true at step 0, zero Δv flows, and the ladder relatches the same
           residual forever (nova @ 0.82 measured dv = 6.5 m/s on 17 consecutive zero-burn taps;
           the GAME chain's passes each ended in the same lock and only escaped because the
           Moon's tide kicked dv back over the 20 m/s re-arm — a win by luck, not by law).
           The smallest Δv this engine CAN meter is set by its 0.25/s throttle ramp: opening to
           thr and shutting again moves ramp-up 2a·thr² + ramp-down 2a·thr², so a sub-step tap
           opens to thr = √(dv/4a), which makes the two ramps move dv between them and the cut
           fire at half the ask. (Slack `2a·thr²` is bg_56's leak law — a slack LARGER than the
           ask reproduces the same step-0 lock: measured with thr = dv/(a·H) > 1, taps burning
           0.0 m/s at ask 12.2.) The loop eats the ~1.4× overshoot as a sign flip and dv decays
           to the hand-back floor. Taps ≥ 2·a·H stay exactly the certified full-throttle law. */
        const stepV = a * H;
        const thr = teiCorrDv >= 2 * stepV ? 1 : Math.max(0.02, Math.sqrt(teiCorrDv / (4 * a)));
        const cut = teiAcc >= teiCorrDv - (thr === 1 ? stepV : 2 * a * thr * thr + 0.0004)
          || fuel <= 0 || ++teiCBurn > 3000;
        steerTo(teiCorr);
        if (!P.getEngineOn()) P.toggleIgnite();
        P.setTargetThrottle(cut || !aligned ? 0 : thr);
        if (trace && teiCBurn % 200 === 199) console.log(`  tap${teiIter} t=${P.getSimTime().toFixed(0)} dv=${(teiCorrDv * 1000).toFixed(0)} acc=${(teiAcc * 1000).toFixed(0)} deg=${(Math.acos(THREE.MathUtils.clamp(P.fwd().dot(teiCorr), -1, 1)) * 57.3).toFixed(1)} thr=${P.getThrottle().toFixed(2)}`);
        if (cut) {
          if (process.env.TLTAP) {
            const realV = P.S.v.clone().sub(teiCorr._v0);
            console.error(`    tap${teiIter} ask=${(teiCorrDv * 1000).toFixed(1)} along=${(realV.dot(teiCorr) * 1000).toFixed(1)} real=${(realV.length() * 1000).toFixed(1)} thr=${thr.toFixed(2)} cb=${teiCBurn}`);
          }
          P.setTargetThrottle(0); teiCorr = null; teiCW = 1500;
        }
      }
      }
    } else if (mode === 'tecoast') {
      P.setTargetThrottle(0);
      P.setSas(true, true);                        // retrograde: heat shield first, from here to the water
      /* The correction RE-ARMS, like Apollo's chain of MCCs: one pass at 1.8× the sphere is
         not enough — the Moon keeps pulling after it (bg_62: taps converged, and 23 days later
         the Moon's tide had walked the periapsis out again and the ship was still 400,000 km
         up). The corridor is held by re-entering teicorr whenever the drift to the graze target
         exceeds 20 m/s — 4× the 5 m/s hand-back floor, so the tide has actually reopened the
         error. The pair 20/5 measured as the winner once sub-step taps burn real Δv; before
         that fix the same 20/4 "chased noise with 40 taps ≈ 450 m/s" because taps below one
         full-throttle step burned nothing and the residual just sat in the lock band until the
         tide kicked it (the game's certified passes 1–3 each ended on such a zero-burn tap 9).
         teiIter is the PER-PASS tap budget — the cumulative figure starved late passes (nova
         @ 0.82 spent 23 of 40 in the first locked pass); teiFixAcc remains the one Δv budget
         for the whole return. Between passes it costs nothing. */
      if (++teiRN % 10 === 0 && altE > 200 && P.S.pos.distanceTo(C.moonPos(P.getSimTime(), new THREE.Vector3())) > 1.8 * C.SOI_M
        && teiDv().dv.length() > 0.02) {
        teiCorr = null; teiCW = 0; teiIter = 0;
        mode = 'teicorr';
      }
      if (altE < 150) {
        ev.teiFix = teiFixSnap || { taps: 0, dv: +(teiDv().dv.length() * 1000).toFixed(1) };
        mark('teifix');
        P.separateStage(2);
        mark('entry');
        mode = 'capsule';
      }
      if (P.getSimTime() > 2.3e6) mode = 'dry';   // ~27 d: a cheap chain docks late (day 8+ here)
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
  if (P.landing.speed > 0) ev.touch = { v: +P.landing.speed.toFixed(1), tilt: +P.landing.tilt.toFixed(1) };
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
/* `--scan=lo,hi,step` sweeps launch phases printing the COAST-ONLY first periselene (probePeri:
   no LOI, no return leg — one number per phase, immune to what the mission does afterwards).
   The periselene basin is narrow (~500 km per 1e-3 rad), coarser than the circle/64 solve scan,
   so this is how a moved window is found before asking the bisection to straddle it. */
const SCAN = (process.argv.find(a => a.startsWith('--scan=')) || '').slice(7).split(',').map(Number);
if (SCAN.length === 3 && SCAN.every(Number.isFinite)) {
  for (let ph = SCAN[0]; ph < SCAN[1]; ph += SCAN[2]) {
    const fp = probePeri(ph % (2 * Math.PI));
    console.log(`${ph.toFixed(5)} ${fp >= 1e5 ? 'none' : fp.toFixed(0)}`);
  }
  process.exit(0);
}

/* Bisection of a straddling bracket (peri crossing AIM_PERI between lo and hi, circularly).
   `hiIsLow` states the bracket's sense: true = peri(lo) > AIM > peri(hi) (peri falls going
   forward), the main walk's and the retry walk's orientation; false = peri(lo) < AIM < peri(hi)
   (the scan fallback that walked FORWARD out of the valley floor — handing that inverted to
   the normal sense collapses the bracket onto an endpoint and certifies the valley, an impact
   phase). The circular midpoint, exactly as the loop takes it: if the bracket ever straddles
   the 0/2π seam — MOON_PHASE0 moved 0.036 rad in one physics commit — the naive (lo+hi)/2
   lands antipodal and certifies the wrong window; that is also why the inverted sense cannot
   be coded as a lo/hi swap, which would bisect the antipodal arc. */
const bisectBracket = (lo, hi, hiIsLow = true) => {
  for (let k = 0; k < 16; k++) {
    const m = (lo + (((hi - lo) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) / 2) % (2 * Math.PI);
    const fm = probePeri(m);
    console.log(`  solve ${k}: phase=${m.toFixed(7)} periselene=${fm >= 1e5 ? 'no encounter' : fm.toFixed(1) + ' km'}`);
    if ((fm > AIM_PERI) === hiIsLow) { lo = m; } else { hi = m; }
    if (Math.abs(fm - AIM_PERI) < 5) break;
  }
  return (lo + (((hi - lo) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) / 2 + 2 * Math.PI) % (2 * Math.PI);
};
if (!Number.isFinite(phase)) {
  /* The straddling corridor (periselene crossing AIM_PERI) is ~0.004 rad wide, and anything that
     touches the stack's mass moves it: +2 t of ascent tank moved the 2.1597 encounter from 350 km
     to 25,292 km. A coarse walk around the whole circle is a coin flip on whether a 0.25 rad step
     lands on either side of it; the honest seed is MOON_PHASE0 — the last certified window — and
     an honest stride is 0.002 rad, fine enough that the corridor cannot hide between two probes
     (AGENTS.md: the landable band alone spans ±2e-3 rad). 0.12 rad of walking FORWARD of the
     seed covers a moonrise — the walk never backs up, a window below the seed is the scan's
     to find; the probes that miss the Moon cost 400 ks of sim and ~10 s of wall. */
  let lo = C.MOON_PHASE0, hi = lo, flo = probePeri(lo), fhi = flo, hiIsLow = true;
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
    /* Walk out of the valley floor for a flank that is a REAL high pass: `probePeri` reports no
       encounter as ≥1e5, and a bracket between "none" and "impact" jumps the discontinuity — the
       bisection then rides the edge of the encounter window and certifies a grazing impact (what
       nova's 648 m/s loss was). The flank wanted is above AIM_PERI and below the SOI cutoff. */
    const highPass = fp => fp > AIM_PERI && fp < 1e5;
    hi = bestPh; fhi = best; lo = bestPh; flo = best;
    for (let back = 0; !highPass(flo) && back < 192; back++) {
      lo = (((lo - 0.002) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      flo = probePeri(lo);
    }
    if (!highPass(flo)) {
      lo = bestPh; flo = best;
      for (let fwd = 0; !highPass(fhi) && fwd < 192; fwd++) {
        hi = ((hi + 0.002) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        fhi = probePeri(hi);
      }
      if (!highPass(fhi)) { console.error('solve: no launch window straddles AIM_PERI — check AIM_PERI and the forces'); process.exit(1); }
      /* The forward flank brackets the crossing INVERTED (peri rises going forward from the
         valley floor), so the bisection is told the sense — with the default sense this bracket
         collapses onto the valley floor, an impact phase. */
      hiIsLow = false;
    }
  }
  phase = bisectBracket(lo, hi, hiIsLow);
}

const report = (r, phase) => {
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
};
let r = mission(phase, { trace: TRACE });
report(r, phase);
/* A round trip can miss the periselene aim by nothing and still lose the mission on the way
   home: the return corridor is its own geometry, and the ladder's budget cap (0.45 km/s of
   asks — see teicorr) can leave some periselene-350 phases unwinnable at the end while other
   corridors in the same basin splash at 7.8 m/s. Measured on the pre-awarded-touchdown chain:
   nova's first candidate stranded the CSM dry at 130 × 139,533 km after 841 m/s of corrections
   — the same phase flies the whole chain on the current one (self-solved WON, 11.936 d), so
   this loop is insurance for the geometry that still loses. After a loss it walks DOWN the
   phase circle to the next straddle of AIM_PERI (peri rises as phase falls through a corridor,
   so a crossing is the step where peri passes from below AIM_PERI to above it), bisects it and
   flies again. The walk starts one step BELOW the failed candidate: the candidate was bisected
   to AIM ±5 km and may sit a hair below it, and re-straddling its own crossing would return
   the same lost phase for every retry. Up to seven reflys; an explicit --phase is never retried. */
if (STACKS[WHICH].length >= 5 && r.state !== 'won' && !Number.isFinite(PHASE_ARG)) {
  for (let cand = 1; cand < 8 && r.state !== 'won'; cand++) {
    console.error(`solve: candidate ${phase.toFixed(7)} ${r.state.toUpperCase()} on the return — walking down to the next straddle`);
    let prevPh = (((phase - 0.02) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    let prevFp = probePeri(prevPh), lo = NaN, hi = NaN;
    for (let k = 0; k < 313 && !Number.isFinite(lo); k++) {
      const ph = (((prevPh - 0.02) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const fp = probePeri(ph);
      if (prevFp < AIM_PERI && fp > AIM_PERI && fp < 1e5) { lo = ph; hi = prevPh; }
      prevPh = ph; prevFp = fp;
    }
    if (!Number.isFinite(lo)) { console.error('solve: no further straddle above AIM_PERI on the circle'); break; }
    phase = bisectBracket(lo, hi);
    r = mission(phase, { trace: TRACE });
    report(r, phase);
  }
}
/* The exit code is the verdict: the shipped stacks must WIN, the retro stack is kept as a recorded
   LOSS. --expect=won|lost|any overrides. A check that cannot fail is not a check. */
const EXPECT = (process.argv.find(a => a.startsWith('--expect=')) || '').split('=')[1] || (WHICH === 'retro' ? 'lost' : 'won');
process.exitCode = EXPECT === 'any' || r.state === EXPECT ? 0 : 1;
console.log('  log:', (process.env.TLLOG ? r.log : r.log.slice(-6)).join('\n        '));
