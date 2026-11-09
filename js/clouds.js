import * as THREE from 'three';
import { RE } from './constants.js';
import { cumulusTex, cirrusTex } from './textures.js';

/* Weather is ONE field on ONE mesh, not a cap that follows the ship.

   The old system was two tangent-plane caps re-centred under the vehicle: a 44x44 grid at 220 km
   and a 28x28 grid at 32 km. Both are squares in a plane, so zooming out showed a flat
   quadrilateral with straight edges hanging around the ship — a 45x45 mesh outline 400+ km wide,
   unmistakable from 100 km up. A cap cannot be weather either: the field only exists where the
   camera happens to be, and the rest of the planet is bare.

   The atmosphere is now a shell from 4 km to 11 km, and every pixel of it gets its opacity from an
   optical-depth march through the analytic chord of the view ray. Density grows toward the horizon
   the way real air does, the top edge is a gradient rather than a decal edge, and there is no mesh
   silhouette left to see because the surface is only ever translucent.

   Two scales, one mesh. The macro field is the zonal weather from js/textures.js (20 km per texel:
   ITCZ, dry subtropics, storm tracks) and it decides WHERE clouds live. The cell field is a
   tileable convective lattice at 160 km per tile (0.3125 km per texel: towers of 3-13 km), which
   is what makes weather legible from the pad. The old argument that "no deck change will ever put
   a cumulus over the pad" was true only because the deck was one texel per 39 km; tiling fixes it
   without a moving cap.

   Two cell lattices drift at different speeds, so cells build and fade as they slide past each
   other rather than merely translating. Ground shadows come from the SAME march projected up the
   sun ray (cloudShadeInject), so the darkening on the surface is the column of cloud overhead —
   the job the 32 km shade cap could only do under the camera. */

const BAND_BASE = 4;                    // km: cloud base
const BAND_TOP = 11;                    // km: cloud top
const R_IN = RE + BAND_BASE;            // 6375
const R_OUT = RE + BAND_TOP;            // 6382, the shell's own radius
const THICK = BAND_TOP - BAND_BASE;     // 7 km
const CELLS = 250;                      // tile repeats around the globe: 160 km per tile
const CELL_TEX = 512;                   // 0.3125 km per texel
const SEG_W = 512, SEG_H = 256;         // same chord as the decks it replaces (12.5 km)
const MARCH = 8;                        // samples through the view column
const MARCH_SHADE = 4;                  // samples through the sun column for ground shade

/* Extinction per km of solid cloud. A cumulus core is opaque within a kilometre; the cirrus veil
   never is. */
const EXT_LOW = 1.6;
const EXT_HIGH = 0.10;
const SHADE = 0.45;                     // how far a cloud column can darken the ground
/* Fraction of sky covered by cumulus: outside the macro systems (fair weather) and inside them.
   The macro field moves COVERAGE between these, it does not scale opacity — scaling opacity is
   what turned the first version of this shell into a planet-wide white fog with no edges. */
const COVER_CLEAR = 0.07;
const COVER_STORM = 0.82;

/* Winds in tile-uv per second: 1.1e-4 is 17.6 m/s at 160 km/tile, 3.5e-4 is 56 m/s for the second
   lattice. Their difference is what makes cells grow and dissipate; both ride on the planet's spin
   so weather follows the ground instead of freezing in inertial space. */
const WIND_LOW = 1.1e-4;
const WIND_HIGH = 3.5e-4;

const CLOUD_LIT = new THREE.Color(0xffffff);
const CLOUD_SHADE = new THREE.Color(0x7f93ad);   // bases and the night side

/* Tileable convective noise, two independent fields in R and G, stored as RANK (the value's
   percentile in its own field), not as raw fbm. Rank is uniform on 0..1 by construction, so the
   shader can turn a coverage fraction into a threshold exactly instead of by a tuned guess: the
   mean of two uniform fields is triangular, and its upper tail above t holds 2(1-t)^2 of the area.
   Four octaves at 10/20/40/80 cells per tile: towers of 16, 8, 4 and 2 km. */
function cellTex() {
  const N = CELL_TEX, n2 = N * N;
  const hash = (x, y, seed) => {
    let v = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2654435761);
    v = Math.imul(v ^ (v >>> 15), 2246822519);
    return ((v ^ (v >>> 13)) >>> 0) / 4294967296;
  };
  const lattice = (ix, iy, per, seed) => {
    const fx = ix * per / N, fy = iy * per / N;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const ax = tx * tx * (3 - 2 * tx), ay = ty * ty * (3 - 2 * ty);
    const x1 = (x0 + 1) % per, y1 = (y0 + 1) % per;
    return hash(x0, y0, seed) * (1 - ax) * (1 - ay) + hash(x1, y0, seed) * ax * (1 - ay)
      + hash(x0, y1, seed) * (1 - ax) * ay + hash(x1, y1, seed) * ax * ay;
  };
  const data = new Uint8Array(n2 * 4).fill(255);
  for (let ch = 0; ch < 2; ch++) {
    const f = new Float32Array(n2);
    for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
      let v = 0, amp = 1;
      for (let k = 0; k < 4; k++, amp *= 0.55) v += amp * lattice(ix, iy, 10 << k, 17 + ch * 40 + k * 7);
      f[iy * N + ix] = v;
    }
    const order = new Uint32Array(n2);
    for (let i = 0; i < n2; i++) order[i] = i;
    order.sort((a, b) => f[a] - f[b]);
    for (let r = 0; r < n2; r++) data[order[r] * 4 + ch] = Math.round(r / (n2 - 1) * 255);
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;   // minified cells average toward 0.5: far cloud
  t.generateMipmaps = true;                       // fields soften into their coverage, never stair
  t.needsUpdate = true;
  return t;
}

/* The march, shared by the shell and by the ground-shade injection. uv is equirectangular and
   matches js/textures.js (v = 0 is the south pole); each sample gets its uv by projecting its
   displacement onto local east and north — a linear shift, so no atan or acos per sample.
   NOTE for whoever edits this: it lives inside a JS template literal, so a backtick in a comment
   ends the shader. */
const MARCH_FN = /* glsl */`
vec2 tangentUv( vec2 uv0, vec3 disp, vec3 n, vec3 east, vec3 north, float cosLat ) {
  return vec2( uv0.x + dot( disp, east ) / ( PI2 * SHELL_R * cosLat ),
               uv0.y + dot( disp, north ) / ( PI * SHELL_R ) );
}

/* The segment of the ray inside the cloud band. Three regimes: eye outside the shell (orbit), eye
   below the cloud base (the pad), eye inside the band (flying through it).
   TWO out-scalars, deliberately: this once handed back a float array, and a GLSL ES parameter is
   IN unless it says otherwise — an array written through an in parameter is a local copy, so the
   caller kept its zeros, every column came back empty, and the whole shell discarded itself with
   no error anywhere (a magenta probe at 6/km extinction produced not one magenta pixel). */
void bandSegment( vec3 o, vec3 d, out float tA, out float tB ) {
  float A = dot( o, d );
  float C = dot( o, o );
  float dO = A * A - ( C - SHELL_R * SHELL_R );
  if ( dO <= 0.0 ) { tA = 0.0; tB = 0.0; return; }
  float sO = sqrt( dO );
  float dI = A * A - ( C - BAND_IN * BAND_IN );
  if ( dI <= 0.0 ) { tA = max( -A - sO, 0.0 ); tB = -A + sO; return; }   // never dips below the base
  float sI = sqrt( dI );
  if ( C > SHELL_R * SHELL_R )      { tA = -A - sO; tB = -A - sI; }      // down through the deck
  else if ( C < BAND_IN * BAND_IN ) { tA = -A + sI; tB = -A + sO; }      // up from the ground
  else                              { tA = 0.0; tB = A < 0.0 ? -A - sI : -A + sO; }   // eye in the band
  if ( tB < tA ) { tA = 0.0; tB = 0.0; }
}

/* Optical depth along the ray, composited front to back. tau is the total; lightH is the mean
   height (0 base .. 1 top) of the cloud the ray actually SEES, weighted by what is still
   unoccluded — from above that is the tops, from the pad it is the bases, which is the whole of
   the lit/shaded cue and costs nothing. */
void marchCloud( vec3 o, vec3 d, vec2 uv0, vec3 n, out float tau, out float lightH ) {
  tau = 0.0; lightH = 0.5;
  float cosLat = max( length( n.xz ), 0.2 );
  vec3 east = vec3( n.z, 0.0, -n.x ) / max( length( n.xz ), 1e-4 );   // direction of increasing u
  vec3 north = cross( n, east );                                      // toward the pole
  float tA, tB;
  bandSegment( o, d, tA, tB );
  float len = tB - tA;
  if ( len <= 0.0 ) return;
  float step = len / float( MARCH_SAMPLES );
  vec2 uvM = tangentUv( uv0, ( tA + 0.5 * len ) * d + o - uvOrigin, n, east, north, cosLat );
  // the systems are hundreds of km wide: one macro sample per column is enough
  float m = smoothstep( 0.08, 0.85, texture2D( cloudMacro, uvM ).a );
  float veil = texture2D( cloudVeil, uvM ).a;
  /* coverage -> threshold on the mean of two rank-uniform fields (triangular distribution) */
  /* A third, slower look at the same lattice (800 km per tile, 80 km blobs) bunches the cover into
     fields and gaps. Without it every square kilometre of a belt carried the same odds and the
     ocean from orbit was an evenly spaced polka dot. */
  float bunch = texture2D( cloudCells, uvM * BUNCH_REPEAT + 0.2 * driftA ).g;
  float c = clamp( mix( COVER_CLEAR, COVER_STORM, m ) * ( 0.25 + 1.6 * bunch ), 0.0, 0.92 );
  float thr = c < 0.5 ? 1.0 - sqrt( 0.5 * c ) : sqrt( 0.5 * ( 1.0 - c ) );
  /* Texels of the cell lattice under one pixel. Past a few, the sampler's mips have averaged the
     rank field to 0.5 everywhere and a threshold on it is a coin that always lands the same way:
     measured from 4000 km as storm belts gone solid white and everything else gone bare. There the
     density becomes the coverage itself — the exact mean of what the threshold would have drawn. */
  float minif = smoothstep( 1.5, 5.0, length( fwidth( uvOrigin ) ) / TEXEL_KM );
  float T = 1.0, hSum = 0.0, wSum = 0.0;
  /* Each pixel starts its samples at a different phase (interleaved gradient noise). With a fixed
     phase every ray cuts the band at the same eight heights and a slanted view draws each puff as
     a stack of plates — measured as visible terraces from 100 km up. The jitter trades them for a
     sub-pixel grain the eye integrates. */
  float jit = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  for ( int i = 0; i < MARCH_SAMPLES; i++ ) {
    float t = tA + ( float( i ) + mix( jit, 0.5, minif ) ) * step;   // unresolved cloud has no terraces to hide
    vec3 q = o + t * d;
    float h = clamp( ( length( q ) - BAND_IN ) / BAND_THICK, 0.0, 1.0 );
    vec2 uvC = tangentUv( uv0, q - uvOrigin, n, east, north, cosLat ) * CELL_REPEAT;
    float f = 0.5 * ( texture2D( cloudCells, uvC + driftA ).r + texture2D( cloudCells, uvC + driftB ).g );
    /* The threshold climbs with height, so only the strongest cores reach the top of the band:
       every cloud is a dome with a flat base, taller where it is denser. */
    float rise = thr + ( 0.10 + 0.22 * ( 1.0 - m ) ) * h;
    float tail = rise > 0.5 ? 2.0 * ( 1.0 - rise ) * ( 1.0 - rise ) : 1.0 - 2.0 * rise * rise;
    float cu = mix( smoothstep( rise, rise + 0.035, f ), clamp( tail, 0.0, 1.0 ), minif )
             * smoothstep( 0.0, 0.06, h );
    float ci = veil * smoothstep( 0.72, 0.9, h );
    float dt = ( cu * extLow + ci * extHigh ) * step;
    float a = 1.0 - exp( -dt );
    hSum += T * a * h; wSum += T * a;
    T *= 1.0 - a;
    tau += dt;
  }
  if ( wSum > 1e-4 ) lightH = hSum / wSum;
}
`;

const DEFINES = (samples) => `
#define SHELL_R ${R_OUT.toFixed(1)}
#define BAND_IN ${R_IN.toFixed(1)}
#define BAND_THICK ${THICK.toFixed(1)}
#define CELL_REPEAT ${CELLS}.0
#define BUNCH_REPEAT ${CELLS / 5}.0
#define TEXEL_KM ${(2 * Math.PI * RE / CELLS / CELL_TEX).toFixed(4)}
#define COVER_CLEAR ${COVER_CLEAR.toFixed(3)}
#define COVER_STORM ${COVER_STORM.toFixed(3)}
#define MARCH_SAMPLES ${samples}

uniform sampler2D cloudCells;
uniform sampler2D cloudMacro;
uniform sampler2D cloudVeil;
uniform vec2 driftA;
uniform vec2 driftB;
uniform float extLow;
uniform float extHigh;
uniform vec3 sunWorld;
`;

const SHELL_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vWorld;
varying vec2 vUvC;

void main() {
  vWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  vUvC   = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  #include <logdepthbuf_vertex>
}
`;

const SHELL_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
` + DEFINES(MARCH) + /* glsl */`
uniform vec3 cloudLit;
uniform vec3 cloudShade;

varying vec3 vWorld;
varying vec2 vUvC;

#define uvOrigin vWorld
` + MARCH_FN + /* glsl */`
void main() {
  /* One face per regime. From outside, the near face's march already covers the whole chord and
     the far face would run the full march only to be depth-rejected (logdepthbuf writes
     gl_FragDepth, so there is no early-z to save it). From underneath, only the inside face is
     the sky. */
  bool outside = dot( cameraPosition, cameraPosition ) > SHELL_R * SHELL_R;
  if ( outside != gl_FrontFacing ) discard;

  vec3 n = normalize( vWorld );
  float tau, lightH;
  marchCloud( cameraPosition, normalize( vWorld - cameraPosition ), vUvC, n, tau, lightH );
  float alpha = 1.0 - exp( -tau );
  if ( alpha < 0.01 ) discard;

  /* Cel tone in three bands by the height the eye lands on: shaded base, body, lit top. The step
     is softened by its own screen-space width so the bands have an edge without a stair. */
  float band = lightH * 3.0;
  float w = max( fwidth( band ), 0.02 );
  float tone = ( smoothstep( 1.0 - w, 1.0 + w, band ) + smoothstep( 2.0 - w, 2.0 + w, band ) ) * 0.5;
  float day = smoothstep( -0.12, 0.30, dot( n, sunWorld ) );
  vec3 col = mix( cloudShade, cloudLit, 0.35 + 0.65 * tone ) * ( 0.10 + 0.90 * day );
  gl_FragColor = vec4( col, alpha );
  #include <logdepthbuf_fragment>
}
`;

/* Ground shade: the same march aimed up the sun ray from the surface point. Injected into the globe
   and the near patch so the darkening on the ground is the cloud column above it. */
const SHADE_FRAG = DEFINES(MARCH_SHADE) + /* glsl */`
uniform float shadeStrength;

varying vec3 vShadeW;

#define uvOrigin vShadeW
` + MARCH_FN + /* glsl */`
void cloudDarken() {
  vec3 n = normalize( vShadeW );
  if ( dot( n, sunWorld ) < 0.02 ) return;                // night side: nothing to shade
  // two-argument atan: GLSL ES has no atan2, and asking for one fails the whole program
  vec2 uv0 = vec2( atan( n.z, -n.x ) / PI2, 1.0 - acos( clamp( n.y, -1.0, 1.0 ) ) / PI );
  float tau, lightH;
  marchCloud( vShadeW, sunWorld, uv0, n, tau, lightH );
  gl_FragColor.rgb *= mix( 1.0, exp( -tau ), shadeStrength );
}
`;

export function makeWeather() {
  return {
    cloudCells: { value: cellTex() },
    cloudMacro: { value: cumulusTex() },
    cloudVeil: { value: cirrusTex() },
    driftA: { value: new THREE.Vector2(0, 0) },
    driftB: { value: new THREE.Vector2(0, 0) },
    cloudLit: { value: CLOUD_LIT },
    cloudShade: { value: CLOUD_SHADE },
    extLow: { value: EXT_LOW },
    extHigh: { value: EXT_HIGH },
    shadeStrength: { value: SHADE },
    sunWorld: { value: new THREE.Vector3(0, 1, 0) },
  };
}

export function makeCloudShell(U) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(R_OUT, SEG_W, SEG_H),
    new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,     // the sky above the pad is the inside of this shell
      fog: false,                 // planet-scale body: FogExp2 measured from the camera would
                                  // erase it in the system view 20 000 km out
    })
  );
  mesh.renderOrder = 1;           // after terrain and vehicle, before the plume
  mesh.castShadow = false;        // a 7 km sheet at a low sun drags its silhouette hundreds of km
  return mesh;
}

/* Add the weather shade to an already-built material's program. three keys its program cache on
   onBeforeCompile.toString(), so one material carries exactly ONE onBeforeCompile: world.js
   composes this with the haze and the coastline ink inside a single function. The uniforms are
   bound at compile time, so no customProgramCacheKey is needed — see the magenta-probe note in
   AGENTS.md for what happens when they are not. */
export function cloudShadeInject(sh, U) {
  for (const key of ['cloudCells', 'cloudMacro', 'cloudVeil', 'driftA', 'driftB',
    'extLow', 'extHigh', 'shadeStrength', 'sunWorld']) sh.uniforms[key] = U[key];
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vShadeW;')
    .replace('#include <project_vertex>',
      '#include <project_vertex>\n  vShadeW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\n' + SHADE_FRAG)
    /* before fog_fragment: the shade darkens the ground, and any haze laid over it afterwards is
       unshadowed air. The include is in the template whether or not the material uses fog. */
    .replace('#include <fog_fragment>', '  cloudDarken();\n#include <fog_fragment>');
}

export function updateWeather(mesh, simT, spin, sunWorld) {
  const U = mesh.material.uniforms;
  const ride = (spin / (2 * Math.PI)) * CELLS;    // weather rides with the ground
  U.driftA.value.set(ride + simT * WIND_LOW, simT * 2.0e-5);
  U.driftB.value.set(ride + simT * WIND_HIGH, -simT * 3.0e-5);
  U.sunWorld.value.copy(sunWorld).normalize();
}
