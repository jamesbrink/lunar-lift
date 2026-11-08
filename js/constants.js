import * as THREE from 'three';

/* ---------------- real-world constants, all distances in km, time in seconds ----------------
   Gravity is GM/r^2 in km/s^2. Masses are tonnes, thrust is kN, so thrust/mass is m/s^2. */
export const RE = 6371, MU_E = 398600.4418;              // Earth radius, GM (km³/s²)
export const RM = 1737.4, MU_M = 4904.8695, SOI_M = 66200;  // Moon radius, GM, sphere of influence (km)
export const MOON_DIST = 384400;
export const MOON_RATE = 2.6617e-6;                      // rad/s — 27.32 d sidereal period
export const EARTH_SPIN = 7.292115e-5;                   // rad/s

/* Launch site: LC-39, Cape Canaveral. Fixed forever in inertial space at t = 0,
   and the pad mesh rides the rotating planet, so it stays on the same ground. */
export const PAD_LAT = 28.4961, PAD_LON = -80.6194;      // degrees
const LATR = PAD_LAT * Math.PI / 180, LONR = PAD_LON * Math.PI / 180;

/* three's SphereGeometry (x = -R cos(phi) sin(theta), y = R cos(theta), z = R sin(phi) sin(theta),
   u = (lon+180)/360, v = (90-lat)/180) puts north at +Y, so the surface normal at (lat, lon) is: */
export const PAD_UP = new THREE.Vector3(Math.cos(LATR) * Math.cos(LONR), Math.sin(LATR), -Math.cos(LATR) * Math.sin(LONR)).normalize();
export const SPIN_AXIS = new THREE.Vector3(0, 1, 0);
export const PAD_EAST = new THREE.Vector3().crossVectors(SPIN_AXIS, PAD_UP).normalize();

/* The Moon's orbit is tilted 28.5° to the equator and its node is aligned with the launch
   azimuth — the classic launch window, where the translunar trajectory lies in one plane. */
export const MOON_PLANE_N = new THREE.Vector3().crossVectors(PAD_UP, PAD_EAST).normalize();
export const MOON_U = PAD_EAST.clone();
export const MOON_V = new THREE.Vector3().crossVectors(MOON_PLANE_N, MOON_U).normalize();
export const MOON_PHASE = 1.7595;                        // Moon ~101° along its orbit at MET 0: launch window

export function moonPos(t, out = new THREE.Vector3()) {
  const a = MOON_PHASE + MOON_RATE * t;
  return out.copy(MOON_U).multiplyScalar(Math.cos(a)).addScaledVector(MOON_V, Math.sin(a)).multiplyScalar(MOON_DIST);
}

export const VS = 0.0014;                 // vehicle visual scale: 75 build units → ~105 m, Saturn-V sized
export const PAD_SCALE = VS;
export const RHALF = 37 * VS;             // contact offset from the vehicle centre (~ half its height)
export const PAD_POS = PAD_UP.clone().multiplyScalar(RE + 4 * PAD_SCALE + 37 * VS);
export const PAD_ANGULAR = new THREE.Vector3().crossVectors(SPIN_AXIS, PAD_POS).multiplyScalar(EARTH_SPIN); // pad's inertial velocity

/* atmosphere: exponential density with an 8.5 km scale height */
export const ATMO_H = 8.5, RHO0 = 1.225, CD_AREA = 28;   // kg/m³, m²
export const DTPHYS = 0.1, WARPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000];

export const LAND_SAFE = 0.032;          // km/s — 32 m/s touchdown limit
export const SAFE_EARTH = 0.12;          // km/s — splashdown is survivable below this

export const SKY_DAY = new THREE.Color(0x79b1de), SKY_NULL = new THREE.Color(0x04060b);

/* stage specs: dry/fuel in tonnes, thrust in kN, isp in seconds */
export const SPECS = [
  { name: 'S-1 SATURN I', dry: 130, fuel: 2400, thrust: 46000, isp: 263 },
  { name: 'S-2 SATURN II', dry: 120, fuel: 700, thrust: 12000, isp: 340 },
  { name: 'CSM ENGINE', dry: 20, fuel: 400, thrust: 3000, isp: 420 },
];
export const CAPSULE_MASS = 10;
