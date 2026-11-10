import * as THREE from 'three';
import { VS, RE } from './constants.js';
import { S, getState, landing } from './physics.js';
import * as WORLD from './world.js';

/* Splashdown, drawn. Display only: it watches js/physics.js for the moment the mission is won at
   home (state 'won' with landing.home) and, if that place is water, plays one splash there.

   Four kinds of flat shape in one mesh, every one a function of the seconds since contact:
   - a crown: fourteen pointed petals of water thrown up and outward round the capsule, each two
     facets in two tones, rising and falling back inside about a second;
   - droplets: small diamonds on ballistic arcs, gone when they meet the water again;
   - two rings running out across the surface, scalloped, thinning to nothing as they go;
   - a collar of foam left round the hull, which is what remains.
   The mesh is opaque and writes depth, so nothing is sorted or blended. After about five seconds
   only the collar is left and the picture is a still. The clock is the frame time js/vehicle.js
   hands over, so a paused game holds the splash where it is. */

const PETALS = 14, DROPS = 26, SEG = 56;

const VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec4 aP;        // x: kind (0 ring, 1 petal, 2 droplet, 3 foam collar). y: angle. z: role. w: seed
  attribute float aTone;
  uniform float uT;
  varying float vTone;
  float h1( float n ) { return fract( sin( n * 91.345 ) * 47453.5 ); }
  void main() {
    float kind = aP.x, a = aP.y, role = aP.z, s = aP.w;
    vec3 p = vec3( 0.0 );
    vec2 bill = vec2( 0.0 );
    if ( kind < 0.5 || kind > 2.5 ) {
      /* a band on the water: role 0 its inner edge, 1 its outer */
      float r, w;
      if ( kind > 2.5 ) { r = 2.75; w = 0.75 * smoothstep( 0.15, 0.9, uT ); }
      else {
        float e = uT - 0.45 * s;
        r = 2.6 + 15.0 * ( 1.0 - exp( -max( e, 0.0 ) / 1.5 ) );
        w = e > 0.0 ? max( 0.0, 1.5 * exp( -e / 1.3 ) - 0.1 ) : 0.0;
      }
      float scal = 1.0 + 0.09 * sin( a * 9.0 + s * 3.0 ) + 0.05 * sin( a * 17.0 + 1.3 + s );
      float rr = r + ( role - 0.5 ) * w * ( role > 0.5 ? scal * 1.0 : 2.0 - scal );
      p = vec3( cos( a ) * rr, sin( a ) * rr, 0.03 + 0.02 * s );
    } else if ( kind < 1.5 ) {
      /* a petal: role 0 and 1 its feet, 2 the middle of its base, 3 its point */
      float tau = clamp( ( uT - 0.08 * h1( s ) ) / ( 0.85 + 0.5 * h1( s + 1.0 ) ), 0.0, 1.0 );
      float h = ( 3.2 + 4.6 * h1( s + 2.0 ) ) * 4.0 * tau * ( 1.0 - tau );
      float rb = 2.0 + 2.4 * tau, dA = 0.2;
      float aa = a + ( role < 0.5 ? -dA : role < 1.5 ? dA : role > 2.5 ? 0.12 * ( h1( s + 3.0 ) - 0.5 ) : 0.0 );
      float rr = rb + ( role > 2.5 ? 0.5 * h : 0.0 );
      p = vec3( cos( aa ) * rr, sin( aa ) * rr, role > 2.5 ? h : 0.0 );
    } else {
      /* a droplet: role 0..3 the corners of a diamond that faces the eye */
      float e = uT - 0.06 * h1( s + 2.0 );
      float vh = 2.0 + 5.5 * h1( s ), vz = 5.0 + 7.0 * h1( s + 1.0 );
      float z = vz * e - 4.905 * e * e;
      float live = e > 0.0 && z > 0.0 ? 1.0 : 0.0;
      float rr = 2.2 + vh * max( e, 0.0 );
      p = vec3( cos( a ) * rr, sin( a ) * rr, max( z, 0.0 ) );
      float size = ( 0.20 + 0.26 * h1( s + 3.0 ) ) * live;
      bill = ( role < 0.5 ? vec2( 1.0, 0.0 ) : role < 1.5 ? vec2( 0.0, 1.3 ) : role < 2.5 ? vec2( -1.0, 0.0 ) : vec2( 0.0, -1.3 ) ) * size * 0.001;
    }
    vTone = aTone;
    vec4 mv = modelViewMatrix * vec4( p, 1.0 );
    mv.xy += bill;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uDay;
  varying float vTone;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 col = vTone < 0.5 ? vec3( 0.957, 0.976, 1.0 ) : vTone < 1.5 ? vec3( 0.72, 0.85, 0.95 ) : vec3( 0.47, 0.68, 0.87 );
    gl_FragColor = vec4( col * mix( 0.34, 1.0, uDay ), 1.0 );
  }`;

function geometry() {
  const P = [], T = [];
  const v = (kind, a, role, seed, tone) => { P.push(kind, a, role, seed); T.push(tone); };
  const band = (kind, seed, tone) => {
    for (let j = 0; j < SEG; j++) {
      const a0 = j / SEG * Math.PI * 2, a1 = (j + 1) / SEG * Math.PI * 2;
      v(kind, a0, 0, seed, tone); v(kind, a0, 1, seed, tone); v(kind, a1, 1, seed, tone);
      v(kind, a0, 0, seed, tone); v(kind, a1, 1, seed, tone); v(kind, a1, 0, seed, tone);
    }
  };
  band(0, 0, 1); band(0, 1, 1); band(3, 2, 0);
  for (let k = 0; k < PETALS; k++) {
    const a = (k + 0.5 * (k & 1) * 0.3) / PETALS * Math.PI * 2, s = k * 7.13 + 1;
    v(1, a, 0, s, 0); v(1, a, 2, s, 0); v(1, a, 3, s, 0);          // the lit facet
    v(1, a, 2, s, 1); v(1, a, 1, s, 1); v(1, a, 3, s, 1);          // the shaded one
  }
  for (let k = 0; k < DROPS; k++) {
    const a = (k * 0.618034 % 1) * Math.PI * 2, s = k * 3.77 + 40, tone = k % 3 === 0 ? 1 : 0;
    v(2, a, 0, s, tone); v(2, a, 1, s, tone); v(2, a, 2, s, tone);
    v(2, a, 0, s, tone); v(2, a, 2, s, tone); v(2, a, 3, s, tone);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(T.length * 3), 3));
  g.setAttribute('aP', new THREE.BufferAttribute(new Float32Array(P), 4));
  g.setAttribute('aTone', new THREE.BufferAttribute(new Float32Array(T), 1));
  return g;
}

const uniforms = { uT: { value: 0 }, uDay: { value: 1 } };
const mesh = new THREE.Mesh(geometry(), new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide, fog: false }));
mesh.frustumCulled = false; mesh.castShadow = false; mesh.visible = false;
mesh.scale.setScalar(0.001);                       // the shader works in metres

export function initSplashFx(scene) { scene.add(mesh); }
export function resetSplashFx() { mesh.visible = false; armed = true; uniforms.uT.value = 0; }

const CM_BASE_Z = 26.0;                            // build units: the heat shield's face (js/physics.js CM_TAIL_Z)
const Z = new THREE.Vector3(0, 0, 1), _p = new THREE.Vector3(), _up = new THREE.Vector3();
let armed = true;

/* Once per drawn frame; `dt` is the frame's seconds (0 while paused — it is not called then). */
export function updateSplashFx(dt) {
  const won = getState() === 'won' && landing.home;
  if (!won) { if (mesh.visible) resetSplashFx(); armed = true; return; }
  if (armed) {
    armed = false;
    _p.set(0, 0, CM_BASE_Z * VS).applyQuaternion(S.q).add(S.pos);
    const fn = WORLD.fineGroundHeight || WORLD.groundHeight;
    const h = typeof fn === 'function' ? fn(_up.copy(_p)) || 0 : 0;
    /* Oceans are the bare sphere in the height field; anything standing above it is land, and a
       capsule that comes down there raises no water. */
    if (h > 0.0005) return;
    _up.copy(_p).normalize();
    mesh.position.copy(_up).multiplyScalar(RE + h + 0.0001);
    mesh.quaternion.setFromUnitVectors(Z, _up);
    uniforms.uDay.value = THREE.MathUtils.smoothstep(_up.dot(WORLD.SUN_DIR), -0.12, 0.08);
    uniforms.uT.value = 0;
    mesh.visible = true;
  }
  if (mesh.visible) uniforms.uT.value = Math.min(30, uniforms.uT.value + Math.min(dt, 0.1));
}
