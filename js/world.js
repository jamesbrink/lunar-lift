import * as THREE from 'three';
import {
  RE, RM, MOON_RATE, EARTH_SPIN, PAD_UP, PAD_EAST, PAD_SCALE, PAD_POS, SKY_DAY, SKY_NULL, moonPos
} from './constants.js';
import { cumulusTex, cirrusTex, moonTex, earthTex, glowTex, flareTex } from './textures.js';
import { toon, outline, PALETTE, RAMP_EARTH, RAMP_MOON, RAMP_CLOUD } from './toon.js';
import {
  applyRelief, sampleGrid, reliefField, coastField, shoreDistance, fineEarth,
  padWeight, paintedCanvas,
} from './toonmap.js';
import { makePatch, attachEarthPatch, updatePatch, makeMoonPatch, attachMoonPatch, updateMoonPatch, hidePatch } from './terrain.js';
import { makeCloudLayer, updateCloudLayer } from './clouds.js';

/* distances are km, angles rad — everything here lives at real planetary scale */
const SUN_RANGE = 1500;            // km the directional light sits off the tracked vehicle
const SUN_DIST = 1000000;          // km — the flare sprite rides a million km out on the sun's bearing
const SUN_ANG = 0.009;             // rad: the real sun is 0.53° wide, so the flare disk is 0.9% of its range
const STAR_R = 2000000;            // km — the starfield sits well outside the moon's orbit
const SKY_R = 20000;               // km — the sky dome rides the camera; small vs the moon at 384 400
const SHADOW_MAX = 48;             // km half-extent of the vehicle-tracking shadow box
const SHADOW_MIN = 6;              // km — tight enough for ~100 m pad structures to resolve
const CUMULUS_ALT = 2, CIRRUS_ALT = 9;          // km above the surface
const ATMO_SHELL = 1.01;          // atmosphere glow shell: RE * 1.01

/* Sun bearing, fixed in inertial space: ~37° above the pad's horizon at MET 0, off to the east, so
   the pad, the rocket and the towers are lit at liftoff and the planet turns under the light. */
const PAD_NORTH = new THREE.Vector3().crossVectors(PAD_UP, PAD_EAST).normalize();
const SUN_ELEV = 0.645;                                    // rad, 37 deg
/* Exported for the orbital map (js/hud.js): the night side on the map's Earth disc has to sit where
   this light actually is, and the sun bearing is inertial and constant, so the map can treat it as
   truth exactly like the renderer does. */
export const SUN_DIR = PAD_UP.clone().multiplyScalar(Math.sin(SUN_ELEV))
  .addScaledVector(PAD_EAST, Math.cos(SUN_ELEV) * 0.85)
  .addScaledVector(PAD_NORTH, Math.cos(SUN_ELEV) * 0.4).normalize();

let scene = null, earth = null, pad = null, cumulus = null, cirrus = null, atmo = null, moon = null;
let sun = null, sunTarget = null, flare = null, stars = null, sky = null;
let spin = 0, cloudSpin = 0, cirrusSpin = 0, simT = 0;
/* The floodlight LENS sprites, kept for the night gate in updateSunShadow. They were ungated —
   created in buildPad and never touched again — so four additive warm discs baked daytime haze
   into the pad lenses at all hours. The lamps themselves (housing, truss) stay year-round. */
const padLamps = [];

/* Ground cloud shade is a NEAR-SCALE projected texture now (js/clouds.js): the shade cap is the
   same 64 km tile as the deck above it, offset anti-sunward by deck height over tan(elevation) and
   draped on the terrain, so the dark shape on the ground is the cloud that casts it.

   What used to live here was an onBeforeCompile injection marching each ground fragment to the
   planet-scale decks and sampling a blurred 512x256 composite of their alpha. It was correct in
   principle and unusable in practice: 78 km per texel meant the shade could only ever be slabs —
   straight-edged sawtooth wedges that staircased across the pad and read as terrain damage, not
   weather. The decks stay out of the sun's shadow pass for the same reason they always did. */
/* Height grids (km, body-local uv) resolved from the paint jobs — the camera colliders read these;
   null until the painting lands, and every reader below degrades to the bare sphere meanwhile. */
let earthField = null, moonField = null, shore = null;
let earthPatch = null;
let moonPatch = null;
let clouds = null;
let _sky = new THREE.Color();
const _moon = new THREE.Vector3();
const _ld = new THREE.Vector3();
const _cs = new THREE.Vector3();
const _uvw = { u: 0, v: 0 };
let _skyMix = 1;

/* builds everything that is not the vehicle: sun with a vehicle-tracking shadow camera, bodies,
   cloud decks, atmosphere shell, starfield and the launch pad welded to the rotating planet. */
export function initWorld(target) {
  scene = target;

  /* ---- sun: one shadow-casting light whose frustum follows the vehicle, pad liftoff to moon landing.
     Cel lighting: one hard sun, one coloured fill. Intensity 1.0 rather than 3.2 because there is no
     tone mapping left to compress it — anything above clips the lit band to featureless white. The
     fill is deliberately blue: the shadow side of a cel-shaded object is a colour, not black. ---- */
  sun = new THREE.DirectionalLight(0xfff6e8, 1.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);   // 1.5 m at the ±6 km pad box; PCF then has texels to work with
  setShadowBox(SHADOW_MAX);
  /* Bias, in NORMALISED depth × the camera's 300 km range: the old −0.0005 was 1.5 km of
     along-light shadow smear, and normalBias 0.12 km slid every mast shadow a full 120 m along
     the ground — together they drew the fat wedges mis-called texel staircase. 10 m each at a
     2048² map over a ±6 km ground box (~6 m/texel) is texel-exact: towers read as thin lines. */
  sun.shadow.bias = -0.00003;
  sun.shadow.normalBias = 0.01;
  sunTarget = new THREE.Object3D();
  sun.target = sunTarget;
  moonPos(0, _moon);
  sun.position.copy(PAD_POS).addScaledVector(SUN_DIR, SUN_RANGE);
  sunTarget.position.copy(PAD_POS);
  sunTarget.updateMatrixWorld();
  scene.add(sun, sunTarget, new THREE.AmbientLight(0x39496b, 1.0));

  const earthMap = earthTex(), cloudMap = cumulusTex(),
        cirrusMap = cirrusTex(), moonMap = moonTex(), glowMap = glowTex();
  const flareMap = flareTex();

  /* ---- earth: the painted map under a three-band ramp. 384×192 segments (74 305 vertices) and
     displaced by the land height field from js/toonmap.js — oceans stay the perfect sphere,
     continents get a limb, and the launch pad sits on ground that is exactly zero for 90 km
     around it, so it can never float or sink. No normal map: docs/reference/cartoon-art-direction
     .md retires per-pixel surface detail — the scale needed to sell 20 km-per-texel slope through
     a three-band ramp (26!) stippled the ground at the grazing angles a pad camera lives at. The
     map's flat colour shapes are the surface; relief survives only as horizon silhouette. The
     small navy emissive is a floor for the night side and the grazing limb, where the shadow
     band alone left the sea black. ---- */
  earth = new THREE.Mesh(new THREE.SphereGeometry(RE, 384, 192),
    toon({
      map: earthMap,
      gradientMap: RAMP_EARTH, emissive: 0x07182c,
    }));
  earth.geometry.setAttribute('aUv', earth.geometry.attributes.uv);   // shared, not copied
  earth.receiveShadow = true;
  /* ---- crisp coastline ink ----
     Round 5: the shelf/ocean/deep banding this shader used to draw is gone — it moved into the
     canvas paint in js/toonmap.js, because at the oblique review slants (cpx ≈ 40-150 km per
     pixel) every derivative-faded band switches itself off and the MAP texture is all the eye
     gets; and the canvas's dilate-mask boundaries staircased at 20 km there. What remains here
     is the one job only a shader can do: an ink stroke ±16 km around the smoothed SDF zero
     line, AA'd by its own derivative width, fading out below one-pixel width so the system view
     sees the plain map and nothing shimmers. A single-wrap sphere sampling a smooth field is
     exactly the case AGENTS.md's mip-wedge rule EXEMPTS — that rule needs uv repeats.
     R16F because the field must bilinear-filter: R8 would quantise km at ~8 per code and draw
     the 16 km stroke as a 16 km staircase; WebGL2 filters half-float natively. Night side
     unaffected: this recolours diffuse before the toon lighting. */
  const coastU = { value: null };
  earth.material.onBeforeCompile = (sh) => {
    if (!coastU.value) return;
    sh.uniforms.coastMap = coastU;
    sh.uniforms.coastInk = { value: new THREE.Color(0x0e2842) };     // C.coast  [14,40,66]
    sh.fragmentShader = 'uniform sampler2D coastMap; uniform vec3 coastInk;\n' +
      sh.fragmentShader.replace('#include <map_fragment>',
        '#include <map_fragment>\n' +
        '  float csd = texture2D( coastMap, vMapUv ).r;\n' +              // km from coast, <0 land
        '  float cpx = max(fwidth( csd ), 0.5);\n' +                      // km per pixel at this fragment
        // Round 5: the shelf/ocean/deep bands moved into the canvas paint (smooth-SDF iso-lines),
        // because at review slants (cpx 40-150 km) every shader band fades itself out to avoid
        // aliasing and the MAP texture is all the eye gets. Only the ink stroke remains here: it
        // stays crisp where the canvas can only be 20 km coarse, and it fades below
        // one-pixel width like before.
        '  float vInk = 1.0 - smoothstep( 14.0, 34.0, cpx );\n' +
        '  float ink = 1.0 - smoothstep( 16.0 - cpx, 16.0 + cpx, abs( csd ) );\n' +
        '  diffuseColor.rgb = mix( diffuseColor.rgb, coastInk, ink * vInk );');
  };
  /* Planet-scale bodies are exempt from the fog: FogExp2 is measured from the camera, so at
     0.002/km a system-view camera 20 000 km out would erase the planet entirely. The haze the
     fog models is the near-field air around the vehicle; the day sky itself comes from
     scene.background and the limb shell below. */
  earth.material.fog = false;
  scene.add(earth);
  applyRelief(earth.geometry, 'earth');
  reliefField('earth').then((f) => { earthField = f; });
  coastField().then((c) => {
    shore = c;
    if (!c || !earth) return;
    /* Encode the signed coast distance (km, Float32, 2048×1024 — the map's own grid) as half
       floats for the coastline band above. f16 by hand: Float32/Uint32 union, exponent rebias
       127→15, mantissa 23→10; flush denormals to zero (|sd| < 6e-5 km is on the line anyway)
       and clamp to f16 max (the field's extremes are ~±10 000 km, well inside 65 504). */
    const n = c.w * c.h;
    const px = new Uint16Array(n);
    const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
    for (let i = 0; i < n; i++) {
      f32[0] = c.km[i];
      const x = u32[0], sign = (x >>> 16) & 0x8000;
      let e = ((x >>> 23) & 0xff) - 127 + 15;
      if (e <= 0) { px[i] = sign; continue; }
      if (e >= 31) { px[i] = sign | 0x7c00; continue; }
      px[i] = sign | (e << 10) | ((x & 0x7fffff) >>> 13);
    }
    const tex = new THREE.DataTexture(px, c.w, c.h, THREE.RedFormat, THREE.HalfFloatType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;    // the band samples the field with derivatives, so it
    tex.minFilter = THREE.LinearFilter;    // must be filterable; no mips — R16F filters natively
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    coastU.value = tex;
    earth.material.needsUpdate = true;     // recompile with the injection live
    /* needsUpdate ALONE never re-injects: three's program cache key includes
       onBeforeCompile.toString(), which the late uniform assignment does not change — the boot
       frame compiled and cached the NO-BAND program (coastU.value was still null, the fn early-
       returns), and every needsUpdate since re-fetched that same cached program. Magenta-probe
       proof: with the flat-sea uniform forced to 0xff00ff, not one magenta pixel rendered at
       160 km over the 100 km-wide Adriatic. The cache key must lie about the difference, so it
       declares which injection is live. */
    earth.material.customProgramCacheKey = () => (coastU.value ? 'coast-on' : 'coast-off');
  });
  /* The near level: ONE mesh, 161×161 vertices, dense (≈70 m) under the vehicle and stretched to a
     220 km rim — the horizon from altitude h is √(2·RE·h), and the rim stays beyond it until the
     patch's remaining difference from the globe mesh is sub-pixel. It rides the spin as a child of
     the mesh, and it is what receives the pad and vehicle shadows now that the pad's fake-island
     discs are gone — with real authored coastline under it, the complex sits on Merritt Island. */
  earthPatch = makePatch(earth);
  attachEarthPatch(earthPatch);
  /* The sky at human scale: a 64 km cloud tile on a cap that re-centres under the vehicle, plus its
     own terrain-draped shade cap. The planet-scale decks below cannot show a cumulus from the pad —
     one of their texels is 39 km and the whole visible sky spans a fraction of one. */
  clouds = makeCloudLayer(earth, groundKmLocal);

  /* ---- two cloud decks, both generated in js/textures.js, both white with the weather in alpha and
     read through `map` — see the note on alphaMap's green channel there.

     They blend; they do NOT alpha-test. That distinction is the reason clouds never appeared:
     the field is mipmapped (a nearest-sampled minified alpha is the grazing wedge the earlier
     attempt drew), and averaging a cloudy field into coarse mips lifts EVERY texel to around the
     global mean (measured 0.26 after the drift-cluster pass, 0.19 before) — above any threshold
     that could be chosen. `discard` is
     therefore mathematically dead at distance: the deck rendered as one uniform sheet from
     every altitude, at 0.45 before the mips existed and at 0.14 after. Blending on the other
     hand gets the whole mip chain for free: puffs where the eye can resolve them, soft veil
     where it cannot, and no threshold anywhere to alias against.

     DoubleSide is not decoration: the camera lives on BOTH sides of a cloud layer — inside it at
     the pad, outside it in orbit. A FrontSide shell seen from its own interior shows only the far
     wall (which the planet occludes from the ground), so a single-sided deck is structurally
     invisible as overhead sky from the surface. Back faces light correctly — the toon chunks flip
     the normal by gl_FrontFacing.
     Scale is the hard limit though: 39 km/texel means the whole pad sky is under one texel, so the
     decks are the PLANET-SCALE layer (orbit) only — near-scale puffs live on the streamed ground
     plate, and no deck change will ever put weather over the pad. ---- */
  /* 512×256, was 256×128: a 256-segment sphere's silhouette chord error is r(1−cos(π/256)) ≈
     0.48 km, and from 68 km altitude that is the wavy limb edge review2 flagged. 512 puts it at
     0.12 km — sub-pixel at every altitude the decks are visible. The cirrus deck and the limb
     shell below get the same value (Earth is already 384×192 = 0.21 km chord, Moon 512×256). */
  cumulus = new THREE.Mesh(new THREE.SphereGeometry(RE + CUMULUS_ALT, 512, 256),
    toon({
      map: cloudMap, transparent: true, side: THREE.DoubleSide,
      opacity: 0.95, depthWrite: false, gradientMap: RAMP_CLOUD
    }));
  /* Neither deck casts into the sun's shadow map. They sit 2 and 9 km up, so a low sun drags
     their silhouettes hundreds of kilometres across the surface, and through the tower-resolution
     box those streaks clip into hard grey slabs that read as architecture rather than weather.
     Weather shade for the ground comes from js/clouds.js at 64 km per tile, where the shadow can
     actually hold a puff's shape; it costs the shadow box nothing. */
  cumulus.castShadow = false;
  cumulus.material.fog = false;   // same reason as the ground: a deck 2 km up is a planet-scale body
  /* Two regimes, crossed by TEXELS-PER-PIXEL (|d uv| × texture width), because no constant alpha
     threshold survives minification and fwidth(ca) is not a valid proxy for it. Where cells
     RESOLVE (tpp < 2) the cel steps stand: a cell above 0.34 is alpha 1 with a derivative-AA'd
     edge, the 0.18 haze is a CONSTANT step (the round-4 fix for the ca*0.14 proportional floor's
     ±3/255 gradient smudges). Where the texture minifies, the GPU's box mips average clear ocean
     and cloud core into one smooth INTERMEDIATE ca (0.3–0.6 over whole belts — measured over the
     real chain: global mean 0.263, invariant across mips; region p50s in the mid teens but the
     grazing horizon mixes thousands of km in all directions) and fwidth(ca) of that smooth field
     is small, so a fwidth gate never fires — the 0.34 step then decides alpha = 1 across whole
     ocean: the uniform grey sheet this frame had at 900 km, and its mirror image (ca < 0.34 →
     bare navy planet) at Moon distance. The uv-derivative gate measures minification directly:
     tpp = max(|∂u/∂px|·2048, |∂v/∂px|·1024) is exactly what the sampler's LOD picks. Above it the
     alpha rides the local mean through a contrast window (0.30→0.62: a clear mip cell ≤0.18
     stays bare, a saturated one goes full white), so zonal structure survives from orbit and
     intermediate blur reads as haze, not as opaque deck. The deck is a single-wrap sphere — the
     multi-repeat mip-wedge failure of AGENTS.md cannot apply to it. */
  cumulus.material.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>',
      '#include <map_fragment>\n' +
      '  float ca = diffuseColor.a;\n' +
      '  float cw = max(fwidth(ca), 0.004);\n' +
      '  float tpp = max(length(vec2(dFdx(vMapUv.x), dFdy(vMapUv.x))) * 2048.0, length(vec2(dFdx(vMapUv.y), dFdy(vMapUv.y))) * 1024.0);\n' +
      '  float cell = mix(mix(0.0, 0.06, smoothstep(0.18 - cw, 0.18 + cw, ca)), 1.0, smoothstep(0.34 - cw, 0.34 + cw, ca));\n' +
      '  float veil = smoothstep(0.30, 0.62, ca);\n' +
      '  diffuseColor.a = mix(cell, veil, smoothstep(2.0, 8.0, tpp));');
  };
  scene.add(cumulus);

  cirrus = new THREE.Mesh(new THREE.SphereGeometry(RE + CIRRUS_ALT, 512, 256),
    toon({
      color: 0xf4f8fc, map: cirrusMap, transparent: true, side: THREE.DoubleSide,
      opacity: 0.5, depthWrite: false, gradientMap: RAMP_CLOUD
    }));
  cirrus.castShadow = false;        // see the cumulus note: 9 km up is enough to wreck the ground
  cirrus.material.fog = false;
  /* Continuous, not stepped — the round-5 correction, measured with a red canary painted into
     the CUMULUS law at this exact view: the grey sheet that blanketed the 900 km oblique frame
     tinted the land brown but left the ocean untouched, so it belonged to this mesh, not that
     one. The streak field's texel alpha (mean 0.13, but region p25 0.22 / p50 0.42 through
     mips 2–4 in the tropical–mid-latitude band) sits around the old 0.25 step almost everywhere
     in that band, and a step there is a wash by construction. smoothstep(0.5, 0.8) answers the
     field's upper tail — the p95 mass (0.76) and nothing else: thin white streak cores against
     clear sky at any scale, with no gate needed because a continuous law degrades gracefully
     where the step did not. The 0.55 keeps cirrus under the cumulus at every distance. */
  cirrus.material.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>',
      '#include <map_fragment>\n' +
      '  diffuseColor.a *= 0.55 * smoothstep(0.5, 0.8, diffuseColor.a);');
  };
  scene.add(cirrus);

  /* ---- atmosphere: back-side limb shell. Intensity comes from the optical depth still in front of
     each fragment — long tangential sight lines glow, the thin overhead shell from the ground does not. ---- */
  atmo = new THREE.Mesh(new THREE.SphereGeometry(RE * ATMO_SHELL, 512, 256), new THREE.ShaderMaterial({
    uniforms: {
      glow: { value: new THREE.Color(0x63b7ff) },
      shellR: { value: RE * ATMO_SHELL },
      sunDir: { value: SUN_DIR.clone() }
    },
    vertexShader: `
      varying vec3 vP; varying vec3 vN;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vP = (modelMatrix * vec4(position, 1.0)).xyz;
        vN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      uniform vec3 glow; uniform float shellR; uniform vec3 sunDir;
      varying vec3 vP; varying vec3 vN;
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec3 n = normalize(vN);
        vec3 eye = normalize(cameraPosition - vP);
        float grazing = 1.0 - abs(dot(n, eye));                 // 0 overhead, 1 at the limb
        // intersect the sight line with the shell and take the segment still ahead of this fragment
        vec3 d = normalize(vP - cameraPosition);
        float a = dot(d, cameraPosition);
        float b = dot(cameraPosition, cameraPosition) - shellR * shellR;
        float disc = max(a * a - b, 0.0);
        float t1 = -a - sqrt(disc), t2 = -a + sqrt(disc);
        float path = max(t2 - max(t1, 0.0), 0.0);                // km of air in front of this point
        float depth = clamp(path / 400.0, 0.0, 1.0);
        /* Dusk, not a knife. A binary day-cut on a 65 km-thin shell put a hard cyan edge on the
           terminator with nothing above it — the band switched off across an angle the eye reads
           as a rendering error. Three degrees of smoothstep is still cel: the night side keeps a
           cold floor rather than going dark, so the limb reads as air on both sides. */
        float day = 0.14 + 0.86 * smoothstep(-0.06, 0.20, dot(n, sunDir));
        float rim = pow(grazing, 3.4) * depth;
        /* Continuous. The earlier six-band quantisation (floor(rim·6)/6 mixed in near grazing)
           is what read as four broad horizontal steps in the 20 km sky — the pad view crosses
           the whole grazing range in one frame, so posterising it posterises the sky. */
        gl_FragColor = vec4(glow, clamp(rim, 0.0, 1.0) * day * 0.55);
      }`,
    side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
  }));
  scene.add(atmo);

  /* ---- the sky: a dome that rides with the vehicle and paints the atmosphere as ONE thing —
     a smooth vertical gradient from deep blue at the zenith to pale at the horizon, a soft
     glow around the sun's bearing, and its own alpha fading to nothing as the air thins
     (background beneath it is black space, so the fade to orbit IS the dome giving out).
     It renders first with no depth write so every body and the flare composite over it, and
     it is the same dome at 0.2 km and 200 km — coherence is the whole immersion ask (docs/
     reference/cartoon-art-direction.md). ShaderMaterial: logdepthbuf chunks are mandatory. ---- */
  sky = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 32, 16), new THREE.ShaderMaterial({
    uniforms: {
      zenith: { value: new THREE.Color(0x1e5cab) },
      band: { value: new THREE.Color(0x9fc4de) },
      glowC: { value: new THREE.Color(0xfff0cf) },
      sunDir: { value: SUN_DIR.clone() },
      atmoMix: { value: 1 },
    },
    vertexShader: `
      varying vec3 vP;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vP = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      uniform vec3 zenith; uniform vec3 band; uniform vec3 glowC;
      uniform vec3 sunDir; uniform float atmoMix;
      varying vec3 vP;
      #include <logdepthbuf_pars_fragment>
      void main() {
        /* logdepthbuf_fragment is a STATEMENT — it belongs inside main. It sat outside for
           rounds of rounds: the sky dome silently failed to compile ("Shader Error 0 ...
           'gl_FragDepth' syntax error" in the page console, unnoticed because a missing dome
           looks like space), which is why daytime views had no sky wash. */
        #include <logdepthbuf_fragment>
        vec3 dir = normalize(vP - cameraPosition);
        float up = dot(dir, normalize(cameraPosition));      // elevation above the local horizon
        float t = pow(clamp(up, 0.0, 1.0), 0.45);            // pale band hugs the horizon
        vec3 col = mix(band, zenith, t);
        float sd = max(dot(dir, sunDir), 0.0);
        // three-lobe glow: a halo near the disc, a wide warm wash that stays readable at the pad
        col += glowC * (pow(sd, 40.0) * 0.75 + pow(sd, 12.0) * 0.28 + pow(sd, 3.0) * 0.07);
        // 1-LSB dither: the 8-bit buffer bands exactly where this gradient is slowest, the sky
        float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        gl_FragColor = vec4(col + (d - 0.5) / 255.0, atmoMix);
      }`,
    side: THREE.BackSide, transparent: true, depthWrite: false,
  }));
  sky.renderOrder = -2;
  sky.frustumCulled = false;        // it is centred on the camera; the culler's sphere is meaningless
  scene.add(sky);

  /* No colour multiplier: the painted map already carries the four regolith tones, and a multiplier
     here scales them all away. The grey that used to sit on this material was compensation for a
     photographic map, and with the authored palette it just dimmed the highlands.

     512×256 segments (131 841 vertices, ~10 km apart) and NO near level: everything the lunar
     surface must say, this mesh says. That is why js/toonmap.js sizes the lunar field for it —
     45 km crater floor, real elevation step between the flat maria and the highlands — so a
     descent reads as terrain in silhouette alone. Displacement stays capped at ±2 km because
     physics touches down on the exact RM sphere. No normal map (cartoon-art-direction): the
     terrain must survive as shape against the sky, not as surface shading. */
  moon = new THREE.Mesh(new THREE.SphereGeometry(RM, 512, 256),
    toon({
      map: moonMap,
      gradientMap: RAMP_MOON,
    }));
  moon.material.fog = false;      // ground haze must not eat the moon or the stars
  moon.position.copy(_moon);
  /* Round 6: the Moon no longer CASTS shadow. With castShadow on, the relief-displaced sphere and
     the +4 m patch are both caster and receiver inside the ±48 km vehicle box, and at the 23 m
     shadow texel (4096² over ±48 km) plus a 28° sun, every lit surface inside the box compared as
     self-shadowed: measured 2026-11-09 at site (−0.536,−0.841,−0.065) t=2980800 — the whole
     near field rendered dark navy (the RAMP_MOON 0.16–0.26 band over grey regolith) inside the
     box edge while the far sphere beyond it lit to 0.86, a hard diagonal boundary across the
     frame at pitch −32. Clearing castShadow on the moon (A/B: only toggle that survived the fix)
     restores the lit read. Vehicle→moon and Earth→moon (eclipse) shadows are unaffected: their
     casters are the vehicle and the Earth, not the moon. Relief self-shading lives in the vertex
     normals and the ramp, which is what the cartography is anyway. */
  moon.castShadow = false; moon.receiveShadow = true;
  scene.add(moon);
  applyRelief(moon.geometry, 'moon');
  reliefField('moon').then((f) => { moonField = f; });
  /* and its near level — the final kilometres want craters, not the 10.6 km/texel canvas (see
     js/terrain.js). It rides the Moon mesh as a child, so it turns with the same spin. */
  moonPatch = makeMoonPatch(moon);
  attachMoonPatch(moonPatch);

  /* ---- starfield, well outside the moon's orbit ----
     A real sky is a magnitude pyramid: many faint, few bright, and the bright ones are BIGGER.
     One PointsMaterial cannot say that (one size for all 6 000), which is why every star used to
     land as the same 2 px dot — "TV static". Three layers, one per size class, share the fade
     clock in updateSky; only their radii differ. */
  {
    /* The point sprite is a painted 32×32 radial falloff, not the default square. Review 5 flagged
       "a few star sprites render as hard squares" — the 2 px and 3 px layers at 600 km, where a
       6 px square with hard edges reads as a glitch and not a star. The falloff (α 1 → 0 at r 15,
       linear-ish with a soft knee) keeps the core near-solid so faint stars do not lose half their
       flux; the corners, which are what looked square, are gone. Created at final size once — the
       placeholder-swap trap in AGENTS.md does not apply, and SRGBColorSpace matches every other
       painted texture here. */
    const sc = document.createElement('canvas'); sc.width = sc.height = 32;
    {
      const g = sc.getContext('2d');
      const rg = g.createRadialGradient(16, 16, 0, 16, 16, 15.5);
      rg.addColorStop(0, 'rgba(255,255,255,1)');
      rg.addColorStop(0.55, 'rgba(255,255,255,0.92)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.fillRect(0, 0, 32, 32);
    }
    const starTex = new THREE.CanvasTexture(sc);
    starTex.colorSpace = THREE.SRGBColorSpace;
    const layers = [[4200, 1, 0.35, 0.38], [1500, 2, 0.55, 0.55], [140, 3, 0.85, 0.15]];
    stars = [];
    for (const [n, px, bmin, bspread] of layers) {
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const v = new THREE.Vector3().randomDirection().multiplyScalar(STAR_R);
        pos.set([v.x, v.y, v.z], i * 3);
        const b = bmin + Math.random() * bspread;
        const warm = Math.random() < 0.18;
        col.set(warm ? [b, b * 0.8, b * 0.6] : [b * 0.9, b * 0.95, b], i * 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      /* The stars are faded by js/world.js:updateSky against the measured lightness of the sky, not by
         the exponential fog. Fog was the original mechanism and it did not hold: at the pad the factor
         over 2 000 000 km is unity, and they still speckled the daylight sky, brightest along the lit
         limb band. `transparent` is set at construction so the opacity has something to blend with. */
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({
        size: px, map: starTex, vertexColors: true, sizeAttenuation: false,
        transparent: true, opacity: 0, fog: false
      }));
      scene.add(pts);
      stars.push(pts);
    }

    /* The sun is a DRAWN disc, not a lantern. The soft glowTex profile made every flare frame a
       blurry white balloon with no edge; a crisp plate with a narrow corona is the cartoon sun,
       and the same sprite still scales with SUN_ANG so it stays 0.53° of sky from any distance. */
    flare = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flareMap, color: 0xfff3d8, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false
    }));
    flare.position.copy(PAD_POS).addScaledVector(SUN_DIR, SUN_DIST);
    flare.scale.setScalar(SUN_DIST * SUN_ANG * 2.4);
    scene.add(flare);
  }

  /* ---- launch pad: a child of the Earth mesh, so it rides the spin and stays over the same ground.
     Local frame: +Z = PAD_UP (radial), +X = PAD_EAST, +Y = north. Build units; the crawler deck
     keeps the platform top at z = 4, the anchor physics expects, and the group scales by PAD_SCALE. ---- */
  pad = buildPad(glowMap);
  pad.position.copy(PAD_UP).multiplyScalar(RE);
  const north = new THREE.Vector3().crossVectors(PAD_UP, PAD_EAST).normalize();
  pad.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(PAD_EAST, north, PAD_UP));
  earth.add(pad);

  scene.fog = new THREE.FogExp2(SKY_DAY.getHex(), 0.002);
  updateSky(PAD_POS);
  return scene;
}

function setShadowBox(extent) {
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -extent;
  sc.right = sc.top = extent;
  /* ±150 km around the vehicle's depth plane, not 1→5000 km: the depth range IS the bias
     resolution (0.0001 of this range is 30 m), and nothing casts a shadow 400 km in front of
     or behind the tracked vehicle. */
  sc.near = SUN_RANGE - 150; sc.far = SUN_RANGE + 150;
  sc.updateProjectionMatrix();
}

/* the shadow box tracks the vehicle: tight enough that pad structures resolve at 4096² (~3 m/texel
   grounded), growing only as fast as the far detail actually needs it, and never past ±48 km —
   cloud weather does NOT come through this box (js/clouds.js supplies it), so it no longer has to be huge
   to hold cloud silhouettes, and hardware shadows no longer have to be coarse to fit weather in. */
function updateShadowBox(pos) {
  moonPos(simT, _moon);
  const local = Math.min(pos.length() - RE, pos.distanceTo(_moon) - RM);
  /* Above the relief patch's show altitude the only shadow receivers left are the bare body
     meshes, and the vehicle-tracking box (±48 km lateral, ±150 km in depth) stops covering the
     ground under them: fragments outside the map then sample the clamped edge and three paints
     them shadowed — measured as straight-edged wedges across the ocean from 150 km up. Nothing
     above this height casts a shadow worth catching either, so the pass comes off. */
  sun.castShadow = local < 30;
  setShadowBox(THREE.MathUtils.clamp(SHADOW_MIN + local * 0.12, SHADOW_MIN, SHADOW_MAX));
}

/* 84 meshes + 4 lamp sprites, all in build units around the crawler deck */
function buildPad(glowMap) {
  const g = new THREE.Group();
  g.scale.setScalar(PAD_SCALE);
  /* Pad materials, cel. `steel` was metalness 0.7, which is why the towers and tanks came out black:
     nothing to reflect. They are light grey now, and the outline is what separates them from the sky
     at dawn. */
  const concrete = toon({ color: PALETTE.padConcrete });
  /* The crawler deck used to sit on three big discs — a graded slab, a foam collar, a shallow bank —
     because the blue-marble map put LC-39 in open ocean: the real coast of Merritt Island is finer
     than one 20 km texel and the complex read as a plate dropped on the sea. That coast is now
     authored properly (js/toonmap.js, padShore*), the near terrain patch paints grass, marsh, beach
     and lagoon under the pad at 32 m per vertex, and the patch is the shadow receiver — so the discs
     are gone and the pad stands on ground that is actually land. */
  const steel = toon({ color: PALETTE.padSteel });
  const blast = toon({ color: PALETTE.blast });   // scorched blast surfaces
  const box = (w, d, h, mat, x, y, z, cast = false, recv = false, edge = false) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), mat);
    m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = recv; g.add(m);
    if (edge) outline(m);
    return m;
  };

  // crawler platform with track skirts; deck top z = 3
  // The skirts join the deck in carrying the dark outline: review2 — "none of the pad models
  // carry the dark outlines the art direction promises"; the big readable shapes get edge=true.
  box(64, 46, 3, concrete, 0, 0, 1.5, false, true, true);
  box(64, 9, 3.6, concrete, 0, -23, 1.2, false, true, true);
  box(64, 9, 3.6, concrete, 0, 23, 1.2, false, true, true);
  // reinforced launch deck: four slabs ring the flame-trench opening; tops z = 4 (physics anchor)
  box(44, 12, 1, concrete, 0, -14, 3.5, false, true);
  box(44, 12, 1, concrete, 0, 14, 3.5, false, true);
  box(12, 16, 1, concrete, -16, 0, 3.5, false, true);
  box(12, 16, 1, concrete, 16, 0, 3.5, false, true);
  // flame trench below the opening + four canted exhaust deflectors (outlined: against the dark
  // trench the un-outlined slabs read as one black hole; the edge is what separates four plates)
  box(21, 17, 4.4, blast, 0, 0, 0.8, false, true);
  const d1 = box(18, 7, 1.2, blast, 0, -3.5, 2.4, true, true, true); d1.rotation.x = 0.75;
  const d2 = box(18, 7, 1.2, blast, 0, 3.5, 2.4, true, true, true); d2.rotation.x = -0.75;
  const d3 = box(15, 7, 1.2, blast, -7, 0, 2.4, true, true, true); d3.rotation.y = 0.75;
  const d4 = box(15, 7, 1.2, blast, 7, 0, 2.4, true, true, true); d4.rotation.y = -0.75;
  // strongback tower (legs to z 56) with a swing arm reaching for the rocket at mid-vehicle height
  box(1.8, 1.8, 52, steel, -16, -10, 30, true, false, true);
  box(1.8, 1.8, 52, steel, -16, -2, 30, true, false, true);
  for (const bz of [14, 27, 40]) box(1.8, 8, 1.2, steel, -16, -6, bz, true);
  /* X-bracing in every strongback bay. Two legs and four rungs read as a wardrobe at pad distance;
     the real strongback is a truss, and diagonal members are what the eye recognises as one. */
  for (const [z0, z1] of [[6, 14], [14, 27], [27, 40], [40, 52]]) {
    const bl = Math.hypot(8, z1 - z0), bc = (z0 + z1) / 2, ba = Math.atan2(8, z1 - z0);
    const b1 = box(0.7, 0.7, bl, steel, -16, -6, bc, true); b1.rotation.x = ba;
    const b2 = box(0.7, 0.7, bl, steel, -16, -6, bc, true); b2.rotation.x = -ba;
  }
  const swing = box(12, 1.6, 1.6, steel, -9, -2, 34, true, false, true); swing.rotation.z = 0.05;
  // service tower: legs to z 60, a clad core between them, and a crew access arm at capsule height
  box(1.8, 1.8, 56, steel, 16, -10, 32, true, false, true);
  box(1.8, 1.8, 56, steel, 16, -2, 32, true, false, true);
  box(4.6, 6.6, 50, steel, 16, -6, 29, true, false, true);   // cladding: the tower is a building, not two poles
  box(2.2, 3.2, 6, blast, 16, -6, 57, true);                  // dark cab/crown cap under the arm pivot
  for (const bz of [18, 44]) box(1.8, 8, 1.2, steel, 16, -6, bz, true);
  /* Diagonal bracing: at y=-9.3 the brace CENTRE sat outboard of the leg line — the member spans
     Δy=8 about its centre, so it ran −13.3..−5.3 while the legs are at −10 and −2, both ends
     floating off the tower (review2: "a diagonal strut that appears to float off the structure").
     y=-6 centres it between the legs exactly like the strongback's: occluded by the clad core
     where the cladding exists, real truss against the sky in the bays above it. */
  for (const [z0, z1] of [[7, 18], [18, 44], [44, 55]]) {
    const bl = Math.hypot(8, z1 - z0), bc = (z0 + z1) / 2, ba = Math.atan2(8, z1 - z0);
    const b1 = box(0.6, 0.6, bl, steel, 16, -6, bc, true); b1.rotation.x = ba;
  }
  const crewArm = box(11, 1.5, 1.5, steel, 10, -2, 56, true, false, true); crewArm.rotation.z = -0.04;
  // two thin lightning masts; tips clear the 74-unit vehicle
  for (const mx of [-30, 30]) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, 88, 8), steel);
    mast.position.set(mx, -26, 48); mast.rotation.x = Math.PI / 2; mast.castShadow = true; g.add(mast);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), steel);
    tip.position.set(mx, -26, 92.4); tip.castShadow = true; g.add(tip);
  }
  // clustered LOX/LH2 tanks on a pad with a manifold header and a feed line toward the deck
  box(34, 28, 2, concrete, 50, 36, 3, false, true, true);
  /* White with a floor of emissive: on the shared toon ramp these spheres sat on the camera side
     of their own terminator through the whole launch window (the sun is east, the chase camera
     looks from the south), so the cluster read as four black donuts ringed by their own outline.
     The real tanks are the brightest objects on the complex — a fixed lift is honest here. */
  const tankMat = toon({ color: 0xe9eef4 });
  tankMat.emissive = new THREE.Color(0x33383f);
  for (const [tx, ty] of [[40, 28], [58, 30], [42, 44], [60, 46]]) {
    const tank = new THREE.Mesh(new THREE.SphereGeometry(6, 24, 16), tankMat);
    tank.position.set(tx, ty, 10); tank.castShadow = true; tank.receiveShadow = true; g.add(tank);
    outline(tank);
  }
  const manifold = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 26, 10), steel);
  manifold.position.set(50, 36, 7); manifold.rotation.x = Math.PI / 2; manifold.castShadow = true; g.add(manifold);
  box(22, 1.2, 1.2, steel, 25, 36, 6.4, true);
  /* floodlight rig: mast + cross-truss carrying four lamps on real fixtures. 1.4-unit sections
     were hairline sticks at pad distance (review2); 2.4/2.0 reads as a rig the lamps hang from. */
  box(2.4, 2.4, 22, steel, 0, -34, 15, true);
  box(30, 2.0, 2.0, steel, 0, -34, 26, true);
  for (let i = 0; i < 4; i++) {
    /* The lamp used to be the sprite alone: a 7-unit bokeh disc hanging in the air with nothing
       behind it, which read as floating domes — at night and against the sky especially. Now the
       sprite is the LENS of a fixture: a housing box on a stem under the truss, the glow sitting
       proud of the lens face. depthTest stays on (the hull occludes it — see prior note), and the
       disc is smaller than the housing pattern it emits from. */
    const lx = -13.5 + i * 9;
    box(0.5, 0.5, 2.6, steel, lx, -34, 24.6, true);            // stem from the truss
    box(2.6, 1.4, 1.6, steel, lx, -34, 22.8, true, false, true); // housing
    const l = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xfff2c9, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    l.position.set(lx, -33.4, 22.8); l.scale.setScalar(3.4); g.add(l);
    padLamps.push(l);
  }
  /* Crawler track shoes + operator cab. The deck used to be one unbroken concrete slab, and a
     40 × 35 m crawler with no track reads as a building foundation. The shoe row rides the
     OUTBOARD face of the +y skirt (the −y face carries the banner): a row tried inside the
     skirt volume was simply geometry the deck swallowed. */
  for (let i = 0; i < 12; i++) {
    const sx = -29 + i * 5.3;
    box(2.4, 0.8, 3.0, blast, sx, 27.85, 1.3);
  }
  box(8, 6.5, 4.5, steel, 26, -19, 5.6, true, false, true);   // cab
  box(8, 0.6, 2.2, blast, 26, -22.6, 6.4, false);             // cab rear window band
  // banner stripe painted along the outboard crawler skirt
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(64, 2.8), blast);
  banner.position.set(0, -27.6, 1.5); banner.rotation.x = Math.PI / 2; g.add(banner);
  return g;
}

/* main.js calls this every frame: the shadow frustum travels with the vehicle, so the same sun
   shades the pad at liftoff and the lander on the moon. The near terrain patch travels with it
   too — one distance test per frame, a rebuild only after 12 km of ground travel, no allocation. */
export function updateSunShadow(pos) {
  sun.position.copy(pos).addScaledVector(SUN_DIR, SUN_RANGE);
  sun.target.position.copy(pos);
  sun.target.updateMatrixWorld();
  flare.position.copy(pos).addScaledVector(SUN_DIR, SUN_DIST);   // flare stays on the sun's bearing
  updateShadowBox(pos);
  /* Pad lamps burn at night only. PAD_UP is body-local; its world direction is rotY(current spin)
     of it — the exact inverse of spinLocal — and dotting that with the inertial SUN_DIR is the
     sine of the sun's elevation over the pad. The lamps light across twilight (el +0.05 → −0.10)
     and hold through the night side; daytime additive lens sprites over the ground were the warm
     haze the review frames caught. */
  if (padLamps.length && earth) {
    const a = earth.rotation.y, cb = Math.cos(a), sb = Math.sin(a);
    const el = PAD_UP.y * SUN_DIR.y + (cb * PAD_UP.x + sb * PAD_UP.z) * SUN_DIR.x
             + (-sb * PAD_UP.x + cb * PAD_UP.z) * SUN_DIR.z;
    const on = THREE.MathUtils.clamp((0.05 - el) / 0.15, 0, 1);
    for (const l of padLamps) { l.visible = on > 0.02; l.material.opacity = 0.5 * on; }
  }
  updateReliefPatches(pos);
}

/* Two patches, switched by altitude (below): each is fed the ground point in its mesh-local frame
   (undo the spin — patches are children of the meshes, the vehicle position is inertial), and each
   hides itself above its own 30 km gate, so exactly one is ever drawn. */
function updateReliefPatches(pos) {
  _ld.copy(pos).normalize();
  spinLocal(earth, _ld);
  updatePatch(earthPatch, _ld.x, _ld.y, _ld.z, pos.length() - RE);
  /* The Moon's own near level: the update's altitude gate does the handoff, so exactly one of
     the two patches is ever visible — near the Moon altE is ~384 000 km and the Earth patch
     hides itself; below 30 km of lunar ground the mesh-local direction feeds the crater field. */
  const dM = pos.distanceTo(moon.position);
  if (dM < RM + 30) {
    _ld.copy(pos).sub(moon.position).normalize();
    spinLocal(moon, _ld);
    updateMoonPatch(moonPatch, _ld.x, _ld.y, _ld.z, dM - RM);
  } else hidePatch(moonPatch);
  if (clouds) {
    _cs.copy(SUN_DIR);
    spinLocal(earth, _cs);
    updateCloudLayer(clouds, _ld.x, _ld.y, _ld.z, _cs, pos.length() - RE);
  }
}

/* body-local → world, the inverse of spinLocal: the cloud shade asks the terrain how high the ground
   is under a shadow point, and the terrain fields are keyed in world space. */
const _cw = new THREE.Vector3();
function groundKmLocal(dir) {
  const a = earth ? earth.rotation.y : 0, c = Math.cos(a), s = Math.sin(a);
  _cw.set(dir.x * c + dir.z * s, dir.y, -dir.x * s + dir.z * c);
  return fineGroundHeight(_cw);
}

/* rotY(−rotation.y) in place: world direction → body-local, the same inverse every uv lookup here
   uses, so the fields, the mesh and the colliders can never drift apart. */
function spinLocal(body, v) {
  const a = body ? body.rotation.y : 0, c = Math.cos(a), s = Math.sin(a);
  const x = v.x, z = v.z;
  v.x = c * x - s * z;
  v.z = s * x + c * z;
}

/* ── terrain lookups ──

   km of ground along a world-space direction from a body's centre. The groundHeight pair is the
   FAR level and is what js/camera.js should collide against: it matches the mesh the player sees
   displaced. The fine pair adds the near octaves and the smooth authored coastline — use them when
   the vehicle is on or near the ground and want the collider to agree with the patch. All four:
   allocation-free, cheap, and 0 for a zero-length or non-finite direction (and 0 until the paint
   jobs land, which just means "sphere" — the same thing the renderer shows at that moment). */
function uvAlong(body, dir) {
  if (!body || !dir) return false;
  const dx = dir.x, dy = dir.y, dz = dir.z;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return false;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 1e-9)) return false;
  const inv = 1 / len;
  _ld.set(dx * inv, dy * inv, dz * inv);
  spinLocal(body, _ld);
  let u = Math.atan2(_ld.z, -_ld.x) / (2 * Math.PI);
  if (u < 0) u += 1;
  _uvw.u = u;
  _uvw.v = 0.5 + Math.asin(_ld.y < -1 ? -1 : _ld.y > 1 ? 1 : _ld.y) / Math.PI;
  return true;
}

export function groundHeight(dir) {
  if (!earthField || !uvAlong(earth, dir)) return 0;
  return sampleGrid(earthField, _uvw.u, _uvw.v);
}

export function moonGroundHeight(dir) {
  if (!moonField || !uvAlong(moon, dir)) return 0;
  return sampleGrid(moonField, _uvw.u, _uvw.v);
}

export function fineGroundHeight(dir) {
  if (!uvAlong(earth, dir)) return 0;
  const u = _uvw.u, v = _uvw.v;
  const rel = earthField ? sampleGrid(earthField, u, v) : 0;   // pad flattening is already baked in
  const f = shore ? 1 - smooth01((0.06 + shoreDistance(shore, u, v)) / 0.12) : (rel > 0 ? 1 : 0);
  return rel + fineEarth(u, v) * f * padWeight(u, v);
}

const smooth01 = (t) => { const x = THREE.MathUtils.clamp(1 - t, 0, 1); return x * x * (3 - 2 * x); };
// f = 1 − smoothstep(−e, +e, sd): rewritten as smooth01 above so no extra temp is needed.
// The Moon has no fine getter: it has no near level, so moonGroundHeight IS its terrain.

/* The painted canvases, for the orbital map screen (js/hud.js): the same authored pixels the
   planets wear, so the map can blit real coastline instead of a flat blue disc, and never kicks
   off a second paint. null while painting is still in flight. */
export function planetCanvas(which) { return paintedCanvas(which); }

/* The spin the map has to account for: which is just the angle the meshes are actually at — the
   map converts its own longitude through this, and the equirect u = (lon+180)/360 mapping the
   canvas and the sphere share stays the map's business. */
export function bodySpin(which) { return which === 'moon' ? (moon ? moon.rotation.y : 0) : (earth ? earth.rotation.y : 0); }

/* The bodies are placed from world.js's own clock, which `spinBodies` advances by the same simDt the
   integrator gets. Anything that jumps the mission clock instead of flying through the intervening
   time — the debug `teleport(pos, vel, t)`, `ff()`, a reset — would otherwise leave the Moon hanging
   where the old time put it: the physics would pull toward one place while the picture showed
   another, which is exactly what a screenshot or a test would then read wrong. So the angles are
   recomputed from the absolute time rather than nudged, and a state is fully determined by
   (pos, vel, t). */
export function syncTime(t) {
  /* Non-finite time must not reach the rotations: `spin = EARTH_SPIN * NaN` and
     moon.rotation.y = NaN latch PERMANENTLY (spinBodies then only accumulates NaN), and every
     consumer that multiplies through the angle — js/navball.js's drawOrbit blit chief among
     them — starts throwing inside main.js's swallowed frame catch. Observed as the round-3
     'empty black orbit sub-map' that no finite-state math could reproduce. A bad t re-bases
     to 0 (the angle recomputation's own origin); valid t is untouched — frames for finite
     time are bit-identical to before. js/navball.js also keeps its own NaN-immunity layer. */
  const ts = Number.isFinite(t) ? t : 0;
  simT = ts;
  spin = EARTH_SPIN * ts;
  cloudSpin = EARTH_SPIN * 1.08 * ts;
  cirrusSpin = EARTH_SPIN * 1.22 * ts;
  earth.rotation.y = spin;
  cumulus.rotation.y = cloudSpin;
  cirrus.rotation.y = cirrusSpin;
  moon.rotation.y = MOON_RATE * ts;
  moonPos(simT, moon.position);
}

/* the planet and its weather turn; the cloud decks drift a little faster than the ground (real
   superrotation), at rates of the same order as EARTH_SPIN, never orders of magnitude faster */
export function spinBodies(simDt) {
  /* A non-finite step is SKIPPED, not accumulated (see syncTime): += 0 keeps every angle at its
     last good value, so one poisoned frame cannot destroy the spin clock forever. Finite simDt
     runs the identical arithmetic, in the same order, as before. */
  const dt = Number.isFinite(simDt) ? simDt : 0;
  simT += dt;
  spin += EARTH_SPIN * dt;
  cloudSpin += EARTH_SPIN * 1.08 * dt;
  cirrusSpin += EARTH_SPIN * 1.22 * dt;
  earth.rotation.y = spin;
  cumulus.rotation.y = cloudSpin;
  cirrus.rotation.y = cirrusSpin;
  moon.rotation.y += MOON_RATE * dt;
  moonPos(simT, moon.position);
}

const HORIZON = new THREE.Color(0xb2cfe2);

/* blue sky -> black space: the mix halves every ~55 km of climb, so the sky is effectively black
   by 200 km. The dome (built in initWorld) follows the vehicle and fades on this clock; the
   background under it is black space. The exponential fog thins on the same clock and takes the
   dome's horizon tone, so near-field haze always matches the sky behind it. */
const SKY_SCALE = 80;            // km — visual atmospheric depth for the sky/fog blend
export function updateSky(pos) {
  const alt = Math.max(0, pos.length() - RE);
  _skyMix = Math.exp(-alt / SKY_SCALE);
  /* One part in eight of pale blue MIXED IN LINEAR SPACE already renders as 30 %-grey sRGB —
     that is what turned orbit into a grey poster: at 163 km the old linear mix left the whole
     sky measured-flat (69,82,90). The dome's alpha and the background therefore fall on the
     SQUARE of the physical mix: the pad keeps its full sky, the mesosphere goes dark fast, and
     above ~150 km there is nothing between the eye and the stars. The fog keeps the un-squared
     clock — near-field haze is optical depth, not mood. */
  const vis = _skyMix * _skyMix;
  /* ...and the dome + background fall on the QUARTIC. Apollo 8's "the sky is black even at
     30 000 feet" is the calibration: zenith optical depth is exp(−alt/8 km), so the sky OVERHEAD
     dies far faster than the horizon glow (which the shell draws independently, from grazing
     rays). On the quadratic alone the 68 km sky measured (77,91,100) — a flat slate poster with
     the stars suppressed; on the quartic it goes deep indigo by 40 km and black by 100. */
  const skyVis = vis * vis;
  if (sky) {
    sky.position.copy(pos);
    sky.material.uniforms.atmoMix.value = skyVis;
  }
  _sky.copy(SKY_NULL).lerp(HORIZON, skyVis * 0.9);
  scene.background.copy(_sky);
  scene.fog.color.copy(_sky);
  scene.fog.density = 0.0038 * _skyMix * _skyMix;
  /* Stars come up against what the EYE measures, not the linear buffer: sRGB lightness. With
     the squared background this crosses fully visible around 300 km and is exactly zero for
     the whole pad day. */
  const per = Math.pow(0.2126 * _sky.r + 0.7152 * _sky.g + 0.0722 * _sky.b, 1 / 2.2);
  const dark = THREE.MathUtils.clamp((0.16 - per) / 0.10, 0, 1);
  for (const s of stars) { s.material.opacity = dark; s.visible = dark > 0.01; }
}

export function getSkyMix() { return _skyMix; }

