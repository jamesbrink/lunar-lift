import * as THREE from 'three';
import { glowTex } from './textures.js';
import { LAYER_FX } from './halfres.js';

/* The drawn flame: one mesh per stage holding a tube for every engine, shaped and painted entirely in
   its shader. It is the fire; the particle field (js/exhaust-*.js) is the smoke, the steam and the dust.

   Why a mesh and not sprites: a flame in a cel drawing is a SHAPE with tone bands inside it — pale
   core, yellow, orange mantle — and those bands have to be hard edges at the screen's full resolution.
   The predecessor was two nested additive teardrops per engine, and additive light over a pale blue
   sky can only wash toward white: at the pad it read as a short pale-yellow smear. This one composites
   (premultiplied: rgb = tone·(cover + glow), a = cover), so at sea level it is nearly opaque paint and
   in vacuum, where `cover` falls to almost nothing, it is a translucent veil.

   What the shader draws, all of it a function of (t along the jet, angle round it, time, air):
   - the outline: a teardrop the bell's own width in thick air, opening into the wide bell an
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

const VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec2 aUV;       // x: 0 at the bell, 1 at the tip. y: angle round the jet
  attribute vec4 aEng;      // xy: the engine's place in the stage, z: a phase, w: its start-up delay
  uniform float uTime, uLen, uRad, uVac, uStart, uZ, uCant, uWide;
  uniform vec2 uGimbal;
  varying float vT, vF, vSeed;
  float radius( float t, float seed ) {
    float sea = ( 0.95 + 0.95 * sin( min( t, 0.5 ) * 3.14159 ) ) * pow( max( 1.0 - t, 0.0 ), 0.8 );
    sea *= 1.0 - 0.10 * pow( sin( 3.14159 * t * 5.0 ), 2.0 ) * ( 1.0 - smoothstep( 0.45, 0.7, t ) );   // the diamonds pinch it
    float bell = 1.0 + uWide * ( 1.0 - exp( -4.0 * t ) );
    float r = mix( sea, bell, uVac );
    r *= 1.0 + 0.07 * sin( t * 21.0 - uTime * 34.0 + seed ) * smoothstep( 0.08, 0.4, t );              // bulges running aft
    return r * uRad;
  }
  void main() {
    float on = smoothstep( 0.0, 0.45, uStart - aEng.w );
    float seed = aEng.z;
    float len = uLen * on * ( 1.0 + 0.05 * sin( uTime * 23.0 + seed * 3.0 ) );
    float t = aUV.x, th = aUV.y;
    float r = radius( t, seed );
    float dr = ( radius( t + 0.02, seed ) - r ) / 0.02;
    /* tongues: the tail is not round */
    r *= 1.0 + 0.22 * sin( th * 3.0 + seed * 5.0 + uTime * 15.0 ) * smoothstep( 0.45, 1.0, t ) * ( 1.0 - uVac );
    vec2 c = vec2( cos( th ), sin( th ) );
    float out2 = dot( aEng.xy, aEng.xy );
    vec2 cant = out2 > 1e-6 ? aEng.xy * inversesqrt( out2 ) * uCant : vec2( 0.0 );
    vec3 p = vec3( aEng.xy + c * r * on + ( cant * t + uGimbal * t * t ) * len, uZ - t * len );
    vec3 n = normalize( vec3( c * max( len, 1e-3 ), dr ) );
    vec4 mv = modelViewMatrix * vec4( p, 1.0 );
    vF = dot( normalize( normalMatrix * n ), normalize( -mv.xyz ) );
    vT = t; vSeed = seed;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

/* Shared by the painted flame and the punch: how much of the pixel the flame covers, and which band. */
const BANDS = /* glsl */`
  uniform float uTime, uVac, uSoot, uCover, uVeil;
  varying float vT, vF, vSeed;
  /* x: band 0 core, 1 middle, 2 mantle, 3 soot collar, 4 diamond.  y: coverage. */
  vec2 flameBand() {
    float f = clamp( vF, 0.0, 1.0 );
    float lat = sqrt( 1.0 - f * f );                       // 0 on the centre line, 1 on the silhouette
    float wob = 0.06 * sin( vT * 26.0 - uTime * 30.0 + vSeed );
    float thick = 1.0 - uVac;
    float wCore = ( 0.50 - 0.50 * vT ) * ( 1.0 - 0.45 * uVac ) + wob;
    float wMid = 0.80 - 0.42 * vT + wob;
    float band = lat < wCore ? 0.0 : lat < wMid ? 1.0 : 2.0;
    /* shock diamonds: a chain of lozenges on the axis, standing only where the air is thick */
    float d = abs( fract( vT * 5.0 + 0.1 ) - 0.5 ) * 2.0;
    if ( vT < 0.62 && lat < 0.5 * ( 1.0 - d ) * thick - 0.08 ) band = 4.0;
    if ( band > 1.5 && vT < uSoot * ( 0.07 + 0.3 * wob ) ) band = 3.0;
    /* coverage: paint in thick air, a veil in vacuum that thins in steps toward the tail */
    float step3 = 1.0 - floor( clamp( vT * 1.15 + wob, 0.0, 0.999 ) * 3.0 ) / 3.0;
    float veil = uVeil * step3 * ( band < 0.5 ? 1.6 : band < 1.5 ? 1.0 : 0.55 );
    float cover = mix( uCover * ( band < 1.5 || band > 3.5 ? 1.0 : 0.86 ), veil, uVac );
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
    float glow = b.x > 2.5 && b.x < 3.5 ? 0.0 : uGlow * mix( 1.0, 2.2, uVac );
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
   is how many bell radii the vacuum plume opens by; `cover` is the sea-level opacity and `veil` the
   vacuum one. Kerosene burns orange and sooty; hydrogen is a pale blue that is barely there. */
const LOOKS = [
  { len: 46, rad: 1.2, wide: 11.0, vacLen: 2.3, cover: 0.96, veil: 0.20, glow: 0.10, soot: 1, cant: 0.035,
    core: 0xfff8dc, mid: 0xffd43c, out: 0xff7d1e, sootC: 0x7d3415, halo: 0xffa24a, haloSize: 26, delays: [0, 0.25, 0.5, 0.25, 0.5] },
  { len: 15, rad: 0.72, wide: 10.0, vacLen: 2.6, cover: 0.55, veil: 0.085, glow: 0.5, soot: 0, cant: 0,
    core: 0xf6fbff, mid: 0xb4dcff, out: 0x6aaeff, sootC: 0x6aaeff, halo: 0x9cc8ff, haloSize: 9, delays: [0, 0.1, 0.2, 0.1, 0.2] },
  { len: 9, rad: 0.85, wide: 2.6, vacLen: 1.3, cover: 0.8, veil: 0.34, glow: 0.6, soot: 0, cant: 0,
    core: 0xffffff, mid: 0xc4e6ff, out: 0x74b6ff, sootC: 0x74b6ff, halo: 0xa8d0ff, haloSize: 5, delays: [0] },
];

/* The shader writes its tones straight to the canvas (a raw ShaderMaterial has no output encoding), so
   a colour is handed over as the bytes it should be on screen, not converted to linear. */
const paint = (hex) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);

const flames = [];     // per stage: { mesh, punch, halo, look, uniforms }

function tubeGeometry(engines, delays) {
  const nv = (NT + 1) * NA, n = engines.length;
  const pos = new Float32Array(n * nv * 3), uv = new Float32Array(n * nv * 2), eng = new Float32Array(n * nv * 4);
  const idx = [];
  engines.forEach(([x, y], e) => {
    const base = e * nv;
    for (let i = 0; i <= NT; i++) for (let j = 0; j < NA; j++) {
      const k = base + i * NA + j;
      uv[k * 2] = i / NT; uv[k * 2 + 1] = j / NA * Math.PI * 2;
      eng[k * 4] = x; eng[k * 4 + 1] = y; eng[k * 4 + 2] = e * 1.7 + 0.3; eng[k * 4 + 3] = delays[e % delays.length];
      pos[k * 3] = x; pos[k * 3 + 1] = y;
    }
    for (let i = 0; i < NT; i++) for (let j = 0; j < NA; j++) {
      const a = base + i * NA + j, b = base + i * NA + (j + 1) % NA, c = a + NA, d = b + NA;
      idx.push(a, c, b, b, c, d);          // t runs aft (−z), so this winding faces outward
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aUV', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aEng', new THREE.BufferAttribute(eng, 4));
  g.setIndex(idx);
  return g;
}

/* Build the flames for the stage records js/saturn.js exports (their `engines`, `tailZ` and group). */
export function buildFlames(stages) {
  stages.forEach((st, s) => {
    const look = LOOKS[s];
    const uniforms = {
      uTime: { value: 0 }, uLen: { value: look.len }, uRad: { value: look.rad }, uVac: { value: 0 }, uStart: { value: 9 },
      uZ: { value: st.tailZ + 0.5 }, uCant: { value: look.cant }, uWide: { value: look.wide }, uGimbal: { value: new THREE.Vector2() },
      uSoot: { value: look.soot }, uCover: { value: look.cover }, uVeil: { value: look.veil }, uGlow: { value: look.glow },
      cCore: { value: paint(look.core) }, cMid: { value: paint(look.mid) }, cOut: { value: paint(look.out) }, cSoot: { value: paint(look.sootC) },
    };
    const common = { uniforms, vertexShader: VERT, transparent: true, depthWrite: false, fog: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor };
    const geo = tubeGeometry(st.engines, look.delays);
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ ...common, fragmentShader: FRAG }));
    /* ZERO / ONE_MINUS_SRC_ALPHA on colour and alpha alike: what is already in the target is scaled
       down by the flame's coverage and nothing is added — an eraser. */
    const punch = new THREE.Mesh(geo, new THREE.ShaderMaterial({ ...common, fragmentShader: PUNCH, blendSrc: THREE.ZeroFactor }));
    mesh.renderOrder = 1;                    // under the half-resolution layer's composite (2)
    punch.layers.set(LAYER_FX); punch.renderOrder = 4;   // after the puffs (3), before the sparks (5)
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: look.halo, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    halo.position.z = st.tailZ - 1; halo.renderOrder = 12;
    for (const o of [mesh, punch, halo]) { o.frustumCulled = false; o.castShadow = false; o.visible = false; st.meshes.add(o); }
    flames.push({ mesh, punch, halo, look, uniforms });
  });
}

/* Pose the flames for this frame. `vac` is 0 in sea-level air and 1 in none; `since` is seconds of
   burn so far (the start-up reads it); `gx, gy` swing the jets against the body rate, in radians. */
export function updateFlames(active, burning, throttle, vac, since, time, gx, gy) {
  for (let s = 0; s < flames.length; s++) {
    const f = flames[s], on = burning && s === active;
    f.mesh.visible = f.punch.visible = f.halo.visible = on;
    if (!on) continue;
    const u = f.uniforms, look = f.look;
    /* The plume opens late: half way to vacuum by density is only ~17 km up, where a Saturn V's flame
       is still a column. The cube puts the opening where the air is really gone. */
    const open = vac * vac * vac;
    u.uTime.value = time % 1000; u.uVac.value = open; u.uStart.value = since;
    u.uLen.value = look.len * (0.3 + 0.7 * throttle) * (1 + (look.vacLen - 1) * open);
    u.uRad.value = look.rad * (0.85 + 0.15 * throttle);
    u.uGimbal.value.set(gx, gy);
    const lit = Math.min(1, since * 2.5) * (0.5 + 0.5 * throttle);
    f.halo.scale.setScalar(look.haloSize * (0.6 + 0.4 * throttle) * (1 + 0.8 * open));
    f.halo.material.opacity = 0.42 * lit * (1 - 0.6 * open);
  }
}

/* Where the visible fire ends, in km aft of the exit plane: the smoke trail starts there. */
export function flameReach(active, throttle, VS) {
  const f = flames[active];
  return f ? f.look.len * (0.3 + 0.7 * throttle) * 0.75 * VS : 0;
}
