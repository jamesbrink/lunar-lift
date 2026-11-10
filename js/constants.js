import * as THREE from 'three';

/* ---------------- real-world constants, all distances in km, time in seconds ----------------
   Gravity is GM/r^2 in km/s^2. Masses are tonnes, thrust is kN, so thrust/mass is m/s^2. */
export const RE = 6371, MU_E = 398600.4418;              // Earth radius, GM (km³/s²)
export const RM = 1737.4, MU_M = 4904.8695, SOI_M = 66200;  // Moon radius, GM, sphere of influence (km)
export const MOON_DIST = 384400;
export const MOON_RATE = 2.6617e-6;                      // rad/s — 27.32 d sidereal period
export const EARTH_SPIN = 7.292115e-5;                   // rad/s

/* Launch site: LC-39, Cape Canaveral. Fixed forever in inertial space at t = 0,
   and the pad mesh rides the rotating planet, so it stays on the same ground.
   Geocentric latitude (measured against docs/reference/launch-site.md): a sphere has one
   latitude, and the geocentric value is the one that makes the physics come out — rotation
   credit 2π·RE·cos(28.4469°)/86164 = 408.6 m/s and an achievable inclination of 28.447°,
   SP-4029's numbers. The 18 km difference from the geodetic latitude is below the resolution of
   the committed 2048x1024 sheet (17 km/px; its Florida coast runs to -80.68 against a real
   shoreline near -80.55), so the pad's pixel reads as near-shore water at either value. The
   texture's own alignment with this mapping was measured at IoU 0.954 against Natural Earth with
   zero offset, so nothing here needs a fudge to agree with the picture. */
export const PAD_LAT = 28.4469, PAD_LON = -80.6041;       // degrees, geocentric
const LATR = PAD_LAT * Math.PI / 180, LONR = PAD_LON * Math.PI / 180;

/* three's SphereGeometry (x = -R cos(phi) sin(theta), y = R cos(theta), z = R sin(phi) sin(theta),
   u = (lon+180)/360, v = (lat+90)/180) puts north at +Y, so the surface normal at (lat, lon) is: */
export const PAD_UP = new THREE.Vector3(Math.cos(LATR) * Math.cos(LONR), Math.sin(LATR), -Math.cos(LATR) * Math.sin(LONR)).normalize();
export const SPIN_AXIS = new THREE.Vector3(0, 1, 0);
export const PAD_EAST = new THREE.Vector3().crossVectors(SPIN_AXIS, PAD_UP).normalize();

/* The Moon's orbit is tilted 28.5° to the equator and its node is aligned with the launch
   azimuth — the classic launch window, where the translunar trajectory lies in one plane. */
export const MOON_PLANE_N = new THREE.Vector3().crossVectors(PAD_UP, PAD_EAST).normalize();
export const MOON_U = PAD_EAST.clone();
export const MOON_V = new THREE.Vector3().crossVectors(MOON_PLANE_N, MOON_U).normalize();
/* Launch window: the Moon's angle along its orbit at MET 0 for which a transfer burned at the
   first perigee after insertion arrives at the Moon instead of thousands of km past it. Solved
   numerically by tools/mission-sim.mjs (bisecting the first periselene altitude) at the step the
   game can actually run — see the note in that tool about coast step size: from the shipped
   coast-start state the game's scheme reaches 346 km at 0.1 s steps and an impact 475 km under
   the surface at 1 s steps, so this number is only valid for the step it was solved at. The tool
   aims at AIM_PERI = 350 km, the middle of the band its autopilot lands from.

   Measured sensitivity near the window (shipped vehicle, game's own step):
     phase -3e-3    rad -> periselene 745 km, touchdown 2.8 m/s, 6.6 t spare
     phase -1e-3    rad -> periselene 477 km, touchdown 2.8 m/s, 7.0 t spare
     phase 4.9187044    -> periselene 346 km, touchdown 3.3 m/s, 7.2 t spare
     phase +1e-3    rad -> periselene 218 km, touchdown 4.1 m/s, 7.4 t spare
     phase +1.75e-3 rad -> periselene 123 km, touchdown 4.9 m/s, 7.6 t spare
     phase +2e-3    rad -> periselene  91 km, LOST at 80 m/s, 0.4 t left
   i.e. ~130 km of periselene per 1e-3 rad (376 s of lunar motion at MOON_RATE), a gentle slope on
   the early side and a cliff on the late one, with the window 1.75e-3 rad — eleven minutes — from
   the last late flight that lands. js/targeting.js turns that into a HUD readout, so the aim is
   no longer invisible; the corridor it paints green (120-745 km) is the landed band.
   Waiting on the pad and warping advances the Moon, so any other start time can still reach one. */
/* Standard gravity as THIS GAME uses it, m/s²: Isp → exhaust velocity and mass flow, and the unit of
   every g readout. The defined value is 9.80665; 9.81 is what the certified flight was flown with,
   and changing it moves the propellant flow and with it the launch window. One name, so the HUD
   and the predictor cannot disagree with the engine. The budget tools (tools/mission-sim.mjs,
   tools/mission-math.py) keep the defined 9.80665 for their delta-v bookkeeping, as the Apollo
   figures they are compared with do: their totals read 0.034 % under the engine's own (16,274 m/s
   quoted, 16,280 at 9.81 - measured by switching the tool's constant on the shipped flight). */
export const G0 = 9.81;
export const MOON_PHASE0 = 2.1597018;                      // rad — 123.74° along the lunar orbit.
// Round-trip window: the 5-row SPECS ascend differently (16 parking orbits before TLI), and the
// window sits ~2.76 rad from the one-way stack's 4.9187044 — which is still the phase the one-way
// regression (landed) flies. Re-solve with `node tools/mission-sim.mjs game` after any change to
// the ascent, the TURN table, the forces or the masses; the check walks from this value.
let moonPhase = MOON_PHASE0;
export function setMoonPhase(p) { moonPhase = p; }

export function moonPos(t, out = new THREE.Vector3()) {
  const a = moonPhase + MOON_RATE * t;
  return out.copy(MOON_U).multiplyScalar(Math.cos(a)).addScaledVector(MOON_V, Math.sin(a)).multiplyScalar(MOON_DIST);
}

/* d/dt of moonPos: the Moon's own travel through the game frame, ~1.02 km/s. Anything that
   asks "how fast am I going relative to the lunar surface" needs this; the surface rides with it. */
export function moonVel(t, out = new THREE.Vector3()) {
  const a = moonPhase + MOON_RATE * t;
  return out.copy(MOON_U).multiplyScalar(-Math.sin(a)).addScaledVector(MOON_V, Math.cos(a)).multiplyScalar(MOON_DIST * MOON_RATE);
}
/* CSM park orbit: the CSM hovers in a circular lunar orbit while the LM is on the surface
   or in descent. Its position is analytic, not integrated — it is the parked object, not the
   primary, and the single primary state vector is the LM (or the mated CSM on the way home).
   Mirrors moonPos in Earth-frame: the Moon's own position plus a radius PARK_R out in the same
   plane (MOON_U/MOON_V), sweeping at the circular rate PARK_N. P0_PARK is the single phase
   knob that lets the LM rendezvous with it on one lap instead of waiting a lunar day. */
export const PARK_ALT = 110, PARK_R = RM + PARK_ALT;
export const PARK_N = Math.sqrt(MU_M / PARK_R ** 3);       // rad/s, circular — one lap every ~1 h 59 min
export const P0_PARK = 0;
export function csmParkPos(t, out = new THREE.Vector3()) {
  moonPos(t, out);
  const a = P0_PARK + PARK_N * t;
  return out.addScaledVector(MOON_U, PARK_R * Math.cos(a)).addScaledVector(MOON_V, PARK_R * Math.sin(a));
}
/* d/dt of csmParkPos: the parked CSM's velocity, Moon-relative term plus the Moon's own travel.
   The docking rule compares it against the LM's: closing faster than ~50 m/s is not docking. */
export function csmParkVel(t, out = new THREE.Vector3()) {
  moonVel(t, out);
  const a = P0_PARK + PARK_N * t;
  return out.addScaledVector(MOON_U, -PARK_R * PARK_N * Math.sin(a)).addScaledVector(MOON_V, PARK_R * PARK_N * Math.cos(a));
}

export const VS = 0.0014;                 // vehicle visual scale: 75 build units → ~105 m, Saturn-V sized
export const PAD_SCALE = VS;
/* The state point on the pad: 41 u above the datum — the deck's top is z 1.0 (js/pad.js's height
   table) and the vehicle's centre rests 40 u above the deck (about half its height). The 4 + 37
   grouping below is the CERTIFIED arithmetic, kept verbatim on purpose: regrouping it to 41·VS
   changes the float's last bit and moves the recorded retro loss from 1,264 to 1,274 m/s. Contact
   is js/physics.js surfaceAlt(), not this. */
export const PAD_POS = PAD_UP.clone().multiplyScalar(RE + 4 * PAD_SCALE + 37 * VS);
export const PAD_ANGULAR = new THREE.Vector3().crossVectors(SPIN_AXIS, PAD_POS).multiplyScalar(EARTH_SPIN); // pad's inertial velocity

/* atmosphere: exponential density with an 8.5 km scale height. CD_AREA is the full stack's drag
   area nose-on below Mach 0.8; js/aero.js builds the Mach rise, angle of attack and lift on it. */
export const ATMO_H = 8.5, RHO0 = 1.225, CD_AREA = 28;   // kg/m³, m²
/* Time warp steps. 0 is paused and 0.25 is slow motion; WARP_ONE is where a mission starts.
   DTPHYS is the one step the flight is integrated at. js/main.js banks frame time × warp and spends
   it in whole DTPHYS steps (at most 20,000 a frame), so warp — x0.25 included — changes how MANY steps
   a frame takes, never their size, and the picture between two steps is interpolated. The one
   exception is a cold vehicle held down on the pad, where a step is an exact rotation with the
   planet at any size: there the frame is a single step, which is what makes x10000 affordable. */
export const DTPHYS = 0.1, WARPS = [0, 0.25, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000, 10000, 100000];   // the top two are for the pad and for open space: physics.js warpCap
export const WARP_ONE = WARPS.indexOf(1);

/* SAS pitch program. A real launch vehicle does not chase "prograde" off the pad: it
   holds the local vertical, then sweeps the nose toward the launch-plane east direction
   (the plane that contains the Moon's orbit), then trims to the inertial velocity.
   Verified with the stack below: a 151 x 760 km parking orbit at 7.37 km/s, and 7.2 t of CSM
   propellant left on the Moon. The pitch-over here reaches 66 degrees rather than horizontal; a
   steeper table (t0 60, ramp 200, max pi/2, --turn=steep in the tool) also completes the mission and
   lands with 7.7 t spare for 16,216 m/s instead of 16,274, so the exact shape is not what makes the
   mission fly - the propellant load is. MOON_PHASE0 is solved for whichever table is in here
   (4.9187044 for this one, 4.9463355 for the steep one), so changing one without re-running
   tools/mission-sim.mjs mis-aims the translunar injection by tens of thousands of km. */
export const TURN = { t0: 55, ramp: 190, max: 1.15 };

/* Translunar ignition cue: how far the Moon leads the ship along the orbit (rad) when the certified
   flight lights its 817 s injection burn at 245 km — measured by tools/mission-sim.mjs (ev.tliIgn).
   A cue, not a solution: it puts a hand-flown burn in the right half-hour, and the lunar-aim readout
   and a trim burn do the rest. */
export const TLI_LEAD = 2.7742;
export const LAND_SAFE = 0.032;          // km/s — 32 m/s touchdown limit
export const SAFE_EARTH = 0.012;         // km/s — 12 m/s: a splashdown under parachutes (three good mains give ~8)

export const SKY_DAY = new THREE.Color(0x79b1de), SKY_NULL = new THREE.Color(0x04060b);

/* stage specs: dry/fuel in tonnes, thrust in kN, isp in seconds.
   Verified by tools/mission-sim.mjs, which flies the whole round trip through this file's own
   physics and the controls a player has: ideal staged budget 20,192 m/s (2,129 + 6,423 + 6,810 +
   2,117 + 2,714) against the 15,142 m/s it used to take just to reach lunar orbit (1.33x — the
   extra is the landing, the ascent from the Moon, TEI and the ride home). Full breakdown in
   docs/reference/mission-design.md.
   What the sizing is actually doing:
     - pad thrust-to-weight 1.29 g at 4,898 t ignition. Drag is never the problem
       (mission-math.py section 8 puts it at <= 174 m/s for CD_AREA 28 with the drag rise;
       ~24 m/s measured). The one structural load is the lateral limit in physics.js, which the
       SAS ascent stays far under.
     - stage 2 over 0.95 g at ignition (1.08 g here) so the vehicle is still accelerating when it
       takes over from stage 1.
     - the CSM engine is the mission engine: 650 kN is 0.18 g on Earth and 1.06 g_moon at the
       378 t LOI mass, so capture is flown at full throttle from periselene and the throttle
       closes on the cutoff, not on the tank.
     - the LM descent engine at 380 kN is 4.7 g_moon at the 50 t PDI mass and hovers at ~20 %
       throttle. That is survivable only because the descent guidance commands a velocity
       envelope bounded by altitude instead of trying to hover. Throttle granularity, not thrust
       level, is what limits a soft landing. The ascent engine at 180 kN lifts its 19 t off the
       surface at 5.8 g_moon — Apollo's was 1.6 g — because at 120 kN the spiral to orbit spends
       too much propellant fighting gravity: measured, it died 2.9 km short of the parked CSM
       with an empty tank. The spiral is fuel, not velocity.
   The 2,400/700/400 t stack this replaced had 16,303 m/s of ideal budget (1.08x) and still failed:
   it reached lunar orbit, then ran the tank dry on the descent and hit the surface at 1,264 m/s.
   Margin on paper is not margin; the descent has to be flown. */
export const SPECS = [
  { name: 'S-1 SATURN I', dry: 130, fuel: 2500, thrust: 62000, isp: 304 },
  { name: 'S-2 SATURN II', dry: 90, fuel: 1800, thrust: 24000, isp: 415 },
  { name: 'CSM ENGINE', dry: 18, fuel: 300, thrust: 650, isp: 440 },
  { name: 'LM DESCENT', dry: 5, fuel: 26, thrust: 380, isp: 380 },
  { name: 'LM ASCENT', dry: 4, fuel: 15, thrust: 180, isp: 380 },
];
export const CAPSULE_MASS = 10;
