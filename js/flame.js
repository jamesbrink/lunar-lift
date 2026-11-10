import * as THREE from 'three';
import { LAYER_FX } from './halfres.js';

/* The drawn flame: one mesh per stage holding a tube for every engine, shaped and painted entirely in
   its shader. It is the fire; the particle field (js/exhaust-*.js) is the smoke, the steam and the dust.

   Why a mesh and not sprites: a flame in a cel drawing is a SHAPE with tone bands inside it — pale
   core, yellow, orange mantle — and those bands have to be hard edges at the screen's full resolution.
   The predecessor was two nested additive teardrops per engine, and additive light over a pale blue
   sky can only wash toward white: at the pad it read as a short pale-yellow smear. This one composites
   (premultiplied: rgb = tone·(cover + glow), a = cover), so at sea level it is nearly opaque paint and
   in vacuum, where `cover` falls to flat veils, it is a translucent shape with the same hard bands.
   Nothing here is soft: the additive halo sprite each stage used to carry is gone, and the light the
   fire throws on the smoke is painted on the puffs themselves (js/exhaust-draw.js).

   What the shader draws, all of it a function of (t along the jet, angle round it, time, air):
   - the outline: a teardrop the bell's own width in thick air, opening into the wide balloon an
     under-expanded nozzle throws as the air thins (`vac`, from the physics module's own density);
   - tone bands by how squarely the surface faces the eye, which on a body of revolution is the
     distance from its centre line — so the core is always in the middle of the silhouette from any
     side. Band edges ride a travelling wave, which is the flicker: shapes moving down the jet, not
     noise;
   - shock diamonds while there is air to stand them up, a sooty collar at the lip of a kerosene
     engine, tongues at the tail;
   - a start-up: each engine has a delay, so five F-1s light centre first and then in opposed pairs.

   Order against the smoke. The smoke is drawn in the half-resolution pass and laid over the frame, so
   a mesh in the main pass is either always under it or always over it. Neither is right: the trail is
   behind the flame, the pad cloud is in front of it. So the flame is drawn twice: here in the main
   pass, under the smoke layer, and again into the half-resolution target by `punch` — same vertices,
   depth-tested against the puffs' own depth, writing only "erase" — which cuts the flame's outline out
   of whatever smoke is behind it. The flame shows through that hole at full resolution. */

const NT = 20, NA = 14;                    // rings along the jet, segments round it, per engine

/* Two kinds of tube share the mesh. A JET stands on each bell: narrow, with the shock diamonds and the
   soot collar. The ENVELOPE (aUV.z = 1) is the one fire a cluster's jets merge into a few bell lengths
   down: at the pad a fat torch a little wider than the stage, and as the ambient pressure falls it
   swells into the balloon an under-expanded cluster really throws — several vehicle diameters across
   and longer than the stage by 30 km. Its triangles come first in the index, so the jets paint over it. */
const VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 aUV;       // x: 0 at the bell, 1 at the tip. y: angle round the jet. z: 0 jet, 1 envelope
  attribute vec4 aEng;      // xy: the engine's place in the stage, z: a phase, w: its start-up delay
  uniform float uTime, uLen, uRad, uVac, uStart, uZ, uCant, uWide;
  uniform float uEnvLen, uEnvRad, uEnvWide;
  uniform vec2 uGimbal;
  varying float vT, vF, vSeed, vKind;
  float radius( float t, float seed, float env ) {
    float close = sqrt( max( 1.0 - t * t * t * t, 0.0 ) );                                             // a vacuum plume is a balloon, not a funnel
    float sea = ( 0.95 + 0.95 * sin( min( t, 0.5 ) * 3.14159 ) ) * pow( max( 1.0 - t, 0.0 ), 0.8 );
    sea *= 1.0 - 0.10 * pow( sin( 3.14159 * t * 5.0 ), 2.0 ) * ( 1.0 - smoothstep( 0.45, 0.7, t ) );   // the diamonds pinch it
    float bell = ( 1.0 + uWide * ( 1.0 - exp( -4.0 * t ) ) ) * close;
    float seaE = mix( 0.72, 1.0, smoothstep( 0.0, 0.2, t ) ) * pow( max( 1.0 - smoothstep( 0.25, 1.0, t ), 0.0 ), 0.85 );
    float bellE = ( 0.72 + uEnvWide * ( 1.0 - exp( -3.5 * t ) ) ) * close;
    float r = mix( mix( sea, bell, uVac ) * uRad, mix( seaE, bellE, uVac ) * uEnvRad, env );
    /* bulges running aft: fast and fine on a jet, slow and long on the envelope */
    r *= 1.0 + mix( 0.07, 0.05, env ) * sin( t * mix( 21.0, 12.0, env ) - uTime * mix( 34.0, 19.0, env ) + seed ) * smoothstep( 0.08, 0.4, t );
    return r;
  }
  void main() {
    float env = aUV.z;
    float on = smoothstep( 0.0, 0.45, uStart - aEng.w );
    float seed = aEng.z;
    float len = mix( uLen, uEnvLen, env ) * on * ( 1.0 + mix( 0.05, 0.03, env ) * sin( uTime * 23.0 + seed * 3.0 ) );
    float t = aUV.x, th = aUV.y;
    float r = radius( t, seed, env );
    float dr = ( radius( t + 0.02, seed, env ) - r ) / 0.02;
    /* tongues: the tail is not round */
    r *= 1.0 + mix( 0.22, 0.16, env ) * sin( th * mix( 3.0, 5.0, env ) + seed * 5.0 + uTime * mix( 15.0, 9.0, env ) ) * smoothstep( 0.45, 1.0, t ) * ( 1.0 - uVac * mix( 1.0, 0.55, env ) );
    vec2 c = vec2( cos( th ), sin( th ) );
    float out2 = dot( aEng.xy, aEng.xy );
    vec2 cant = out2 > 1e-6 ? aEng.xy * inversesqrt( out2 ) * uCant : vec2( 0.0 );
    vec3 p = vec3( aEng.xy + c * r * on + ( cant * t + uGimbal * t * t ) * len, uZ - t * len );
    vec3 n = normalize( vec3( c * max( len, 1e-3 ), dr ) );
    vec4 mv = modelViewMatrix * vec4( p, 1.0 );
    vF = dot( normalize( normalMatrix * n ), normalize( -mv.xyz ) );
    vT = t; vSeed = seed; vKind = env;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

/* Shared by the painted flame and the punch: how much of the pixel the flame covers, and which band. */
const BANDS = /* glsl */`
  uniform float uTime, uVac, uThin, uSoot, uCover, uVeil;
  varying float vT, vF, vSeed, vKind;
  /* x: band 0 core, 1 middle, 2 mantle, 3 soot collar, 4 diamond.  y: coverage. */
  vec2 flameBand() {
    float f = clamp( vF, 0.0, 1.0 );
    float lat = sqrt( 1.0 - f * f );                       // 0 on the centre line, 1 on the silhouette
    float env = step( 0.5, vKind );
    float wob = 0.06 * sin( vT * mix( 26.0, 15.0, env ) - uTime * mix( 30.0, 17.0, env ) + vSeed );
    float thick = 1.0 - uVac;
    /* the envelope's pale heart is narrower: it is the mantle, the jets inside it are the core */
    float wCore = mix( ( 0.50 - 0.50 * vT ) * ( 1.0 - 0.45 * uVac ), ( 0.36 - 0.34 * vT ) * ( 1.0 - 0.5 * uVac ), env ) + wob;
    float wMid = mix( 0.80 - 0.42 * vT, 0.74 - 0.36 * vT, env ) + wob;
    float band = lat < wCore ? 0.0 : lat < wMid ? 1.0 : 2.0;
    if ( env < 0.5 ) {
      /* shock diamonds: a chain of lozenges on the axis, standing only where the air is thick */
      float d = abs( fract( vT * 5.0 + 0.1 ) - 0.5 ) * 2.0;
      if ( vT < 0.62 && lat < 0.5 * ( 1.0 - d ) * thick - 0.08 ) band = 4.0;
      if ( band > 1.5 && vT < uSoot * ( 0.07 + 0.3 * wob ) ) band = 3.0;
    }
    /* coverage: paint in thick air; in thin air flat veils, one step per band and three steps down
       the length, every edge hard */
    float step3 = 1.0 - floor( clamp( vT * 1.15 + wob, 0.0, 0.999 ) * 3.0 ) / 3.0;
    float veil = uVeil * step3 * ( band < 0.5 ? 1.8 : band < 1.5 ? 1.25 : 0.8 );
    float cover = mix( uCover * ( band < 1.5 || band > 3.5 ? 1.0 : 0.86 ), min( veil, 0.95 ), uThin );
    return vec2( band, cover );
  }`;

const FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 cCore, cMid, cOut, cSoot;
  uniform float uGlow;
` + BANDS + /* glsl */`
  void main() {
    #include <logdepthbuf_fragment>
    vec2 b = flameBand();
    vec3 col = b.x < 0.5 ? cCore : b.x < 1.5 ? cMid : b.x < 2.5 ? cOut : b.x < 3.5 ? cSoot : vec3( 1.0 );
    if ( vKind > 0.5 && b.x < 0.5 ) col = mix( cCore, cMid, 0.6 );      // the envelope's heart is a tone, not the jets' white
    float glow = b.x > 2.5 && b.x < 3.5 ? 0.0 : uGlow * mix( 1.0, 2.2, uThin );
    gl_FragColor = vec4( col * ( b.y + glow * b.y ), b.y );
  }`;

const PUNCH = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
` + BANDS + /* glsl */`
  void main() {
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4( 0.0, 0.0, 0.0, flameBand().y );
  }`;

/* Per-stage look. Lengths and radii are build units (1 u = 1.4 m) at full throttle in thick air; `wide`
   is how many radii the vacuum plume opens by, `vacLen` how much longer it is there; `cover` is the
   sea-level opacity and `veil` the vacuum one. `env` is the merged fire of a cluster (see VERT); a
   single engine has none. Kerosene burns orange and sooty; hydrogen is pale blue, drawn in the same
   three flat bands.
   The S-1's numbers against the airframe (hull radius 3.63 u, stage 42 u, vehicle 80 u): on the pad
   the envelope is 5.4 u in radius and 62 u long; fully open it is 5.4 × (0.72 + 3.0) = 20 u in radius
   — five and a half hull diameters across — and 62 × 2.4 = 149 u long, three and a half stage lengths. */
const LOOKS = [
  { len: 40, rad: 1.2, wide: 2.2, vacLen: 1.5, cover: 0.96, veil: 0.48, glow: 0.10, soot: 1, cant: 0.035,
    env: { len: 62, rad: 5.4, wide: 3.0, vacLen: 2.4, delay: 0.5 },
    core: 0xfff8dc, mid: 0xffd43c, out: 0xff7d1e, sootC: 0x7d3415, tint: 0xff9a3c, delays: [0, 0.25, 0.5, 0.25, 0.5] },
  { len: 15, rad: 0.72, wide: 2.6, vacLen: 1.8, cover: 0.7, veil: 0.5, glow: 0.2, soot: 0, cant: 0,
    env: { len: 26, rad: 2.7, wide: 3.0, vacLen: 2.3, delay: 0.25 },
    core: 0xf6fbff, mid: 0xa9d6ff, out: 0x5c9df2, sootC: 0x5c9df2, tint: 0x9cc8ff, delays: [0, 0.1, 0.2, 0.1, 0.2] },
  { len: 9, rad: 0.85, wide: 2.6, vacLen: 1.3, cover: 0.8, veil: 0.52, glow: 0.2, soot: 0, cant: 0,
    core: 0xffffff, mid: 0xb6deff, out: 0x66a8f6, sootC: 0x66a8f6, tint: 0xa8d0ff, delays: [0] },
  /* The LM's hypergolics: single bells, a hotter whiter core than the J-2 family and an amber rim —
     NTO/A-50 burns bright orange, and neither stage throws a merged envelope (one jet each). */
  { len: 12, rad: 0.72, wide: 2.4, vacLen: 1.5, cover: 0.8, veil: 0.5, glow: 0.2, soot: 0, cant: 0,
    core: 0xffffff, mid: 0xffd96a, out: 0xff8a2e, sootC: 0xff8a2e, tint: 0xffb45a, delays: [0] },
  { len: 8, rad: 0.55, wide: 2.4, vacLen: 1.5, cover: 0.8, veil: 0.52, glow: 0.2, soot: 0, cant: 0,
    core: 0xffffff, mid: 0xffd96a, out: 0xff8a2e, sootC: 0xff8a2e, tint: 0xffb45a, delays: [0] },
];

/* The shader writes its tones straight to the canvas (a raw ShaderMaterial has no output encoding), so
   a colour is handed over as the bytes it should be on screen, not converted to linear. */
const paint = (hex) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);

const flames = [];     // per stage: { mesh, punch, look, uniforms }
let openNow = 0;       // how far the plume has opened this frame (0 sea level, 1 vacuum)

/* `tubes`: [x, y, delay, kind] each — envelopes first, so the jets draw over them. */
function tubeGeometry(tubes) {
  const nv = (NT + 1) * NA, n = tubes.length;
  const pos = new Float32Array(n * nv * 3), uv = new Float32Array(n * nv * 3), eng = new Float32Array(n * nv * 4);
  const idx = [];
  tubes.forEach(([x, y, delay, kind], e) => {
    const base = e * nv;
    for (let i = 0; i <= NT; i++) for (let j = 0; j < NA; j++) {
      const k = base + i * NA + j;
      /* the envelope's rings crowd toward the bell, where its outline turns fastest */
      uv[k * 3] = kind ? Math.pow(i / NT, 1.35) : i / NT; uv[k * 3 + 1] = j / NA * Math.PI * 2; uv[k * 3 + 2] = kind;
      eng[k * 4] = x; eng[k * 4 + 1] = y; eng[k * 4 + 2] = e * 1.7 + 0.3; eng[k * 4 + 3] = delay;
      pos[k * 3] = x; pos[k * 3 + 1] = y;
    }
    for (let i = 0; i < NT; i++) for (let j = 0; j < NA; j++) {
      const a = base + i * NA + j, b = base + i * NA + (j + 1) % NA, c = a + NA, d = b + NA;
      idx.push(a, c, b, b, c, d);          // t runs aft (−z), so this winding faces outward
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aUV', new THREE.BufferAttribute(uv, 3));
  g.setAttribute('aEng', new THREE.BufferAttribute(eng, 4));
  g.setIndex(idx);
  return g;
}

/* Build the flames for the stage records js/saturn.js exports (their `engines`, `tailZ` and group). */
export function buildFlames(stages) {
  stages.forEach((st, s) => {
    const look = LOOKS[s], env = look.env;
    const uniforms = {
      uTime: { value: 0 }, uLen: { value: look.len }, uRad: { value: look.rad }, uVac: { value: 0 }, uThin: { value: 0 }, uStart: { value: 9 },
      uZ: { value: st.tailZ + 0.5 }, uCant: { value: look.cant }, uWide: { value: look.wide }, uGimbal: { value: new THREE.Vector2() },
      uEnvLen: { value: env ? env.len : 1 }, uEnvRad: { value: env ? env.rad : 1 }, uEnvWide: { value: env ? env.wide : 1 },
      uSoot: { value: look.soot }, uCover: { value: look.cover }, uVeil: { value: look.veil }, uGlow: { value: look.glow },
      cCore: { value: paint(look.core) }, cMid: { value: paint(look.mid) }, cOut: { value: paint(look.out) }, cSoot: { value: paint(look.sootC) },
    };
    const common = { uniforms, vertexShader: VERT, transparent: true, depthWrite: false, fog: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor };
    const tubes = st.engines.map(([x, y], e) => [x, y, look.delays[e % look.delays.length], 0]);
    if (env) tubes.unshift([0, 0, env.delay, 1]);
    const geo = tubeGeometry(tubes);
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ ...common, fragmentShader: FRAG }));
    /* ZERO / ONE_MINUS_SRC_ALPHA on colour and alpha alike: what is already in the target is scaled
       down by the flame's coverage and nothing is added — an eraser. */
    const punch = new THREE.Mesh(geo, new THREE.ShaderMaterial({ ...common, fragmentShader: PUNCH, blendSrc: THREE.ZeroFactor }));
    mesh.renderOrder = 1;                    // under the half-resolution layer's composite (2)
    punch.layers.set(LAYER_FX); punch.renderOrder = 4;   // after the puffs (3), before the sparks (5)
    for (const o of [mesh, punch]) { o.frustumCulled = false; o.castShadow = false; o.visible = false; st.meshes.add(o); }
    flames.push({ mesh, punch, look, uniforms });
  });
}

/* Pose the flames for this frame. `vac` is 0 in sea-level air and 1 in none; `since` is seconds of
   burn so far (the start-up reads it); `time` is the clock the shapes travel on; `gx, gy` swing the
   jets against the body rate, in radians. */
export function updateFlames(active, burning, throttle, vac, since, time, gx, gy) {
  for (let s = 0; s < flames.length; s++) {
    const f = flames[s], on = burning && s === active;
    f.mesh.visible = f.punch.visible = on;
    if (!on) continue;
    const u = f.uniforms, look = f.look, env = look.env;
    /* Two clocks off the one density (vac = 1 - exp(-alt / 17 km)). The SHAPE opens on vac squared
       — 0.07 at 5 km, 0.34 at 15, 0.63 at 27, 0.89 at the 49 km of staging — because that is when a
       Saturn V's fire is seen to swell. The PAINT thins on the cube: the flame is still opaque colour at 15 km and a set
       of flat veils only where the air has really gone. */
    const open = vac * vac, thr = 0.3 + 0.7 * throttle;
    openNow = open;
    u.uTime.value = time % 1000; u.uVac.value = open; u.uThin.value = vac * vac * vac; u.uStart.value = since;
    u.uLen.value = look.len * thr * (1 + (look.vacLen - 1) * open);
    u.uRad.value = look.rad * (0.85 + 0.15 * throttle);
    if (env) {
      u.uEnvLen.value = env.len * thr * (1 + (env.vacLen - 1) * open);
      u.uEnvRad.value = env.rad * (0.8 + 0.2 * throttle);
    }
    u.uGimbal.value.set(gx, gy);
  }
}

/* Where the visible fire ends, in km aft of the exit plane, and how wide it is near there, in
   metres: the smoke trail starts at that place and at that width. */
export function flameReach(active, throttle, VS) {
  const f = flames[active];
  if (!f) return 0;
  const e = f.look.env || f.look;
  return e.len * (0.3 + 0.7 * throttle) * (1 + (e.vacLen - 1) * openNow) * 0.82 * VS;
}
export function flameWidth(active, VS) {
  const f = flames[active];
  if (!f) return 0;
  const e = f.look.env;
  return (e ? e.rad * (0.55 + e.wide * 0.8 * openNow) : f.look.rad) * VS * 1000;
}

/* The colour a burning stage throws on the smoke round it (js/exhaust-draw.js), as a hex. */
export function flameTint(active) { const f = flames[active]; return f ? f.look.tint : 0; }
