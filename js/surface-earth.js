import { ROADS, SITE, SITE_HALF } from './padsite.js';

/* The Earth's ground, drawn. Spliced into the globe and the near patch by js/surface.js, which owns
   the preamble (sfN, sfAA, the anchor) and explains why this is a shader and not a texture.

   Inputs: sfField (R aridity, G tree cover, B cold, A ruggedness — js/earthpaint.js), sfCoast (signed
   km to the coast, negative inland), the authored launch site (js/padsite.js: sfPadSdf, the shore
   over ±72 km; sfSite, shore / wood lots / ocean side over ±10 km at 39 m; sfRoad, the road
   segments) and eight octaves of lattice noise, cells 512 km … 31 m.

   What is drawn, coarse to fine:
   - biome: grass / savanna / forest / jungle / boreal / steppe / sand / tundra / ice, each a
     threshold on a field with the octaves on the threshold — so a border is a fractal line, and
     groves and clearings appear at every scale a border passes through;
   - relief: a ridged height built from the same octaves, scaled by the real ruggedness, shaded in
     two flat bands by its slope toward the sun; rock above the tree line and snow above that;
   - the sea: water masses by latitude (tropic / temperate / cold) and by depth (rise / plain /
     abyss), then the coast's own bands (ocean, shelf, shallows, bar, surf), pack ice, and the
     sun's reflection — three nested hard-edged shapes round the specular point, broken by the
     octaves the way a glitter path is broken by swell;
   - the launch site: wood lots, marsh on the lagoon banks, beach on the ocean's, the crawlerway
     and the roads as inked lines at their own width or 1.3 px, the causeway's fill over water;
   - patch tones: one lighter and one darker flat tone per resolved octave.

   Everything is a flat tone behind an anti-aliased edge; nothing is a gradient or a grain.

   sfLit and sfTwi are the daylight on the ground, read by the lighting stage (js/surface.js). The
   toon ramp alone lit the night side at 34–72 % of noon — a ramp shades a FORM, and a planet's
   night side is not the shadow side of a form, it is in the planet's own shadow. On the pad at
   night the shadow box (3 km) happened to hide that and everything beyond it glowed green. So the
   sun's term is cut to nothing where the sun is under the horizon (sfLit), and twilight is cool
   SKY light (sfTwi) — indirect, because light from a sun that has set has no direction for a
   shadow map to shade. Neither is a flat step, the one exception to this file's rule: a step in
   sun elevation is a straight line across the whole landscape, and the two that were tried here
   crossed the Cape at dusk as a ruled diagonal 40 km long. */
export const EARTH_GLSL = /* glsl */`
#define SF_NR ${ROADS.length}
#define SF_SITE_HALF ${SITE_HALF.toFixed(1)}
#define SF_VAB vec2( ${SITE.vab.x.toFixed(3)}, ${SITE.vab.y.toFixed(3)} )
#define SF_PADB vec2( ${SITE.padB.x.toFixed(3)}, ${SITE.padB.y.toFixed(3)} )
uniform sampler2D sfCoast;
uniform sampler2D sfPadSdf;
uniform sampler2D sfSite;
uniform vec3 sfPadUp;
uniform vec3 sfPadE;
uniform vec3 sfPadN;
uniform vec2 sfPadO;
uniform vec3 sfEye;
uniform vec4 sfRoad[ SF_NR ];
uniform float sfRoadKind[ SF_NR ];
float sfLit = 1.0;
vec3 sfTwi = vec3( 0.0 );

#define SFW( s ) ( 1.0 - smoothstep( 0.03, 0.11, fp / ( s ) ) )
/* relief is shaded from screen derivatives, which are per 2×2 pixels: an octave under ~25 px per
   cell shades as a stipple (measured over the Rockies from 400 km), so relief fades earlier */
#define SFR( s ) ( 1.0 - smoothstep( 0.02, 0.045, fp / ( s ) ) )

vec3 sfColour() {
  vec3 Pw = vSfL + sfAnchor;
  float rl = length( Pw );
  vec3 dn = Pw / rl;
  if ( dot( dn, sfHole.xyz ) > sfHole.w ) discard;          // the near patch draws this ground
  /* the point on the reference sphere, relative to the anchor: the lattice domain */
  vec3 Lp = vSfL - dn * mix( rl - SF_R, vSfH, sfLocal );
  vec3 dpx = dFdx( vSfL ), dpy = dFdy( vSfL );
  float fp = max( length( dpx ), length( dpy ) );           // km per pixel

  /* daylight: day, twilight, night */
  float sunUp = dot( dn, sfSun );
  /* (the sun's own edge is not a pixel line: its disc takes 0.53° to set, 59 km of ground — drawn
     as a one-pixel step, sunset crossed the Cape as a ruled diagonal) */
  sfLit = smoothstep( - 0.006, 0.012, sunUp );
  sfTwi = vec3( 0.50, 0.62, 0.92 ) * ( RECIPROCAL_PI * 0.34 * ( 1.0 - sfLit ) * smoothstep( - 0.14, 0.0, sunUp ) );

  float w1 = SFW( 128.0 ), w2 = SFW( 32.0 ), w3 = SFW( 8.0 ), w4 = SFW( 2.0 );
  float w5 = SFW( 0.5 ), w6 = SFW( 0.125 ), w7 = SFW( 0.03125 );
  vec2 n4 = vec2( 0.5 ), n5 = vec2( 0.5 ), n6 = vec2( 0.5 ), n7 = vec2( 0.5 );
  vec2 n0 = vSfA.xy, n1 = vSfA.zw, n2 = vSfB.xy, n3 = vSfB.zw;
#if SF_VTX < 2
  n0 = sfN( Lp / 512.0 + sfCellF[0], sfCellI[0], 11u );
  if ( w1 > 0.0 ) n1 = sfN( Lp / 128.0 + sfCellF[1], sfCellI[1], 12u );
  if ( w2 > 0.0 ) n2 = sfN( Lp / 32.0 + sfCellF[2], sfCellI[2], 13u );
  if ( w3 > 0.0 ) n3 = sfN( Lp / 8.0 + sfCellF[3], sfCellI[3], 14u );
#endif
  if ( w4 > 0.0 ) n4 = sfN( Lp / 2.0 + sfCellF[4], sfCellI[4], 15u );
  if ( w5 > 0.0 ) n5 = sfNv( Lp / 0.5 + sfCellF[5], sfCellI[5], 16u );
  if ( w6 > 0.0 ) n6 = sfNv( Lp / 0.125 + sfCellF[6], sfCellI[6], 17u );
  if ( w7 > 0.0 ) n7 = sfNv( Lp / 0.03125 + sfCellF[7], sfCellI[7], 18u );

  vec4 F = texture2D( sfField, vSfUv );
  /* ruggedness, read one mip down: at the sheet's own 20 km texel the JPEG's blocks came through
     as square hills */
  float rg = texture2D( sfField, vSfUv, 1.3 ).a;
  float lat2 = dn.y * dn.y;

  /* ---- the shore: global field, authored fields at the launch site, octaves on both ----
     tp is km east / north of the pad. pw: the authored Cape (whole inside 45 km). ws: the site
     itself (whole inside 8 km), where every shape is authored to the metre and only the fine
     octaves may move a line. */
  vec2 tp = vec2( dot( Lp, sfPadE ), dot( Lp, sfPadN ) ) + sfPadO;
  float pr = length( tp );
  float pw = dot( dn, sfPadUp ) > 0.8 ? 1.0 - smoothstep( 45.0, 67.0, pr ) : 0.0;
  float ws = 0.0, sdP = 0.0, roadNear = 1e3;
  vec4 site = vec4( 0.0, - 1.0, - 4.0, 1.0 );
  if ( pw > 0.0 ) {
    vec2 far = textureLod( sfPadSdf, tp / 144.0 + 0.5, 0.0 ).rg;
    sdP = far.r; roadNear = far.g - 0.42;                 // 0.28 km texels: a lower bound, not a distance
    ws = 1.0 - smoothstep( 0.82 * SF_SITE_HALF, 0.97 * SF_SITE_HALF, max( abs( tp.x ), abs( tp.y ) ) );
    if ( ws > 0.0 ) {
      site = textureLod( sfSite, tp / ( 2.0 * SF_SITE_HALF ) + 0.5, 0.0 );
      sdP = mix( sdP, site.r, ws ); roadNear = mix( roadNear, site.a, ws );
    }
  }
  float sd = mix( texture2D( sfCoast, vSfUv ).r, sdP, pw );
  sd += ( n2.y - 0.5 ) * 14.0 * w2 * ( 1.0 - pw )
      + ( n3.y - 0.5 ) * 4.0 * w3 * ( 1.0 - 0.65 * pw ) * ( 1.0 - ws )
      + ( n4.y - 0.5 ) * 1.0 * w4 * ( 1.0 - 0.85 * ws )
      + ( n5.y - 0.5 ) * 0.25 * w5 * ( 1.0 - 0.8 * ws )
      + ( n6.y - 0.5 ) * 0.06 * w6 * ( 1.0 - 0.5 * ws )
      + ( n7.y - 0.5 ) * 0.015 * w7;
  /* which water: the open ocean's side of the land has a beach and surf, a lagoon's has marsh.
     Away from the site every shore is the ocean's. */
  float oceanSide = 1.0 - ws * smoothstep( 0.02, 0.07, site.r - site.b );

  /* ---- patch tones: one step lighter, one step darker, per resolved octave ---- */
  float tl = w1 * sfAA( 0.63, n1.y ) + w2 * sfAA( 0.63, n2.y ) + w3 * sfAA( 0.63, n3.x ) + w4 * sfAA( 0.63, n4.y )
           + w5 * sfAA( 0.63, n5.y ) + w6 * sfAA( 0.63, n6.y ) + w7 * sfAA( 0.63, n7.x );
  float td = w1 * sfAA( 0.63, 1.0 - n1.y ) + w2 * sfAA( 0.63, 1.0 - n2.y ) + w3 * sfAA( 0.63, 1.0 - n3.x ) + w4 * sfAA( 0.63, 1.0 - n4.y )
           + w5 * sfAA( 0.63, 1.0 - n5.y ) + w6 * sfAA( 0.63, 1.0 - n6.y ) + w7 * sfAA( 0.63, 1.0 - n7.x );
  /* and one continental step from the 512 km octave, the only one a whole-Earth view resolves */
  float tone = min( tl + 0.6 * sfAA( 0.60, n0.y ), 2.0 ) - min( td + 0.6 * sfAA( 0.60, 1.0 - n0.y ), 2.0 );

  /* Land and sea are each drawn only where they can show: within sdw of the shore (the width of
     its anti-aliased edge, with room for the 2×2 quad the derivatives are taken over) both are,
     and everywhere else one of them is skipped. Seven tenths of an orbital frame is open water. */
  float sdw = 2.5 * fwidth( sd ) + 0.003;
  vec3 land = vec3( 0.0 ), sea = vec3( 0.0 );
  if ( sd < sdw ) {
  /* ---- biome ---- */
  float wg = ( n0.x - 0.5 ) * 0.20 + ( n1.x - 0.5 ) * 0.16 * w1 + ( n2.x - 0.5 ) * 0.11 * w2 + ( n3.x - 0.5 ) * 0.07 * w3;
  float wh = ( n0.y - 0.5 ) * 0.20 + ( n1.y - 0.5 ) * 0.16 * w1 + ( n3.y - 0.5 ) * 0.09 * w3;
  float grove = ( n2.x - 0.5 ) * w2 + ( n3.x - 0.5 ) * w3 + ( n4.x - 0.5 ) * w4 + ( n5.x - 0.5 ) * w5 + ( n6.x - 0.5 ) * w6;
  /* the launch site is authored: Merritt Island is grass and palmetto scrub, whatever the 20 km
     texel under it voted; inside the site the wood lots are the drawn field js/cape.js plants in */
  float arid = mix( F.r, 0.12, pw ) + wg;
  float cold = F.b + wh * 0.6;
  float tree = mix( F.g, 0.30, pw ) * 0.8 + 0.1 + wh * 0.5 + grove * 0.62;
  float isTree = sfAA( 0.5, tree );
  /* the handover is a line too (the 2 km octave on a threshold), not a blend: two tree masks mixed
     across a kilometre and a half drew a soft dark band round the site from 27 km */
  if ( ws > 0.0 ) isTree = mix( isTree, sfAA( 0.0, site.g + ( n6.x - 0.5 ) * 0.22 * w6 + ( n7.x - 0.5 ) * 0.10 * w7 ),
                                sfAA( 0.5, ws + ( n4.x - 0.5 ) * 0.7 * w4 ) );
  /* the tropics' forest is a different green from the temperate one, and the line wanders */
  float trop = ( 1.0 - sfAA( 0.15, lat2 + wg * 0.22 ) ) * ( 1.0 - pw );
  land = mix( K_GRASS, mix( K_FOREST, K_JUNGLE, trop ), isTree );
  land = mix( land, K_BOREAL, isTree * sfAA( 0.16, cold ) );
  land = mix( land, K_SAVANNA, sfAA( 0.27, arid ) * ( 1.0 - isTree ) * ( 1.0 - sfAA( 0.12, cold ) ) );
  land = mix( land, K_STEPPE, sfAA( 0.40, arid ) * ( 1.0 - 0.75 * isTree * ( 1.0 - sfAA( 0.56, arid ) ) ) );
  land = mix( land, K_DESERT, sfAA( 0.74, arid ) );
  land = mix( land, K_TUNDRA, sfAA( 0.42, cold ) );
  land = mix( land, K_ICEEDGE, sfAA( 0.68, cold ) );
  float isIce = sfAA( 0.86, cold );
  land = mix( land, K_ICE, isIce );

  /* ---- farmland: districts of straight-edged plots. A plot is one cell of the 500 m and 125 m
     lattices, and a cubic lattice cut by the ground is a patchwork of polygons. Round the Cape
     the mainland and the island beyond the space centre are groves and pasture ---- */
  float rural = pw * smoothstep( 4.5, 8.0, pr ) * ( 1.0 - ws * sfAA( - 1.6, site.b ) );
  float farm = sfAA( 0.52 - 0.10 * rural, n3.y + ( n2.x - 0.5 ) * 0.6 ) * ( 1.0 - isTree ) * ( 1.0 - sfAA( 0.34, arid ) )
             * ( 1.0 - sfAA( 0.14, cold ) ) * ( 1.0 - pw + rural ) * sfAA( 0.25, - sd );
  if ( farm * ( w5 + w6 ) > 0.0 ) {
    uint fa = sfH( ivec3( floor( Lp / 0.5 + sfCellF[5] ) ) + sfCellI[5], 77u );
    uint fb = sfH( ivec3( floor( Lp / 0.125 + sfCellF[6] ) ) + sfCellI[6], 78u );
    uint fh = w6 > 0.5 ? fa ^ ( fb & 3u ) : fa;
    float fv = float( fh & 255u ) * ( 1.0 / 255.0 );
    vec3 plot = fv < 0.34 ? K_WHEAT : fv < 0.62 ? K_CROP : fv < 0.82 ? K_SOIL : K_GRASS;
    land = mix( land, plot * ( 0.9 + 0.2 * fract( fv * 7.0 ) ), farm * w5 * 0.85 );
  }

  vec3 toneUp = land * vec3( 1.34, 1.28, 1.02 ) + vec3( 0.016, 0.016, 0.0 );
  vec3 toneDn = land * vec3( 0.70, 0.78, 0.84 );
  float soften = 1.0 - 0.7 * isIce;
  land = mix( land, toneUp, clamp( tone, 0.0, 2.0 ) * 0.5 * soften );
  land = mix( land, toneDn, clamp( - tone, 0.0, 2.0 ) * 0.5 * soften );

  /* ---- rivers: the 0.5 contour of a slow field is a long winding line; a second field says
     where one runs at all and tapers it to a source, or every contour closes into a loop.
     Drawn at its real width or 1.4 px, whichever is wider ---- */
  float rv = n1.y + ( n2.x - 0.5 ) * 0.30 * w2 + ( n3.x - 0.5 ) * 0.10 * w3 + ( n4.x - 0.5 ) * 0.03 * w4;
  float rvw = fwidth( rv ), river = 0.0;
  float reach = smoothstep( 0.50, 0.62, n1.x + ( n0.y - 0.5 ) * 0.5 );
  if ( reach > 0.02 && pw < 1.0 ) {
    float rkm = abs( rv - 0.5 ) * fp / max( rvw, 1e-7 );
    float rw = max( ( 0.12 + 0.5 * n0.x ) * reach, 0.7 * fp * step( 0.05, reach ) );
    river = ( 1.0 - smoothstep( rw * 0.7, rw * 1.2, rkm ) ) * w1 * ( 1.0 - smoothstep( 4.0, 12.0, fp ) )
          * ( 1.0 - sfAA( 0.62, arid ) ) * ( 1.0 - sfAA( 0.60, cold ) ) * ( 1.0 - pw );
  }

  /* ---- relief: ridged height from the octaves, scaled by the real ruggedness ---- */
  float hill = 0.016 + 0.9 * smoothstep( 0.02, 0.42, rg );
  /* valleys keep their biome, flanks go to rock, crests to snow: the ridges cut the ruggedness */
  float hm = rg * ( 0.15 + 0.6 * mix( 0.5, sfRidge( n2.y ), w2 ) + 0.5 * mix( 0.5, sfRidge( n3.y ), w3 )
                  + 0.35 * mix( 0.5, sfRidge( n4.x ), w4 ) + 0.2 * mix( 0.5, n5.x, w5 ) );
  land = mix( land, K_ROCK, sfAA( 0.46, hm ) * ( 1.0 - isIce ) );
  float snow = sfAA( 1.0 - 0.5 * clamp( cold, 0.0, 1.0 ) - 0.3 * lat2, hm );
  land = mix( land, K_SNOW, snow );
  /* slope toward the sun. Globe: a screen derivative of H, no extra noise reads. Patch: the coarse
     octaves arrive already differenced per vertex (vSfS); only the 2 km octave is derived here. */
  vec3 st = sfSun - dn * dot( sfSun, dn );
  st /= max( length( st ), 0.05 );
  /* hill multiplies the SLOPE, it is not inside the height that is differenced: its own gradient
     across one 20 km texel of the ruggedness sheet times a 64 km amplitude is a slope of 0.16 —
     right on the band threshold — and the bilinear facets of the sheet came out as square hills
     (measured over the Congo from 500 km). */
#ifdef SF_PATCH
  float H = SFR( 2.0 ) * sfRidge( n4.x );
  float slope = 0.5 * ( SFR( 128.0 ) * vSfS.x + SFR( 32.0 ) * vSfS.y + SFR( 8.0 ) * vSfS.z );
#else
  float H = ( SFR( 128.0 ) * 128.0 * sfRidge( n1.x ) + SFR( 32.0 ) * 32.0 * sfRidge( n2.y ) + SFR( 8.0 ) * 8.0 * sfRidge( n3.y )
            + SFR( 2.0 ) * 2.0 * sfRidge( n4.x ) ) * 0.5;
  float slope = 0.0;
#endif
  vec2 dH = vec2( dFdx( H ), dFdy( H ) );
  /* a plain has no slope worth a band: at hill 0.03 the steepest ridge is under the 0.13 threshold */
  if ( hill > 0.03 ) {
    vec3 r1 = cross( dpy, dn ), r2 = cross( dn, dpx );
    float det = dot( dpx, r1 );
    slope = hill * ( slope + dot( ( dH.x * r1 + dH.y * r2 ) / ( abs( det ) > 1e-12 ? det : 1e-12 ), st ) );
    float lit = smoothstep( 0.13, 0.19, slope ), shd = smoothstep( 0.13, 0.19, - slope );
    land = mix( land, land * vec3( 1.16, 1.13, 1.02 ) + 0.012, lit );
    land = mix( land, land * vec3( 0.60, 0.66, 0.80 ), shd );
  }

  land = mix( land, K_LAKE, river * ( 1.0 - snow ) );

  /* ---- the launch site's worn ground: round both pads, and the assembly building's apron ---- */
  if ( ws > 0.0 ) {
    float wear = max( 1.0 - smoothstep( 0.2, 0.7, pr ), 1.0 - smoothstep( 0.2, 0.6, length( tp - SF_PADB ) ) );
    land = mix( land, K_CONCRETE, wear * 0.35 );
    vec2 ap = abs( tp - SF_VAB - vec2( 0.16, - 0.12 ) ) - vec2( 0.42, 0.36 );
    land = mix( land, K_CONCRETE, ( 1.0 - sfAA( 0.0, max( ap.x, ap.y ) ) ) * 0.8 );
  }

  /* ---- beach and dune grass on the ocean's side of the land, marsh on a lagoon's ---- */
  float bw = clamp( 3.0 * fp, 0.05, 1.4 ) * ( 0.15 + 1.7 * n3.y ) * ( 1.0 - smoothstep( 3.0, 9.0, fp ) );
  float soft = 1.0 - isIce;
  land = mix( land, K_MARSH, sfAA( - 0.075 * ( 0.3 + 1.4 * n5.y ), sd ) * ( 1.0 - oceanSide ) * 0.85 );
  land = mix( land, K_DUNE, sfAA( - 2.6 * bw, sd ) * 0.75 * soft * oceanSide );
  land = mix( land, K_DESERT, sfAA( - bw, sd ) * soft * oceanSide );
  }

  if ( sd > - sdw ) {
  /* ---- the sea. Open water first: three masses by latitude, three by depth, all flat ---- */
  float zq = abs( dn.y ) + ( n0.x - 0.5 ) * 0.55 + ( n1.x - 0.5 ) * 0.24 * w1 + ( n2.x - 0.5 ) * 0.07 * w2;
  sea = mix( K_TROPIC, K_DEEP, sfAA( 0.36, zq ) );
  sea = mix( sea, K_COLDSEA, sfAA( 0.68, zq ) );
  float dq = n0.y + ( n1.y - 0.5 ) * 0.55 * w1 + ( n2.y - 0.5 ) * 0.16 * w2;
  sea = mix( sea, sea * vec3( 0.74, 0.80, 0.86 ), sfAA( 0.585, dq ) );
  sea = mix( sea, sea * vec3( 1.30, 1.20, 1.10 ) + vec3( 0.0, 0.006, 0.012 ), sfAA( 0.585, 1.0 - dq ) );
  /* then the coast's bands by distance, and pack ice */
  sea = mix( K_OCEAN, sea, sfAA( 170.0 * ( 0.6 + 0.8 * n0.y ), sd ) );
  /* (the Cape's own shelf is authored narrow: the real one drops off within a few km of the beach,
     and a 40 km pale apron washed the whole site out from 8 km up) */
  sea = mix( K_SHELF, sea, sfAA( mix( 44.0, 7.0, pw ) * ( 0.5 + n1.y ), sd ) );
  sea = mix( K_SHALLOW, sea, sfAA( mix( 2.6, 1.2, ws ) * ( 0.4 + 1.2 * n3.x ), sd ) );
  sea = mix( K_BAR, sea, sfAA( 0.50 * ( 0.5 + n4.x ), sd ) );
  sea = mix( K_AQUA, sea, sfAA( 0.21 * ( 0.4 + 1.2 * n5.x ), sd ) );
  sea *= 1.0 + 0.04 * tone;
  /* surf: the wash on the sand, and one line of breakers off an ocean beach, cut into runs */
  float nearK = 1.0 - smoothstep( 0.05, 0.3, fp );
  float foam = ( 1.0 - sfAA( max( 0.012, 1.1 * fp ), sd ) ) * nearK * oceanSide;
  float bk = abs( sd - 0.085 - 0.05 * n5.y ) - max( 0.0045, 0.55 * fp );
  foam = max( foam, ( 1.0 - sfAA( 0.0, bk ) ) * sfAA( 0.47, n6.x * w6 + n4.x * ( 1.0 - w6 ) ) * oceanSide * ( 1.0 - smoothstep( 0.012, 0.035, fp ) ) );
  sea = mix( sea, K_FOAM, foam * 0.85 );
  float floe = smoothstep( 0.86, 0.96, abs( dn.y ) ) + ( n1.x - 0.5 ) * 0.5 * w1 + ( n2.x - 0.5 ) * 0.7 * w2 + ( n3.x - 0.5 ) * 0.4 * w3;
  float isFloe = sfAA( 0.55, floe );
  sea = mix( sea, K_ICE, isFloe );
  /* the sun on the water: where the surface normal bisects the sun and the eye. Three nested
     shapes — core, glare, glitter — each a hard edge the swell's octaves break up */
  vec3 hv = normalize( normalize( sfEye - Pw ) + sfSun );
  float sp = dot( dn, hv );
  float swell = ( n1.x - 0.5 ) * w1 + ( n2.y - 0.5 ) * w2 + ( n3.x - 0.5 ) * w3 + ( n4.y - 0.5 ) * w4 + ( n5.x - 0.5 ) * w5 + ( n6.y - 0.5 ) * w6;
  float gOn = sfAA( 0.03, sunUp ) * ( 1.0 - isFloe );
  /* the further from the specular point, the more the swell decides: a solid core, a ragged glare,
     and glitter that is all islands */
  sea = mix( sea, mix( sea, K_SHALLOW, 0.6 ), sfAA( 0.9925, sp + swell * 0.0130 ) * gOn );
  sea = mix( sea, K_GLARE, sfAA( 0.9962, sp + swell * 0.0060 ) * gOn );
  sea = mix( sea, K_GLINT, sfAA( 0.99895, sp + swell * 0.0016 ) * gOn );
  }

  float isSea = sfAA( 0.0, sd );
  vec3 col = mix( land, sea, isSea );
  /* the shore, inked: 1.6 pixels at every range it can be seen from */
  float ink = 1.0 - smoothstep( 0.5 * fp, 1.1 * fp, abs( sd ) );
  col = mix( col, K_COAST, ink * 0.7 * ( 1.0 - smoothstep( 6.0, 30.0, fp ) ) );

  /* ---- the roads and the crawlerway, inked over land and water alike ---- */
  /* (27 segments a pixel was 2 ms of a 10 ms frame at the pad: the site grid carries the distance
     to the nearest road, and the segments are only walked where one can reach the pixel) */
  if ( pw > 0.0 && fp < 0.16 && roadNear < 0.04 + 2.6 * fp ) {
    float dA = 1e3, dC = 1e3;
    for ( int i = 0; i < SF_NR; i ++ ) {
      vec2 a = sfRoad[ i ].xy, ba = sfRoad[ i ].zw - a, pa = tp - a;
      float d = length( pa - ba * clamp( dot( pa, ba ) / dot( ba, ba ), 0.0, 1.0 ) );
      if ( sfRoadKind[ i ] > 0.5 ) dC = min( dC, d ); else dA = min( dA, d );
    }
    float farK = ( 1.0 - smoothstep( 0.08, 0.16, fp ) ) * pw;
    float hw = max( 0.0055, 0.65 * fp ), e = 0.5 * fp;
    /* a causeway is a road on its own bank: where the road is over water, the fill shows */
    col = mix( col, K_DUNE, ( 1.0 - smoothstep( 3.2 * hw - e, 3.2 * hw + e, dA ) ) * isSea * farK );
    float cw = max( 0.0245, 0.8 * fp );
    float crawl = 1.0 - smoothstep( cw - e, cw + e, dC );
    /* two tracks with a grass median between them, once a pixel can hold the median */
    crawl *= mix( 1.0, smoothstep( 0.0063 - e, 0.0063 + e, dC ), 1.0 - smoothstep( 0.003, 0.007, fp ) );
    col = mix( col, K_GRAVEL, crawl * farK * ( 1.0 - isSea ) );
    col = mix( col, K_ASPHALT, ( 1.0 - smoothstep( hw - e, hw + e, dA ) ) * farK );
  }
  return col;
}
`;
