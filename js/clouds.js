import * as THREE from 'three';
import { RE } from './constants.js';
import { cumulusTex, cirrusTex } from './textures.js';
import { skyOnly, sky, RES_SCALE } from './halfres.js';

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
/* 192 × 96: a 208 km facet whose chord sags 0.85 km. That would be a wobbling limb on an opaque deck;
   here the mesh only says WHICH pixels the shell covers and where each ray starts, and the ray's
   direction does not care how far along it the surface was. At 512 × 256 the four shell draws put
   half a million vertices through the pipeline every frame for nothing (measured: ~1 ms). */
const SEG_W = 192, SEG_H = 96;
const MARCH = 20;                       // samples through the view column
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
  /* A ray that dips under the cloud base without reaching the ground comes back up through the
     band on the far side, and that far side is the horizon's cloud. Stopping at the base cut it
     off, and the view from inside the band had a hard line where the sky's long white chord met
     short clear ones. Such a ray is marched straight through; the stretch under the base is empty. */
  float dG = A * A - ( C - GROUND_R * GROUND_R );
  bool grounded = A < 0.0 && dG > 0.0;
  if ( C > SHELL_R * SHELL_R )      { tA = -A - sO; tB = grounded ? -A - sI : -A + sO; }   // down through the deck
  else if ( C < BAND_IN * BAND_IN ) { tA = -A + sI; tB = -A + sO; }                        // up from the ground
  else                              { tA = 0.0; tB = grounded ? -A - sI : -A + sO; }       // eye in the band
  if ( tB < tA ) { tA = 0.0; tB = 0.0; }
}

/* Column state, set once per ray by marchCloud and read by cloudAt. */
vec3 gN, gEast, gNorth;
vec2 gUv0;
float gCosLat, gThr, gM, gVeil, gMinif;

/* Cumulus density (0..1) at a point; h comes back as its height in the band, 0 base .. 1 top. */
float cloudAt( vec3 q, float edge, out float h ) {
  float hr = ( length( q ) - BAND_IN ) / BAND_THICK;
  h = clamp( hr, 0.0, 1.0 );
  if ( hr < 0.0 || hr > 1.0 ) return 0.0;
  float f = 0.5;
  if ( gMinif < 0.999 ) {     // unresolved cloud is its coverage: two fetches per sample saved across the far field
    vec2 uvC = tangentUv( gUv0, q - uvOrigin, gN, gEast, gNorth, gCosLat ) * CELL_REPEAT;
    f = 0.5 * ( texture2D( cloudCells, uvC + driftA ).r + texture2D( cloudCells, uvC + driftB ).g );
  }
  /* The threshold climbs with height, so only the strongest cores reach the top of the band:
     every cloud is a dome with a flat base, taller where it is denser. */
  float rise = gThr + ( 0.10 + 0.22 * ( 1.0 - gM ) ) * h;
  float tail = rise > 0.5 ? 2.0 * ( 1.0 - rise ) * ( 1.0 - rise ) : 1.0 - 2.0 * rise * rise;
  return mix( smoothstep( rise - 0.5 * edge, rise + 0.5 * edge, f ), clamp( tail, 0.0, 1.0 ), gMinif ) * smoothstep( 0.0, 0.06, h );
}

/* Optical depth along the ray, composited front to back. tau is the total; tSeen is where along
   the ray the cloud the eye actually lands on is, weighted by what is still unoccluded — from
   above that is the tops, from the pad it is the bases. */
void marchCloud( vec3 o, vec3 d, vec2 uv0, vec3 n, out float tau, out float tSeen ) {
  tau = 0.0; tSeen = 0.0;
  gN = n; gUv0 = uv0;
  gCosLat = max( length( n.xz ), 0.2 );
  gEast = vec3( n.z, 0.0, -n.x ) / max( length( n.xz ), 1e-4 );   // direction of increasing u
  gNorth = cross( n, gEast );                                     // toward the pole
  float tA, tB;
  bandSegment( o, d, tA, tB );
  float len = tB - tA;
  if ( len <= 0.0 ) return;
  float step = len / float( MARCH_SAMPLES );
  /* Texels of the cell lattice under one pixel. Past a few, the sampler's mips have averaged the
     rank field to 0.5 everywhere and a threshold on it is a coin that always lands the same way:
     measured from 4000 km as storm belts gone solid white and everything else gone bare. There the
     density becomes the coverage itself — the exact mean of what the threshold would have drawn. */
  gMinif = smoothstep( 1.5, 5.0, length( fwidth( uvOrigin ) ) * PIXEL_SCALE / TEXEL_KM );
  vec2 uvM = tangentUv( uv0, ( tA + 0.5 * len ) * d + o - uvOrigin, n, gEast, gNorth, gCosLat );
  /* The systems are hundreds of km wide: one macro sample per column is enough. Unresolved, it is
     read two mips down — the sheet is a hard mask, and a hard mask at 20 km per texel seen from
     9000 km is a white continent with a coastline, not weather. */
  gM = smoothstep( 0.08, 0.85 + 0.15 * gMinif, texture2D( cloudMacro, uvM, 4.0 * gMinif ).a );
  gVeil = texture2D( cloudVeil, uvM ).a;
  /* A third, slower look at the same lattice (800 km per tile), read two mips down so only its
     80 km blobs survive, bunches the cover into fields and gaps. Without it every square kilometre
     of a belt carried the same odds and the ocean from orbit was an evenly spaced polka dot. */
  float bunch = 0.5 * ( texture2D( cloudCells, uvM * BUNCH_REPEAT + 0.2 * driftA, 2.0 ).g
                      + texture2D( cloudCells, uvM.yx * ( 0.5 * BUNCH_REPEAT ) + 0.1 * driftB, 2.0 ).r );
  float c = clamp( mix( COVER_CLEAR, COVER_STORM, gM ) * ( 3.4 * bunch - 0.7 ), 0.0, 0.92 );
  /* coverage -> threshold on the mean of two rank-uniform fields (triangular distribution) */
  gThr = c < 0.5 ? 1.0 - sqrt( 0.5 * c ) : sqrt( 0.5 * ( 1.0 - c ) );
  float T = 1.0, tSum = 0.0, wSum = 0.0;
  /* Each pixel starts its samples at a different phase. With a fixed
     phase every ray cuts the band at the same heights and a slanted view draws each puff as a
     stack of plates — measured as visible terraces from 100 km up. Unresolved cloud has no
     terraces to hide, so the jitter fades out with it. */
  /* White noise, not an ordered pattern: this pass is upsampled through a 3x3 tent, which averages
     uncorrelated noise away but leaves an ordered dither's diagonals standing as a weave. */
  float jit = mix( fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ), 0.5, gMinif );
  for ( int i = 0; i < MARCH_SAMPLES; i++ ) {
    float t = tA + ( float( i ) + jit ) * step;
    float h;
    float cu = cloudAt( o + t * d, 0.05, h );
    float ci = gVeil * smoothstep( 0.72, 0.9, h );
    float dt = ( cu * extLow + ci * extHigh ) * step;
    float a = 1.0 - exp( -dt );
    tSum += T * a * t; wSum += T * a;
    T *= 1.0 - a;
    tau += dt;
    if ( T < 0.02 ) break;      // opaque already: nothing behind this can be seen
  }
  if ( wSum > 1e-4 ) tSeen = tSum / wSum;
}
`;

const DEFINES = (samples, pixelScale) => `
#define SHELL_R ${R_OUT.toFixed(1)}
#define BAND_IN ${R_IN.toFixed(1)}
#define GROUND_R ${RE.toFixed(1)}
#define BAND_THICK ${THICK.toFixed(1)}
#define CELL_REPEAT ${CELLS}.0
#define BUNCH_REPEAT ${CELLS / 5}.0
#define TEXEL_KM ${(2 * Math.PI * RE / CELLS / CELL_TEX).toFixed(4)}
#define COVER_CLEAR ${COVER_CLEAR.toFixed(3)}
#define COVER_STORM ${COVER_STORM.toFixed(3)}
#define MARCH_SAMPLES ${samples}
#define PIXEL_SCALE ${pixelScale.toFixed(2)}

uniform sampler2D cloudCells;
uniform sampler2D cloudMacro;
uniform sampler2D cloudVeil;
uniform vec2 driftA;
uniform vec2 driftB;
uniform float extLow;
uniform float extHigh;
uniform vec3 sunWorld;
`;

/* Which of the shell's surfaces owns a pixel. Exactly one does, by construction, so the march can
   run with blending off and the composite can draw both meshes without doubling anything.
   - eye above the band: the outer sphere's near (front) face; its march covers the whole chord;
   - eye below the band: the outer sphere's inside (back) face — unless the ray goes into the ground;
   - eye inside the band: the same back face for rays that stay clear of the ground, and the band's
     FLOOR (the inner sphere) for rays that end on it. Without the floor a camera between 4 and 11 km
     saw clear air beneath it and cloud shadows on the sea with nothing casting them. */
const FACE = /* glsl */`
  float eye2 = dot( cameraPosition, cameraPosition );
  float Ae = dot( cameraPosition, normalize( vWorld - cameraPosition ) );
  bool grounded = Ae < 0.0 && Ae * Ae - ( eye2 - GROUND_R * GROUND_R ) > 0.0;
  #ifdef INNER
    if ( !gl_FrontFacing || eye2 <= BAND_IN * BAND_IN || eye2 >= SHELL_R * SHELL_R || !grounded ) discard;
  #else
    if ( ( eye2 > SHELL_R * SHELL_R ) != gl_FrontFacing ) discard;
    if ( eye2 <= SHELL_R * SHELL_R && grounded ) discard;
  #endif
`;

/* The shell as the MAIN pass draws it: the same geometry, depth-tested at full resolution against
   everything opaque, its colour looked up from the half-resolution march by screen position. */
const LOOKUP_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
#define SHELL_R ${R_OUT.toFixed(1)}
#define BAND_IN ${R_IN.toFixed(1)}
#define GROUND_R ${RE.toFixed(1)}
uniform sampler2D skyMap;
uniform vec2 skyTexel;
uniform vec2 skyScreen;
varying vec3 vWorld;
varying vec2 vUvC;

void main() {
` + FACE + /* glsl */`
  vec2 uv = gl_FragCoord.xy / skyScreen, o = 0.5 * skyTexel;     // 3x3 tent: see js/halfres.js
  vec4 c = 0.25 * ( texture2D( skyMap, uv + o ) + texture2D( skyMap, uv - o )
                  + texture2D( skyMap, uv + vec2( o.x, -o.y ) ) + texture2D( skyMap, uv + vec2( -o.x, o.y ) ) );
  if ( c.a < 0.004 ) discard;
  gl_FragColor = c;
  #include <logdepthbuf_fragment>
}
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
` + DEFINES(MARCH, RES_SCALE) + /* glsl */`
uniform vec3 cloudLit;
uniform vec3 cloudShade;

varying vec3 vWorld;
varying vec2 vUvC;

#define uvOrigin vWorld
` + MARCH_FN + /* glsl */`
void main() {
` + FACE + /* glsl */`
  vec3 n = normalize( vWorld );
  vec3 d = normalize( vWorld - cameraPosition );
  float tau, tSeen;
  marchCloud( cameraPosition, d, vUvC, n, tau, tSeen );
  float alpha = 1.0 - exp( -tau );
  if ( alpha < 0.01 ) discard;

  /* Light is how much cloud stands between the point the eye landed on and the sun: two more looks
     at the field, 0.5 and 1.5 km sunward. From above the eye lands on tops with clear air sunward
     of them (white); from the pad it lands on bases with the whole cloud in the way (grey); from
     the side a puff has a bright flank and a dark one. Nothing else lights these, which is why a
     height-only tone made them read as plates. */
  vec3 seen = cameraPosition + tSeen * d;
  float hs;
  /* The light reads the field through a much wider edge than the march does (0.30 of rank against
     0.05). The seen point moves by up to a sample with the march's jitter, and against a hard edge
     that flipped the cel band pixel to pixel — hatching over every flank. */
  float occ = 0.6 * cloudAt( seen + 0.5 * sunWorld, 0.30, hs ) + 0.4 * cloudAt( seen + 1.5 * sunWorld, 0.30, hs );
  float light = 1.0 - 0.9 * occ * ( 1.0 - gMinif );
  /* Cel tone in three bands, each step softened by its own screen-space width so the bands have
     an edge without a stair. */
  float band = light * 3.0;
  float w = max( fwidth( band ), 0.10 );   // below this the march's own jitter stipples the step
  float tone = ( smoothstep( 1.0 - w, 1.0 + w, band ) + smoothstep( 2.0 - w, 2.0 + w, band ) ) * 0.5;
  float day = smoothstep( -0.12, 0.30, dot( n, sunWorld ) );
  vec3 col = mix( cloudShade, cloudLit, tone ) * ( 0.10 + 0.90 * day );
  gl_FragColor = vec4( col * alpha, alpha );      // premultiplied: this is a layer, not the frame
  #include <logdepthbuf_fragment>
}
`;

/* Ground shade: the same march aimed up the sun ray from the surface point. Injected into the globe
   and the near patch so the darkening on the ground is the cloud column above it. */
const SHADE_FRAG = DEFINES(MARCH_SHADE, 1) + /* glsl */`
uniform float shadeStrength;

varying vec3 vShadeW;

#define uvOrigin vShadeW
` + MARCH_FN + /* glsl */`
void cloudDarken() {
  vec3 n = normalize( vShadeW );
  if ( dot( n, sunWorld ) < 0.02 ) return;                // night side: nothing to shade
  // two-argument atan: GLSL ES has no atan2, and asking for one fails the whole program
  vec2 uv0 = vec2( atan( n.z, -n.x ) / PI2, 1.0 - acos( clamp( n.y, -1.0, 1.0 ) ) / PI );
  float tau, tSeen;
  marchCloud( vShadeW, sunWorld, uv0, n, tau, tSeen );
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
  /* The march: no depth, no blending (one surface per pixel, see FACE), drawn only into the sky
     target. Its 6.7 ms at full resolution is why it lives there. */
  const march = (defines) => new THREE.ShaderMaterial({
    uniforms: U, defines, vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG,
    side: THREE.DoubleSide,       // the sky above the pad is the inside of this shell
    transparent: false, blending: THREE.NoBlending, depthTest: false, depthWrite: false, fog: false,
  });
  /* The lookup: what the main camera draws. fog: false — a planet-scale body, and FogExp2 measured
     from the camera would erase it in the system view 20 000 km out. */
  const lookup = (defines) => new THREE.ShaderMaterial({
    uniforms: sky, defines, vertexShader: SHELL_VERT, fragmentShader: LOOKUP_FRAG,
    side: THREE.DoubleSide, transparent: true, depthWrite: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const outer = new THREE.SphereGeometry(R_OUT, SEG_W, SEG_H), floor = new THREE.SphereGeometry(R_IN, SEG_W, SEG_H);
  const mesh = new THREE.Mesh(outer, march({}));
  mesh.add(new THREE.Mesh(floor, march({ INNER: '' })));
  skyOnly(mesh);
  for (const [geo, defines] of [[outer, {}], [floor, { INNER: '' }]]) {
    const m = new THREE.Mesh(geo, lookup(defines));
    m.renderOrder = 1;            // after terrain and vehicle, before the exhaust and the ribbon
    m.castShadow = false;         // a 7 km sheet at a low sun drags its silhouette hundreds of km
    mesh.add(m);
  }
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
