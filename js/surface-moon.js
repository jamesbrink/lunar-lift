/* The Moon's ground, drawn. Spliced into the lunar globe and its near patch by js/surface.js.

   Inputs: sfField (R albedo, G the 340 km-smoothed albedo the mare cut is taken on, B the highland
   weight, A where the two largest crater octaves reach — js/moonpaint.js) and the octave ladder,
   cells 1024 km … 16 m.

   - Mare / plain / highland / bright are thresholds on the albedo with the octaves on the
     threshold, so a mare has one flat tone inside one drawn outline at every range, and the outline
     carries a darker collar stroke on its inside.
   - Craters are ONE population, a ladder: one candidate per lattice cell per octave, centre
     jittered, radius 5–27 % of the cell — 0.8 m to 276 km without a gap. js/mooncraters.js runs
     the same hash and turns the six largest octaves into relief, so what is drawn here is a bowl
     in the mesh and in the contact surface too. Each is drawn the way a cartoon draws a bowl: a
     shadow crescent inside the sunward rim, a lit crescent on the far wall, a floor one step off
     its plain, a rim line. The crescents are two offset discs — the offset grows as the sun
     drops — so they are shapes, not gradients.
   - No two are the same stamp. One hash decides size (few large, many small), age (a fresh crater
     has a hard bright rim and a ragged ejecta apron; a worn one has faint crescents, no rim line,
     and a wall broken in one or two places), and whether a large one keeps a central peak.
   - The fresh craters of the two top octaves throw rays: tapering spokes out to 0.47 of a cell
     (480 km in the top octave), an albedo
     mark that does not care where the sun is (a bright splash once a spoke is under a pixel), and
     the oldest are flooded — a dark flat floor. Those two are what a disc 4,000 km away is read by.
   - Tone composes by MAX across craters (agents.md: a product across overlapping bowls goes black). */
export const MOON_GLSL = /* glsl */`
uniform float sfMareCut;

#define SFW( s ) ( 1.0 - smoothstep( 0.03, 0.11, fp / ( s ) ) )
#define SFC( s ) ( 1.0 - smoothstep( 0.030, 0.065, fp / ( s ) ) )

/* q: lattice coordinates of this fragment; px: a pixel's size in cells; st: unit sun tangent; e: the
   crescent offset; big: 1 on the octaves that may throw rays. Accumulates the strongest shadow,
   light, floor and ray. The hash chain and every constant are mirrored in js/mooncraters.js. */
void sfCraters( vec3 q, ivec3 off, float px, vec3 dn, vec3 st, float e, float wgt, uint seed, float big, float rag,
                inout float dark, inout float lite, inout float flr, inout float ray, inout float lava ) {
  vec3 b = floor( q - 0.5 );
  vec3 f = q - b;
  ivec3 ib = ivec3( b ) + off;
  for ( int k = 0; k < 8; k ++ ) {
    ivec3 o = ivec3( k & 1, ( k >> 1 ) & 1, ( k >> 2 ) & 1 );
    /* a cell whose crater cannot reach this fragment is rejected before its hash. The bound is
       exact (js/mooncraters.js derives it: 0.644 of a cell; 0.74 for the two octaves whose rays
       run 0.47) and leaves ~2.1 of the 8 cells to evaluate. A tighter box cuts craters off along
       lattice planes; the looser one this had first cost half the Moon's frame again. */
    vec3 c0 = abs( f - vec3( o ) - 0.5 );
    if ( max( c0.x, max( c0.y, c0.z ) ) > ( big > 0.5 ? 0.745 : 0.645 ) ) continue;
    uint h = sfH( ib + o, seed );
    vec3 j = vec3( float( h & 1023u ), float( ( h >> 10 ) & 1023u ), float( ( h >> 20 ) & 1023u ) ) * ( 1.0 / 1023.0 );
    vec3 d = f - ( vec3( o ) + 0.5 + ( j - 0.5 ) * 0.34 );
    float up = dot( d, dn );
    /* one layer of the lattice owns the surface: centres within a third of a cell of it, faded at the edge */
    float own = 1.0 - smoothstep( 0.25, 0.33, abs( up ) );
    if ( own <= 0.0 ) continue;
    uint h2 = h * 747796405u + 2891336453u;
    float size = float( ( h2 >> 8 ) & 1023u ) * ( 1.0 / 1023.0 );
    float r = 0.05 + 0.22 * size * size * sqrt( size );
    float age = float( ( h2 >> 20 ) & 255u ) * ( 1.0 / 255.0 );          // 1 fresh … 0 worn
    vec3 t = ( d - dn * up ) / r;
    float tl = length( t );
    /* rays run as far as the lattice can reach from a jittered centre, 0.47 of a cell: 480 km from
       a crater of the top octave, which is Tycho's order */
    float rmax = 0.47 / r;
    bool rayed = big > 0.5 && age > ( big > 1.5 ? 0.55 : 0.80 ) && r < 0.16;
    float aa = px / r;
    if ( tl > ( rayed ? rmax : 1.25 ) || aa > 1.6 ) continue;
    float vis = own * wgt * ( 1.0 - smoothstep( 0.35, 0.8, aa ) );
    /* the angle round the crater, in a frame its own hash turns */
    uint h3 = h2 * 747796405u + 2891336453u;
    vec3 a0 = vec3( float( h3 & 255u ), float( ( h3 >> 8 ) & 255u ), float( ( h3 >> 16 ) & 255u ) ) * ( 1.0 / 127.5 ) - 1.0;
    vec3 e1 = normalize( a0 - dn * dot( a0, dn ) + 1e-4 );
    float th = atan( dot( t, cross( dn, e1 ) ), dot( t, e1 ) );
    float worn = 1.0 - smoothstep( 0.25, 0.55, age );
    float fresh = smoothstep( 0.70, 0.86, age );
    /* a worn wall is down in one or two places: no crescent, no rim there */
    float wall = 1.0 - worn * smoothstep( 0.55, 0.75, cos( th * float( 1u + ( ( h3 >> 24 ) & 1u ) ) + float( h3 >> 25 ) * 0.05 ) )
                     * smoothstep( 0.55, 0.85, tl );                    // at the wall, not across the floor: a gap is not a pie slice
    float disc = 1.0 - smoothstep( 1.0 - aa, 1.0 + aa, tl );
    float a = disc * vis, soft = mix( 1.0, 0.45, worn ) * wall;
    float sh = smoothstep( 0.80 - aa, 0.80 + aa, length( t + st * e ) );
    float li = smoothstep( 0.80 - aa, 0.80 + aa, length( t - st * e ) );
    dark = max( dark, a * sh * ( 1.0 - li ) * soft );
    lite = max( lite, a * li * ( 1.0 - sh ) * soft );
    flr = max( flr, a * ( 1.0 - sh ) * ( 1.0 - li ) * ( 0.35 + 0.65 * age ) );
    /* the rim line: a thin bright ring that survives noon, when the crescents close. Hard on a
       fresh crater, gone from a worn one. */
    float rw = clamp( 2.0 * aa, 0.014, 0.05 );                          // a line, not a band: 2 px, within 1.4–5 % of the radius
    float ring = 1.0 - smoothstep( rw, rw + aa + 0.01, abs( tl - 1.0 ) );
    lite = max( lite, ring * vis * ( 0.30 + 0.45 * fresh ) * ( 1.0 - worn ) * wall * ( 1.0 - smoothstep( 0.2, 0.5, aa ) ) );
    /* the oldest of the large ones are flooded: a dark flat floor, the one crater a high sun shows */
    lava = max( lava, min( big, 1.0 ) * vis * ( 1.0 - smoothstep( 0.12, 0.22, age ) ) * ( 1.0 - smoothstep( 0.86 - aa, 0.86 + aa, tl ) ) * ( 1.0 - smoothstep( 0.12, 0.25, aa ) ) );
    /* a central peak in the larger ones: lit toward the sun, a shadow thrown behind */
    if ( size > 0.62 && worn < 0.5 ) {
      float pa = aa * 1.2;
      float pl = 1.0 - smoothstep( 0.12 - pa, 0.12 + pa, length( t - st * 0.04 ) );
      float pd = ( 1.0 - smoothstep( 0.13 - pa, 0.13 + pa, length( t + st * ( 0.05 + 0.2 * e ) ) ) ) * ( 1.0 - pl );
      float pv = vis * ( 1.0 - smoothstep( 0.04, 0.09, aa ) );
      lite = max( lite, pv * pl * 0.8 ); dark = max( dark, pv * pd * 0.8 );
    }
    /* fresh: the ejecta apron, bright, its edge ragged — two harmonics, or it is a cog. Not drawn
       under 12 px of radius, where its lobes are a pixel each. */
    float lobes = 0.06 * cos( th * 5.0 + float( h3 & 63u ) ) + 0.04 * cos( th * 11.0 + float( ( h3 >> 6 ) & 63u ) );
    float apron = ( 1.0 - smoothstep( 1.13 - aa, 1.13 + aa, tl + lobes ) ) * ( 1.0 - disc ) * ( 1.0 - smoothstep( 0.05, 0.085, aa ) );
    ray = max( ray, apron * fresh * vis * 0.5 );
    /* rays: spokes whose threshold climbs with distance, so each tapers to a point */
    if ( rayed && tl > 1.0 ) {
      float n = 6.0 + float( ( h3 >> 8 ) & 3u ) + float( ( h3 >> 10 ) & 1u ) * 2.0;
      float spoke = cos( th * n + float( h3 & 63u ) ) * ( 0.70 + 0.30 * cos( th * 3.0 + float( ( h3 >> 6 ) & 63u ) ) );
      /* the edge of a ray is the ground's own noise (rag): close to, a ray is a ragged streak with
         gaps in it, not a ruled band */
      float thr = 0.30 + 0.66 * ( tl - 1.0 ) / ( rmax - 1.0 ) + rag;
      float w = clamp( px * n / ( r * tl ), 0.02, 0.5 );                // a pixel, in units of the spoke's cosine
      float far = smoothstep( 0.30, 0.5, w );                           // too far to hold a spoke: a splash instead
      float rays = smoothstep( thr - w, thr + w, spoke ) * ( 1.0 - far )
                 + far * ( 1.0 - smoothstep( 1.5, 2.3, tl ) ) * 0.8;
      ray = max( ray, own * wgt * rays * ( 1.0 - smoothstep( 0.8, 1.6, aa ) ) );
    }
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
  float alb = F.r + ( n0.x - 0.5 ) * 0.03 + ( n1.x - 0.5 ) * 0.045 * w1 + ( n2.x - 0.5 ) * 0.045 * w2 + ( n3.x - 0.5 ) * 0.03 * w3;
  float wd = F.g + ( n1.y - 0.5 ) * 0.020 * w1 + ( n2.y - 0.5 ) * 0.010 * w2 + ( n3.y - 0.5 ) * 0.005 * w3 + ( n4.y - 0.5 ) * 0.002 * w4;

  vec3 col = mix( K_MID, K_HIGH, sfAA( 0.50, alb ) );
  col = mix( col, K_BRIGHT, sfAA( 0.66, alb ) );
  float inMare = ( sfMareCut - wd ) / max( fwidth( wd ), 1e-7 );      // pixels inside the mare border
  float mare = clamp( inMare * 0.7 + 0.5, 0.0, 1.0 );
  col = mix( col, K_MARIA, mare );
  /* the collar: a stroke on the inside of the border, 2.5 px, faded out where a mare is a dot */
  col *= 1.0 - 0.24 * mare * ( 1.0 - smoothstep( 2.0, 3.0, inMare ) ) * ( 1.0 - smoothstep( 12.0, 40.0, fp ) );

  /* patch tones */
  float tl = sfAA( 0.63, n0.y ) + w1 * sfAA( 0.63, n1.y ) + w2 * sfAA( 0.63, n2.y ) + w3 * sfAA( 0.63, n3.y ) + w4 * sfAA( 0.63, n4.x ) + w5 * sfAA( 0.63, n5.x );
  float td = sfAA( 0.63, 1.0 - n0.y ) + w1 * sfAA( 0.63, 1.0 - n1.y ) + w2 * sfAA( 0.63, 1.0 - n2.y ) + w3 * sfAA( 0.63, 1.0 - n3.y ) + w4 * sfAA( 0.63, 1.0 - n4.x ) + w5 * sfAA( 0.63, 1.0 - n5.x );
  col *= 1.0 + 0.045 * ( min( tl, 2.0 ) - min( td, 2.0 ) );

  /* the crater ladder. The two largest octaves are flooded out of the maria (F.b, the highland
     weight the relief uses too). */
  vec3 st = sfSun - dn * dot( sfSun, dn );
  float sl = length( st );
  st /= max( sl, 0.05 );
  float e = 0.10 + 0.34 * sl * sl;
  float dark = 0.0, lite = 0.0, flr = 0.0, ray = 0.0, lava = 0.0;
  float rag = ( n0.x - 0.5 ) * 0.35 + ( n1.x - 0.5 ) * 0.55 * w1 + ( n2.x - 0.5 ) * 0.45 * w2 + ( n3.y - 0.5 ) * 0.35 * w3;
  float hiK = 0.15 + 0.85 * F.b;
  float c8 = SFC( 1024.0 ), c0 = SFC( 256.0 ), c1 = SFC( 64.0 ), c2 = SFC( 16.0 ), c3 = SFC( 4.0 ), c4 = SFC( 1.0 ), c5 = SFC( 0.25 ), c6 = SFC( 0.0625 ), c7 = SFC( 0.015625 );
  /* F.a: where those two octaves reach at all (js/moonpaint.js craterReach: 2/3 for the 1024 km
     lattice, 1/3 for the 256 km one, 1 for both). Past ~8 km a pixel the sheet's mips have
     averaged the mask and it is not asked. */
  float open = step( 8.0, fp );
  if ( F.a + open < 0.36 ) c8 = 0.0;
  if ( open < 0.5 && ( F.a < 0.02 || ( F.a > 0.63 && F.a < 0.70 ) ) ) c0 = 0.0;
  if ( c8 > 0.0 ) sfCraters( Lp / 1024.0 + sfCellF[8], sfCellI[8], fp / 1024.0, dn, st, e, c8 * hiK, 48u, 2.0, rag, dark, lite, flr, ray, lava );
  if ( c0 > 0.0 ) sfCraters( Lp / 256.0 + sfCellF[0], sfCellI[0], fp / 256.0, dn, st, e, c0 * hiK, 40u, 1.0, rag, dark, lite, flr, ray, lava );
  if ( c1 > 0.0 ) sfCraters( Lp / 64.0 + sfCellF[1], sfCellI[1], fp / 64.0, dn, st, e, c1, 41u, 0.0, 0.0, dark, lite, flr, ray, lava );
  if ( c2 > 0.0 ) sfCraters( Lp / 16.0 + sfCellF[2], sfCellI[2], fp / 16.0, dn, st, e, c2, 42u, 0.0, 0.0, dark, lite, flr, ray, lava );
  if ( c3 > 0.0 ) sfCraters( Lp / 4.0 + sfCellF[3], sfCellI[3], fp / 4.0, dn, st, e, c3, 43u, 0.0, 0.0, dark, lite, flr, ray, lava );
  if ( c4 > 0.0 ) sfCraters( Lp / 1.0 + sfCellF[4], sfCellI[4], fp / 1.0, dn, st, e, c4, 44u, 0.0, 0.0, dark, lite, flr, ray, lava );
  if ( c5 > 0.0 ) sfCraters( Lp / 0.25 + sfCellF[5], sfCellI[5], fp / 0.25, dn, st, e, c5, 45u, 0.0, 0.0, dark, lite, flr, ray, lava );
  if ( c6 > 0.0 ) sfCraters( Lp / 0.0625 + sfCellF[6], sfCellI[6], fp / 0.0625, dn, st, e, c6, 46u, 0.0, 0.0, dark, lite, flr, ray, lava );
  if ( c7 > 0.0 ) sfCraters( Lp / 0.015625 + sfCellF[7], sfCellI[7], fp / 0.015625, dn, st, e, c7, 47u, 0.0, 0.0, dark, lite, flr, ray, lava );
  /* on the night side there is no sun to throw a crescent: the bowls keep only their floor tone */
  float day = smoothstep( - 0.04, 0.10, dot( dn, sfSun ) );
  col = mix( col, K_MARIA, lava * 0.85 );
  col = mix( col, K_BRIGHT * 1.30, ray * 0.9 );
  col *= 1.0 - 0.42 * dark * day + 0.34 * lite * day - 0.11 * flr;
  return col;
}
`;
