/* The Earth's ground, drawn. Spliced into the globe and the near patch by js/surface.js, which owns
   the preamble (sfN, sfAA, the anchor) and explains why this is a shader and not a texture.

   Inputs: sfField (R aridity, G tree cover, B cold, A ruggedness — js/earthpaint.js), sfCoast (signed
   km to the coast, negative inland), sfPadSdf (the authored launch-site shore, js/padsite.js) and
   eight octaves of lattice noise, cells 512 km … 31 m.

   What is drawn, coarse to fine:
   - biome: grass / forest / boreal / steppe / sand / tundra / ice, each a threshold on a field with
     the octaves on the threshold — so a border is a fractal line, and groves and clearings appear
     at every scale a border passes through;
   - relief: a ridged height built from the same octaves, scaled by the real ruggedness, shaded in
     two flat bands by its slope toward the sun; rock above the tree line and snow above that;
   - coast: the distance field plus the octaves, cut into sea bands (deep, ocean, shelf, shallows,
     surf), a beach and dune band on the land side, and a 1.6-pixel ink line on the shore;
   - patch tones: one lighter and one darker flat tone per resolved octave.

   Everything is a flat tone behind an anti-aliased edge; nothing is a gradient or a grain. */
export const EARTH_GLSL = /* glsl */`
uniform sampler2D sfCoast;
uniform sampler2D sfPadSdf;
uniform vec3 sfPadUp;
uniform vec3 sfPadE;
uniform vec3 sfPadN;
uniform vec2 sfPadO;

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
  float lat2 = dn.y * dn.y;

  /* ---- the shore: global field, authored field at the launch site, octaves on both ---- */
  vec2 tp = vec2( dot( Lp, sfPadE ), dot( Lp, sfPadN ) ) + sfPadO;
  float pr = length( tp );
  float pw = dot( dn, sfPadUp ) > 0.8 ? 1.0 - smoothstep( 45.0, 67.0, pr ) : 0.0;
  float sd = mix( texture2D( sfCoast, vSfUv ).r, texture2D( sfPadSdf, tp / 144.0 + 0.5 ).r, pw );
  sd += ( n2.y - 0.5 ) * 14.0 * w2 * ( 1.0 - pw )
      + ( n3.y - 0.5 ) * 4.0 * w3 * ( 1.0 - 0.65 * pw )
      + ( n4.y - 0.5 ) * 1.0 * w4
      + ( n5.y - 0.5 ) * 0.25 * w5
      + ( n6.y - 0.5 ) * 0.06 * w6
      + ( n7.y - 0.5 ) * 0.015 * w7;

  /* ---- biome ---- */
  float wg = ( n0.x - 0.5 ) * 0.20 + ( n1.x - 0.5 ) * 0.16 * w1 + ( n2.x - 0.5 ) * 0.11 * w2 + ( n3.x - 0.5 ) * 0.07 * w3;
  float wh = ( n0.y - 0.5 ) * 0.20 + ( n1.y - 0.5 ) * 0.16 * w1 + ( n3.y - 0.5 ) * 0.09 * w3;
  float grove = ( n2.x - 0.5 ) * w2 + ( n3.x - 0.5 ) * w3 + ( n4.x - 0.5 ) * w4 + ( n5.x - 0.5 ) * w5 + ( n6.x - 0.5 ) * w6;
  /* the launch site is authored: Merritt Island is grass and palmetto scrub, whatever the 20 km
     texel under it voted */
  float arid = mix( F.r, 0.12, pw ) + wg;
  float cold = F.b + wh * 0.6;
  float tree = mix( F.g, 0.30, pw ) * 0.8 + 0.1 + wh * 0.5 + grove * 0.42;
  float isTree = sfAA( 0.5, tree );
  vec3 land = mix( K_GRASS, K_FOREST, isTree );
  land = mix( land, K_BOREAL, isTree * sfAA( 0.16, cold ) );
  land = mix( land, K_STEPPE, sfAA( 0.40, arid ) * ( 1.0 - 0.75 * isTree * ( 1.0 - sfAA( 0.56, arid ) ) ) );
  land = mix( land, K_DESERT, sfAA( 0.74, arid ) );
  land = mix( land, K_TUNDRA, sfAA( 0.42, cold ) );
  land = mix( land, K_ICEEDGE, sfAA( 0.68, cold ) );
  float isIce = sfAA( 0.86, cold );
  land = mix( land, K_ICE, isIce );

  /* ---- patch tones: one step lighter, one step darker, per resolved octave ---- */
  float tl = w1 * sfAA( 0.63, n1.y ) + w2 * sfAA( 0.63, n2.y ) + w3 * sfAA( 0.63, n3.x ) + w4 * sfAA( 0.63, n4.y )
           + w5 * sfAA( 0.63, n5.y ) + w6 * sfAA( 0.63, n6.y ) + w7 * sfAA( 0.63, n7.x );
  float td = w1 * sfAA( 0.63, 1.0 - n1.y ) + w2 * sfAA( 0.63, 1.0 - n2.y ) + w3 * sfAA( 0.63, 1.0 - n3.x ) + w4 * sfAA( 0.63, 1.0 - n4.y )
           + w5 * sfAA( 0.63, 1.0 - n5.y ) + w6 * sfAA( 0.63, 1.0 - n6.y ) + w7 * sfAA( 0.63, 1.0 - n7.x );
  float tone = min( tl, 2.0 ) - min( td, 2.0 );

  /* ---- farmland: districts of straight-edged plots. A plot is one cell of the 500 m and 125 m
     lattices, and a cubic lattice cut by the ground is a patchwork of polygons ---- */
  float farm = sfAA( 0.52, n3.y + ( n2.x - 0.5 ) * 0.6 ) * ( 1.0 - isTree ) * ( 1.0 - sfAA( 0.34, arid ) )
             * ( 1.0 - sfAA( 0.14, cold ) ) * ( 1.0 - pw );
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
  land = mix( land, toneUp, clamp( tone, 0.0, 2.0 ) * 0.42 * soften );
  land = mix( land, toneDn, clamp( - tone, 0.0, 2.0 ) * 0.42 * soften );

  /* ---- rivers: the 0.5 contour of a slow field is a long winding line. Drawn at its real
     width or 1.4 px, whichever is wider, so it is an inked line from every altitude ---- */
  float rv = n1.y + ( n2.x - 0.5 ) * 0.30 * w2 + ( n3.x - 0.5 ) * 0.10 * w3 + ( n4.x - 0.5 ) * 0.03 * w4;
  float rkm = abs( rv - 0.5 ) * fp / max( fwidth( rv ), 1e-7 );
  float rw = max( 0.12 + 0.5 * n0.x, 0.7 * fp );
  float river = ( 1.0 - smoothstep( rw * 0.7, rw * 1.2, rkm ) ) * w1 * ( 1.0 - smoothstep( 4.0, 12.0, fp ) )
              * ( 1.0 - sfAA( 0.62, arid ) ) * ( 1.0 - sfAA( 0.60, cold ) ) * ( 1.0 - pw );

  /* ---- relief: ridged height from the octaves, scaled by the real ruggedness ---- */
  float rg = F.a;
  float hill = 0.016 + 0.9 * smoothstep( 0.02, 0.42, rg );
  /* valleys keep their biome, flanks go to rock, crests to snow: the ridges cut the ruggedness */
  float hm = rg * ( 0.15 + 0.6 * mix( 0.5, sfRidge( n2.y ), w2 ) + 0.5 * mix( 0.5, sfRidge( n3.y ), w3 )
                  + 0.35 * mix( 0.5, sfRidge( n4.x ), w4 ) + 0.2 * mix( 0.5, n5.x, w5 ) );
  land = mix( land, K_ROCK, sfAA( 0.50, hm ) * ( 1.0 - isIce ) );
  land = mix( land, K_SNOW, sfAA( 1.0 - 0.5 * clamp( cold, 0.0, 1.0 ) - 0.3 * lat2, hm ) );
  /* slope toward the sun. Globe: a screen derivative of H, no extra noise reads. Patch: the coarse
     octaves arrive already differenced per vertex (vSfS); only the 2 km octave is derived here. */
  vec3 st = sfSun - dn * dot( sfSun, dn );
  st /= max( length( st ), 0.05 );
#ifdef SF_PATCH
  float H = hill * SFR( 2.0 ) * sfRidge( n4.x );
  float slope = hill * 0.5 * ( SFR( 128.0 ) * vSfS.x + SFR( 32.0 ) * vSfS.y + SFR( 8.0 ) * vSfS.z );
#else
  float H = hill * ( SFR( 128.0 ) * 128.0 * sfRidge( n1.x ) + SFR( 32.0 ) * 32.0 * sfRidge( n2.y ) + SFR( 8.0 ) * 8.0 * sfRidge( n3.y )
                   + SFR( 2.0 ) * 2.0 * sfRidge( n4.x ) ) * 0.5;
  float slope = 0.0;
#endif
  vec3 r1 = cross( dpy, dn ), r2 = cross( dn, dpx );
  float det = dot( dpx, r1 );
  slope += dot( ( dFdx( H ) * r1 + dFdy( H ) * r2 ) / ( abs( det ) > 1e-12 ? det : 1e-12 ), st );
  float lit = smoothstep( 0.13, 0.19, slope ), shd = smoothstep( 0.13, 0.19, - slope );
  land = mix( land, land * vec3( 1.16, 1.13, 1.02 ) + 0.012, lit );
  land = mix( land, land * vec3( 0.60, 0.66, 0.80 ), shd );

  land = mix( land, K_LAKE, river );

  /* ---- the launch site's worn ground ---- */
  land = mix( land, K_CONCRETE, ( 1.0 - smoothstep( 0.2, 0.7, pr ) ) * 0.35 * step( 0.5, pw ) );

  /* ---- beach and dune grass, on the land side of the shore ---- */
  float bw = clamp( 3.0 * fp, 0.05, 1.4 ) * ( 0.15 + 1.7 * n3.y ) * ( 1.0 - smoothstep( 3.0, 9.0, fp ) );
  float soft = 1.0 - isIce;
  land = mix( land, K_DUNE, sfAA( - 2.6 * bw, sd ) * 0.75 * soft );
  land = mix( land, K_DESERT, sfAA( - bw, sd ) * soft );

  /* ---- the sea: five flat bands by distance, then pack ice ---- */
  vec3 sea = mix( K_OCEAN, K_DEEP, sfAA( 170.0 * ( 0.6 + 0.8 * n0.y ), sd ) );
  sea = mix( K_SHELF, sea, sfAA( 44.0 * ( 0.5 + n1.y ), sd ) );
  sea = mix( K_SHALLOW, sea, sfAA( 2.6 * ( 0.4 + 1.2 * n3.x ), sd ) );
  sea = mix( K_AQUA, sea, sfAA( 0.30 * ( 0.4 + 1.2 * n5.x ), sd ) );
  sea *= 1.0 + 0.04 * tone;
  float foam = ( 1.0 - sfAA( max( 0.012, 1.1 * fp ), sd ) ) * ( 1.0 - smoothstep( 0.05, 0.3, fp ) );
  sea = mix( sea, K_FOAM, foam * 0.85 );
  float floe = smoothstep( 0.86, 0.96, abs( dn.y ) ) + ( n1.x - 0.5 ) * 0.5 * w1 + ( n2.x - 0.5 ) * 0.7 * w2 + ( n3.x - 0.5 ) * 0.4 * w3;
  sea = mix( sea, K_ICE, sfAA( 0.55, floe ) );

  float isSea = sfAA( 0.0, sd );
  vec3 col = mix( land, sea, isSea );
  /* the shore, inked: 1.6 pixels at every range it can be seen from */
  float ink = 1.0 - smoothstep( 0.5 * fp, 1.1 * fp, abs( sd ) );
  col = mix( col, K_COAST, ink * 0.7 * ( 1.0 - smoothstep( 6.0, 30.0, fp ) ) );
  return col;
}
`;
