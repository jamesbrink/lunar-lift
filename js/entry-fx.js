import * as THREE from 'three';
import { VS, RE, EARTH_SPIN } from './constants.js';
import { S, getHeat, getCooking, getState, getSimTime, activeStage } from './physics.js';
import { BELL_SETS } from './exhaust-emit.js';
import { spawnParticle } from './exhaust-pool.js';

/* Entry heating, drawn. Display only: it reads js/physics.js and changes nothing there.

   What is drawn is a comet, as flat shapes: a blunt cap standing off ahead of whatever face leads
   into the air (the bow shock, a white-hot crescent), a sheath of fire streaming back round the body
   from the cap's rim (yellow inside orange), and behind that a long thin streak. One closed body of
   revolution about the AIR-RELATIVE velocity plus a second, thinner one for the streak, shaped and
   banded in the shader like the engine flame (js/flame.js).

   The body is drawn inside out — back faces only, depth-tested. A closed surface has exactly one
   back face behind every pixel of its silhouette, so this fills the comet's outline once, and the
   vehicle, being nearer than the far wall, covers the middle of it: the capsule stays a readable
   drawing with the fire standing round and ahead of it, from any side, with no sorting.

   Driven by the heat proxy the flight model already keeps (getHeat: sqrt(rho)·v³, the number the
   heat shield is judged by): nothing below 0.5, which the nominal ascent never reaches (measured:
   it peaks at 0.09, at T+114 s and 39 km); full size at 8 — a 7.8 km/s entry from 110 km at -1.5
   degrees peaks at 8.9. It shrinks back
   into the body as the heat falls. getCooking() is how close the vehicle is to burning up — a bare
   capsule apex-first, or anything with stages still on — and it turns the same shapes angry: wider,
   spiked, crimson for orange, shedding burning fragments. */

const NT = 26, NA = 20;

const VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  #define TN 0.2
  attribute vec3 aUV;       // x: 0 at the apex of the cap, 1 at the tail's tip. y: angle. z: 0 sheath, 1 streak
  uniform float uR, uLead, uLen, uK, uAngry, uTime;
  varying float vT, vF, vU, vKind;
  /* the outline: x radius, y station along the direction of flight (+ ahead) */
  vec2 outline( float t, float th, float kind ) {
    float Rs = uR * ( 1.18 + 0.42 * uK + 0.3 * uAngry );
    float stand = uR * ( 0.16 + 0.26 * uK );
    float D = stand + uR * 0.95;
    if ( kind > 0.5 ) {
      /* the streak: a long needle from behind the body */
      float w = sin( min( t * 6.0, 1.5708 ) ) * pow( max( 1.0 - t, 0.0 ), 0.6 );
      w *= 1.0 + 0.2 * sin( t * 26.0 - uTime * 17.0 ) * smoothstep( 0.1, 0.5, t );
      return vec2( Rs * 0.42 * w, uLead - uR - uLen * 3.4 * t );
    }
    if ( t < TN ) {
      float s = t / TN;
      return vec2( Rs * sqrt( max( 1.0 - ( 1.0 - s ) * ( 1.0 - s ), 0.0 ) ), uLead + stand - D * s );
    }
    float u = ( t - TN ) / ( 1.0 - TN );
    float w = pow( max( 1.0 - u, 0.0 ), 0.8 );
    w *= 1.0 + 0.10 * sin( u * 11.0 - uTime * 15.0 ) * smoothstep( 0.05, 0.35, u );                       // bulges running aft
    w *= 1.0 + ( 0.10 + 0.14 * uAngry ) * sin( th * 5.0 + u * 7.0 - uTime * 12.0 ) * smoothstep( 0.1, 0.8, u );   // tongues
    float tri = abs( fract( th * 1.11408 + floor( uTime * 9.0 ) * 0.37 ) - 0.5 ) * 2.0;                  // 7 spikes, redrawn 9 times a second
    w *= 1.0 + 0.5 * uAngry * ( tri - 0.4 ) * smoothstep( 0.0, 0.25, u ) * ( 1.0 - 0.5 * u );
    return vec2( Rs * w, uLead + stand - D - uLen * pow( u, 1.4 ) );
  }
  void main() {
    float t = aUV.x, th = aUV.y, kind = aUV.z;
    vec2 o = outline( t, th, kind ), o2 = outline( t + 0.01, th, kind );
    vec2 tan = o2 - o;
    vec2 c = vec2( cos( th ), sin( th ) );
    vec3 n = normalize( vec3( c * -tan.y, tan.x ) + vec3( 0.0, 0.0, 1e-7 ) );
    vec4 mv = modelViewMatrix * vec4( c * o.x, o.y, 1.0 );
    vF = dot( normalize( normalMatrix * n ), normalize( -mv.xyz ) );
    vT = t; vKind = kind;
    vU = kind > 0.5 ? t : max( 0.0, ( t - TN ) / ( 1.0 - TN ) );
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  #define TN 0.2
  uniform vec3 cCore, cMid, cOut, cDeep;
  uniform float uK, uAngry, uTime;
  varying float vT, vF, vU, vKind;
  void main() {
    #include <logdepthbuf_fragment>
    float f = clamp( abs( vF ), 0.0, 1.0 );
    float lat = sqrt( 1.0 - f * f );                 // 0 on the centre line, 1 on the silhouette
    float wob = 0.05 * sin( vU * 24.0 - uTime * 21.0 );
    vec3 col; float a;
    if ( vKind > 0.5 ) {
      col = lat < 0.5 + wob ? cMid : cOut;
      if ( vU > 0.45 + wob ) col = lat < 0.4 ? cOut : cDeep;
      a = vU < 0.3 ? 0.92 : vU < 0.62 + wob ? 0.78 : 0.55;
    } else if ( vT < TN ) {
      /* the bow shock: brightest at its own front edge */
      col = lat > 0.74 + wob ? cCore : lat > 0.42 ? cMid : cOut;
      a = 0.95;
    } else {
      col = lat > 0.80 + wob ? cOut : lat > 0.42 - 0.5 * vU ? cMid : cCore;
      if ( vU > 0.5 + wob ) col = lat > 0.6 ? cDeep : cOut;
      a = vU < 0.32 + wob ? 0.96 : vU < 0.66 ? 0.9 : 0.78;
    }
    /* It leaves by shrinking into the body, as paint; only the very last of it is a veil. */
    a *= uK < 0.07 ? 0.6 : 1.0;
    gl_FragColor = vec4( col * a, a );
  }`;

const paint = (hex) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);   // bytes as authored: see js/flame.js
const CALM = [0xfffbea, 0xffd23e, 0xff7b1c, 0xd8431c].map(paint);
const ANGRY = [0xfff0ec, 0xff6a3a, 0xe2203c, 0x8c1247].map(paint);

function geometry() {
  const nv = (NT + 1) * NA, pos = new Float32Array(2 * nv * 3), uv = new Float32Array(2 * nv * 3), idx = [];
  for (const kind of [1, 0]) {                       // the streak first: the sheath paints over its root
    const base = (1 - kind) * nv;
    for (let i = 0; i <= NT; i++) for (let j = 0; j < NA; j++) {
      const k = base + i * NA + j;
      uv[k * 3] = i / NT; uv[k * 3 + 1] = j / NA * Math.PI * 2; uv[k * 3 + 2] = kind;
    }
    for (let i = 0; i < NT; i++) for (let j = 0; j < NA; j++) {
      const a = base + i * NA + j, b = base + i * NA + (j + 1) % NA, c = a + NA, d = b + NA;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aUV', new THREE.BufferAttribute(uv, 3));
  g.setIndex(idx);
  return g;
}

const uniforms = {
  uR: { value: 0.002 }, uLead: { value: 0.002 }, uLen: { value: 0.02 }, uK: { value: 0 }, uAngry: { value: 0 }, uTime: { value: 0 },
  cCore: { value: CALM[0].clone() }, cMid: { value: CALM[1].clone() }, cOut: { value: CALM[2].clone() }, cDeep: { value: CALM[3].clone() },
};
/* BackSide: the tubes are wound to face outward (t runs aft, as in js/flame.js) and the mesh is only
   ever rotated, so the back faces are the far wall from any eye. */
const mesh = new THREE.Mesh(geometry(), new THREE.ShaderMaterial({
  uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, fog: false, side: THREE.BackSide,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
}));
mesh.frustumCulled = false; mesh.castShadow = false; mesh.visible = false; mesh.renderOrder = 1;

export function initEntryFx(scene) { scene.add(mesh); }
export function resetEntryFx() { shown = 0; angry = 0; lastT = -1; emberAcc = 0; mesh.visible = false; }

const NOSE_Z = 28.7, CM_TAIL_Z = 26.0, CM_R = 1.39;      // build units; the stations js/physics.js keeps
const Z = new THREE.Vector3(0, 0, 1);
const _v = new THREE.Vector3(), _ax = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Vector3(), _c = new THREE.Color();
let shown = 0, angry = 0, lastT = -1, emberAcc = 0;

/* Once per drawn frame, from the drawn state. Everything here runs on the mission clock, so a paused
   frame is a still and time warp only makes the shapes travel faster. */
export function updateEntryFx() {
  const t = getSimTime(), st = getState();
  const dt = lastT < 0 || t < lastT ? 0 : Math.min(1, t - lastT);
  lastT = t;
  const alt = S.pos.length() - RE;
  const heat = st === 'flying' && alt < 150 ? getHeat() : 0;
  /* The proxy moves in 0.1 s steps; the picture follows it over a fifth of a second. */
  const want = THREE.MathUtils.clamp(Math.log(Math.max(heat, 1e-6) / 0.5) / Math.log(16), 0, 1);
  const wantAngry = st === 'flying' ? Math.min(1, getCooking() * 2.5) : 0;
  const k = 1 - Math.exp(-dt / 0.2);
  shown = st === 'flying' ? shown + (want - shown) * k : 0;
  angry = st === 'flying' ? angry + (wantAngry - angry) * k : 0;
  if (shown < 0.004) { mesh.visible = false; emberAcc = 0; return; }

  _v.set(S.v.x - EARTH_SPIN * S.pos.z, S.v.y, S.v.z + EARTH_SPIN * S.pos.x);     // through the air: js/physics.js uses the same wind
  const sp = _v.length();
  if (sp < 1e-6) { mesh.visible = false; return; }
  _v.multiplyScalar(1 / sp);
  /* The body as the air meets it: a cylinder from the active tail to the nose. */
  const i = activeStage();
  const tail = i >= 0 ? BELL_SETS[i].tailZ : CM_TAIL_Z, rad = (i >= 0 ? BELL_SETS[i].hullR : CM_R) * VS;
  const half = 0.5 * (NOSE_Z - tail) * VS;
  _ax.copy(Z).applyQuaternion(S.q);
  const c = Math.abs(_ax.dot(_v)), s = Math.sqrt(Math.max(0, 1 - c * c));
  const lead = c * half + s * rad, cross = Math.max(rad, s * half + c * rad * 0.6);
  mesh.position.copy(S.pos).addScaledVector(_ax, 0.5 * (NOSE_Z + tail) * VS);
  mesh.quaternion.setFromUnitVectors(Z, _v);
  mesh.visible = true;
  uniforms.uR.value = cross; uniforms.uLead.value = lead;
  uniforms.uLen.value = cross * (2.5 + 13 * shown + 5 * angry);
  uniforms.uK.value = shown; uniforms.uAngry.value = angry; uniforms.uTime.value = t % 1000;
  uniforms.cCore.value.copy(CALM[0]).lerp(ANGRY[0], angry); uniforms.cMid.value.copy(CALM[1]).lerp(ANGRY[1], angry);
  uniforms.cOut.value.copy(CALM[2]).lerp(ANGRY[2], angry); uniforms.cDeep.value.copy(CALM[3]).lerp(ANGRY[3], angry);

  /* Burning up sheds burning pieces: slivers torn off the trailing side, left behind by the air. */
  if (angry > 0.05 && dt > 0) {
    emberAcc += 46 * angry * dt;
    let n = Math.min(12, emberAcc | 0); emberAcc -= emberAcc | 0;
    while (n-- > 0) {
      _e.randomDirection();
      _p.copy(mesh.position).addScaledVector(_e, cross * 0.8).addScaledVector(_v, -lead);
      _e.multiplyScalar(0.03 + 0.05 * Math.random()).addScaledVector(_v, -sp * (0.02 + 0.05 * Math.random())).add(S.v);
      _c.copy(ANGRY[1 + (n & 1)]);
      spawnParticle(_p, _e, 0.35 + 0.5 * Math.random(), [_c.r, _c.g, _c.b], Math.min(3.2, cross * 1000 * (0.25 + 0.35 * Math.random())), 0);
    }
  }
}
