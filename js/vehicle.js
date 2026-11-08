import * as THREE from 'three';
import { SPECS, VS } from './constants.js';
import { glowTex } from './textures.js';

let scene = null;

/* ---------------- rocket ---------------- */
export const rocketGroup = new THREE.Group(); rocketGroup.scale.setScalar(VS);

const matBody = new THREE.MeshStandardMaterial({ color: 0xe8ecf2, roughness: .38, metalness: .5 });
const matDark = new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: .5, metalness: .6 });
const matAccent = new THREE.MeshStandardMaterial({ color: 0xd94f2b, roughness: .5, metalness: .3 });
const matNozzle = new THREE.MeshStandardMaterial({ color: 0x50555c, roughness: .35, metalness: .85 });
const matFlame = new THREE.MeshBasicMaterial({ color: 0xffb45c, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false });

export const stages = SPECS.map(s => ({ ...s, fuel: s.fuel, separated: false, meshes: new THREE.Group(), tailZ: 0, flame: null, glow: null }));

const ZERO_V = new THREE.Vector3();

function cyl(rt, rb, len, z, mat, seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, len, seg), mat);
  m.rotation.x = Math.PI / 2; m.position.z = z; m.castShadow = true; return m;
}

// stage 1: spans z -37.5 .. -3.5
{
  const g = stages[0].meshes;
  g.add(cyl(6, 6, 30, -22.5, matBody));                       // long white booster body, -37.5..-7.5
  g.add(cyl(3.8, 6, 4, -5.5, matDark));                       // black nose-cone skirt at top, -7.5..-3.5
  g.add(cyl(6.28, 6.28, 1, -4, matDark));                     // interstage ring at the -3.5 junction
  g.add(cyl(6.14, 6.14, 3, -16, matAccent));                  // red roll band
  const finShape = new THREE.Shape();                         // swept trapezoidal fin: x = radial, y = axial z
  finShape.moveTo(5.4, -21.5); finShape.lineTo(14.8, -25.8); finShape.lineTo(13.1, -33.6); finShape.lineTo(5.4, -34.8);
  const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: .8, bevelEnabled: false }); finGeo.translate(0, 0, -.4);
  for (let i = 0; i < 4; i++) {                               // 4 big swept tail fins
    const arm = new THREE.Group(); arm.rotation.z = i * Math.PI / 2 + Math.PI / 4;
    const fin = new THREE.Mesh(finGeo, matDark); fin.rotation.x = Math.PI / 2; fin.castShadow = true;
    arm.add(fin); g.add(arm);
  }
  g.add(cyl(1.9, 3.9, 4.5, -39.75, matNozzle));               // large center bell, reaches tailZ -42
  for (let i = 0; i < 4; i++) {                               // cluster of 4 small nozzle bells around it
    const a = i * Math.PI / 2 + Math.PI / 4;
    const bell = cyl(.8, 1.7, 3.4, -39.2, matNozzle, 12);
    bell.position.x = Math.cos(a) * 4.2; bell.position.y = Math.sin(a) * 4.2; g.add(bell);
  }
  stages[0].tailZ = -42;
}
// stage 2: spans z -3.5 .. 18.5
{
  const g = stages[1].meshes;
  g.add(cyl(5, 5, 18.5, 9.25, matBody));                      // white body, 0..18.5
  g.add(cyl(5, 1.7, 3.5, -1.75, matDark));                    // black engine skirt cone at tail, -3.5..0
  g.add(cyl(5.14, 5.14, 2.4, 13, matAccent));                 // red roll band
  g.add(cyl(5.26, 5.26, 1, 17.9, matDark));                   // interstage ring at the 18.5 junction
  g.add(cyl(1.7, 3.2, 4.5, -5.75, matNozzle));                // single large bell, reaches tailZ -8 (shrouded until staging)
  stages[1].tailZ = -8;
}
// stage 3 + capsule: spans z 18.5 .. 37.5  (one vehicle to the Moon)
{
  const g = stages[2].meshes;
  g.add(cyl(4, 4, 9, 23, matBody));                           // cylindrical service module, 18.5..27.5
  g.add(cyl(4.16, 4.16, 1, 19, matDark));                     // interstage ring at the 18.5 junction
  g.add(cyl(4.12, 4.12, 1, 24.5, matAccent));                 // red service-module stripe
  g.add(cyl(1.1, 2.1, 3.5, 16.75, matNozzle));                // service-module engine bell, reaches tailZ 15
  const cm = new THREE.Mesh(new THREE.ConeGeometry(4.15, 5, 24), matBody);  // conical command capsule, base 27.5 tip 32.5
  cm.rotation.x = Math.PI / 2; cm.position.z = 30; cm.castShadow = true; g.add(cm);
  const winGeo = new THREE.BoxGeometry(.5, 1.3, .9);
  for (const wy of [1, -1]) {                                 // small capsule windows set into the cone wall
    const w = new THREE.Mesh(winGeo, matDark); w.position.set(2.85, wy * .95, 29); w.castShadow = true; g.add(w);
  }
  g.add(cyl(.6, .6, .8, 32.6, matDark));                      // launch-escape tower mount at the capsule tip
  g.add(cyl(.18, .18, 4.2, 34.7, matDark));                   // tall thin launch-escape tower, 32.6..36.8
  const lesTip = new THREE.Mesh(new THREE.ConeGeometry(.75, 1, 12), matDark);  // tiny escape-rocket cone tip, top at 37.5
  lesTip.rotation.x = Math.PI / 2; lesTip.position.z = 37.0; lesTip.castShadow = true; g.add(lesTip);
  stages[2].tailZ = 15;
}
stages.forEach(st => {
  const flame = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 14), matFlame);
  flame.rotation.order = 'YXZ'; // gimbal yaw term must rotate the already-pitched plume; see updateBurnVisuals
  flame.rotation.x = -Math.PI / 2; flame.position.z = st.tailZ - 0.6; flame.visible = false; flame.castShadow = false;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: 0xffb060, transparent: true, opacity: .8, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.position.z = st.tailZ; glow.visible = false; glow.castShadow = false;
  st.meshes.add(flame, glow); st.flame = flame; st.glow = glow;
  rocketGroup.add(st.meshes);
});

/* ---------------- particles (plume / explosion) ---------------- */
const NP = 900;
const pPos = new Float32Array(NP * 3), pCol = new Float32Array(NP * 3);
const pVel = new Float32Array(NP * 3), pLife = new Float32Array(NP);
pLife.fill(0);
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
const plume = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.06, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
plume.frustumCulled = false;
let pCursor = 0;

export function spawnParticle(pos, vel, life, color) {
  const i = pCursor = (pCursor + 1) % NP;
  pPos[i * 3] = pos.x; pPos[i * 3 + 1] = pos.y; pPos[i * 3 + 2] = pos.z;
  pVel[i * 3] = vel.x; pVel[i * 3 + 1] = vel.y; pVel[i * 3 + 2] = vel.z;
  pCol[i * 3] = color[0]; pCol[i * 3 + 1] = color[1]; pCol[i * 3 + 2] = color[2];
  pLife[i] = life;
}

export function updateParticles(dt) {
  for (let i = 0; i < NP; i++) {
    if (pLife[i] <= 0) { pCol[i * 3] = pCol[i * 3 + 1] = pCol[i * 3 + 2] = 0; continue; }
    pLife[i] -= dt;
    const k = Math.max(0, pLife[i]) * 1.6;
    pPos[i * 3] += pVel[i * 3] * dt; pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt; pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
    pVel[i * 3] *= .985; pVel[i * 3 + 1] *= .985; pVel[i * 3 + 2] *= .985;
    pCol[i * 3] *= (0.86 + 0.14 * k); pCol[i * 3 + 1] *= (0.8 + 0.1 * k); pCol[i * 3 + 2] *= (0.75 + 0.1 * k);
    if (pLife[i] <= 0) pCol[i * 3] = pCol[i * 3 + 1] = pCol[i * 3 + 2] = 0;
  }
  pGeo.attributes.position.needsUpdate = pGeo.attributes.color.needsUpdate = true;
}

/* ---------------- debris (separated stages) ---------------- */
export const debris = [];   // {mesh, vel, angVel, age}

export function initVehicle(target) {
  scene = target;
  scene.add(rocketGroup);
  scene.add(plume);
}

export function setVisible(visible) { rocketGroup.visible = visible; }

export function detachStage(mesh, pos, quat) {
  rocketGroup.remove(mesh);
  mesh.position.copy(pos); mesh.quaternion.copy(quat); mesh.scale.setScalar(VS);
  scene.add(mesh);
}

export function addDebris(entry) { debris.push(entry); }

export function updateDebris(simDt, accelAt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i]; d.age += simDt;
    const a = accelAt(d.mesh.position, d.vel, 8, null);
    d.vel.addScaledVector(a, simDt); d.mesh.position.addScaledVector(d.vel, simDt);
    d.mesh.rotation.x += d.angVel.x * simDt; d.mesh.rotation.y += d.angVel.y * simDt;
    if (d.age > 400 || d.mesh.position.length() > 60000) { scene.remove(d.mesh); debris.splice(i, 1); }
  }
}

export function clearDebris() {
  debris.forEach(d => scene.remove(d.mesh)); debris.length = 0;
}

export function resetStages() {
  stages.forEach(st => {
    st.meshes.visible = true; st.meshes.position.set(0, 0, 0); st.meshes.quaternion.identity();
    rocketGroup.add(st.meshes);
  });
  rocketGroup.visible = true;
  rocketGroup.quaternion.identity();
}

/* visuals follow physics: rocket transform, flame/glow, plume emission */
export function updateBurnVisuals({ pos, quat, vel, throttle, activeIdx, burn, fwd, omega }) {
  rocketGroup.position.copy(pos); rocketGroup.quaternion.copy(quat);
  const om = omega || ZERO_V;   // body-frame angular velocity (rad/s)
  stages.forEach((st, idx) => {
    const on = burn && idx === activeIdx;
    st.flame.visible = on; st.glow.visible = on;
    if (on) {
      const L = (4 + throttle * 11) * (idx === 0 ? 1.35 : idx === 1 ? 1.0 : .55);
      const flick = .9 + Math.random() * .2;
      st.flame.scale.set((2 + throttle * 1.6) * flick, L * flick, L * flick);
      st.glow.scale.setScalar((6 + throttle * 13) * flick);
      // engine gimbal: the plume lags the turn, swinging opposite the body rate (clamped +/-0.22 rad).
      // Euler 'YXZ': Rx pitches apex toward +Y for omega.x > 0 (nose pitches toward -Y),
      // then Ry swings apex toward -X for omega.y > 0 (nose yaws toward +X) — both opposite the turn.
      st.flame.rotation.set(-Math.PI / 2 + THREE.MathUtils.clamp(om.x, -1, 1) * .22, THREE.MathUtils.clamp(om.y, -1, 1) * .22, 0);
    } else {
      st.flame.rotation.set(-Math.PI / 2, 0, 0);
    }
  });
  if (burn) {
    const tailPos = pos.clone().addScaledVector(fwd(), stages[activeIdx].tailZ * VS);
    const base = vel.clone();
    for (let k = 0; k < Math.max(1, throttle * 2.2); k++)
      spawnParticle(tailPos, base.addScaledVector(fwd(), -34).add(new THREE.Vector3().randomDirection().multiplyScalar(4)), .55 + Math.random() * .5, [1, .72, .35]);
  }
}
