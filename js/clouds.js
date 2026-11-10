import * as THREE from 'three';
import { RE } from './constants.js';
import { cellField, macroField, veilField, TILE, MACRO_W, MIX1, MIX2, MIX3, W1, W2, W3, WV, SYN_Z, STREET_KM, STREET_AMP, STREET_DEG } from './cloudfields.js';
import { skyOnly, sky, RES_SCALE } from './halfres.js';

/* Weather is ONE field on ONE mesh, and a cloud is a DRAWN SHAPE: an opaque surface with an edge,
   two or three flat tones, and nothing in between.

   The shell is a sphere at RE + 11 km over a band that starts at RE + 4 km. js/cloudfields.js
   defines one scalar field F over the planet; there is cloud wherever F > THR + RISE * h, with h
   the height in the band (0 base, 1 top). So every cloud is a height field on a flat base — taller
   where the field is stronger — and the fragment shader finds where the view ray first enters it:
   a few coarse steps, then a bisection. It does not integrate a density, so there is no soft edge
   to dither and no jitter to hide a march's terraces behind.

   What leaves the half-resolution pass is not a colour. It is four numbers per pixel —
       r  light: how clear the path sunward of the hit is, 0 buried .. 1 open (times coverage)
       g  haze: how much air lies between the eye and the hit
       b  the high veil
       a  coverage as a RAMP through 0.5 at the silhouette, about two pixels wide
   — and the main pass, at full resolution, turns them into ink: coverage is thresholded at 0.5,
   light is cut into three tones. A bilinear-upsampled ramp thresholded per pixel is a clean edge
   at the screen's resolution (the trick distance-field type uses), where an upsampled colour is a
   blur. That is why the clouds can be marched at a quarter of the pixels and still have a line.

   Detail follows the eye for free. Each read of the tile is taken at the mip matching the pixel's
   footprint at that distance, so an octave too fine to resolve averages to its mean and leaves
   the sum: from the pad F carries 1 km billows, from 500 km cells and fields, from 20 000 km only
   the macro sheet's systems. The outline simplifies; it never dissolves and never pops.

   The field itself is not the same at every altitude, though. What is right from the pad — 8 % of
   fair-weather cumulus wherever there is no system — is, from 500 km, an even sprinkle of dots over
   the whole planet. So the uniform `orbit` (0 below 50 km of EYE altitude, 1 above 200) carries
   the field from the macro sheet's red channel to its blue one, the synoptic sheet: fronts, commas,
   streets, decks, and empty sky between them. Everything else that says `orbit` below is the
   same idea — the drawing an orbital eye needs, switched in on that one clock, and worth exactly
   nothing at the pad: the strip-shaped footprint toward the limb, the two-sided coverage ramp, the
   relief of whole systems instead of billows. */

const BAND_BASE = 4;                    // km: cloud base
const BAND_TOP = 11;                    // km: cloud top
const R_IN = RE + BAND_BASE;            // 6375
const R_OUT = RE + BAND_TOP;            // 6382, the shell's own radius
const THICK = BAND_TOP - BAND_BASE;     // 7 km
const CU_THICK = 3;                     // km: the cumulus layer, base to its flat-topped tallest
const VEIL_ALT = 10;                    // km: the high veil
/* Tile repeats round the equator for the three octaves: 1000, 160 and 32 km per tile. The third
   octave is read with its axes swapped so its lobes never line up with the second's. */
const REP1 = 40, REP2 = 250, REP3 = 1250;
const KM_PER_U = 2 * Math.PI * RE;      // 40 030 km of equator per unit u
const TEX_KM = (rep) => KM_PER_U / rep / TILE;
/* 192 x 96: a 208 km facet whose chord sags 0.85 km. The mesh only says WHICH pixels the shell
   covers and where each ray starts, and the ray's direction does not care how far along it the
   surface was. */
const SEG_W = 192, SEG_H = 96;
const MAX_STEPS = 20;                   // strides through the band, at most; overhead rays take 3
const STRIDE_MIN = 0.2;                 // km of ground: no stride needs to be shorter than the smallest billow
/* The threshold climbs this much from base to top: a field value 0.3 over the threshold is a
   tower that reaches 11 km. */
const RISE = 0.30;
/* The billows count for more the higher up they are: at the base they only scallop the outline,
   at the top they are the turrets. 1 + TURRET at the ceiling. */
const TURRET = 3.0;
const RELIEF = 1.6;                     // how hard the field's slope leans the light: 1 is true to the rms slope
const RIM = 0.08;                       // field excess over which a base goes from lit rim to dark middle
const NEAR = 0.015;                     // a miss this close to the threshold gets one more look where it came closest
const SHADE = 0.40;                     // how far a cloud's shadow darkens the ground: one flat tone
const HAZE_KM = 220;                    // e-folding length of the air between eye and cloud
/* The eye's altitude over which the weather goes from the pad's drawing to the orbital one (the
   uniform `orbit`, 0 .. 1). Below ORBIT_LO nothing in this file behaves differently from before. */
const ORBIT_LO = 50, ORBIT_HI = 200;

/* Winds, m/s eastward relative to the ground. The octaves slide past each other, so shapes build
   and fade instead of merely translating; the billows ride with the cells they sit on, nearly. */
const WIND1 = 6, WIND2 = 14, WIND3 = 16;

const CLOUD_LIT = new THREE.Color(0xffffff);
const CLOUD_MID = new THREE.Color(0xc9d8ee);
const CLOUD_SHADE = new THREE.Color(0x8499bd);   // bases and buried flanks
const CLOUD_DUSK = new THREE.Color(0xffc9a4);    // what the lit tone becomes at the terminator
const CLOUD_NIGHT = new THREE.Color(0x121a2a);
const CLOUD_HAZE = new THREE.Color(0xc3dbf0);    // distant cloud goes to the colour of the air

const f4 = (v) => v.toFixed(4);
const vec4 = (a) => `vec4( ${a.map(f4).join(', ')} )`;

let _defines = null;
function defines() {
  if (_defines) return _defines;
  const C = cellField();
  return _defines = `
#define SHELL_R ${R_OUT.toFixed(1)}
#define BAND_IN ${R_IN.toFixed(1)}
#define GROUND_R ${RE.toFixed(1)}
#define CU_R ${(R_IN + CU_THICK).toFixed(1)}
#define BAND_THICK ${CU_THICK.toFixed(1)}
#define VEIL_R ${(RE + VEIL_ALT).toFixed(1)}
#define REP1 ${REP1}.0
#define REP2 ${REP2}.0
#define REP3 ${REP3}.0
#define TEX1_KM ${f4(TEX_KM(REP1))}
#define TEX2_KM ${f4(TEX_KM(REP2))}
#define TEX3_KM ${f4(TEX_KM(REP3))}
#define MACRO_KM ${f4(KM_PER_U / MACRO_W)}
#define MIX1 ${vec4(MIX1)}
#define MIX2 ${vec4(MIX2)}
#define MIX3 ${vec4(MIX3)}
#define W1 ${f4(W1)}
#define W2 ${f4(W2)}
#define W3 ${f4(W3)}
#define MEAN2 ${f4(C.mean[1])}
#define MEAN3 ${f4(C.mean[2])}
#define TOP2 ${f4(C.top[1])}
#define TOP3 ${f4(C.top[2])}
#define GRAD_KM vec3( ${f4(W1 * C.slope[0] / TEX_KM(REP1))}, ${f4(W2 * C.slope[1] / TEX_KM(REP2))}, ${f4(W3 * C.slope[2] / TEX_KM(REP3))} )
#define BUMP3 ${f4(2 * W3 * C.sigma[2])}
#define MEANSUM ${f4(C.meanSum)}
#define SIG2 vec3( ${[W1, W2, W3].map((w, i) => (w * w * C.sigma[i] * C.sigma[i]).toFixed(6)).join(', ')} )
#define SIG_ALL ${f4(Math.hypot(W1 * C.sigma[0], W2 * C.sigma[1], W3 * C.sigma[2]))}
#define INV_K0SQ vec3( ${C.k0.map(k => (1 / (k * k)).toFixed(6)).join(', ')} )
#define THR ${f4(C.thr)}
#define WM ${f4(C.wm)}
#define WV ${f4(WV)}
#define SYN_A ${f4(2 * SYN_Z * Math.hypot(W1 * C.sigma[0], W2 * C.sigma[1], W3 * C.sigma[2]))}
#define SYN_B ${f4(C.thr - C.q50)}
#define STREET_KM ${f4(STREET_KM)}
#define STREET_AMP ${f4(STREET_AMP)}
#define STREET_UV vec2( ${f4(Math.sin(STREET_DEG * Math.PI / 180) * KM_PER_U / STREET_KM)}, ${f4(-Math.cos(STREET_DEG * Math.PI / 180) * KM_PER_U / 2 / STREET_KM)} )
#define FMAX ${f4(C.fmax)}
#define RISE ${f4(RISE)}
#define TURRET ${f4(TURRET)}

uniform sampler2D cloudCells;
uniform sampler2D cloudMacro;
uniform sampler2D cloudVeil;
uniform vec2 drift1;
uniform vec2 drift2;
uniform vec2 drift3;
uniform float macroRide;
uniform float orbit;
uniform vec3 sunWorld;
`;
}

/* The field, shared by the shell and by the ground shade. uv is equirectangular (v = 0 is the
   south pole); a sample gets its uv by projecting its displacement from the column's origin onto
   local east and north — a linear shift, so no atan or acos per sample.
   NOTE for whoever edits this: it lives inside a JS template literal, so a backtick in a comment
   ends the shader. */
const FIELD_FN = /* glsl */`
/* Column state, set once per pixel by setColumn. */
vec3 gEast, gNorth;
vec2 gUv0, gCell0;
float gCosLat;

/* Two maps of the same sphere. The planet sheets are equirectangular. The tile is read in
   MERCATOR: conformal, so a cell is as tall as it is wide at every latitude (it just gets smaller
   toward the poles). Read equirectangularly, the tile kept its height while its width shrank with
   cos(latitude), and everything north of 45 degrees was drawn as north-south streaks. Because the
   cells shrink, every length the cell field deals in is in EQUATORIAL km: true km / cos(lat). */
void setColumn( vec2 uv0, vec3 n ) {
  gUv0 = uv0;
  gCosLat = max( length( n.xz ), 0.2 );
  gCell0 = vec2( uv0.x, log( tan( 0.25 * PI + 0.5 * clamp( ( uv0.y - 0.5 ) * PI, -1.37, 1.37 ) ) ) / PI2 );
  gEast = vec3( n.z, 0.0, -n.x ) / max( length( n.xz ), 1e-4 );   // direction of increasing u
  gNorth = cross( n, gEast );                                     // toward the pole
}

vec2 uvAt( vec3 q ) {
  vec3 disp = q - uvOrigin;
  return vec2( gUv0.x + dot( disp, gEast ) / ( PI2 * SHELL_R * gCosLat ),
               gUv0.y + dot( disp, gNorth ) / ( PI * SHELL_R ) );
}

vec2 cellAt( vec3 q ) {
  vec3 disp = q - uvOrigin;
  return gCell0 + vec2( dot( disp, gEast ), dot( disp, gNorth ) ) / ( PI2 * SHELL_R * gCosLat );
}

float lodOf( float fkm, float texKm ) { return log2( max( fkm / texKm, 1.0 ) ); }

/* Everything that depends only on HOW WIDE a footprint the field is wanted at (km), worked out
   once and handed to every read made at that footprint:
     lod    the mip of each octave whose texel is the footprint;
     fade   how much of octaves 2 and 3 is left — past mip ~6 a 512-texel tile is its own mean, the
            read is skipped, and the last mip and a half fade it out so nothing pops;
     keep   how much of each octave's SLOPE survives: all of it while the octave is magnified, less
            and less once its lobes are smaller than the footprint;
     gain   see below. */
struct Foot { vec3 lod; vec2 fade; vec3 keep; float gain; };

/* A blurred field has less contrast, and a threshold on it would cover less sky: far cloud would
   thin out and vanish. The departure from the mean is scaled back up by what the mips took
   (gain), so the fraction covered is the same at every footprint and only the outline gets simpler. */
Foot footOf( float fkm ) {
  Foot F;
  vec3 k = fkm / vec3( TEX1_KM, TEX2_KM, TEX3_KM );
  F.lod = log2( max( k, 1.0 ) );
  F.fade = 1.0 - smoothstep( 5.0, 6.5, F.lod.yz );
  F.keep = 1.0 / ( 1.0 + k * k / 64.0 );
  vec3 f = vec3( 1.0, F.fade );
  F.gain = min( SIG_ALL / sqrt( dot( SIG2, f * f / ( 1.0 + k * k * INV_K0SQ ) ) + 1e-8 ), 4.0 );
  /* From orbit the cover is the synoptic sheet's business (macroAt), and cells too small to see are
     allowed to go: an edge that was scalloped becomes the sheet's own contour. Holding their
     contrast up here drew the mip's residue of a repeating tile as a weave across every system. */
  F.gain = mix( F.gain, 1.0, orbit );
  return F;
}

/* The three octaves, read separately: the walk reads the first at three points of a ray and the
   third only near a surface. */
float cells1( vec2 uv, Foot F ) {
  return W1 * dot( textureLod( cloudCells, uv * REP1 + drift1, F.lod.x ), MIX1 );
}

float cells2( vec2 uv, Foot F ) {
  if ( F.fade.x <= 0.0 ) return W2 * MEAN2;
  return W2 * mix( MEAN2, dot( textureLod( cloudCells, uv * REP2 + drift2, F.lod.y ), MIX2 ), F.fade.x );
}

/* the billows, as a departure from their mean */
float cells3( vec2 uv, Foot F ) {
  if ( F.fade.y <= 0.0 ) return 0.0;
  return W3 * F.fade.y * ( dot( textureLod( cloudCells, uv.yx * REP3 + drift3, F.lod.z ), MIX3 ) - MEAN3 );
}

float macroAt( vec3 q, float fkm ) {
  vec2 uv = uvAt( q ) + vec2( macroRide, 0.0 );
  vec4 m = textureLod( cloudMacro, uv, lodOf( fkm, MACRO_KM ) );
  /* Red is the weather as the pad sees it: it moves the cover between 8 % and 72 %. Blue is the
     weather as orbit sees it (js/cloudfields.js, the synoptic sheet): it moves the threshold
     SYN_Z standard deviations either side of the cell sum's median, so its systems are solid, the
     sky between them is empty, and the cells are the texture of an edge. Same texel, no extra read.
     Alpha is where the air is combed into streets: crests ride the wind, a little off the
     parallel and mirrored across the equator, meandering with the variety sheet. */
  float syn = m.b - 0.5;
  if ( orbit > 0.0 && m.a > 0.004 )
    syn += STREET_AMP * m.a * sin( PI2 * ( STREET_UV.x * uv.x + STREET_UV.y * abs( uv.y - 0.5 ) ) + 14.0 * m.g ) * ( 1.0 - smoothstep( 0.12 * STREET_KM, 0.35 * STREET_KM, fkm ) );
  return mix( WM * m.r, SYN_B + SYN_A * syn, orbit ) + WV * ( m.g - 0.5 );
}

/* Signed field: positive inside cloud. The threshold climbs with the SQUARE of the height, so a
   cloud's wall is steep at its foot and rounds over at its top; the billows count for more the
   higher up they are. Below the base there is no cloud. c1 is the first octave at q, which the
   caller may already have. */
float fieldD( vec3 q, Foot F, float c1, float mac ) {
  float hr = ( length( q ) - BAND_IN ) / BAND_THICK;
  if ( hr < 0.0 ) return -1.0;
  vec2 uv = cellAt( q );
  return ( c1 + cells2( uv, F ) + W3 * MEAN3 + ( 1.0 + TURRET * hr ) * cells3( uv, F ) - MEANSUM ) * F.gain + MEANSUM + mac - THR - RISE * hr * hr;
}
`;

/* The segment of the ray inside the cloud band. Three regimes: eye outside the shell (orbit), eye
   below the cloud base (the pad), eye inside the band (flying through it).
   TWO out-scalars, deliberately: this once handed back a float array, and a GLSL ES parameter is
   IN unless it says otherwise — an array written through an in parameter is a local copy, so the
   caller kept its zeros and the whole shell discarded itself with no error anywhere. */
const SEGMENT_FN = /* glsl */`
void bandSegment( vec3 o, vec3 d, out float tA, out float tB ) {
  tA = 0.0; tB = 0.0;
  float A = dot( o, d );
  float C = dot( o, o );
  float dO = A * A - ( C - CU_R * CU_R );
  if ( dO <= 0.0 ) return;
  float sO = sqrt( dO );
  if ( -A + sO <= 0.0 ) return;                                           // the layer is behind the eye
  float dI = A * A - ( C - BAND_IN * BAND_IN );
  if ( dI <= 0.0 ) { tA = max( -A - sO, 0.0 ); tB = -A + sO; return; }   // never dips below the base
  float sI = sqrt( dI );
  /* A ray that dips under the cloud base without reaching the ground comes back up through the
     layer on the far side, and that far side is the horizon's cloud. Such a ray is walked straight
     through; the stretch under the base is empty. */
  float dG = A * A - ( C - GROUND_R * GROUND_R );
  bool grounded = A < 0.0 && dG > 0.0;
  if ( C > CU_R * CU_R )            { tA = -A - sO; tB = grounded ? -A - sI : -A + sO; }   // down through the deck
  else if ( C < BAND_IN * BAND_IN ) { tA = -A + sI; tB = -A + sO; }                        // up from the ground
  else                              { tA = 0.0; tB = grounded ? -A - sI : -A + sO; }       // eye in the layer
  if ( tB < tA ) { tA = 0.0; tB = 0.0; }
}
`;

/* Which of the shell's surfaces owns a pixel. Exactly one does, by construction, so the march can
   run with blending off and the composite can draw both meshes without doubling anything.
   - eye above the band: the outer sphere's near (front) face; its march covers the whole chord;
   - eye below the band: the outer sphere's inside (back) face — unless the ray goes into the ground;
   - eye inside the band: the same back face for rays that stay clear of the ground, and the band's
     FLOOR (the inner sphere) for rays that end on it. Without the floor a camera between 4 and 11 km
     saw clear air beneath it and cloud shadows on the sea with nothing casting them. */
const FACE = /* glsl */`
  vec3 d = rayDir();
  float eye2 = dot( camAbs, camAbs );
  float Ae = dot( camAbs, d );
  bool grounded = Ae < 0.0 && Ae * Ae - ( eye2 - GROUND_R * GROUND_R ) > 0.0;
  #ifdef INNER
    if ( !gl_FrontFacing || eye2 <= BAND_IN * BAND_IN || eye2 >= SHELL_R * SHELL_R || !grounded ) discard;
  #else
    if ( ( eye2 > SHELL_R * SHELL_R ) != gl_FrontFacing ) discard;
    if ( eye2 <= SHELL_R * SHELL_R && grounded ) discard;
  #endif
`;

const SHELL_VERT = /* glsl */`
#include <common>
/* The weather is computed in the EARTH-FIXED frame, which is also the frame the scene is drawn in
   (js/origin.js): eyeFixed is the eye there, from doubles in JS. vWorld is the shell's surface
   under the pixel, and it is only good to half a metre (see RAY_FN, which is why no ray is built
   from it any more): the composite uses it for the one thing that does not care, the side of the
   planet the sun is on. */
uniform mat3 fixRot;
uniform vec3 eyeFixed;
#include <logdepthbuf_pars_vertex>

varying vec3 vWorld;
varying vec2 vUvC;

void main() {
  vWorld = eyeFixed + fixRot * ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  vUvC   = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  #include <logdepthbuf_vertex>
}
`;

/* The view ray of a pixel, from the pixel and the camera alone.

   It used to be normalize( vWorld - eye ), with vWorld the shell's own surface under the pixel. That
   surface is a vertex 6 382 km from the planet's centre minus an eye 6 371 km from it, in float32:
   each vertex lands on a half-metre step, and WHICH step depends on the last bit of a matrix that is
   rebuilt every frame (the shell does not turn with the ground, so in the Earth-fixed axes the scene
   is drawn in, its matrix does). Half a metre on a surface 11 km overhead is a twentieth of a
   half-resolution pixel of noise, new every frame, in every ray — and a hard threshold turns noise
   in its argument into flips along its whole outline. Measured on an idle pad with the wind, the
   sun and the macro ride all held still, so that nothing the weather reads was changing: 884 pixels
   of 2.7 million flipped A-B-A in ten frames.

   A ray built from gl_FragCoord has no large numbers in it. The mesh now only says which pixels
   the shell covers; where the ray meets the shell is solved, not interpolated. */
const RAY_FN = /* glsl */`
uniform mat4 rayInv;      // the camera's inverse projection
uniform vec2 rayScale;    // 2 / the size in pixels of the target being drawn into
vec3 rayDir() {
  /* the pixel on the NEAR plane: unprojected on the far one, w is 500 - 500 in float32 and the ray is NaN */
  vec4 v = rayInv * vec4( gl_FragCoord.xy * rayScale - 1.0, -1.0, 1.0 );
  return normalize( v.xyz / v.w * mat3( viewMatrix ) );          // v M = transpose( M ) v: view to world
}
`;

/* The march. Writes ( light, haze, veil, coverage ) — see the header. */
const MARCH_MAIN = /* glsl */`
void main() {
` + FACE + /* glsl */`
  vec3 o = camAbs;
  /* the point of the surface being drawn (the outer sphere, or the band's floor) on this ray */
  #ifdef INNER
    float sR = BAND_IN;
  #else
    float sR = SHELL_R;
  #endif
  float sDisc = Ae * Ae - ( eye2 - sR * sR );
  if ( sDisc < 0.0 ) discard;                       // the mesh's facets overhang the sphere by a sliver at the limb
  gOrigin = o + ( eye2 > sR * sR ? -Ae - sqrt( sDisc ) : -Ae + sqrt( sDisc ) ) * d;
  vec3 n = normalize( gOrigin );
  float pix = length( fwidth( d ) );        // radians across one pixel of THIS pass
  /* uv from the Earth-fixed direction, not from the mesh's own uv: the shell never turns, so its uv
     is inertial and the planet would slide under the weather at 409 m/s. Same map as the shade. */
  setColumn( vec2( atan( n.z, -n.x ) / PI2, 1.0 - acos( clamp( n.y, -1.0, 1.0 ) ) / PI ), n );
  float tA, tB;
  bandSegment( o, d, tA, tB );
  float len = tB - tA;
  float cov = 0.0, light = 1.0, haze = 0.0, veil = 0.0;

  if ( len > 0.0 ) {
    /* Seen from above at a slant, a pixel is not a disc of ground but a strip: t pix wide and
       t pix / cos( zenith ) long. Everything below read the field at the strip's WIDTH, so toward the
       limb each row of pixels sampled ground 100 km from the row above it in a field blurred to
       6 km — rows of unrelated dashes, the blocks on the horizon. From orbit the field is read at
       half the strip's length instead; a lobe the strip cannot hold fades into the sheet's contour. */
    float sinz = length( cross( d, n ) );
    float muz = sqrt( max( 1.0 - sinz * sinz, 1e-4 ) ), limb = smoothstep( 0.0, 0.3, orbit );
    float strip = mix( 1.0, clamp( 0.5 / muz, 1.0, 16.0 ), limb );
    float track = 0.7 * len * sinz;          // the sheet is read at three points of the ray: nothing finer than their spacing
    float m0 = macroAt( o + tA * d, max( tA * pix * strip, track ) ), m1 = macroAt( o + tB * d, max( tB * pix * strip, track ) );
    /* the parameter is not called x: slow.x is in the body, and the preprocessor would rewrite it */
    #define SLOW(at) ( ( at ) < 0.5 ? mix( slow.x, slow.y, 2.0 * ( at ) ) : mix( slow.y, slow.z, 2.0 * ( at ) - 1.0 ) )
    {
      float cpix = pix / gCosLat;                       // the pixel in the cell field's own km
      /* The walk: even strides along the ray's GROUND track, as many as that track is long, and
         the field read no finer than one stride. That last part is what keeps a cloud whole: a
         lobe narrower than the stride is caught by some rays and jumped by their neighbours, and
         the eye sees the slices the samples happened to cut (measured: a stack of plates from the
         pad, combs on every flank). Blurred to the stride, no lobe is narrower than it. An
         overhead ray stays in one column, takes three looks and keeps every billow; a grazing one
         crosses 200 km of band and draws its clouds in broad shapes, which is all its pixels hold. */
      float ground = len * sinz / gCosLat;
      float tMid = tA + 0.5 * len;
      float steps = clamp( ceil( 2.0 * ground / max( tMid * cpix, STRIDE_MIN ) ) + 2.0, 3.0, float( MAX_STEPS ) );
      /* ONE footprint for the whole ray, taken at its middle: the far end of a ray from the pad is
         under twice as far as the near end, and a field that changed scale along the ray would
         have a different threshold at each step. */
      Foot F = footOf( max( tMid * cpix * strip, 2.0 * ground / steps ) );
      /* The slow part of the field — the macro sheets and the first octave, whose smallest lobe
         is 30 km — is read at the two ends of the ray and at its middle and interpolated between,
         instead of at every step. And if the slow part is so low all along the ray that the
         other two octaves at their highest could not lift it over the threshold, there is no
         cloud on this ray and the walk is not taken at all: most of a fair-weather sky. */
      float mM = macroAt( o + tMid * d, max( tMid * pix * strip, track ) );
      vec3 slow = vec3( m0, mM, m1 ) + F.gain * vec3( cells1( cellAt( o + tA * d ), F ), cells1( cellAt( o + tMid * d ), F ), cells1( cellAt( o + tB * d ), F ) );
      float most = F.gain * ( W2 * mix( MEAN2, TOP2, F.fade.x ) + W3 * ( MEAN3 + ( 1.0 + 0.35 * TURRET ) * F.fade.y * ( TOP3 - MEAN3 ) ) - MEANSUM ) + MEANSUM - THR;
      float t = tA, lastT = tA, hitT = tA, hitD = 0.0, best = -1.0, bestT = tA, d0 = -1.0, d1 = -1.0;
      float loT = tA, loD = -1.0;                     // the last place the ray was known to be outside, and the field there
      bool hit = false, first = false, crest = false;
      if ( max( slow.x, max( slow.y, slow.z ) ) + most > 0.0 )
      for ( int i = 0; i <= MAX_STEPS; i++ ) {
        float fi = float( i );
        if ( fi > steps ) break;
        float x = mix( 0.012, 0.988, fi / steps );
        t = tA + len * x;
        vec3 q = o + t * d;
        vec2 uv = cellAt( q );
        float hr = ( length( q ) - BAND_IN ) / BAND_THICK;
        float D = ( cells2( uv, F ) + W3 * MEAN3 - MEANSUM ) * F.gain + MEANSUM + SLOW( x ) - THR - RISE * hr * hr;
        /* the billows are read only where they could decide the answer */
        float tw = F.gain * ( 1.0 + TURRET * hr );
        if ( D + tw * BUMP3 > 0.0 ) D += tw * cells3( uv, F );
        if ( D > 0.0 ) { hit = true; first = i == 0; hitT = t; hitD = D; loT = lastT; loD = d1; break; }
        if ( D > best ) { best = D; bestT = t; }
        /* Three samples in a row with the middle one highest: the field crested BETWEEN samples, and
           a parabola through them says where and how high. If that crest may have broken the
           surface it is looked at NOW, before the walk goes on. It used to be looked at only when
           the whole ray had missed — so a lobe standing in front of a larger cloud was drawn on the
           frames a sample happened to land in it and skipped on the others, and as the wind carried
           it between the samples the pixel went from the lobe's tone to the cloud's and back. */
        float bend = 2.0 * d1 - d0 - D;
        if ( i > 1 && d1 >= d0 && d1 >= D && bend > 1e-5 ) {
          float peak = d1 + ( d0 - D ) * ( d0 - D ) / ( 8.0 * bend );
          float off = 0.5 * ( D - d0 ) / bend, tp = lastT + off * ( t - lastT );
          if ( peak > -NEAR ) {
            peak = fieldD( o + tp * d, F, 0.0, SLOW( ( tp - tA ) / len ) );
            if ( peak > 0.0 ) {
              hit = true; crest = true; hitT = tp; hitD = peak;
              loT = off > 0.0 ? lastT : 2.0 * lastT - t; loD = off > 0.0 ? d1 : d0;
              break;
            }
          }
          if ( peak > best ) { best = peak; bestT = tp; }
        }
        d0 = d1; d1 = D;
        lastT = t;
      }
      float stride = 0.976 * len / steps, hitT0 = hitT, loD0 = loD;
      /* Between the last sample outside and the first inside: two looks by false position, and the
         surface is where the chord through the last pair crosses zero — a place that moves smoothly
         when the field does. The midpoint of a bisection moved in quarter-strides, and the tone
         band read there moved with it. */
      if ( hit && !first && hitT > loT ) {
        float lo = loT, hi = hitT, Dl = min( loD, -1e-5 ), Dh = hitD;
        for ( int k = 0; k < 2; k++ ) {
          float tm = lo + ( hi - lo ) * clamp( Dl / ( Dl - Dh ), 0.1, 0.9 );
          float Dm = fieldD( o + tm * d, F, 0.0, SLOW( ( tm - tA ) / len ) );
          if ( Dm > 0.0 ) { hi = tm; Dh = Dm; } else { lo = tm; Dl = min( Dm, -1e-5 ); }
        }
        hitT = lo + ( hi - lo ) * Dl / ( Dl - Dh );
      }
      t = hit ? hitT : bestT;
      float edge = max( F.gain * dot( GRAD_KM, F.keep ) * t * cpix, 1e-4 );         // field units across one pixel
      float hh = clamp( ( length( o + t * d ) - BAND_IN ) / BAND_THICK, 0.0, 1.0 );
      bool above = dot( o, o ) > CU_R * CU_R;
      /* Coverage is a ramp through 0.5 AT the silhouette, and it has to be ONE ramp, continuous from
         the miss side to the hit side. The quantity is the highest the field stands over its
         threshold anywhere along the ray: under zero the ray missed, at zero it grazes.
         - A hit seen from ABOVE: the threshold climbs RISE h^2 from the base, so a ray that struck
           the cloud h up the layer is over a column whose field stands RISE h^2 clear of the outline.
         - A flank from below or from inside the layer used to write 1 on a hit and at most 0.5 on a
           miss. A pixel on the outline therefore read 0.5 or 1.0 according to which side of zero an
           estimate fell, and its edge on the screen jumped a pixel each time: measured in the
           half-resolution target on an idle pad, coverage series such as 255 255 129 129 255 129
           255. Now a hit that is not clearly inside looks one stride further on: if the field is
           still climbing the ray is going in, and if it has turned the three values give the
           crest. A crest found by the walk already is its own answer. */
      float wide = edge + ( 2.0 * RISE * hh + F.gain * TURRET * BUMP3 * F.fade.y ) * t * pix / BAND_THICK;   // ...and across one pixel of HEIGHT
      if ( above ) cov = hit ? clamp( 0.5 + RISE * hh * hh / ( 4.0 * edge ), 0.5, 1.0 )
                                  : clamp( 0.5 + best / ( 2.0 * max( fwidth( best ), edge ) ), 0.0, 0.5 );
      else {
        float top = hit ? hitD : best;
        if ( hit && !crest && hitD < 2.0 * wide && hitT0 + stride < tB ) {
          float Dn = fieldD( o + ( hitT0 + stride ) * d, F, 0.0, SLOW( ( hitT0 + stride - tA ) / len ) );
          float bend = 2.0 * hitD - loD0 - Dn;
          top = Dn >= hitD || first ? max( Dn, hitD ) : hitD + ( loD0 - Dn ) * ( loD0 - Dn ) / ( 8.0 * max( bend, 1e-5 ) );
        }
        cov = clamp( 0.5 + top / ( 2.0 * wide ), 0.0, 1.0 );
      }
      /* The last sliver before the horizon, seen from orbit: the whole 3 km layer is under a pixel
         tall there, edge on, and whatever is drawn in it is a row of half-resolution dashes. It is
         let go — the ray through the ground's own horizon meets the shell at cos 0.059. */
      cov *= mix( 1.0, smoothstep( 0.05, 0.10, muz ), limb );
      if ( cov > 0.01 ) {
        vec3 p = o + t * d, up = normalize( p );
        float su = dot( up, sunWorld );
        if ( hit && first && dot( o, o ) <= CU_R * CU_R ) {
          /* A base seen from under it (or the inside of a cloud): dark where the cloud above is
             deep, paling to a lit rim where it thins — the one place a cloud is translucent. */
          light = mix( 0.72, 0.12, smoothstep( 0.0, RIM, hitD ) );
        } else {
          /* A top or a flank: the cloud is a height field, so its normal is its slope, and one
             more read of the field a short way toward the sun gives the slope along the only
             direction that matters. It is read at the PIXEL's footprint, finer than the walk's
             when the ray is slanted — the walk finds the mass, this draws the billows on it —
             and the probe lengthens with the pixel, so from orbit it reads the relief of whole
             fields. Only octaves 2 and 3 are read: over a probe this short the first is flat.
             Tops are treated as if they were never cut flat at the layer's ceiling — a plateau
             with no relief is a white plate. */
          vec3 sh = sunWorld - su * up;
          /* From orbit: under a high sun a height field has no shaded side at all and every system
             was one white plate, so the light is leaned east by at least a third; and the relief is
             read three pixels wide, which draws a top in patches of tone instead of in specks. */
          sh += 0.35 * orbit * ( 1.0 - smoothstep( 0.15, 0.5, length( sh ) ) ) * gEast;
          float fl = max( t * cpix * strip * ( 1.0 + 2.0 * orbit ), 1e-4 ), reach = max( 0.5, 4.0 * fl );
          Foot L = footOf( fl );
          /* From orbit, once a pixel is wider than a billow, the relief worth drawing is the FIRST
             octave's — the 30 to 100 km lobes of a system's top — and the billows' two reads are
             spent on it instead. */
          float wide = orbit * smoothstep( 4.5, 5.5, L.lod.z );
          float tw = ( 1.0 + TURRET * clamp( ( length( p ) - BAND_IN ) / BAND_THICK, 0.0, 1.0 ) ) * ( 1.0 - wide );
          vec2 uv = cellAt( p ), uvS = cellAt( p + reach * gCosLat / max( length( sh ), 1e-3 ) * sh );
          /* ...and the second octave, by then a mip's residue of a tile that repeats every 160 km,
             counts for what is left of it instead of being scaled back up to full relief */
          float w2 = mix( 1.0, min( 1.0, 3.0 * L.keep.y ), wide );
          float dF = w2 * W2 * L.fade.x * dot( textureLod( cloudCells, uvS * REP2 + drift2, L.lod.y ) - textureLod( cloudCells, uv * REP2 + drift2, L.lod.y ), MIX2 );
          if ( tw > 0.0 ) dF += tw * ( cells3( uvS, L ) - cells3( uv, L ) );
          if ( wide > 0.0 ) dF += wide * ( cells1( uvS, L ) - cells1( uv, L ) );
          /* in units of the field's own rms slope at this footprint: the same drawing at every range */
          float a = RELIEF * ( 1.0 - 0.4 * wide ) * dF / reach / max( dot( GRAD_KM, L.keep * vec3( wide, w2, tw ) ), 1e-5 );
          light = 0.5 + 0.5 * ( su - a * length( sh ) ) / sqrt( 1.0 + a * a );
        }
        float mu = abs( dot( up, d ) );
        haze = 1.0 - exp( -min( t, 10.0 / max( mu, 0.02 ) ) / HAZE_KM );
      }
    }
  }

  /* The veil: one thin sheet at 10 km, drawn where the ray crosses it. */
  {
    float Rc = VEIL_R;
    float A = dot( o, d ), C = dot( o, o ), disc = A * A - ( C - Rc * Rc );
    if ( disc > 0.0 ) {
      float tc = C > Rc * Rc ? -A - sqrt( disc ) : -A + sqrt( disc );
      if ( tc > 0.0 ) {
        vec3 pc = o + tc * d;
        vec2 uvc = uvAt( pc );
        float fkm = tc * pix;
        float sheet = textureLod( cloudVeil, uvc + vec2( macroRide, 0.0 ), lodOf( fkm, 2.0 * MACRO_KM ) ).r;
        float ls = lodOf( fkm, VEIL_TEX_KM );
        float streak = mix( textureLod( cloudCells, uvc * VEIL_REP + driftV, ls ).r, 0.5, smoothstep( 3.0, 5.0, ls ) );
        float mu = abs( dot( normalize( pc ), d ) );
/* Switched off: seen from above the veil is a fan of pale parallel streaks lying over sea and land
           that reads as a rendering fault, not as cirrus (user screenshot, ~40 km looking down). The
           sheet stays computed so turning it back on is this one factor. */
        veil = 0.0 * clamp( sheet * ( 0.35 + 0.9 * streak ), 0.0, 1.0 ) * exp( -min( tc, 10.0 / max( mu, 0.02 ) ) / HAZE_KM );
      }
    }
  }
  /* light goes out multiplied by coverage. The composite reads this target bilinearly, and a plain
     light let the pixels just OUTSIDE an outline — coverage near zero, light whatever the nearest
     miss happened to read, or the default — vote on the tone of the outline's own pixels. */
  gl_FragColor = vec4( light * cov, haze, veil, cov );
  #include <logdepthbuf_fragment>
}
`;

/* The shell as the MAIN pass draws it: the same geometry, depth-tested at full resolution against
   everything opaque. This is where the four numbers become a drawing. */
const LOOKUP_FRAG = /* glsl */`
#include <common>
uniform vec3 eyeFixed;
#define camAbs eyeFixed
#include <logdepthbuf_pars_fragment>
#define SHELL_R ${R_OUT.toFixed(1)}
#define BAND_IN ${R_IN.toFixed(1)}
#define GROUND_R ${RE.toFixed(1)}
uniform sampler2D skyMap;
uniform vec2 skyScreen;
uniform vec3 sunWorld;
uniform vec3 cloudLit;
uniform vec3 cloudMid;
uniform vec3 cloudShade;
uniform vec3 cloudDusk;
uniform vec3 cloudNight;
uniform vec3 cloudHaze;
varying vec3 vWorld;
varying vec2 vUvC;

` + RAY_FN + /* glsl */`
/* A step with an edge one screen pixel wide, whatever the slope of the thing being stepped. */
float cut( float at, float v ) {
  float w = clamp( fwidth( v ), 0.004, 0.25 );
  return smoothstep( at - w, at + w, v );
}

void main() {
` + FACE + /* glsl */`
  vec4 c = texture2D( skyMap, gl_FragCoord.xy / skyScreen );
  c.r /= max( c.a, 0.02 );                  // light was written times coverage: see the march
  float a = cut( 0.5, c.a );
  float sd = dot( normalize( vWorld ), sunWorld );
  float day = smoothstep( -0.10, 0.14, sd );
  vec3 lit = mix( cloudDusk, cloudLit, smoothstep( 0.02, 0.32, sd ) );
  vec3 col = mix( mix( cloudShade, cloudMid, cut( 0.36, c.r ) ), lit, cut( 0.62, c.r ) );
  col = mix( cloudNight, col, day );
  vec3 air = mix( cloudNight, cloudHaze, day );
  col = mix( col, air, 0.8 * c.g );
  a *= 1.0 - 0.55 * c.g;
  float va = 0.16 * cut( 0.36, c.b ) + 0.16 * cut( 0.58, c.b );
  vec3 vcol = mix( cloudNight, lit, day );
  /* premultiplied; whichever layer is nearer the eye goes over the other */
  vec4 cu = vec4( col * a, a ), ve = vec4( vcol * va, va );
  vec4 px = eye2 > BAND_IN * BAND_IN ? ve + cu * ( 1.0 - va ) : cu + ve * ( 1.0 - a );
  if ( px.a < 0.004 ) discard;
  gl_FragColor = px;
  #include <logdepthbuf_fragment>
}
`;

const VEIL_REP = [40, 320];             // the tile stretched 16:1 along longitude: streaks
const SHELL_FRAG = /* glsl */`
#include <common>
uniform vec3 eyeFixed;
#define camAbs eyeFixed
#include <logdepthbuf_pars_fragment>
` + defines() + /* glsl */`
#define VEIL_REP vec2( ${VEIL_REP[0]}.0, ${VEIL_REP[1]}.0 )
#define VEIL_TEX_KM ${f4(KM_PER_U / 2 / VEIL_REP[1] / TILE)}
#define HAZE_KM ${HAZE_KM.toFixed(1)}
#define MAX_STEPS ${MAX_STEPS}
#define STRIDE_MIN ${STRIDE_MIN.toFixed(2)}
#define RIM ${f4(RIM)}
#define NEAR ${f4(NEAR)}
#define RELIEF ${f4(RELIEF)}
uniform vec2 driftV;

vec3 gOrigin;
#define uvOrigin gOrigin
` + RAY_FN + FIELD_FN + SEGMENT_FN + MARCH_MAIN;

/* Ground shade: is there cloud on the sun ray from this point? Two looks — where the ray crosses
   the base, which is the cloud's own outline, and half way up, which is where a low sun's ray
   meets a tower's flank — and one flat tone. Injected into the globe and the near patch. */
const SHADE_FN = /* glsl */`
void cloudDarken() {
  vec3 n = normalize( vShadeW );
  float sd = dot( n, sunWorld );
  if ( sd < 0.02 ) return;                                // night side: nothing to shade
  // two-argument atan: GLSL ES has no atan2, and asking for one fails the whole program
  setColumn( vec2( atan( n.z, -n.x ) / PI2, 1.0 - acos( clamp( n.y, -1.0, 1.0 ) ) / PI ), n );
  float fkm = max( 2.0 * min( length( dFdx( vShadeW ) ), length( dFdy( vShadeW ) ) ), 0.03 ) / gCosLat;   // ground under this pixel, in the cell field's km
  float A = dot( vShadeW, sunWorld ), C = dot( vShadeW, vShadeW );
  float r1 = BAND_IN + 0.05 * BAND_THICK, r2 = BAND_IN + 0.45 * BAND_THICK;
  vec3 p1 = vShadeW + ( -A + sqrt( A * A - C + r1 * r1 ) ) * sunWorld;
  vec3 p2 = vShadeW + ( -A + sqrt( A * A - C + r2 * r2 ) ) * sunWorld;
  float mac = macroAt( p1, fkm * gCosLat );
  Foot F = footOf( fkm );
  float c1 = cells1( cellAt( p1 ), F );
  float D = max( fieldD( p1, F, c1, mac ), fieldD( p2, F, c1, mac ) );
  float w = 2.0 * F.gain * dot( GRAD_KM, F.keep ) * fkm;
  /* from orbit a shadow is drawn only where the march would draw its cloud: the half of the ramp
     under the threshold belonged to clouds smaller than a pixel, and left specks on an empty sea */
  gl_FragColor.rgb *= 1.0 - shadeStrength * smoothstep( mix( -w, 0.5 * w, orbit ), mix( w, 2.5 * w, orbit ), D ) * smoothstep( 0.02, 0.12, sd );
}
`;
const SHADE_FRAG = defines() + /* glsl */`
uniform float shadeStrength;

varying vec3 vShadeW;

#define uvOrigin vShadeW
` + FIELD_FN + SHADE_FN;

export function makeWeather() {
  return {
    cloudCells: { value: cellField().tex },
    cloudMacro: { value: macroField().tex },
    cloudVeil: { value: veilField() },
    drift1: { value: new THREE.Vector2() },
    drift2: { value: new THREE.Vector2() },
    drift3: { value: new THREE.Vector2() },
    driftV: { value: new THREE.Vector2() },
    macroRide: { value: 0 },
    orbit: { value: 0 },
    cloudLit: { value: CLOUD_LIT },
    cloudMid: { value: CLOUD_MID },
    cloudShade: { value: CLOUD_SHADE },
    cloudDusk: { value: CLOUD_DUSK },
    cloudNight: { value: CLOUD_NIGHT },
    cloudHaze: { value: CLOUD_HAZE },
    shadeStrength: { value: SHADE },
    sunWorld: { value: new THREE.Vector3(0, 1, 0) },     // in the Earth-fixed frame, like everything here
    fixRot: { value: new THREE.Matrix3() }, eyeFixed: { value: new THREE.Vector3(0, 7000, 0) },
    rayInv: { value: new THREE.Matrix4() }, rayScale: { value: new THREE.Vector2(1, 1) },
  };
}

export function makeCloudShell(U) {
  /* The march: no depth, no blending (one surface per pixel, see FACE), drawn only into the sky
     target. */
  const march = (defs) => new THREE.ShaderMaterial({
    uniforms: U, defines: defs, vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG,
    side: THREE.DoubleSide,       // the sky above the pad is the inside of this shell
    transparent: false, blending: THREE.NoBlending, depthTest: false, depthWrite: false, fog: false,
  });
  /* The lookup: what the main camera draws. fog: false — a planet-scale body, and FogExp2 measured
     from the camera would erase it in the system view 20 000 km out. */
  const inkU = { skyMap: sky.skyMap, skyScreen: sky.skyScreen, fixRot: U.fixRot, eyeFixed: U.eyeFixed, rayInv: U.rayInv, rayScale: U.rayScale };
  for (const k of ['sunWorld', 'cloudLit', 'cloudMid', 'cloudShade', 'cloudDusk', 'cloudNight', 'cloudHaze']) inkU[k] = U[k];
  const lookup = (defs) => new THREE.ShaderMaterial({
    uniforms: inkU, defines: defs, vertexShader: SHELL_VERT, fragmentShader: LOOKUP_FRAG,
    side: THREE.DoubleSide, transparent: true, depthWrite: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const outer = new THREE.SphereGeometry(R_OUT, SEG_W, SEG_H), floor = new THREE.SphereGeometry(R_IN, SEG_W, SEG_H);
  const mesh = new THREE.Mesh(outer, march({}));
  mesh.add(new THREE.Mesh(floor, march({ INNER: '' })));
  skyOnly(mesh);
  for (const [geo, defs] of [[outer, {}], [floor, { INNER: '' }]]) {
    const m = new THREE.Mesh(geo, lookup(defs));
    m.renderOrder = 1;            // after terrain and vehicle, before the exhaust and the ribbon
    m.castShadow = false;         // a 7 km sheet at a low sun drags its silhouette hundreds of km
    mesh.add(m);
  }
  /* What rayDir() needs, for the camera and the target of the pass each mesh is about to be drawn
     in: the march goes into the half-resolution target, the lookup onto the screen. */
  const size = new THREE.Vector2();
  const aim = (renderer, scene, camera) => {
    U.rayInv.value.copy(camera.projectionMatrixInverse);
    const rt = renderer.getRenderTarget();
    if (rt) size.set(rt.width, rt.height); else renderer.getDrawingBufferSize(size);
    U.rayScale.value.set(2 / size.x, 2 / size.y);
  };
  mesh.traverse((o) => { o.onBeforeRender = aim; });
  return mesh;
}

/* Add the weather shade to an already-built material's program. three keys its program cache on
   onBeforeCompile.toString(), so one material carries exactly ONE onBeforeCompile: world.js
   composes this with the haze and the coastline ink inside a single function. The uniforms are
   bound at compile time, so no customProgramCacheKey is needed — see the magenta-probe note in
   AGENTS.md for what happens when they are not. */
export function cloudShadeInject(sh, U) {
  for (const key of ['cloudCells', 'cloudMacro', 'drift1', 'drift2', 'drift3', 'macroRide', 'orbit',
    'shadeStrength', 'sunWorld']) sh.uniforms[key] = U[key];
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nuniform mat3 fixRot;\nuniform vec3 eyeFixed;\nvarying vec3 vShadeW;')
    .replace('#include <project_vertex>',
      '#include <project_vertex>\n  vShadeW = eyeFixed + fixRot * ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
  sh.uniforms.fixRot = U.fixRot; sh.uniforms.eyeFixed = U.eyeFixed;
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\n' + SHADE_FRAG)
    /* before fog_fragment: the shade darkens the ground, and any haze laid over it afterwards is
       unshadowed air. The include is in the template whether or not the material uses fog. */
    .replace('#include <fog_fragment>', '  cloudDarken();\n#include <fog_fragment>');
}

/* The shell's mesh never turns; the weather moves through these offsets. A ground point's inertial
   u is its own u plus spin / 2 pi, so a sheet that is to stay over the ground is read at
   u - spin / 2 pi: the offsets carry MINUS the ride, plus a wind. Each is reduced to its
   fraction in double precision here — the tile repeats, and a float32 uniform holding 1250 turns
   has nothing left for the metres. */
export function updateWeather(mesh, simT, spin, sunWorld) {
  const U = mesh.material.uniforms;
  /* No spin term: the shaders already work in the planet's frame, so the drift is the wind alone. */
  const ride = 0, fr = (x) => x - Math.floor(x);
  const wind = (ms, rep) => -(ride + simT * ms / 1000 / KM_PER_U) * rep;      // tile-uv, eastward drift
  U.drift1.value.set(fr(wind(WIND1, REP1)), fr(simT * 1.0e-6));
  U.drift2.value.set(fr(wind(WIND2, REP2)), fr(-simT * 1.0e-5));
  U.drift3.value.set(fr(simT * 2.5e-5), fr(wind(WIND3, REP3)));              // axes swapped: u rides in y
  U.driftV.value.set(fr(wind(30, VEIL_REP[0])), 0);
  U.macroRide.value = fr(-ride - simT * 4 / 1000 / KM_PER_U);
  U.sunWorld.value.copy(sunWorld).normalize().applyAxisAngle(Y_AXIS, -spin);
  U.fixRot.value.identity();     // the scene itself is drawn in Earth-fixed axes now (js/origin.js): nothing left to turn
  lastSpin = spin;
}
const Y_AXIS = new THREE.Vector3(0, 1, 0);
let lastSpin = 0;
/* Once per frame, with the eye the frame is drawn from (the same one js/origin.js uses). */
export function setWeatherEye(U, eye) {
  U.eyeFixed.value.copy(eye).applyAxisAngle(Y_AXIS, -lastSpin);
  /* ...and how far up it is decides which weather is drawn. It is the eye's altitude, not the
     ship's: every pixel of a frame, and the shade on the ground under it, reads the same field. */
  U.orbit.value = THREE.MathUtils.smoothstep(eye.length() - RE, ORBIT_LO, ORBIT_HI);
}
