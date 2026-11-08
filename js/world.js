import * as THREE from 'three';
import { RE, RM, MOON, PAD_UP, PAD_SCALE, PAD_POS, SKY_DAY, SKY_NULL } from './constants.js';
import { earthTex, cloudTex, cirrusTex, moonTex, glowTex } from './textures.js';

let scene = null, earth = null, clouds = null, cirrus = null, atmo = null, moon = null;
let sun = null, sunTarget = null, flare = null;
const _sky = new THREE.Color();
const SUN_DIR = new THREE.Vector3(-0.3, -0.85, 0.55).normalize();   // from the pad side the chase camera sees
let _skyMix = 1;

/* builds everything that is not the vehicle: sun with a vehicle-tracking shadow camera, bodies, starfield, launch pad */
export function initWorld(target) {
  scene = target;

  /* ---- sun: one shadow-casting light that follows the vehicle, pad liftoff to moon landing ---- */
  sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -140; sc.right = sc.top = 140; sc.near = 1; sc.far = 3000;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0005;     // km-scale depths: keeps the cloud shell from self-shadow acne
  sun.shadow.normalBias = 0.12;  // low enough to keep pad-structure shadows attached to the structures
  sunTarget = new THREE.Object3D();
  sun.target = sunTarget;
  sun.position.copy(PAD_POS).addScaledVector(SUN_DIR, 1500);
  sunTarget.position.copy(PAD_POS);
  sunTarget.updateMatrixWorld();
  scene.add(sun, sunTarget, new THREE.AmbientLight(0x2a3242, 1.1));

  const earthMap = earthTex(), cloudMap = cloudTex(), cirrusMap = cirrusTex(), moonMap = moonTex(), glowMap = glowTex();

  /* ---- celestial bodies ---- */
  earth = new THREE.Mesh(new THREE.SphereGeometry(RE, 192, 128),
    new THREE.MeshStandardMaterial({ map: earthMap, roughness: .82, metalness: .02 }));
  earth.receiveShadow = true;
  scene.add(earth);
  /* cloud decks are opaque density maps (luminance -> the alphaMap channel); alphaTest carves the
     holes, so whichever deck slices cross the sun's frustum near the vehicle throw moving shadows down */
  clouds = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.006, 128, 80),
    new THREE.MeshStandardMaterial({ map: cloudMap, alphaMap: cloudMap, alphaTest: .55, transparent: true, opacity: .9, depthWrite: false }));
  clouds.castShadow = true;
  scene.add(clouds);
  cirrus = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.02, 128, 80),
    new THREE.MeshStandardMaterial({ map: cirrusMap, alphaMap: cirrusMap, alphaTest: .3, transparent: true, opacity: .45, depthWrite: false }));
  cirrus.castShadow = true;
  scene.add(cirrus);
  atmo = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.035, 128, 80), new THREE.ShaderMaterial({
    uniforms: { c: { value: new THREE.Color(0x63b7ff) } },
    vertexShader: `varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `uniform vec3 c; varying vec3 vN;
      void main(){ float f = pow(max(dot(vN, vec3(0.,0.,1.)), 0.), 2.2); gl_FragColor = vec4(c, f * .8); }`,
    side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(atmo);
  moon = new THREE.Mesh(new THREE.SphereGeometry(RM, 64, 48),
    new THREE.MeshStandardMaterial({ map: moonMap, roughness: .95, metalness: 0 }));
  moon.position.copy(MOON); moon.receiveShadow = true; scene.add(moon);

  /* ---- starfield + sun flare ---- */
  {
    const N = 4000, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(150000);
      pos.set([v.x, v.y, v.z], i * 3);
      const b = .35 + Math.pow(Math.random(), 3) * .65;
      const warm = Math.random() < .18;
      col.set(warm ? [b, b * .8, b * .6] : [b * .9, b * .95, b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ size: 1.5, vertexColors: true, sizeAttenuation: false })));
    flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xffe9c4, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    flare.position.copy(SUN_DIR).multiplyScalar(33000); flare.scale.setScalar(9000); scene.add(flare);
  }

  /* ---- launch pad (north pole of the spin axis = +Z).
     Build-units; the crawler deck keeps the platform top at z = 4, the anchor physics expects,
     and the group still scales by PAD_SCALE. 37 meshes + 4 lamp sprites. ---- */
  {
    const pad = new THREE.Group();
    pad.scale.setScalar(PAD_SCALE);
    const concrete = new THREE.MeshStandardMaterial({ color: 0x8d949e, roughness: .9 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: .4, metalness: .7 });
    const blast = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 1, metalness: .05 });   // scorched blast surfaces
    const box = (w, d, h, mat, x, y, z, cast = false, recv = false) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), mat);
      m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = recv; pad.add(m); return m;
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
    box(21, 17, 4.4, blast, 0, 0, .8, false, true);
    const d1 = box(18, 7, 1.2, blast, 0, -3.5, 2.4, true, true); d1.rotation.x = .75;
    const d2 = box(18, 7, 1.2, blast, 0, 3.5, 2.4, true, true); d2.rotation.x = -.75;
    const d3 = box(15, 7, 1.2, blast, -7, 0, 2.4, true, true); d3.rotation.y = .75;
    const d4 = box(15, 7, 1.2, blast, 7, 0, 2.4, true, true); d4.rotation.y = -.75;
    // strongback tower (legs to z 56) with a swing arm reaching for the rocket at mid-vehicle height
    box(1.8, 1.8, 52, steel, -16, -10, 30, true);
    box(1.8, 1.8, 52, steel, -16, -2, 30, true);
    for (const bz of [14, 27, 40]) box(1.8, 8, 1.2, steel, -16, -6, bz, true);
    const swing = box(12, 1.6, 1.6, steel, -9, -2, 34, true); swing.rotation.z = .05;
    // service tower (legs to z 60) with a crew access arm at capsule height
    box(1.8, 1.8, 56, steel, 16, -10, 32, true);
    box(1.8, 1.8, 56, steel, 16, -2, 32, true);
    for (const bz of [18, 44]) box(1.8, 8, 1.2, steel, 16, -6, bz, true);
    const crewArm = box(11, 1.5, 1.5, steel, 10, -2, 56, true); crewArm.rotation.z = -.04;
    // two thin lightning masts; tips clear the 74-unit vehicle
    for (const mx of [-30, 30]) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(.35, .6, 88, 8), steel);
      mast.position.set(mx, -26, 48); mast.rotation.x = Math.PI / 2; mast.castShadow = true; pad.add(mast);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(.8, 10, 8), steel);
      tip.position.set(mx, -26, 92.4); tip.castShadow = true; pad.add(tip);
    }
    // clustered LOX/LH2 tanks on a pad with a manifold header and a feed line toward the deck
    box(34, 28, 2, concrete, 50, 36, 3, false, true);
    for (const [tx, ty] of [[40, 28], [58, 30], [42, 44], [60, 46]]) {
      const tank = new THREE.Mesh(new THREE.SphereGeometry(6, 24, 16), steel);
      tank.position.set(tx, ty, 10); tank.castShadow = true; tank.receiveShadow = true; pad.add(tank);
    }
    const manifold = new THREE.Mesh(new THREE.CylinderGeometry(.9, .9, 26, 10), steel);
    manifold.position.set(50, 36, 7); manifold.rotation.x = Math.PI / 2; manifold.castShadow = true; pad.add(manifold);
    box(22, 1.2, 1.2, steel, 25, 36, 6.4, true);
    // floodlight rig: mast + cross-truss carrying four glow lamps
    box(1.4, 1.4, 22, steel, 0, -34, 15, true);
    box(30, 1.4, 1.4, steel, 0, -34, 26, true);
    for (let i = 0; i < 4; i++) {
      const l = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xfff2c9, transparent: true, opacity: .55, blending: THREE.AdditiveBlending, depthWrite: false }));
      l.position.set(-13.5 + i * 9, -34, 23.5); l.scale.setScalar(7); pad.add(l);
    }
    // banner stripe painted along the outboard crawler skirt
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(64, 2.8), blast);
    banner.position.set(0, -27.6, 1.5); banner.rotation.x = Math.PI / 2; pad.add(banner);
    scene.add(pad);
    pad.position.copy(PAD_UP).multiplyScalar(RE);   // deck top at z=4 build units above the surface = physics anchor
  }
}

/* main.js calls this every frame: the shadow frustum travels with the vehicle, so the same sun
   shades the pad at liftoff and the lander on the moon */
export function updateSunShadow(pos) {
  sun.position.copy(pos).addScaledVector(SUN_DIR, 1500);
  sun.target.position.copy(pos);
  sun.target.updateMatrixWorld();
  flare.position.copy(pos).addScaledVector(SUN_DIR, 33000);   // flare stays on the sun's bearing
}

export function spinBodies(simDt) {
  earth.rotation.z += 0.0012 * simDt;
  clouds.rotation.z += 0.002 * simDt;    // cloud decks drift faster than the surface; cirrus fastest
  cirrus.rotation.z += 0.0032 * simDt;
  moon.rotation.y += 0.0002 * simDt;
}

const ZENITH = new THREE.Color(0x1e5f9f), HORIZON = new THREE.Color(0xb2cfe2);

export function updateSky(pos) {
  _skyMix = Math.exp(-Math.max(0, pos.length() - RE) / 240);
  if (_skyMix < 0.5) _sky.copy(SKY_NULL).lerp(SKY_DAY, _skyMix * 2);              // space -> day
  else if (_skyMix < 0.8) _sky.copy(SKY_DAY).lerp(ZENITH, (_skyMix - 0.5) / 0.3); // descent -> deep zenith blue
  else _sky.copy(ZENITH).lerp(HORIZON, (_skyMix - 0.8) / 0.2 * 0.55);             // grounded -> pale horizon tint
  scene.background.copy(_sky); scene.fog.color.copy(_sky);
  scene.fog.density = 0.0024 * _skyMix * _skyMix * (0.8 + 0.4 * _skyMix);
}

export function getSkyMix() { return _skyMix; }
