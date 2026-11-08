import * as THREE from 'three';
import {
  RE, RM, MOON_RATE, EARTH_SPIN, PAD_UP, PAD_EAST, PAD_SCALE, PAD_POS, SKY_DAY, SKY_NULL, moonPos
} from './constants.js';
import { earthTex, earthNormalTex, earthSpecTex, cloudTex, cirrusTex, moonTex, glowTex } from './textures.js';

/* distances are km, angles rad — everything here lives at real planetary scale */
const SUN_RANGE = 1500;            // km the directional light sits off the tracked vehicle
const SUN_DIST = 1000000;          // km — the flare sprite rides a million km out on the sun's bearing
const SUN_ANG = 0.009;             // rad: the real sun is 0.53° wide, so the flare disk is 0.9% of its range
const STAR_R = 2000000;            // km — the starfield sits well outside the moon's orbit
const SHADOW_MAX = 300;            // km half-extent of the vehicle-tracking shadow box
const SHADOW_MIN = 8;              // km — tight enough for ~100 m pad structures to resolve
const CUMULUS_ALT = 2, CIRRUS_ALT = 9;          // km above the surface
const ATMO_SHELL = 1.01;          // atmosphere glow shell: RE * 1.01

/* Sun bearing, fixed in inertial space: ~37° above the pad's horizon at MET 0, off to the east, so
   the pad, the rocket and the towers are lit at liftoff and the planet turns under the light. */
const PAD_NORTH = new THREE.Vector3().crossVectors(PAD_UP, PAD_EAST).normalize();
const SUN_ELEV = 0.645;                                    // rad, 37 deg
const SUN_DIR = PAD_UP.clone().multiplyScalar(Math.sin(SUN_ELEV))
  .addScaledVector(PAD_EAST, Math.cos(SUN_ELEV) * 0.85)
  .addScaledVector(PAD_NORTH, Math.cos(SUN_ELEV) * 0.4).normalize();

let scene = null, earth = null, pad = null, cumulus = null, cirrus = null, atmo = null, moon = null;
let sun = null, sunTarget = null, flare = null;
let spin = 0, cloudSpin = 0, cirrusSpin = 0, simT = 0;
const _sky = new THREE.Color();
const _moon = new THREE.Vector3();
let _skyMix = 1;

/* builds everything that is not the vehicle: sun with a vehicle-tracking shadow camera, bodies,
   cloud decks, atmosphere shell, starfield and the launch pad welded to the rotating planet. */
export function initWorld(target) {
  scene = target;

  /* ---- sun: one shadow-casting light whose frustum follows the vehicle, pad liftoff to moon landing ---- */
  sun = new THREE.DirectionalLight(0xfff3e0, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  setShadowBox(SHADOW_MAX);
  sun.shadow.bias = -0.0005;     // km-scale depths: keeps the cloud shells from self-shadow acne
  sun.shadow.normalBias = 0.12;  // low enough to keep pad-structure shadows attached to the structures
  sunTarget = new THREE.Object3D();
  sun.target = sunTarget;
  moonPos(0, _moon);
  sun.position.copy(PAD_POS).addScaledVector(SUN_DIR, SUN_RANGE);
  sunTarget.position.copy(PAD_POS);
  sunTarget.updateMatrixWorld();
  scene.add(sun, sunTarget, new THREE.AmbientLight(0x2a3242, 1.1));

  const earthMap = earthTex(), normalMap = earthNormalTex(), specMap = earthSpecTex(),
        cloudMap = cloudTex(), cirrusMap = cirrusTex(), moonMap = moonTex(), glowMap = glowTex();

  /* ---- earth: real blue-marble map, tangent-space normals, specular oceans read as metalness ---- */
  earth = new THREE.Mesh(new THREE.SphereGeometry(RE, 256, 128),
    new THREE.MeshStandardMaterial({
      map: earthMap, normalMap, metalnessMap: specMap,
      roughness: 0.65, metalness: 0.3, normalScale: new THREE.Vector2(0.6, 0.6)
    }));
  earth.receiveShadow = true;
  /* Planet-scale bodies are exempt from the fog: FogExp2 is measured from the camera, so at
     0.002/km a system-view camera 20 000 km out would erase the planet entirely. The haze the
     fog models is the near-field air around the vehicle; the day sky itself comes from
     scene.background and the limb shell below. */
  earth.material.fog = false;
  scene.add(earth);

  /* ---- two cloud decks. Both are luminance-is-density maps bound to map + alphaMap, so alphaTest
     carves the holes and whichever deck crosses the sun's frustum throws moving shadows down. ---- */
  cumulus = new THREE.Mesh(new THREE.SphereGeometry(RE + CUMULUS_ALT, 256, 128),
    new THREE.MeshStandardMaterial({
      map: cloudMap, alphaMap: cloudMap, alphaTest: 0.5, transparent: true,
      opacity: 0.92, roughness: 0.9, metalness: 0, depthWrite: false
    }));
  cumulus.castShadow = true;
  cumulus.material.fog = false;   // same reason as the ground: a deck 2 km up is a planet-scale body
  scene.add(cumulus);

  cirrus = new THREE.Mesh(new THREE.SphereGeometry(RE + CIRRUS_ALT, 256, 128),
    new THREE.MeshStandardMaterial({
      map: cirrusMap, alphaMap: cirrusMap, alphaTest: 0.32, transparent: true,
      opacity: 0.45, roughness: 1, metalness: 0, depthWrite: false
    }));
  cirrus.castShadow = true;
  cirrus.material.fog = false;
  scene.add(cirrus);

  /* ---- atmosphere: back-side limb shell. Intensity comes from the optical depth still in front of
     each fragment — long tangential sight lines glow, the thin overhead shell from the ground does not. ---- */
  atmo = new THREE.Mesh(new THREE.SphereGeometry(RE * ATMO_SHELL, 256, 128), new THREE.ShaderMaterial({
    uniforms: {
      glow: { value: new THREE.Color(0x63b7ff) },
      shellR: { value: RE * ATMO_SHELL },
      sunDir: { value: SUN_DIR.clone() }
    },
    vertexShader: `
      varying vec3 vP; varying vec3 vN;
      void main() {
        vP = (modelMatrix * vec4(position, 1.0)).xyz;
        vN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 glow; uniform float shellR; uniform vec3 sunDir;
      varying vec3 vP; varying vec3 vN;
      void main() {
        vec3 n = normalize(vN);
        vec3 eye = normalize(cameraPosition - vP);
        float grazing = 1.0 - abs(dot(n, eye));                 // 0 overhead, 1 at the limb
        // intersect the sight line with the shell and take the segment still ahead of this fragment
        vec3 d = normalize(vP - cameraPosition);
        float a = dot(d, cameraPosition);
        float b = dot(cameraPosition, cameraPosition) - shellR * shellR;
        float disc = max(a * a - b, 0.0);
        float t1 = -a - sqrt(disc), t2 = -a + sqrt(disc);
        float path = max(t2 - max(t1, 0.0), 0.0);                // km of air in front of this point
        float depth = clamp(path / 400.0, 0.0, 1.0);
        float day = clamp(dot(n, sunDir) * 0.5 + 0.5, 0.0, 1.0);
        float rim = pow(grazing, 2.4) * depth * (0.25 + 0.75 * day);
        gl_FragColor = vec4(glow, clamp(rim, 0.0, 1.0) * 0.8);
      }`,
    side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
  }));
  scene.add(atmo);

  moon = new THREE.Mesh(new THREE.SphereGeometry(RM, 128, 96),
    new THREE.MeshStandardMaterial({ map: moonMap, roughness: 0.95, metalness: 0 }));
  moon.material.fog = false;      // ground haze must not eat the moon or the stars
  moon.position.copy(_moon);
  moon.castShadow = true; moon.receiveShadow = true;
  scene.add(moon);

  /* ---- starfield, well outside the moon's orbit ---- */
  {
    const N = 6000, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(STAR_R);
      pos.set([v.x, v.y, v.z], i * 3);
      const b = 0.35 + Math.pow(Math.random(), 3) * 0.65;
      const warm = Math.random() < 0.18;
      col.set(warm ? [b, b * 0.8, b * 0.6] : [b * 0.9, b * 0.95, b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    /* fog stays ON here on purpose: at the pad the fog factor over 2 000 000 km is unity, so the
       stars vanish in daylight, and as the fog thins to nothing in orbit they come back. */
    scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ size: 2, vertexColors: true, sizeAttenuation: false })));

    flare = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowMap, color: 0xffe9c4, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false
    }));
    flare.position.copy(PAD_POS).addScaledVector(SUN_DIR, SUN_DIST);
    flare.scale.setScalar(SUN_DIST * SUN_ANG);            // ~0.53 deg disk, like the real sun
    scene.add(flare);
  }

  /* ---- launch pad: a child of the Earth mesh, so it rides the spin and stays over the same ground.
     Local frame: +Z = PAD_UP (radial), +X = PAD_EAST, +Y = north. Build units; the crawler deck
     keeps the platform top at z = 4, the anchor physics expects, and the group scales by PAD_SCALE. ---- */
  pad = buildPad(glowMap);
  pad.position.copy(PAD_UP).multiplyScalar(RE);
  const north = new THREE.Vector3().crossVectors(PAD_UP, PAD_EAST).normalize();
  pad.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(PAD_EAST, north, PAD_UP));
  earth.add(pad);

  scene.fog = new THREE.FogExp2(SKY_DAY.getHex(), 0.002);
  updateSky(PAD_POS);
  return scene;
}

function setShadowBox(extent) {
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -extent;
  sc.right = sc.top = extent;
  sc.near = 1; sc.far = 5000;
  sc.updateProjectionMatrix();
}

/* the shadow box tracks the vehicle: it never exceeds the ±300 km system view, but tightens to
   ±8 km while the vehicle is on the ground so the towers, the rocket and the lander resolve */
function updateShadowBox(pos) {
  moonPos(simT, _moon);
  const local = Math.min(pos.length() - RE, pos.distanceTo(_moon) - RM);
  setShadowBox(THREE.MathUtils.clamp(SHADOW_MIN + local * 0.6, SHADOW_MIN, SHADOW_MAX));
}

/* 37 meshes + 4 lamp sprites, all in build units around the crawler deck */
function buildPad(glowMap) {
  const g = new THREE.Group();
  g.scale.setScalar(PAD_SCALE);
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8d949e, roughness: 0.9 });
  /* The blue-marble map is ~20 km per texel, so at LC-39 the surface under the pad is one dark
     ocean texel. A graded slab of launch-complex ground makes the pad read as land instead of
     open sea, and it is the only thing close enough to the camera to catch the towers' shadows. */
  const ground = new THREE.Mesh(new THREE.CircleGeometry(320, 64),
    new THREE.MeshStandardMaterial({ color: 0x8a8778, roughness: 0.9, metalness: 0.05 }));
  ground.position.set(8, 4, 0.05); ground.receiveShadow = true; g.add(ground);
  const steel = new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.4, metalness: 0.7 });
  const blast = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 1, metalness: 0.05 });   // scorched blast surfaces
  const box = (w, d, h, mat, x, y, z, cast = false, recv = false) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), mat);
    m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = recv; g.add(m); return m;
  };

  // crawler platform with track skirts; deck top z = 3
  box(64, 46, 3, concrete, 0, 0, 1.5, false, true);
  box(64, 9, 3.6, concrete, 0, -23, 1.2, false, true);
  box(64, 9, 3.6, concrete, 0, 23, 1.2, false, true);
  // reinforced launch deck: four slabs ring the flame-trench opening; tops z = 4 (physics anchor)
  box(44, 12, 1, concrete, 0, -14, 3.5, false, true);
  box(44, 12, 1, concrete, 0, 14, 3.5, false, true);
  box(12, 16, 1, concrete, -16, 0, 3.5, false, true);
  box(12, 16, 1, concrete, 16, 0, 3.5, false, true);
  // flame trench below the opening + four canted exhaust deflectors
  box(21, 17, 4.4, blast, 0, 0, 0.8, false, true);
  const d1 = box(18, 7, 1.2, blast, 0, -3.5, 2.4, true, true); d1.rotation.x = 0.75;
  const d2 = box(18, 7, 1.2, blast, 0, 3.5, 2.4, true, true); d2.rotation.x = -0.75;
  const d3 = box(15, 7, 1.2, blast, -7, 0, 2.4, true, true); d3.rotation.y = 0.75;
  const d4 = box(15, 7, 1.2, blast, 7, 0, 2.4, true, true); d4.rotation.y = -0.75;
  // strongback tower (legs to z 56) with a swing arm reaching for the rocket at mid-vehicle height
  box(1.8, 1.8, 52, steel, -16, -10, 30, true);
  box(1.8, 1.8, 52, steel, -16, -2, 30, true);
  for (const bz of [14, 27, 40]) box(1.8, 8, 1.2, steel, -16, -6, bz, true);
  const swing = box(12, 1.6, 1.6, steel, -9, -2, 34, true); swing.rotation.z = 0.05;
  // service tower (legs to z 60) with a crew access arm at capsule height
  box(1.8, 1.8, 56, steel, 16, -10, 32, true);
  box(1.8, 1.8, 56, steel, 16, -2, 32, true);
  for (const bz of [18, 44]) box(1.8, 8, 1.2, steel, 16, -6, bz, true);
  const crewArm = box(11, 1.5, 1.5, steel, 10, -2, 56, true); crewArm.rotation.z = -0.04;
  // two thin lightning masts; tips clear the 74-unit vehicle
  for (const mx of [-30, 30]) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, 88, 8), steel);
    mast.position.set(mx, -26, 48); mast.rotation.x = Math.PI / 2; mast.castShadow = true; g.add(mast);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), steel);
    tip.position.set(mx, -26, 92.4); tip.castShadow = true; g.add(tip);
  }
  // clustered LOX/LH2 tanks on a pad with a manifold header and a feed line toward the deck
  box(34, 28, 2, concrete, 50, 36, 3, false, true);
  for (const [tx, ty] of [[40, 28], [58, 30], [42, 44], [60, 46]]) {
    const tank = new THREE.Mesh(new THREE.SphereGeometry(6, 24, 16), steel);
    tank.position.set(tx, ty, 10); tank.castShadow = true; tank.receiveShadow = true; g.add(tank);
  }
  const manifold = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 26, 10), steel);
  manifold.position.set(50, 36, 7); manifold.rotation.x = Math.PI / 2; manifold.castShadow = true; g.add(manifold);
  box(22, 1.2, 1.2, steel, 25, 36, 6.4, true);
  // floodlight rig: mast + cross-truss carrying four glow lamps
  box(1.4, 1.4, 22, steel, 0, -34, 15, true);
  box(30, 1.4, 1.4, steel, 0, -34, 26, true);
  for (let i = 0; i < 4; i++) {
    const l = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xfff2c9, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    l.position.set(-13.5 + i * 9, -34, 23.5); l.scale.setScalar(7); g.add(l);
  }
  // banner stripe painted along the outboard crawler skirt
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(64, 2.8), blast);
  banner.position.set(0, -27.6, 1.5); banner.rotation.x = Math.PI / 2; g.add(banner);
  return g;
}

/* main.js calls this every frame: the shadow frustum travels with the vehicle, so the same sun
   shades the pad at liftoff and the lander on the moon */
export function updateSunShadow(pos) {
  sun.position.copy(pos).addScaledVector(SUN_DIR, SUN_RANGE);
  sun.target.position.copy(pos);
  sun.target.updateMatrixWorld();
  flare.position.copy(pos).addScaledVector(SUN_DIR, SUN_DIST);   // flare stays on the sun's bearing
  updateShadowBox(pos);
}

/* the planet and its weather turn; the cloud decks drift a little faster than the ground (real
   superrotation), at rates of the same order as EARTH_SPIN, never orders of magnitude faster */
export function spinBodies(simDt) {
  simT += simDt;
  spin += EARTH_SPIN * simDt;
  cloudSpin += EARTH_SPIN * 1.08 * simDt;
  cirrusSpin += EARTH_SPIN * 1.22 * simDt;
  earth.rotation.y = spin;
  cumulus.rotation.y = cloudSpin;
  cirrus.rotation.y = cirrusSpin;
  moon.rotation.y += MOON_RATE * simDt;
  moonPos(simT, moon.position);
}

const ZENITH = new THREE.Color(0x1e5f9f), HORIZON = new THREE.Color(0xb2cfe2);

/* blue sky -> black space: the mix halves every ~55 km of climb, so the sky is effectively black
   by 200 km. The exponential fog thins on the same clock: 0.002 per km at the pad, nothing up high. */
const SKY_SCALE = 80;            // km — visual atmospheric depth for the sky/fog blend
export function updateSky(pos) {
  const alt = Math.max(0, pos.length() - RE);
  _skyMix = Math.exp(-alt / SKY_SCALE);
  if (_skyMix < 0.5) _sky.copy(SKY_NULL).lerp(SKY_DAY, _skyMix * 2);              // space -> day
  else if (_skyMix < 0.8) _sky.copy(SKY_DAY).lerp(ZENITH, (_skyMix - 0.5) / 0.3); // descent -> deep zenith blue
  else _sky.copy(ZENITH).lerp(HORIZON, (_skyMix - 0.8) / 0.2 * 0.55);             // grounded -> pale horizon tint
  scene.background.copy(_sky);
  scene.fog.color.copy(_sky);
  scene.fog.density = 0.002 * _skyMix * _skyMix;
}

export function getSkyMix() { return _skyMix; }
