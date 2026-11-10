import * as THREE from 'three';
import { RE, RM, PAD_UP, PAD_EAST } from './constants.js';
import { C, MOON } from './palette.js';
import { EARTH_GLSL } from './surface-earth.js';
import { MOON_GLSL } from './surface-moon.js';
import { ROADS } from './padsite.js';

/* The ground is drawn per fragment, from data.

   A painted canvas has one resolution. The Earth's was 20 km per texel and the Moon's 2.7, so from
   the pad the ground was one bilinear smear, during ascent a soft strip, and from 110 km of lunar
   orbit a field of 20-pixel texels. What a cel surface needs instead is what a vector drawing has:
   flat tones whose EDGES stay sharp at every zoom. So nothing photographic or painted is sampled
   as colour any more. Each body carries a few smooth data fields (js/earthpaint.js, js/moonpaint.js)
   and the fragment shader thresholds them — with seeded lattice noise on the threshold, an octave
   ladder four apart from 512 km down to 31 m — into flat shapes with a one-pixel anti-aliased edge.

   Three rules hold the look and the cost together:

   - ONE function colours both ground meshes. The globe and the near patch run the same shader on
     the same body-fixed point, so the two cannot disagree (agents.md: the patch and the globe are
     one surface). Where the patch is up, the globe's fragments under it are discarded before any
     of this runs: with a logarithmic depth buffer there is no early-z, and paying twice was most
     of the first measurement.
   - An octave exists only where it is resolved. Each fades out as its cell drops under ~30 pixels
     and is not evaluated at all under ~9, so there is no speckle at any range and the far planet
     costs two noise reads, not eight.
   - Precision is local. A float32 body-fixed position has a 0.5 m grid at the Earth's radius,
     which is 20 pixels under a pad camera. The patch's vertices are differenced against an anchor
     in the vertex stage and every lattice is addressed as (local offset) + (integer cell of the
     anchor), computed in doubles here — same field, no grid.

   The noise is a uint hash on integer cells, not a texture: a texture's bilinear weights are 8-bit,
   which staircases any threshold drawn across a cell that covers more than ~250 pixels. */

const lin = (c) => {
  const f = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return `vec3(${f(c[0]).toFixed(5)}, ${f(c[1]).toFixed(5)}, ${f(c[2]).toFixed(5)})`;
};
const palette = (o) => Object.entries(o).map(([k, v]) => `#define K_${k.toUpperCase()} ${lin(v)}`).join('\n');

export const CELLS = {
  earth: [512, 128, 32, 8, 2, 0.5, 0.125, 0.03125],
  moon: [256, 64, 16, 4, 1, 0.25, 0.0625, 0.015625],
};
const ANCHOR_STEP = 8;                 // km: the patch anchor snaps to this lattice

/* The lattice noise, shared by both stages: the patch evaluates its coarse octaves per VERTEX (a
   32 km cell is hundreds of vertices wide there) and hands them down as varyings; the globe, whose
   vertices are 104 km apart, evaluates everything per fragment. Same function, same numbers. */
const NOISE = /* glsl */`
uniform ivec3 sfCellI[8];
uniform vec3 sfCellF[8];

uint sfMix( uint n ) {
  n = ( n ^ ( n >> 15 ) ) * 2246822519u;
  return n ^ ( n >> 13 );
}
uint sfH( ivec3 c, uint s ) {
  return sfMix( uint( c.x ) * 374761393u ^ uint( c.y ) * 668265263u ^ uint( c.z ) * 1274126177u ^ s * 2654435761u );
}
/* One lattice corner's share of two independent fields at offset d from it: a gradient term plus a
   value term. Value noise alone has zero slope across every lattice plane, which the relief shading
   drew as straight-edged facets (measured from 400 km over Italy); gradient noise alone is exactly
   0.5 at every lattice point, which pins every contour to the grid. The sum has neither tell. */
vec2 sfV( uint h, vec3 d ) {
  uint h2 = h * 747796405u + 2891336453u;
  vec3 g1 = vec3( float( h & 255u ), float( ( h >> 8 ) & 255u ), float( ( h >> 16 ) & 255u ) ) * ( 2.0 / 255.0 ) - 1.0;
  vec3 g2 = vec3( float( h2 >> 24 ), float( ( h2 >> 16 ) & 255u ), float( ( h2 >> 8 ) & 255u ) ) * ( 2.0 / 255.0 ) - 1.0;
  vec2 v = vec2( float( h >> 24 ), float( ( h2 ^ ( h2 >> 17 ) ) & 255u ) ) * ( 1.0 / 255.0 );
  return 0.5 + 0.62 * vec2( dot( g1, d ), dot( g2, d ) ) + 0.36 * ( v - 0.5 );
}
/* two independent noise fields, centred on 0.5, from eight corner hashes that share their
   per-axis products (14 multiplies for the cell, not 32) */
vec2 sfN( vec3 q, ivec3 off, uint s ) {
  vec3 fl = floor( q );
  vec3 f = q - fl;
  ivec3 i = ivec3( fl ) + off;
  vec3 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  uvec3 K = uvec3( 374761393u, 668265263u, 1274126177u );
  uvec3 p0 = uvec3( i ) * K, p1 = uvec3( i + 1 ) * K;
  uint b = s * 2654435761u;
  uint y0 = p0.y ^ p0.z ^ b, y1 = p1.y ^ p0.z ^ b, y2 = p0.y ^ p1.z ^ b, y3 = p1.y ^ p1.z ^ b;
  vec2 a = mix( sfV( sfMix( p0.x ^ y0 ), f ), sfV( sfMix( p1.x ^ y0 ), f - vec3( 1.0, 0.0, 0.0 ) ), u.x );
  vec2 c = mix( sfV( sfMix( p0.x ^ y1 ), f - vec3( 0.0, 1.0, 0.0 ) ), sfV( sfMix( p1.x ^ y1 ), f - vec3( 1.0, 1.0, 0.0 ) ), u.x );
  vec2 d = mix( sfV( sfMix( p0.x ^ y2 ), f - vec3( 0.0, 0.0, 1.0 ) ), sfV( sfMix( p1.x ^ y2 ), f - vec3( 1.0, 0.0, 1.0 ) ), u.x );
  vec2 e = mix( sfV( sfMix( p0.x ^ y3 ), f - vec3( 0.0, 1.0, 1.0 ) ), sfV( sfMix( p1.x ^ y3 ), f - vec3( 1.0 ) ), u.x );
  return mix( mix( a, c, u.y ), mix( d, e, u.y ), u.z );
}
/* The cheap one: two value-noise fields, no gradient term. Good enough wherever only a CONTOUR of
   the field is drawn; anything shaded by slope must use sfN. */
vec2 sfNv( vec3 q, ivec3 off, uint s ) {
  vec3 fl = floor( q );
  vec3 f = q - fl;
  ivec3 i = ivec3( fl ) + off;
  vec3 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  uvec3 K = uvec3( 374761393u, 668265263u, 1274126177u );
  uvec3 p0 = uvec3( i ) * K, p1 = uvec3( i + 1 ) * K;
  uint b = s * 2654435761u;
  uint y0 = p0.y ^ p0.z ^ b, y1 = p1.y ^ p0.z ^ b, y2 = p0.y ^ p1.z ^ b, y3 = p1.y ^ p1.z ^ b;
  uvec4 hA = uvec4( sfMix( p0.x ^ y0 ), sfMix( p1.x ^ y0 ), sfMix( p0.x ^ y1 ), sfMix( p1.x ^ y1 ) );
  uvec4 hB = uvec4( sfMix( p0.x ^ y2 ), sfMix( p1.x ^ y2 ), sfMix( p0.x ^ y3 ), sfMix( p1.x ^ y3 ) );
  vec4 ax = vec4( hA & 65535u ), ay = vec4( hA >> 16 ), bx = vec4( hB & 65535u ), by = vec4( hB >> 16 );
  vec2 lo = mix( mix( vec2( ax.x, ay.x ), vec2( ax.y, ay.y ), u.x ), mix( vec2( ax.z, ay.z ), vec2( ax.w, ay.w ), u.x ), u.y );
  vec2 hi = mix( mix( vec2( bx.x, by.x ), vec2( bx.y, by.y ), u.x ), mix( vec2( bx.z, by.z ), vec2( bx.w, by.w ), u.x ), u.y );
  return mix( lo, hi, u.z ) * ( 1.0 / 65535.0 );
}
`;

const COMMON = /* glsl */`
uniform vec3 sfAnchor;
uniform vec3 sfSun;
uniform vec4 sfHole;
uniform float sfLocal;
uniform sampler2D sfField;
varying vec3 vSfL;
varying float vSfH;
varying vec2 vSfUv;
varying vec4 vSfA;
varying vec4 vSfB;
varying vec3 vSfS;

/* a threshold with a one-pixel edge: the flat-tone brush everything here is drawn with */
float sfAA( float thr, float x ) {
  float w = max( fwidth( x ) * 0.7, 1e-6 );
  return smoothstep( thr - w, thr + w, x );
}
float sfRidge( float n ) { return 1.0 - abs( 2.0 * n - 1.0 ); }
`;

const VERT_PARS = /* glsl */`
uniform vec3 sfCentre;
uniform vec3 sfOff;
uniform vec3 sfAnchor;
uniform vec3 sfSun;
attribute vec2 sfUv;
varying vec3 vSfL;
varying float vSfH;
varying vec2 vSfUv;
varying vec4 vSfA;
varying vec4 vSfB;
varying vec3 vSfS;
`;

/* `vtx`: the octaves (cell km, seed) each mesh evaluates per VERTEX instead of per fragment — every
   cell listed is at least five vertices wide at that mesh's coarsest spacing (patch: 1.4 km on
   Earth, 1.9 km on the Moon; globe: 10.7 km on the Moon; the Earth's globe is 104 km a vertex, too coarse for any octave). `fn` is the noise they use. */
const BODIES = {
  earth: { R: RE, glsl: EARTH_GLSL, fn: 'sfN', slope: [[1, 'x', 'x'], [2, 'y', 'y'], [3, 'y', 'z']], vtx: { patch: [[512, 11], [128, 12], [32, 13], [8, 14]], globe: [] },
    lit: true,
    pal: palette({ ...C, snow: [244, 248, 250], steppe: [170, 160, 100], shallow: [128, 196, 226], aqua: [166, 220, 226], foam: [238, 246, 248], lake: [72, 148, 204], wheat: [206, 190, 112], crop: [138, 172, 84], soil: [152, 124, 90],
      // biomes the vote does not name: the tropics' forest, and the dry grass between pasture and steppe
      jungle: [40, 112, 52], savanna: [158, 162, 86], marsh: [112, 126, 78],
      // water masses, the bar inside the shallows, and the sun's glare and core on the sea
      tropic: [34, 104, 172], coldsea: [30, 72, 122], bar: [146, 208, 228],
      forest: [66, 116, 60],
      // the site's inked ground: js/toon.js PALETTE.gravel / .asphalt, so the drawn crawlerway meets the built one
      gravel: [191, 174, 140], asphalt: [74, 79, 87] })
      /* Light that is not paint. A lit toon surface shows albedo × (sun + sky) / π — about a third
         of what the palette says, which every tone here was chosen under. Foam and the sun on the
         sea are the two things that must come out white, so they are written past 1 in linear. */
      + '\n#undef K_FOAM\n#define K_FOAM vec3( 2.3, 2.4, 2.45 )\n#define K_GLARE vec3( 0.75, 1.45, 2.05 )\n#define K_GLINT vec3( 2.9, 3.0, 3.0 )' },
  moon: { R: RM, glsl: MOON_GLSL, fn: 'sfNv', vtx: { patch: [[256, 31], [64, 32], [16, 33]], globe: [[256, 31], [64, 32]] },
    pal: palette({
      // the regolith palette after the ×1.5 contrast curve the painted canvas applies about 140
      maria: MOON.maria.map((v) => (v - 140) * 1.5 + 140), mid: MOON.mid.map((v) => (v - 140) * 1.5 + 140),
      high: MOON.high.map((v) => (v - 140) * 1.5 + 140), bright: MOON.bright.map((v) => (v - 140) * 1.5 + 140),
    }) },
};

const surfaces = new Map();

/* One per body: the shared textures, and two uniform sets — `globe` (anchor zero, carries the hole
   the patch covers) and `patch` (anchored, local precision). Textures are allocated at their final
   size with a neutral fill and written in place when the paint job lands: a late-bound sampler would
   need a recompile behind a cache key (agents.md), a late-filled one needs nothing. */
export function surface(key) {
  let S = surfaces.get(key);
  if (S) return S;
  const tex = {};
  const set = (local) => {
    const U = {
      sfAnchor: { value: new THREE.Vector3() },
      /* A patch's vertices are stored from its own centre (js/terrain.js): sfCentre puts the planet
         back for the things that need a direction or a height, and sfOff = centre − anchor, taken
         in doubles here, is all the lattices ever see. Both are zero for the globe. */
      sfCentre: { value: new THREE.Vector3() }, sfOff: { value: new THREE.Vector3() },
      sfCellI: { value: new Int32Array(24) },
      sfCellF: { value: new Float32Array(24) },
      sfSun: { value: new THREE.Vector3(1, 0, 0) },
      sfHole: { value: new THREE.Vector4(0, 1, 0, 2) },
      sfEye: { value: new THREE.Vector3(0, 0, 1e6) },
      sfLocal: { value: local },
      sfMareCut: { value: 0.36 },
    };
    return U;
  };
  S = { key, R: BODIES[key].R, globe: set(0), patch: set(1), tex };
  if (key === 'earth') {
    tex.sfField = dataTex(new Uint8Array(2048 * 1024 * 4), 2048, 1024, THREE.RGBAFormat, THREE.UnsignedByteType, true);
    tex.sfCoast = dataTex(new Uint16Array(2048 * 1024).fill(THREE.DataUtils.toHalfFloat(1000)), 2048, 1024, THREE.RedFormat, THREE.HalfFloatType, false);
    tex.sfPadSdf = dataTex(new Uint16Array(PAD_N * PAD_N * 2).fill(THREE.DataUtils.toHalfFloat(1000)), PAD_N, PAD_N, THREE.RGFormat, THREE.HalfFloatType, false);
    tex.sfPadSdf.wrapS = THREE.ClampToEdgeWrapping;
    /* the site at 39 m: shore, wood lots, ocean side. Filled a moment after boot (fillSite); until
       then it reads "land, no woods, far from the ocean". */
    const blank = new Uint16Array(SITE_N * SITE_N * 4), hf = THREE.DataUtils.toHalfFloat;
    for (let i = 0; i < blank.length; i += 4) { blank[i] = hf(-1); blank[i + 1] = hf(-1); blank[i + 2] = hf(-4); blank[i + 3] = hf(0); }
    tex.sfSite = dataTex(blank, SITE_N, SITE_N, THREE.RGBAFormat, THREE.HalfFloatType, false);
    tex.sfSite.wrapS = THREE.ClampToEdgeWrapping;
    const road = new Float32Array(ROADS.length * 4), kind = new Float32Array(ROADS.length);
    ROADS.forEach((r, i) => { road.set(r.slice(0, 4), i * 4); kind[i] = r[5]; });
    const north = new THREE.Vector3().crossVectors(PAD_UP, PAD_EAST).normalize();
    for (const U of [S.globe, S.patch]) {
      U.sfPadUp = { value: PAD_UP.clone() }; U.sfPadE = { value: PAD_EAST.clone() }; U.sfPadN = { value: north };
      U.sfPadO = { value: new THREE.Vector2() };
      U.sfRoad = { value: road }; U.sfRoadKind = { value: kind };
    }
  } else {
    tex.sfField = dataTex(new Uint8Array(1024 * 512 * 4).fill(128), 1024, 512, THREE.RGBAFormat, THREE.UnsignedByteType, true);
  }
  for (const U of [S.globe, S.patch]) for (const k in tex) U[k] = { value: tex[k] };
  surfaces.set(key, S);
  return S;
}

export const PAD_N = 512;              // texels across the authored launch-site distance field
export const SITE_N = 512;             // and across the site's own ±10 km

function dataTex(data, w, h, format, type, mips) {
  const t = new THREE.DataTexture(data, w, h, format, type);
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mips;
  if (mips) t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/* Write a landed product into its texture, in place. `rows north-first` grids (the coast field) are
   flipped here: a DataTexture's row 0 is v = 0, the south pole. */
export function fillField(key, bytes) {
  const t = surface(key).tex.sfField;
  t.image.data.set(bytes); t.needsUpdate = true;
}
export function fillCoast(grid) {
  const t = surface('earth').tex.sfCoast, d = t.image.data, { w, h, km } = grid;
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w, dst = y * w;
    for (let x = 0; x < w; x++) d[dst + x] = THREE.DataUtils.toHalfFloat(Math.max(-60000, Math.min(60000, km[src + x])));
  }
  t.needsUpdate = true;
}
export function fillPadSdf(km) {
  const t = surface('earth').tex.sfPadSdf, d = t.image.data;
  for (let i = 0; i < km.length; i++) d[i] = THREE.DataUtils.toHalfFloat(km[i]);
  t.needsUpdate = true;
}

export function fillSite(rgba) {
  const t = surface('earth').tex.sfSite, d = t.image.data;
  for (let i = 0; i < rgba.length; i++) d[i] = THREE.DataUtils.toHalfFloat(Number.isFinite(rgba[i]) ? rgba[i] : 0);
  t.needsUpdate = true;
}

/* The anchor of a patch: its centre snapped to an 8 km lattice, plus — per octave — the integer
   cell and the fraction of a cell the anchor sits at, in doubles. The shader adds the fraction to a
   small local offset and the integer to the cell index, so no lattice is ever addressed through a
   float32 of planetary magnitude. */
export function anchorPatch(key, cx, cy, cz) {
  const S = surface(key), U = S.patch, cells = CELLS[key];
  const a = [Math.round(cx / ANCHOR_STEP) * ANCHOR_STEP, Math.round(cy / ANCHOR_STEP) * ANCHOR_STEP, Math.round(cz / ANCHOR_STEP) * ANCHOR_STEP];
  U.sfAnchor.value.set(a[0], a[1], a[2]);
  U.sfCentre.value.set(cx, cy, cz); U.sfOff.value.set(cx - a[0], cy - a[1], cz - a[2]);
  for (let k = 0; k < 8; k++) for (let c = 0; c < 3; c++) {
    const q = a[c] / cells[k], i = Math.floor(q);
    U.sfCellI.value[k * 3 + c] = i; U.sfCellF.value[k * 3 + c] = q - i;
  }
  if (U.sfPadO) U.sfPadO.value.set(
    a[0] * PAD_EAST.x + a[1] * PAD_EAST.y + a[2] * PAD_EAST.z,
    a[0] * U.sfPadN.value.x + a[1] * U.sfPadN.value.y + a[2] * U.sfPadN.value.z);
}

/* The globe's hole: fragments within `km` of ground distance from (x,y,z) are the patch's to draw.
   km <= 0 closes it. */
export function setHole(key, x, y, z, km) {
  const S = surface(key);
  S.globe.sfHole.value.set(x, y, z, km > 0 ? Math.cos(km / S.R) : 2);
}

export function setSun(key, x, y, z) {
  const S = surface(key);
  S.globe.sfSun.value.set(x, y, z); S.patch.sfSun.value.set(x, y, z);
}

/* The eye, planet-centred in the body's own axes: the sun's reflection on the sea needs it. */
export function setEye(key, x, y, z) {
  const S = surface(key);
  S.globe.sfEye.value.set(x, y, z); S.patch.sfEye.value.set(x, y, z);
}

/* Splice the ground shader into a toon material's program. `which` is 'globe' or 'patch'. The
   geometry must carry `sfUv`, the body's equirectangular uv (unwrapped across the dateline). */
export function surfaceInject(sh, key, which) {
  const S = surface(key), B = BODIES[key], U = S[which];
  for (const k in U) sh.uniforms[k] = U[k];
  const list = B.vtx[which];
  const def = (which === 'patch' ? '#define SF_PATCH\n' : '') + '#define SF_VTX ' + list.length + '\n';
  let coarse = '\n  vec3 sfLp = vSfL - normalize( position + sfCentre ) * vSfH;\n  vSfA = vec4( 0.5 ); vSfB = vec4( 0.5 );';
  list.forEach(([cell, seed], k) => {
    coarse += `\n  vSf${k < 2 ? 'A' : 'B'}.${k % 2 ? 'zw' : 'xy'} = ${B.fn}( sfLp / ${cell.toFixed(1)} + sfCellF[${k}], sfCellI[${k}], ${seed}u );`;
  });
  /* Relief is shaded by its slope toward the sun. On the globe that slope is a screen derivative of
     the fragment's own height; on a patch the coarse octaves are per-vertex, a derivative of them is
     constant per triangle (measured: sawtooth shading over the Alps from 12 km), so the patch
     differences each octave's ridge toward the sun in the vertex stage instead. */
  if (which === 'patch' && B.slope) {
    coarse += '\n  vec3 sfDn = normalize( position + sfCentre );\n  vec3 sfSt = sfSun - sfDn * dot( sfSun, sfDn );\n  sfSt /= max( length( sfSt ), 0.05 );\n  vSfS = vec3( 0.0 );';
    B.slope.forEach(([k, ch, comp]) => {
      const [cell, seed] = list[k];
      coarse += `\n  vSfS.${comp} = ( ( 1.0 - abs( 2.0 * ${B.fn}( ( sfLp + sfSt * ${(cell * 0.02).toFixed(4)} ) / ${cell.toFixed(1)} + sfCellF[${k}], sfCellI[${k}], ${seed}u ).${ch} - 1.0 ) ) - ( 1.0 - abs( 2.0 * vSf${k < 2 ? 'A' : 'B'}.${k % 2 ? (ch === 'x' ? 'z' : 'w') : ch} - 1.0 ) ) ) * 50.0;`;
    });
  } else coarse += '\n  vSfS = vec3( 0.0 );';
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\n' + def + VERT_PARS + NOISE)
    .replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  vSfL = position + sfOff;\n  vSfH = length( position + sfCentre ) - ' + B.R.toFixed(1) + ';\n  vSfUv = sfUv;' + coarse);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\n' + def + '#define SF_R ' + B.R.toFixed(1) + '\n' + B.pal + '\n' + NOISE + COMMON + B.glsl)
    .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb = sfColour();');
  /* the Earth's ground carries its own daylight (see js/surface-earth.js): the sun's term is cut by it */
  if (B.lit) sh.fragmentShader = sh.fragmentShader
    .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.directDiffuse *= sfLit;\n  reflectedLight.indirectDiffuse += sfTwi * diffuseColor.rgb;');
}
