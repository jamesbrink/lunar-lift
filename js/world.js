import * as THREE from 'three';
import { RE, RM, MOON, PAD_SCALE, SKY_DAY, SKY_NULL } from './constants.js';
import { earthTex, cloudTex, moonTex, glowTex } from './textures.js';

let scene = null, earth = null, clouds = null, atmo = null, moon = null;
const _sky = new THREE.Color();

/* builds everything that is not the vehicle: lights, bodies, starfield, launch pad */
export function initWorld(target) {
  scene = target;

  const sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
  sun.position.set(-0.3, -0.85, 0.55).normalize().multiplyScalar(60000);   // lights the pad side the chase camera sees
  scene.add(sun, new THREE.AmbientLight(0x2a3242, 1.1));

  const earthMap = earthTex(), cloudMap = cloudTex(), moonMap = moonTex(), glowMap = glowTex();

  /* ---- celestial bodies ---- */
  earth = new THREE.Mesh(new THREE.SphereGeometry(RE, 192, 128),
    new THREE.MeshStandardMaterial({ map: earthMap, roughness: .82, metalness: .02 }));
  scene.add(earth);
  clouds = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.008, 128, 80),
    new THREE.MeshStandardMaterial({ map: cloudMap, transparent: true, opacity: .85, depthWrite: false }));
  scene.add(clouds);
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
  moon.position.copy(MOON); scene.add(moon);

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
    const flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xffe9c4, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    flare.position.copy(sun.position).multiplyScalar(.55); flare.scale.setScalar(9000); scene.add(flare);
  }

  /* ---- launch pad (north pole of the spin axis = +Z) ---- */
  {
    const pad = new THREE.Group();
    pad.scale.setScalar(PAD_SCALE);
    const concrete = new THREE.MeshStandardMaterial({ color: 0x8d949e, roughness: .9 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: .4, metalness: .7 });
    const plat = new THREE.Mesh(new THREE.CylinderGeometry(26, 28, 4, 32), concrete); plat.position.z = 2; pad.add(plat);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(20, .6, 8, 48), steel); ring.position.z = 4.2; pad.add(ring);
    const tower = new THREE.Group();
    for (const side of [0, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 46), steel);
      leg.position.set(side ? 10 : -10, -10, 27); tower.add(leg);
    }
    for (let i = 0; i < 5; i++) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(20, 1.2, 1.2), steel); beam.position.set(0, -10, 10 + i * 9); tower.add(beam);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(9, 1.2, 1.2), steel); arm.position.set(5, -5, 14 + i * 7); tower.add(arm);
    }
    pad.add(tower);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(7, 4), new THREE.MeshStandardMaterial({ color: 0xd94f2b, side: THREE.DoubleSide }));
    flag.position.set(-30, -18, 14); pad.add(flag);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(.4, .4, 16, 8), steel); mast.position.set(-30, -18, 8); mast.rotation.x = Math.PI / 2; pad.add(mast);
    for (let i = 0; i < 4; i++) {
      const l = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xfff2c9, transparent: true, opacity: .55, blending: THREE.AdditiveBlending, depthWrite: false }));
      l.position.set(Math.cos(i * 1.57) * 34, Math.sin(i * 1.57) * 34, 10); l.scale.setScalar(9); pad.add(l);
    }
    const block = new THREE.Mesh(new THREE.BoxGeometry(14, 10, 7), concrete); block.position.set(-70, 40, 3.5); pad.add(block);
    scene.add(pad);
  }
}

export function spinBodies(simDt) {
  earth.rotation.z += 0.0012 * simDt; clouds.rotation.z += 0.0016 * simDt;
  moon.rotation.y += 0.0002 * simDt;
}

export function updateSky(pos) {
  const mix = Math.exp(-Math.max(0, pos.length() - RE) / 240);
  _sky.copy(SKY_NULL).lerp(SKY_DAY, mix * 0.9);
  scene.background.copy(_sky); scene.fog.color.copy(_sky);
  scene.fog.density = 0.003 * mix * mix;
}
