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

function cyl(rt, rb, len, z, mat, seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, len, seg), mat);
  m.rotation.x = Math.PI / 2; m.position.z = z; return m;
}

// stage 1: spans z -37.5 .. -3.5
{
  const g = stages[0].meshes;
  g.add(cyl(6, 6, 34, -20.5, matBody));
  g.add(cyl(6.15, 6.15, 2.2, -34, matAccent));
  g.add(cyl(6.15, 6.15, 1.4, -12, matAccent));
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(1, 11, 9), matDark);
    const a = i * Math.PI / 2 + Math.PI / 4;
    fin.position.set(Math.cos(a) * 6.8, Math.sin(a) * 6.8, -33); fin.rotation.z = a; g.add(fin);
  }
  g.add(cyl(1.1, 2.4, 5, -39.5, matNozzle));
  stages[0].tailZ = -42;
}
// stage 2: spans z -3.5 .. 18.5
{
  const g = stages[1].meshes;
  g.add(cyl(5, 5, 22, 7.5, matBody));
  g.add(cyl(5.2, 5.2, 1.6, 16, matAccent));
  g.add(cyl(1.2, 2, 6, -4.5, matNozzle));      // interstage shroud conceals it until staging
  stages[1].tailZ = -8;
}
// stage 3 + capsule: spans z 18.5 .. 37.5  (one vehicle to the Moon)
{
  const g = stages[2].meshes;
  g.add(cyl(4, 4, 9, 23, matBody));
  const cone = new THREE.Mesh(new THREE.ConeGeometry(4.6, 8, 24), matBody); cone.rotation.x = Math.PI / 2; cone.position.z = 31.5; g.add(cone);
  const win = new THREE.Mesh(new THREE.SphereGeometry(.7, 10, 10), new THREE.MeshBasicMaterial({ color: 0x8fdcff })); win.position.set(0, 3.6, 31); g.add(win);
  g.add(cyl(.8, 1.7, 4, 17.5, matNozzle));
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(.12, .12, 6, 6), matDark); ant.rotation.x = Math.PI / 2; ant.position.z = 38; g.add(ant);
  stages[2].tailZ = 15;
}
stages.forEach(st => {
  const flame = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 14), matFlame);
  flame.rotation.x = -Math.PI / 2; flame.position.z = st.tailZ - 0.6; flame.visible = false;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: 0xffb060, transparent: true, opacity: .8, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.position.z = st.tailZ; glow.visible = false;
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
export function updateBurnVisuals({ pos, quat, vel, throttle, activeIdx, burn, fwd }) {
  rocketGroup.position.copy(pos); rocketGroup.quaternion.copy(quat);
  stages.forEach((st, idx) => {
    const on = burn && idx === activeIdx;
    st.flame.visible = on; st.glow.visible = on;
    if (on) {
      const L = (4 + throttle * 11) * (idx === 0 ? 1.35 : idx === 1 ? 1.0 : .55);
      const flick = .9 + Math.random() * .2;
      st.flame.scale.set((2 + throttle * 1.6) * flick, L * flick, L * flick);
      st.glow.scale.setScalar((6 + throttle * 13) * flick);
    }
  });
  if (burn) {
    const tailPos = pos.clone().addScaledVector(fwd(), stages[activeIdx].tailZ * VS);
    const base = vel.clone();
    for (let k = 0; k < Math.max(1, throttle * 2.2); k++)
      spawnParticle(tailPos, base.addScaledVector(fwd(), -34).add(new THREE.Vector3().randomDirection().multiplyScalar(4)), .55 + Math.random() * .5, [1, .72, .35]);
  }
}
