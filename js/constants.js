import * as THREE from 'three';

/* ---------------- world constants (game units: 1 unit = 1 km) ---------------- */
export const RE = 1000, MU_E = 9.81 * RE * RE;            // Earth radius, gravity param
export const MOON = new THREE.Vector3(8485, 0, -8485);   // 135° from the pad: a classic gravity-turn transfer reaches it
export const RM = 273, MU_M = 1.62 * RM * RM, SOI_M = 2100;
export const PAD_UP = new THREE.Vector3(0, 0, 1);
export const VS = 0.013;                    // vehicle visual scale: a slender rocket on a 1000 km planet, KSP-style
export const PAD_SCALE = VS;                // launch complex scales with the vehicle
export const RHALF = 37 * VS + 0.02;        // contact offset from rocket center (~ half vehicle height)
export const PAD_POS = PAD_UP.clone().multiplyScalar(RE + 4 * PAD_SCALE + 37 * VS);   // platform + half rocket
export const ATMO_H = 95, RHO0 = 0.0024, CD_AREA = 30;
export const DTPHYS = 0.02, WARPS = [1, 2, 4, 8];
export const VSCALE = 31.62;      // game-velocity -> displayed m/s (keeps g = 9.81 believable)
export const TSCALE = 31.62;      // sim-seconds -> displayed mission-elapsed-seconds
export const LAND_SAFE_M = 32 / VSCALE;      // landing speed limits in game units
export const SAFE_EARTH = 0.6;

export const SPECS = [
  { name: 'S-1 SOLID BOOSTER', dry: 12, fuel: 48, thrust: 2900, isp: 240 },
  { name: 'S-2 UPPER',   dry: 6,  fuel: 45, thrust: 1400, isp: 300 },
  { name: 'CSM ENGINE',  dry: 4,  fuel: 40, thrust: 380,  isp: 300 },
];
export const CAPSULE_MASS = 5;

/* KSP-style sky: blue with haze near the ground, fading to black space as you climb */
export const SKY_DAY = new THREE.Color(0x79b1de), SKY_NULL = new THREE.Color(0x04060b);
