import * as THREE from 'three';
import { RM, SOI_M, moonPos } from './constants.js';
import { getSimTime } from './physics.js';
import * as WORLD from './world.js';

/* The sheet of dust a lunar burn drives out along the ground. Display only.

   On the Moon nothing holds dust up: an engine near the surface blows the regolith out as a flat
   sheet, radially, at ground level, and it is gone the moment the engine stops. The parcels of
   js/exhaust-sim.js are the pieces of that sheet in flight; this is the sheet itself — one disc
   lying on the ground round the point the jet strikes, drawn as flat rays: a ragged star of two
   greys a step lighter than the regolith, each ray running outward and starting again, every edge
   hard. It appears as the engine comes within about 110 m of the ground and widens with throttle.

   The disc is a fixed polar grid whose vertices are stood on the same height field the drawn
   ground uses (WORLD.moonGroundHeight), re-read only when the strike point has moved; the rays are
   cut in the fragment stage from each pixel's own radius and bearing, in metres, so they are sharp
   at any size and the grid's density has nothing to do with the picture. */

const RINGS = 12, SEGS = 48, R_MAX = 0.14;          // km: the grid reaches 140 m; the sheet is drawn inside it

const VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec2 aPolar;    // metres from the strike point, bearing in radians
  varying vec2 vPolar;
  void main() {
    vPolar = aPolar;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    #include <logdepthbuf_vertex>
  }`;

const FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uR, uT, uDay;
  uniform vec3 cA, cB;
  varying vec2 vPolar;
  float h1( float n ) { return fract( sin( n * 91.345 ) * 47453.5 ); }
  /* how far the ray through this bearing reaches now, in units of the sheet's radius */
  float reach( float th, float n, float seedOff ) {
    float x = th * n / 6.28318;
    float seg = floor( x ), w = abs( fract( x ) - 0.5 ) * 2.0;        // 0 on the ray's centre line, 1 on its edge
    float h = h1( seg + seedOff );
    float run = fract( h * 7.0 + uT * ( 0.9 + 1.3 * h ) );              // each ray runs out and starts again
    return ( 0.42 + 0.58 * run ) * ( 1.0 - 0.8 * w );                   // a ray comes to a point
  }
  void main() {
    #include <logdepthbuf_fragment>
    float r = vPolar.x / max( uR, 1e-3 );
    float a = reach( vPolar.y, 31.0, 0.0 ), b = reach( vPolar.y + 0.11, 47.0, 50.0 ) * 0.7;
    if ( r > max( a, b ) ) discard;
    /* two flat greys: the short dense rays near the strike point are the lighter one */
    vec3 col = r < b ? cA : cB;
    gl_FragColor = vec4( col * mix( 0.4, 1.0, uDay ), 1.0 );
  }`;

const paint = (hex) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);   // bytes as authored: see js/flame.js
const uniforms = { uR: { value: 1 }, uT: { value: 0 }, uDay: { value: 1 }, cA: { value: paint(0xb9b9bc) }, cB: { value: paint(0xa2a3a9) } };

const nv = (RINGS + 1) * SEGS;
const positions = new Float32Array(nv * 3), polar = new Float32Array(nv * 2);
const geo = new THREE.BufferGeometry();
{
  const idx = [];
  for (let i = 0; i <= RINGS; i++) for (let j = 0; j < SEGS; j++) {
    const k = i * SEGS + j;
    /* the bearing of the last column is 2 pi, not 0, so a ray is not interpolated backwards across the seam */
    polar[k * 2] = Math.pow(i / RINGS, 1.4) * R_MAX * 1000; polar[k * 2 + 1] = j / (SEGS - 1) * Math.PI * 2;
  }
  for (let i = 0; i < RINGS; i++) for (let j = 0; j < SEGS - 1; j++) {
    const a = i * SEGS + j, b = a + 1, c = a + SEGS, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aPolar', new THREE.BufferAttribute(polar, 2));
  geo.setIndex(idx);
}
/* `transparent` only to keep it out of the half-resolution pass's occluders (js/halfres.js marks
   opaque meshes); it is drawn opaque and writes depth. */
const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG,
  side: THREE.DoubleSide, fog: false, transparent: true, blending: THREE.NoBlending, depthWrite: true }));
mesh.frustumCulled = false; mesh.castShadow = false; mesh.visible = false; mesh.renderOrder = 0;

export function initDustSheet(scene) { scene.add(mesh); }
export function resetDustSheet() { mesh.visible = false; shown = 0; lastT = -1; laid.set(1e9, 0, 0); }

const _m = new THREE.Vector3(), _up = new THREE.Vector3(), _d = new THREE.Vector3(), _hub = new THREE.Vector3(), _e1 = new THREE.Vector3(),
  _e2 = new THREE.Vector3(), _p = new THREE.Vector3(), laid = new THREE.Vector3(1e9, 0, 0);
let shown = 0, lastT = -1;
const ground = (v) => { const fn = WORLD.moonGroundHeight; const h = typeof fn === 'function' ? fn(_p.copy(v)) : 0; return h === h ? h : 0; };

/* Once per drawn frame while flying. `nozzle` is the exit plane (km, world), `axis` the way the
   exhaust leaves (unit), `power` the throttle of a burning engine or 0. */
export function updateDustSheet(nozzle, axis, power) {
  const t = getSimTime();
  const dt = lastT < 0 || t < lastT ? 0 : Math.min(1, t - lastT);
  lastT = t;
  moonPos(t, _m);
  let want = 0;
  if (power > 0 && nozzle.distanceToSquared(_m) < SOI_M * SOI_M) {
    _d.subVectors(nozzle, _m);
    const h = _d.length() - RM - ground(_d);                     // km, engine above the ground under it
    _up.copy(_d).normalize();
    const c = -axis.dot(_up);
    if (h < 0.11 && c > 0.3) {
      /* Radius: 30 m at idle to 100 m at full throttle, coming in over the last 110 m of height. */
      want = (0.03 + 0.07 * power) * (1 - THREE.MathUtils.smoothstep(h, 0.012, 0.11));
      _hub.copy(nozzle).addScaledVector(axis, Math.max(0, h) / c);
    }
  }
  /* The sheet follows the engine in a fifth of a second, on the mission clock. */
  shown += (want - shown) * (1 - Math.exp(-dt / 0.2));
  if (shown < 0.004) { mesh.visible = false; return; }
  _hub.sub(_m);                                                  // Moon-relative from here on: the Moon moves 1 km/s
  if (want > 0 && _hub.distanceToSquared(laid) > 4e-6) {         // the strike point has moved 2 m: stand the grid on the ground again
    laid.copy(_hub);
    _up.copy(laid).normalize();
    _e1.set(1, 0, 0).cross(_up); if (_e1.lengthSq() < 1e-6) _e1.set(0, 1, 0).cross(_up);
    _e1.normalize(); _e2.crossVectors(_up, _e1);
    const c0 = laid.length();
    for (let k = 0; k < nv; k++) {
      const r = polar[k * 2] * 0.001, a = polar[k * 2 + 1];
      _d.copy(_up).multiplyScalar(c0).addScaledVector(_e1, Math.cos(a) * r).addScaledVector(_e2, Math.sin(a) * r);
      const rr = RM + ground(_d) + 0.0003;                         // 30 cm proud of the ground
      _d.normalize().multiplyScalar(rr);
      positions[k * 3] = _d.x - laid.x; positions[k * 3 + 1] = _d.y - laid.y; positions[k * 3 + 2] = _d.z - laid.z;
    }
    geo.attributes.position.needsUpdate = true;
    uniforms.uDay.value = THREE.MathUtils.smoothstep(_up.dot(WORLD.SUN_DIR), -0.12, 0.08);
  }
  /* The grid is stored about the strike point, and that point about the Moon, which carries it along. */
  mesh.position.copy(_m).add(laid);
  mesh.visible = true;
  uniforms.uR.value = shown * 1000; uniforms.uT.value = t % 1000;
}
