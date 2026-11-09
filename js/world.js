import * as THREE from 'three';
import {
  RE, RM, MOON_RATE, EARTH_SPIN, PAD_UP, PAD_EAST, PAD_SCALE, PAD_POS, SKY_DAY, SKY_NULL, moonPos
} from './constants.js';
import { moonTex, earthTex, glowTex, flareTex } from './textures.js';
import { toon, RAMP_EARTH, RAMP_MOON } from './toon.js';
import {
  applyRelief, sampleGrid, reliefField, coastField, shoreDistance, fineEarth,
  padWeight, paintedCanvas,
} from './toonmap.js';
import { makePatch, attachEarthPatch, updatePatch, makeMoonPatch, attachMoonPatch, updateMoonPatch, hidePatch } from './terrain.js';
import { makeWeather, makeCloudShell, updateWeather, cloudShadeInject } from './clouds.js';
import { makeHaze, hazeInject, updateHaze } from './haze.js';
import { buildPad } from './pad.js';

/* distances are km, angles rad — everything here lives at real planetary scale */
const SUN_RANGE = 1500;            // km the directional light sits off the tracked vehicle
const SUN_DIST = 1000000;          // km — the flare sprite rides a million km out on the sun's bearing
const SUN_ANG = 0.009;             // rad: the real sun is 0.53° wide, so the flare disk is 0.9% of its range
const STAR_R = 2000000;            // km — the starfield sits well outside the moon's orbit
const SKY_R = 20000;               // km — the sky dome rides the camera; small vs the moon at 384 400
const SHADOW_MAX = 48;             // km half-extent of the vehicle-tracking shadow box
const SHADOW_MIN = 3;              // km — 4096² over ±3 km is 1.46 m/texel: the pad zoom the user screenshotted showed ~10 m blob steps at the old ±6 km
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

let scene = null, earth = null, pad = null, weather = null, cloudMesh = null, hazeU = null, atmo = null, moon = null;
let sun = null, sunTarget = null, flare = null, stars = null, sky = null;
let spin = 0, simT = 0;
/* The floodlight LENS sprites, kept for the night gate in updateSunShadow. They were ungated —
   created in buildPad and never touched again — so four additive warm discs baked daytime haze
   into the pad lenses at all hours. The lamps themselves (housing, truss) stay year-round. */
const padLamps = [];

/* Ground cloud shade is marched, not projected: js/clouds.js injects an optical-depth integral
   along the sun ray through the 4-11 km band into the globe and the near patch, so the darkening on
   the ground is the same column of weather the sky shows. What used to live here was a 512x256
   composite of the deck alphas — 78 km per texel, which could only ever produce slab-sided wedges
   across the pad. The old near-scale shade cap (32 km, re-centred under the vehicle) is gone with
   the caps it belonged to: it was a square, and squares are what the zoom-out view showed. */
/* Height grids (km, body-local uv) resolved from the paint jobs — the camera colliders read these;
   null until the painting lands, and every reader below degrades to the bare sphere meanwhile. */
let earthField = null, moonField = null, shore = null;
let earthPatch = null;
let moonPatch = null;
let _sky = new THREE.Color();
const _moon = new THREE.Vector3();
const _ld = new THREE.Vector3();
const _uvw = { u: 0, v: 0 };
let _skyMix = 1;

/* builds everything that is not the vehicle: sun with a vehicle-tracking shadow camera, bodies,
   cloud decks, atmosphere shell, starfield and the launch pad welded to the rotating planet. */
export function initWorld(target) {
  scene = target;
  /* One shared aerial-perspective state for both ground surfaces; js/haze.js explains why they
     cannot be left on different laws. Bound before either material compiles. */
  hazeU = makeHaze();

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

  const earthMap = earthTex(), moonMap = moonTex(), glowMap = glowTex();
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
    /* ONE injection per material: three keys its program cache on onBeforeCompile.toString(), so
       the weather shade and the coastline ink have to be composed in the same function. Both
       uniforms are bound here, at compile time — no deferred assignment, so no customProgramCacheKey
       is needed for the shade (see the magenta-probe note in AGENTS.md). */
    cloudShadeInject(sh, weather);
    hazeInject(sh, hazeU);      // the globe carries the SAME aerial perspective as the patch
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
  /* The patch is what the eye actually resolves at the pad, so it gets the same marched shade as
     the globe it sits on; without it the ground under a cloud would be lit while the planet around
     it is not. */
  earthPatch.mesh.material.onBeforeCompile = (sh) => {
    cloudShadeInject(sh, weather);
    hazeInject(sh, hazeU);
  };

  /* ---- the weather shell: 4 km to 11 km, one mesh, the whole planet.

     It replaces three things at once — the 2 km cumulus deck, the 9 km cirrus deck, and the two
     tangent-plane caps (220 km and 32 km) that re-centred under the vehicle. The caps were the bug
     the user could see from 100 km up: a 45x45 grid in a plane has a square silhouette, and both
     of them sat inside it. A sphere has no silhouette to leak; every pixel of this one is
     translucent, so density comes from the length of the sight line through the band rather than
     from an alpha threshold that minification can only average.

     Why the march instead of a stacked alpha: opacity = 1 − exp(−τ) over the analytic chord gives a
     base and a top for free (grazing rays accrue 7 km of cloud, overhead rays only what is actually
     there), which is why the horizon reads as a dense deck and the zenith as sky. It also means
     nothing here depends on texel size: the old decks' ceiling was 39 km per texel, and no change
     to them could ever put a cumulus over the pad. The cell lattice tiles at 160 km per repeat
     (0.3125 km per texel), so the same mesh carries zonal systems and individual towers.

     DoubleSide is not decoration: the camera lives on BOTH sides of this layer — inside it at the
     pad, outside it in orbit. A FrontSide shell seen from its own interior shows only the far wall,
     which the planet occludes from the ground, so a single-sided deck is structurally invisible as
     overhead sky from the surface.

     It does not cast into the sun's shadow map: at 4-11 km a low sun drags its silhouette hundreds
     of kilometres across the surface, and through the ±48 km vehicle-tracking box those streaks clip
     into hard grey slabs that read as architecture. Ground shade is marched instead (see
     cloudShadeInject below), from the same field, so it holds a puff's shape at every distance. */
  weather = makeWeather();
  cloudMesh = makeCloudShell(weather);
  scene.add(cloudMesh);

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
  const built = buildPad(glowMap);
  pad = built.group;
  padLamps.push(...built.lamps);
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

/* The launch complex's local-to-world matrix (build units, z up, the vehicle's axis on the origin),
   for anything that has to reason in the pad's own frame — the camera's colliders do. It rides the
   planet's spin, which a frame built from the constant PAD_UP does not. */
export function padMatrix() { return pad ? pad.matrixWorld : null; }

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
  earth.rotation.y = spin;
  moon.rotation.y = MOON_RATE * ts;
  moonPos(simT, moon.position);
  /* Weather drift is a function of absolute time, like the angles above: a teleport or a reset that
     re-based simT without re-based the drift would leave the clouds where the old clock put them. */
  if (cloudMesh) updateWeather(cloudMesh, simT, spin, SUN_DIR);
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
  earth.rotation.y = spin;
  moon.rotation.y += MOON_RATE * dt;
  moonPos(simT, moon.position);
  /* The shell never rotates — its mesh is fixed so its shader can work straight in world space —
     and the weather moves through uv drift: the lattices ride the ground's spin plus a wind, the
     upper lattice faster than the lower, so cells grow and dissolve as they slide past each other
     instead of just translating. Rates are of the same order as EARTH_SPIN (real superrotation),
     never orders of magnitude faster. */
  if (cloudMesh) updateWeather(cloudMesh, simT, spin, SUN_DIR);
}

const HORIZON = new THREE.Color(0xb2cfe2);

/* blue sky -> black space: the mix halves every ~55 km of climb, so the sky is effectively black
   by 200 km. The dome (built in initWorld) follows the vehicle and fades on this clock; the
   background under it is black space. The exponential fog thins on the same clock and takes the
   dome's horizon tone, so near-field haze always matches the sky behind it. */
const SKY_SCALE = 80;            // km — visual atmospheric depth for the sky/fog blend
export function updateSky(pos, camPos) {
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
  /* The ground's haze runs the same numbers through js/haze.js, measured from the EYE and keyed to
     the air the EYE is in: exp² in true distance with a sea-level density is a pad-scale law, and
     applied to a 400 km sight line from a camera 100 km up it washed the whole planet to 60 % sky
     (measured: the coastlines vanished). Vertical optical depth dies with height far faster than a
     slant path length grows, so the clock reads camera altitude, not the vehicle's. */
  if (hazeU) {
    const camAlt = Math.max(0, (camPos || pos).length() - RE);
    const kMix = Math.exp(-camAlt / SKY_SCALE);
    updateHaze(hazeU, camPos || pos, 0.0038 * kMix * kMix, _sky);
  }
  /* Stars come up against what the EYE measures, not the linear buffer: sRGB lightness. With
     the squared background this crosses fully visible around 300 km and is exactly zero for
     the whole pad day. */
  const per = Math.pow(0.2126 * _sky.r + 0.7152 * _sky.g + 0.0722 * _sky.b, 1 / 2.2);
  const dark = THREE.MathUtils.clamp((0.16 - per) / 0.10, 0, 1);
  for (const s of stars) { s.material.opacity = dark; s.visible = dark > 0.01; }
}

export function getSkyMix() { return _skyMix; }

