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
   coast-start state the game's scheme reaches 346 km at 0.1 s substeps and an impact 475 km under
   the surface at 1 s steps, so this number is only valid for the step it was solved at. The tool
   aims at AIM_PERI = 350 km, the middle of the band its autopilot lands from.

   Measured sensitivity near the window (shipped vehicle, game's own step):
     phase -3e-3    rad -> periselene 745 km, touchdown 2.8 m/s, 6.6 t spare
     phase -1e-3    rad -> periselene 477 km, touchdown 2.8 m/s, 7.0 t spare
     phase 4.9187044    -> periselene 346 km, touchdown 3.3 m/s, 7.2 t spare
     phase +1e-3    rad -> periselene 218 km, touchdown 4.1 m/s, 7.4 t spare
     phase +1.75e-3 rad -> periselene 123 km, touchdown 4.9 m/s, 7.6 t spare
     phase +2e-3    rad -> periselene  91 km, LOST at 71 m/s, 0.4 t left
   i.e. ~130 km of periselene per 1e-3 rad (376 s of lunar motion at MOON_RATE), a gentle slope on
   the early side and a cliff on the late one, with the window 1.75e-3 rad — eleven minutes — from
   the last late flight that lands. js/targeting.js turns that into a HUD readout, so the aim is
   no longer invisible; the corridor it paints green (140-600 km) is inside the landed band.
   Waiting on the pad and warping advances the Moon, so any other start time can still reach one. */
export const MOON_PHASE0 = 4.9187044;                      // rad — 281.82° along the lunar orbit
let moonPhase = MOON_PHASE0;
export const getMoonPhase = () => moonPhase;
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

export const VS = 0.0014;                 // vehicle visual scale: 75 build units → ~105 m, Saturn-V sized
export const PAD_SCALE = VS;
export const RHALF = 37 * VS;             // vehicle centre above the pad surface (~ half its height); contact is physics.js surfaceAlt()
export const PAD_POS = PAD_UP.clone().multiplyScalar(RE + 4 * PAD_SCALE + 37 * VS);
export const PAD_ANGULAR = new THREE.Vector3().crossVectors(SPIN_AXIS, PAD_POS).multiplyScalar(EARTH_SPIN); // pad's inertial velocity

/* atmosphere: exponential density with an 8.5 km scale height. CD_AREA is the full stack's drag
   area nose-on below Mach 0.8; js/aero.js builds the Mach rise, angle of attack and lift on it. */
export const ATMO_H = 8.5, RHO0 = 1.225, CD_AREA = 28;   // kg/m³, m²
/* Time warp steps. 0 is paused and 0.25 is slow motion; WARP_ONE is where a mission starts. Warp
   multiplies the NUMBER of 0.1 s substeps, never their size; below x1 the substep is shorter. */
export const DTPHYS = 0.1, WARPS = [0, 0.25, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000];
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

export const LAND_SAFE = 0.032;          // km/s — 32 m/s touchdown limit
export const SAFE_EARTH = 0.012;         // km/s — 12 m/s: a splashdown under parachutes (three good mains give ~8)

export const SKY_DAY = new THREE.Color(0x79b1de), SKY_NULL = new THREE.Color(0x04060b);

/* stage specs: dry/fuel in tonnes, thrust in kN, isp in seconds.
   Verified by tools/mission-sim.mjs, which flies the whole mission through this file's own physics
   and the controls a player has: ideal staged budget 17,090 m/s against the 15,142 m/s one-way
   requirement (1.13x), 16,274 m/s actually spent, 7.2 t of CSM propellant left after a 3.3 m/s
   touchdown on 3.469 days of mission clock. Full breakdown in docs/reference/mission-design.md.
   What the sizing is actually doing:
     - pad thrust-to-weight 1.37 g. The previous stack's 1.24 g also reaches orbit, so this is
       margin, not a cliff; drag is never the problem (mission-math.py section 8 puts it at
       <= 174 m/s for CD_AREA 28 with the drag rise; 24 m/s measured). The one structural load
       is the lateral limit in physics.js, which the SAS ascent stays 20x under.
     - stage 2 over 0.95 g at ignition (1.09 g here) so the vehicle is still accelerating when it
       takes over from stage 1.
     - stage 3 is deliberately *over*-powered against Apollo's 45 kN descent propulsion system:
       400 kN is 4.2 g_moon at the 59 t LOI mass and 6.9 g_moon at the 36 t landing mass, so
       hovering takes 15% throttle and no setting balances lunar gravity exactly. That is
       survivable only because the descent guidance commands a velocity envelope bounded by altitude
       instead of trying to hover. Throttle granularity, not thrust level, is what limits a soft
       landing.
   The 2,400/700/400 t stack this replaced had 16,303 m/s of ideal budget (1.08x) and still failed:
   it reached lunar orbit, then ran the tank dry on the descent and hit the surface at 1,235 m/s.
   Margin on paper is not margin; the descent has to be flown. */
export const SPECS = [
  { name: 'S-1 SATURN I', dry: 130, fuel: 1800, thrust: 46000, isp: 304 },
  { name: 'S-2 SATURN II', dry: 90, fuel: 1200, thrust: 16000, isp: 415 },
  { name: 'CSM ENGINE', dry: 18, fuel: 185, thrust: 400, isp: 420 },
];
export const CAPSULE_MASS = 10;
