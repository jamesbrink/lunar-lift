/* The Moon's ground, drawn. Spliced into the lunar globe and its near patch by js/surface.js.

   Inputs: sfField (R albedo, G the 340 km-smoothed albedo the mare cut is taken on, B the tone of
   the 560 relief craters — js/moonpaint.js) and the octave ladder, cells 256 km … 16 m.

   - Mare / plain / highland / bright are thresholds on the albedo with the octaves on the
     threshold, so a mare has one flat tone inside one drawn outline at every range, and the outline
     carries a darker collar stroke on its inside.
   - Craters are a population per octave: one candidate per lattice cell, centre jittered, radius
     0.07–0.30 of the cell, so the ladder covers 5 m to 19 km without a gap and the relief craters
     (45 km and up, which the mesh also displaces) come from the field. Each is drawn the way a
     cartoon draws a bowl: a shadow crescent inside the sunward rim, a lit crescent on the far wall,
     and a floor one step off its plain. The crescents are two offset discs — the offset grows as
     the sun drops — so they are shapes, not gradients.
   - Tone composes by MAX across craters (agents.md: a product across overlapping bowls goes black). */
export const MOON_GLSL = /* glsl */`
uniform float sfMareCut;

#define SFW( s ) ( 1.0 - smoothstep( 0.03, 0.11, fp / ( s ) ) )
#define SFC( s ) ( 1.0 - smoothstep( 0.030, 0.065, fp / ( s ) ) )

/* q: lattice coordinates of this fragment; px: pixels' size in cells; st: unit sun tangent; e: the
   crescent offset. Accumulates the strongest shadow, light and floor. */
void sfCraters( vec3 q, ivec3 off, float px, vec3 dn, vec3 st, float e, float wgt, uint seed,
                inout float dark, inout float lite, inout float flr ) {
  vec3 b = floor( q - 0.5 );
  vec3 f = q - b;
  ivec3 ib = ivec3( b ) + off;
  for ( int k = 0; k < 8; k ++ ) {
    ivec3 o = ivec3( k & 1, ( k >> 1 ) & 1, ( k >> 2 ) & 1 );
    /* a cell whose centre is further than jitter + reach on any axis cannot touch this fragment:
       rejected before its hash, which leaves ~1.5 of the 8 cells to evaluate */
    vec3 c0 = abs( f - vec3( o ) - 0.5 );
    if ( max( c0.x, max( c0.y, c0.z ) ) > 0.7 ) continue;
    uint h = sfH( ib + o, seed );
    vec3 j = vec3( float( h & 1023u ), float( ( h >> 10 ) & 1023u ), float( ( h >> 20 ) & 1023u ) ) * ( 1.0 / 1023.0 );
    vec3 d = f - ( vec3( o ) + 0.5 + ( j - 0.5 ) * 0.4 );
    float up = dot( d, dn );
    /* one layer of the lattice owns the surface: centres within half a cell of it, faded at the edge */
    float own = 1.0 - smoothstep( 0.40, 0.50, abs( up ) );
    uint h2 = h * 747796405u + 2891336453u;
    float size = float( ( h2 >> 8 ) & 1023u ) * ( 1.0 / 1023.0 );
    float r = 0.07 + 0.23 * size * size;
    vec3 t = ( d - dn * up ) / r;
    float tl = length( t );
    if ( own <= 0.0 || tl > 1.25 ) continue;
    float aa = px / r;
    float disc = 1.0 - smoothstep( 1.0 - aa, 1.0 + aa, tl );
    float a = disc * own * wgt * ( 1.0 - smoothstep( 0.35, 0.8, aa ) );
    float sh = smoothstep( 0.80 - aa, 0.80 + aa, length( t + st * e ) );
    float li = smoothstep( 0.80 - aa, 0.80 + aa, length( t - st * e ) );
    dark = max( dark, a * sh * ( 1.0 - li ) );
    lite = max( lite, a * li * ( 1.0 - sh ) );
    float fresh = float( ( h2 >> 20 ) & 255u ) * ( 1.0 / 255.0 );
    flr = max( flr, a * ( 1.0 - sh ) * ( 1.0 - li ) * ( 0.35 + 0.65 * fresh ) );
    /* the rim line: a thin bright ring that survives noon, when the crescents close */
    float ring = 1.0 - smoothstep( 0.05 + aa, 0.09 + aa, abs( tl - 1.0 ) );
    lite = max( lite, ring * own * wgt * 0.55 * ( 1.0 - smoothstep( 0.2, 0.5, aa ) ) );
  }
}

vec3 sfColour() {
  vec3 Pw = vSfL + sfAnchor;
  float rl = length( Pw );
  vec3 dn = Pw / rl;
  if ( dot( dn, sfHole.xyz ) > sfHole.w ) discard;          // the near patch draws this ground
  vec3 Lp = vSfL - dn * mix( rl - SF_R, vSfH, sfLocal );
  float fp = max( length( dFdx( vSfL ) ), length( dFdy( vSfL ) ) );

  float w1 = SFW( 64.0 ), w2 = SFW( 16.0 ), w3 = SFW( 4.0 ), w4 = SFW( 1.0 ), w5 = SFW( 0.25 );
  vec2 n3 = vec2( 0.5 ), n4 = vec2( 0.5 ), n5 = vec2( 0.5 );
  vec2 n0 = vSfA.xy, n1 = vSfA.zw, n2 = vSfB.xy;
#if SF_VTX < 3
  if ( w2 > 0.0 ) n2 = sfNv( Lp / 16.0 + sfCellF[2], sfCellI[2], 33u );
#endif
  if ( w3 > 0.0 ) n3 = sfNv( Lp / 4.0 + sfCellF[3], sfCellI[3], 34u );
  if ( w4 > 0.0 ) n4 = sfNv( Lp / 1.0 + sfCellF[4], sfCellI[4], 35u );
  if ( w5 > 0.0 ) n5 = sfNv( Lp / 0.25 + sfCellF[5], sfCellI[5], 36u );

  vec4 F = texture2D( sfField, vSfUv );
  float alb = F.r + ( n0.x - 0.5 ) * 0.05 + ( n1.x - 0.5 ) * 0.06 * w1 + ( n2.x - 0.5 ) * 0.045 * w2 + ( n3.x - 0.5 ) * 0.03 * w3;
  float wd = F.g + ( n1.y - 0.5 ) * 0.020 * w1 + ( n2.y - 0.5 ) * 0.010 * w2 + ( n3.y - 0.5 ) * 0.005 * w3 + ( n4.y - 0.5 ) * 0.002 * w4;

  vec3 col = mix( K_MID, K_HIGH, sfAA( 0.47, alb ) );
  col = mix( col, K_BRIGHT, sfAA( 0.62, alb ) );
  float inMare = ( sfMareCut - wd ) / max( fwidth( wd ), 1e-7 );      // pixels inside the mare border
  float mare = clamp( inMare * 0.7 + 0.5, 0.0, 1.0 );
  col = mix( col, K_MARIA, mare );
  /* the collar: a stroke on the inside of the border, 2.5 px, faded out where a mare is a dot */
  col *= 1.0 - 0.22 * mare * ( 1.0 - smoothstep( 2.0, 3.0, inMare ) ) * ( 1.0 - smoothstep( 8.0, 30.0, fp ) );

  /* the relief craters, from the field: floor one step down, rim and rays one step up */
  float bt = F.b * 2.0 - 1.0;
  col *= 1.0 - 0.20 * ( 1.0 - sfAA( - 0.16, bt ) ) + 0.17 * sfAA( 0.20, bt ) + 0.09 * sfAA( 0.07, bt ) * ( 1.0 - sfAA( 0.20, bt ) );

  /* patch tones */
  float tl = sfAA( 0.63, n0.y ) + w1 * sfAA( 0.63, n1.y ) + w2 * sfAA( 0.63, n2.y ) + w3 * sfAA( 0.63, n3.y ) + w4 * sfAA( 0.63, n4.x ) + w5 * sfAA( 0.63, n5.x );
  float td = sfAA( 0.63, 1.0 - n0.y ) + w1 * sfAA( 0.63, 1.0 - n1.y ) + w2 * sfAA( 0.63, 1.0 - n2.y ) + w3 * sfAA( 0.63, 1.0 - n3.y ) + w4 * sfAA( 0.63, 1.0 - n4.x ) + w5 * sfAA( 0.63, 1.0 - n5.x );
  col *= 1.0 + 0.045 * ( min( tl, 2.0 ) - min( td, 2.0 ) );

  /* the crater ladder */
  vec3 st = sfSun - dn * dot( sfSun, dn );
  float sl = length( st );
  st /= max( sl, 0.05 );
  float e = 0.10 + 0.34 * sl * sl;
  float dark = 0.0, lite = 0.0, flr = 0.0;
  float c1 = SFC( 64.0 ), c2 = SFC( 16.0 ), c3 = SFC( 4.0 ), c4 = SFC( 1.0 ), c5 = SFC( 0.25 ), c6 = SFC( 0.0625 ), c7 = SFC( 0.015625 );
  if ( c1 > 0.0 ) sfCraters( Lp / 64.0 + sfCellF[1], sfCellI[1], fp / 64.0, dn, st, e, c1, 41u, dark, lite, flr );
  if ( c2 > 0.0 ) sfCraters( Lp / 16.0 + sfCellF[2], sfCellI[2], fp / 16.0, dn, st, e, c2, 42u, dark, lite, flr );
  if ( c3 > 0.0 ) sfCraters( Lp / 4.0 + sfCellF[3], sfCellI[3], fp / 4.0, dn, st, e, c3, 43u, dark, lite, flr );
  if ( c4 > 0.0 ) sfCraters( Lp / 1.0 + sfCellF[4], sfCellI[4], fp / 1.0, dn, st, e, c4, 44u, dark, lite, flr );
  if ( c5 > 0.0 ) sfCraters( Lp / 0.25 + sfCellF[5], sfCellI[5], fp / 0.25, dn, st, e, c5, 45u, dark, lite, flr );
  if ( c6 > 0.0 ) sfCraters( Lp / 0.0625 + sfCellF[6], sfCellI[6], fp / 0.0625, dn, st, e, c6, 46u, dark, lite, flr );
  if ( c7 > 0.0 ) sfCraters( Lp / 0.015625 + sfCellF[7], sfCellI[7], fp / 0.015625, dn, st, e, c7, 47u, dark, lite, flr );
  /* on the night side there is no sun to throw a crescent: the bowls keep only their floor tone */
  float day = smoothstep( - 0.04, 0.10, dot( dn, sfSun ) );
  col *= 1.0 - 0.40 * dark * day + 0.34 * lite * day - 0.10 * flr;
  return col;
}
`;
