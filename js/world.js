import * as THREE from 'three';
import {
  RE, RM, MOON_RATE, EARTH_SPIN, PAD_UP, PAD_EAST, PAD_POS, SKY_DAY, SKY_NULL, moonPos
} from './constants.js';
import { startPlanetPaint, glowTex, flareTex } from './textures.js';
import { toon, RAMP_EARTH, RAMP_MOON, SHIP_LIGHT, PAD_LIGHT } from './toon.js';
import { applyRelief, sampleGrid, reliefField, coastField, paintedCanvas } from './toonmap.js';
import { fineRelief } from './padsite.js';
import { surfaceInject, setSun } from './surface.js';
import { makePatch, attachEarthPatch, updatePatch, makeMoonPatch, attachMoonPatch, updateMoonPatch, hidePatch } from './terrain.js';
import { makeWeather, makeCloudShell, updateWeather, cloudShadeInject, setWeatherEye } from './clouds.js';
import { makeHaze, hazeInject, updateHaze } from './haze.js';
import { buildPad, setPadNight } from './pad.js';
import { uOrigin, absolute } from './origin.js';

/* distances are km, angles rad — everything here lives at real planetary scale */
const SUN_RANGE = 1500;            // km the directional light sits off the tracked vehicle
const SUN_DIST = 1000000;          // km — the flare sprite rides a million km out on the sun's bearing
const SUN_ANG = 0.009;             // rad: the real sun is 0.53° wide, so the flare disk is 0.9% of its range
const STAR_R = 2000000;            // km — the starfield sits well outside the moon's orbit
const SKY_R = 20000;               // km — the sky dome rides the camera; small vs the moon at 384 400
const SHADOW_MAX = 48;             // km half-extent of the vehicle-tracking shadow box
/* The sun LIGHT's direction is redrawn in steps: it is held fixed in the Earth's own frame while the
   planet turns SUN_STEP rad (27 s of mission time), then moved. The true direction creeps over the
   ground at 7.3e-5 rad/s, and everything with a hard edge crept with it: every shadow-map texel on
   a silhouette flipped in its own time and took a stretch of thresholded shadow edge with it, and
   every cel band boundary on a tank or a hull crossed pixel centres one at a time (measured idle
   on the pad with the hard shadow term: 13 pixels of 1.3 M changing by more than 90, 5 of them
   gone with the shadow map frozen, the rest on ramp boundaries). Held, the light, the shadow
   camera and so the whole lit picture of anything bolted to the ground are the same numbers every
   frame. The light is never more than SUN_STEP (0.11 deg) behind the sun; the sky, the flare and
   the terminator use the true direction. */
const SUN_STEP = 2e-3;
const _sunLight = new THREE.Vector3();
const SHADOW_MIN = 3;              // km — 4096² over ±3 km is 1.46 m/texel: the pad zoom the user screenshotted showed ~10 m blob steps at the old ±6 km
const ATMO_SHELL = 1.01;          // atmosphere glow shell: RE * 1.01

/* Sun bearing, fixed in inertial space: ~37° above the pad's horizon at MET 0, off to the east, so
   the pad, the rocket and the towers are lit at liftoff and the planet turns under the light. */
const PAD_NORTH = new THREE.Vector3().crossVectors(PAD_UP, PAD_EAST).normalize();
const SUN_ELEV = 0.645;                                    // rad, 37 deg
/* Exported for the orbit plot (js/navball.js): the night side on its body disc has to sit where
   this light actually is, and the sun bearing is inertial and constant, so the plot can treat it
   as truth exactly like the renderer does. */
export const SUN_DIR = PAD_UP.clone().multiplyScalar(Math.sin(SUN_ELEV))
  .addScaledVector(PAD_EAST, Math.cos(SUN_ELEV) * 0.85)
  .addScaledVector(PAD_NORTH, Math.cos(SUN_ELEV) * 0.4).normalize();

let scene = null, earth = null, pad = null, weather = null, cloudMesh = null, hazeU = null, atmo = null, moon = null;
let sun = null, sunTarget = null, flare = null, stars = null, sky = null;
let spin = 0, simT = 0;
export const getSpin = () => spin;
const _sunF = new THREE.Vector3(), _camF = new THREE.Vector3(), Y_UP = new THREE.Vector3(0, 1, 0);
/* ---- what reaches the hardware: js/toon.js's CEL_HARDWARE uniforms, filled every frame ----
   The sun light has no planet in its shadow box (the box is ±3..48 km round the vehicle), so nothing
   stopped it lighting a rocket standing on the night side: the stack was day-bright on a navy field.
   The vehicle and the launch complex therefore carry their own "does the sun reach me", from
   geometry — the sun's angle over the limb of each body, eased across a twilight — and at night
   the complex's floodlights take over (a hard-stepped direction in the same shader, see toon.js).

   HARD_GAIN is π: three's Lambert BRDF divides by π and its lights no longer multiply it back, so a
   hull painted 0xf1f4f8 used to reach the screen at sRGB 160 — a grey rocket. Hardware is drawn at
   the palette it was authored in; the planets keep the exposure their own shaders were tuned at. */
const HARD_GAIN = Math.PI;
const TWILIGHT_LO = -0.10, TWILIGHT_HI = 0.05;       // rad of sun over the limb: dark .. full
const FLOOD_COL = new THREE.Color(1.0, 0.93, 0.78);
/* Toward the rig, in the pad's frame (east, north, up): the truss stands south of the stack and its
   lamps hang BELOW the vehicle's middle, so the lit side faces south and a little down. */
const FLOOD_PAD = new THREE.Vector3(0.22, -0.95, -0.2).normalize();
const ZERO = new THREE.Vector3();
const _fd = new THREE.Vector3(), _pd = new THREE.Vector3(), _pv = new THREE.Vector3();
/* Sun over the limb of a body of radius R centred at c, seen from p: 0 in its shadow, 1 in the light. */
function sunOver(p, c, R) {
  _fd.subVectors(p, c); const r = _fd.length();
  const ang = Math.asin(THREE.MathUtils.clamp(_fd.dot(SUN_DIR) / r, -1, 1)) + Math.acos(Math.min(1, R / r));
  return THREE.MathUtils.smoothstep(ang, TWILIGHT_LO, TWILIGHT_HI);
}
function setRig(rig, vis, flood, reach) {
  rig.celSun.value.set(HARD_GAIN * vis, HARD_GAIN * THREE.MathUtils.lerp(0.5, 1, vis), THREE.MathUtils.lerp(0.3, 1, vis), reach);
  rig.celFloodCol.value.copy(FLOOD_COL).multiplyScalar(HARD_GAIN * 0.8 * flood);
}
function updateHardwareLight(pos) {
  /* the pad, in the game's inertial frame at the drawn instant */
  _pd.copy(PAD_UP).applyAxisAngle(Y_UP, spin);
  const visPad = sunOver(_pv.copy(_pd).multiplyScalar(RE), ZERO, RE - 1e-6), night = 1 - visPad;
  setRig(PAD_LIGHT, visPad, night, 0.42);
  PAD_LIGHT.celPool.value.set(0.105, 0.26, 0.5 * night);     // km: the bright ring, and the whole hardstand
  /* the vehicle: either body can stand between it and the sun; the floods reach it only near the pad */
  const d = _pv.distanceTo(pos);
  setRig(SHIP_LIGHT, Math.min(sunOver(pos, ZERO, RE - 1e-6), sunOver(pos, moon.position, RM - 1e-6)),
    night * (1 - THREE.MathUtils.smoothstep(d, 0.2, 1.4)), 1e9);
  setPadNight(night, THREE.MathUtils.smoothstep(d, 0.08, 0.22));
}

/* Ground cloud shade is not a shadow-map caster: js/clouds.js injects a lookup of its own weather
   field along the sun ray into the globe and the near patch (cloudShadeInject), so the darkening
   on the ground is the same weather the sky shows. */
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
   the weather shell, atmosphere shell, sky dome, starfield and the launch pad welded to the
   rotating planet. */
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
  sun.shadow.mapSize.set(4096, 4096);   // 1.46 m/texel at the ±3 km pad box (SHADOW_MIN); PCF then has texels to work with
  setShadowBox(SHADOW_MAX);
  /* Bias, in NORMALISED depth × the camera's 300 km range: −0.00003 is 9 m along the light, and
     normalBias is 0.01 km. Larger values smear: −0.0005 was 1.5 km of along-light shadow, and a
     normalBias of 0.12 km slid every mast shadow a full 120 m along the ground — together they
     drew fat wedges that were mis-called a texel staircase. */
  sun.shadow.bias = -0.00003;
  sun.shadow.normalBias = 0.01;
  sunTarget = new THREE.Object3D();
  sun.target = sunTarget;
  moonPos(0, _moon);
  sun.position.copy(PAD_POS).addScaledVector(SUN_DIR, SUN_RANGE);
  sunTarget.position.copy(PAD_POS);
  sunTarget.updateMatrixWorld();
  scene.add(sun, sunTarget, new THREE.AmbientLight(0x39496b, 1.0));

  startPlanetPaint();
  const glowMap = glowTex();
  const flareMap = flareTex();

  /* ---- earth: the drawn surface under the cel ramp (RAMP_EARTH). 384×192 segments (74 305 vertices) and
     displaced by the land height field from js/toonmap.js — oceans stay the perfect sphere,
     continents get a limb, and the launch pad sits on ground that is exactly zero for 90 km
     around it, so it can never float or sink. No normal map: docs/reference/cartoon-art-direction
     .md retires per-pixel surface detail — the scale needed to sell 20 km-per-texel slope through
     the ramp (26!) stippled the ground at the grazing angles a pad camera lives at. The
     map's flat colour shapes are the surface; relief survives only as horizon silhouette. The
     small navy emissive is a floor for the night side and the grazing limb, where the shadow
     band alone left the sea black. ---- */
  earth = new THREE.Mesh(new THREE.SphereGeometry(RE, 384, 192),
    toon({ gradientMap: RAMP_EARTH, emissive: 0x07182c }));
  earth.geometry.setAttribute('aUv', earth.geometry.attributes.uv);   // shared, not copied
  earth.geometry.setAttribute('sfUv', earth.geometry.attributes.uv);  // the ground shader's name for it
  earth.receiveShadow = true;
  /* The surface is DRAWN, per fragment, by js/surface.js — biomes, relief bands, the inked coast —
     from data fields the paint job fills in place. ONE injection per material: three keys its
     program cache on onBeforeCompile.toString(), so the weather shade, the haze and the ground
     are composed in the same function, and every uniform is bound here at compile time. */
  earth.material.onBeforeCompile = (sh) => {
    cloudShadeInject(sh, weather);
    hazeInject(sh, hazeU);      // the globe carries the SAME aerial perspective as the patch
    surfaceInject(sh, 'earth', 'globe');
  };
  /* Planet-scale bodies are exempt from the fog: FogExp2 is measured from the camera, so at
     0.002/km a system-view camera 20 000 km out would erase the planet entirely. The haze the
     fog models is the near-field air around the vehicle; the day sky itself comes from
     scene.background and the limb shell below. */
  earth.material.fog = false;
  scene.add(earth);
  applyRelief(earth.geometry, 'earth');
  reliefField('earth').then((f) => { earthField = f; });
  coastField().then((c) => { shore = c; });
  /* The near level: ONE mesh, 161×161 vertices, dense (≈70 m) under the vehicle and stretched to a
     220 km rim — the horizon from altitude h is √(2·RE·h), and the rim stays beyond it until the
     patch's remaining difference from the globe mesh is sub-pixel. It rides the spin as a child of
     the mesh, and it is what receives the pad and vehicle shadows now that the pad's fake-island
     discs are gone — with real authored coastline under it, the complex sits on Merritt Island. */
  earthPatch = makePatch(earth);
  attachEarthPatch(earthPatch);
  /* The patch is what the eye actually resolves at the pad, so it gets the same cloud shade as
     the globe it sits on; without it the ground under a cloud would be lit while the planet around
     it is not. */
  earthPatch.mesh.material.onBeforeCompile = (sh) => {
    cloudShadeInject(sh, weather);
    hazeInject(sh, hazeU);
    surfaceInject(sh, 'earth', 'patch');
  };

  /* ---- the weather shell: one mesh round the whole planet, built and drawn by js/clouds.js (its
     header is the truth about how). Two things here depend on it: it does not cast into the sun's
     shadow map — a low sun would drag its silhouette hundreds of kilometres through the ±48 km
     vehicle-tracking box as hard grey slabs — so the ground shade is the same field looked up
     along the sun ray (cloudShadeInject, above); and it replaced flat cloud decks and
     vehicle-following caps, whose square silhouettes showed from 100 km up. ---- */
  weather = makeWeather();
  cloudMesh = makeCloudShell(weather);
  scene.add(cloudMesh);

  /* ---- atmosphere: back-side limb shell. Intensity comes from the optical depth still in front of
     each fragment — long tangential sight lines glow, the thin overhead shell from the ground does not. ---- */
  atmo = new THREE.Mesh(new THREE.SphereGeometry(RE * ATMO_SHELL, 512, 256), new THREE.ShaderMaterial({
    uniforms: {
      uOrigin,
      nightFloor: { value: 0.14 },
      glow: { value: new THREE.Color(0x63b7ff) },
      shellR: { value: RE * ATMO_SHELL },
      sunDir: { value: SUN_DIR.clone() }
    },
    vertexShader: `
      varying vec3 vP; varying vec3 vN;
      #include <common>
      uniform vec3 uOrigin;
      #include <logdepthbuf_pars_vertex>
      void main() {
        vP = (modelMatrix * vec4(position, 1.0)).xyz + uOrigin;
        vN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      uniform vec3 uOrigin;
      #define camAbs ( cameraPosition + uOrigin )
      uniform vec3 glow; uniform float shellR; uniform vec3 sunDir; uniform float nightFloor;
      varying vec3 vP; varying vec3 vN;
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec3 n = normalize(vN);
        vec3 eye = normalize(camAbs - vP);
        float grazing = 1.0 - abs(dot(n, eye));                 // 0 overhead, 1 at the limb
        // intersect the sight line with the shell and take the segment still ahead of this fragment
        vec3 d = normalize(vP - camAbs);
        float a = dot(d, camAbs);
        float b = dot(camAbs, camAbs) - shellR * shellR;
        float disc = max(a * a - b, 0.0);
        float t1 = -a - sqrt(disc), t2 = -a + sqrt(disc);
        float path = max(t2 - max(t1, 0.0), 0.0);                // km of air in front of this point
        float depth = clamp(path / 400.0, 0.0, 1.0);
        /* Dusk, not a knife. A binary day-cut on a 65 km-thin shell put a hard cyan edge on the
           terminator with nothing above it — the band switched off across an angle the eye reads
           as a rendering error. Three degrees of smoothstep is still cel: the night side keeps a
           cold floor rather than going dark, so the limb reads as air on both sides. */
        /* nightFloor: 0.14 seen from space (the limb reads as air on both sides), near zero from
           inside the air at night — standing on the pad at midnight the floor alone, through a
           horizon-long path, painted the whole sky slate grey and hid the stars. */
        float day = nightFloor + ( 1.0 - nightFloor ) * smoothstep(-0.06, 0.20, dot(n, sunDir));
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
      uOrigin,
      zenith: { value: new THREE.Color(0x1e5cab) },
      band: { value: new THREE.Color(0x9fc4de) },
      glowC: { value: new THREE.Color(0xfff0cf) },
      sunDir: { value: SUN_DIR.clone() },
      atmoMix: { value: 1 },
    },
    vertexShader: `
      varying vec3 vP;
      #include <common>
      uniform vec3 uOrigin;
      #include <logdepthbuf_pars_vertex>
      void main() {
        vP = (modelMatrix * vec4(position, 1.0)).xyz + uOrigin;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      uniform vec3 uOrigin;
      #define camAbs ( cameraPosition + uOrigin )
      uniform vec3 zenith; uniform vec3 band; uniform vec3 glowC;
      uniform vec3 sunDir; uniform float atmoMix;
      varying vec3 vP;
      #include <logdepthbuf_pars_fragment>
      void main() {
        /* logdepthbuf_fragment is a STATEMENT — it belongs inside main. Outside it, the sky
           dome silently fails to compile ("Shader Error 0 ... 'gl_FragDepth' syntax error" in
           the page console, unnoticed because a missing dome looks like space) and daytime
           views have no sky wash. */
        #include <logdepthbuf_fragment>
        vec3 dir = normalize(vP - camAbs);
        float up = dot(dir, normalize(camAbs));      // elevation above the local horizon
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
    toon({ gradientMap: RAMP_MOON }));
  moon.geometry.setAttribute('sfUv', moon.geometry.attributes.uv);
  moon.material.onBeforeCompile = (sh) => surfaceInject(sh, 'moon', 'globe');
  moon.material.fog = false;      // ground haze must not eat the moon or the stars
  moon.position.copy(_moon);
  /* The Moon does not CAST shadow. With castShadow on, the relief-displaced sphere and
     the near patch are both caster and receiver inside the ±48 km vehicle box, and at the 23 m
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
    /* The point sprite is a painted 32×32 radial falloff, not the default square. A review flagged
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
  /* The floods, in the axes the frame is drawn in. Those are the Earth's own (js/origin.js turns the
     scene back by the spin), so a direction bolted to the pad is a constant. The pad's origin in
     view space is only known once three has rebuilt the matrices for the frame: scene.onBeforeRender. */
  for (const rig of [PAD_LIGHT, SHIP_LIGHT]) {
    rig.celFloodDir.value.copy(PAD_EAST).multiplyScalar(FLOOD_PAD.x).addScaledVector(PAD_NORTH, FLOOD_PAD.y).addScaledVector(PAD_UP, FLOOD_PAD.z);
    rig.celUp.value.copy(PAD_UP);
  }
  SHIP_LIGHT.celPad = PAD_LIGHT.celPad;
  scene.onBeforeRender = (r, sc, cam) => {
    _pv.setFromMatrixPosition(pad.matrixWorld).applyMatrix4(cam.matrixWorldInverse);
    PAD_LIGHT.celPad.value.set(_pv.x, _pv.y, _pv.z, 1);
  };
  pad.position.copy(PAD_UP).multiplyScalar(RE);
  pad.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(PAD_EAST, PAD_NORTH, PAD_UP));
  earth.add(pad);

  scene.fog = new THREE.FogExp2(SKY_DAY.getHex(), 0.002);
  updateSky(PAD_POS);
  return scene;
}

function setShadowBox(extent) {
  const sc = sun.shadow.camera;
  shadowExtent = extent;
  sc.left = sc.bottom = -extent;
  sc.right = sc.top = extent;
  /* ±150 km around the vehicle's depth plane, not 1→5000 km: the depth range IS the bias
     resolution (0.0001 of this range is 30 m), and nothing casts a shadow 400 km in front of
     or behind the tracked vehicle. */
  sc.near = SUN_RANGE - 150; sc.far = SUN_RANGE + 150;
  sc.updateProjectionMatrix();
}

/* the shadow box tracks the vehicle: ±3 km on the ground, where 4096² is 1.46 m/texel and pad
   structures resolve, growing only as fast as the far detail actually needs it, and never past ±48 km —
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
  /* In quarter-octave steps, not continuously: a box that is resized by a hair every frame
     re-projects every shadow every frame (and defeats the texel snap in updateSunShadow), which is
     shimmer on every edge. On the ground it is one size and stays there. */
  const want = THREE.MathUtils.clamp(SHADOW_MIN + local * 0.12, SHADOW_MIN, SHADOW_MAX);
  const stepped = Math.min(SHADOW_MAX, SHADOW_MIN * Math.pow(2, Math.round(Math.log2(want / SHADOW_MIN) * 4) / 4));
  if (stepped !== shadowExtent) setShadowBox(stepped);
}

const _eyeUp = new THREE.Vector3(), _sf = new THREE.Vector3(), _sx = new THREE.Vector3(), _sy = new THREE.Vector3(), _sp = new THREE.Vector3();
let shadowExtent = 3, snapTexel = 0;
const snapC = new THREE.Vector3(), _sd = new THREE.Vector3();
const _padAbs = new THREE.Matrix4();
/* The launch complex's local-to-world matrix (build units, z up, the vehicle's axis on the origin),
   for anything that has to reason in the pad's own frame — the camera's colliders do. It rides the
   planet's spin, which a frame built from the constant PAD_UP does not. Planet-centred and
   inertial: the drawn matrixWorld is eye-relative and Earth-fixed (js/origin.js). */
export function padMatrix() { return pad ? absolute(pad.matrixWorld, _padAbs) : null; }

/* main.js calls this every frame: the shadow frustum travels with the vehicle, so the same sun
   shades the pad at liftoff and the lander on the moon. The near terrain patches are re-centred
   from here too (updateReliefPatches; js/terrain.js decides when a rebuild is due). */
export function updateSunShadow(pos) {
  updateShadowBox(pos);
  /* The shadow map's texel grid is pinned to the GROUND. The box follows the vehicle, and following
     it continuously slid the grid under every shadow by a fraction of a texel per frame — each edge
     re-sampled, a few pixels flipping along it (the last ~125 unstable pixels on an idle pad). So the
     box centre is snapped to whole texels, measured in the Earth-fixed frame along the shadow
     camera's own axes (x = up × light, y = light × x): on the pad it does not move at all, and in
     flight it moves in steps the map cannot see. */
  const texel = 2 * shadowExtent / sun.shadow.mapSize.x;
  _sf.copy(SUN_DIR).applyAxisAngle(Y_UP, -Math.floor(spin / SUN_STEP) * SUN_STEP);   // light, Earth-fixed, held between steps
  _sunLight.copy(_sf).applyAxisAngle(Y_UP, spin);                // and in the game's inertial frame at the drawn instant
  _sx.crossVectors(Y_UP, _sf).normalize(); _sy.crossVectors(_sf, _sx);
  _sp.copy(pos).applyAxisAngle(Y_UP, -spin);                     // the vehicle, Earth-fixed
  /* The centre is a point ON THE GROUND FRAME that stays where it is; the vehicle may wander 8
     texels from it before it is moved, and then it moves by whole texels. (Snapping the vehicle's
     own planet-centred coordinates to a lattice does not work: the light's axes turn with the sun,
     6,371 km from the planet's centre that sweeps the lattice over the ground at 460 m/s — the
     first two versions of this made the pad ten times worse.) */
  _sd.subVectors(_sp, snapC);
  const dx = _sd.dot(_sx), dy = _sd.dot(_sy);
  if (texel !== snapTexel || Math.abs(dx) > 8 * texel || Math.abs(dy) > 8 * texel) {
    if (texel !== snapTexel || Math.abs(dx) > 400 * texel || Math.abs(dy) > 400 * texel) snapC.copy(_sp);      // a new box, or a jump: start over
    else snapC.addScaledVector(_sx, Math.round(dx / texel) * texel).addScaledVector(_sy, Math.round(dy / texel) * texel);
    snapTexel = texel;
  }
  snapC.addScaledVector(_sf, _sd.subVectors(_sp, snapC).dot(_sf));   // along the light it may follow freely: depth is not sampled
  _sp.copy(snapC).applyAxisAngle(Y_UP, spin);
  sun.position.copy(_sp).addScaledVector(_sunLight, SUN_RANGE);
  sun.target.position.copy(_sp);
  sun.target.updateMatrixWorld();
  flare.position.copy(pos).addScaledVector(SUN_DIR, SUN_DIST);   // flare stays on the sun's bearing
  updateHardwareLight(pos);
  updateReliefPatches(pos);
}

/* Two patches, switched by altitude (below): each is fed the ground point in its mesh-local frame
   (undo the spin — patches are children of the meshes, the vehicle position is inertial), and each
   hides itself above its own 30 km gate, so exactly one is ever drawn. */
function updateReliefPatches(pos) {
  /* the sun in each body's own frame, for the drawn relief bands and crater crescents */
  _ld.copy(SUN_DIR); spinLocal(earth, _ld); setSun('earth', _ld.x, _ld.y, _ld.z);
  _ld.copy(SUN_DIR); spinLocal(moon, _ld); setSun('moon', _ld.x, _ld.y, _ld.z);
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
  if (!earthField || !shore) return 0;
  // the same two terms js/terrain.js writes into the near patch's vertices under the vehicle
  return sampleGrid(earthField, _uvw.u, _uvw.v) + fineRelief(shore, _uvw.u, _uvw.v);
}
// The Moon has no fine getter: its near patch is the relief grid itself, so moonGroundHeight IS
// the drawn ground.

/* The painted canvases, for the orbit plot (js/navball.js): the same authored pixels the paint job
   produced, so the plot can blit real coastline instead of a flat blue disc, and never kicks off a
   second paint. null while painting is still in flight. */
export function planetCanvas(which) { return paintedCanvas(which); }

/* The spin the orbit plot has to account for: the angle the meshes are actually at. The plot
   converts its own longitude through this; the equirect u = (lon+180)/360 mapping the canvas and
   the sphere share stays the plot's business. */
export function bodySpin(which) { return which === 'moon' ? (moon ? moon.rotation.y : 0) : (earth ? earth.rotation.y : 0); }

/* The bodies are placed from the mission time main.js hands in each frame (the DRAWN instant), never
   advanced by a step of their own. Anything that jumps the clock instead of flying through the
   intervening time — the debug `teleport(pos, vel, t)`, `ff()`, a reset — then cannot leave the
   Moon hanging where the old time put it, with the physics pulling toward one place while the
   picture shows another: the angles are recomputed from the absolute time, and a state is fully
   determined by (pos, vel, t). */
export function syncTime(t) {
  /* Non-finite time must not reach the rotations: `spin = EARTH_SPIN * NaN` puts NaN in
     earth.rotation.y and moon.rotation.y, and every consumer that multiplies through the angle —
     js/navball.js's drawOrbit blit chief among them — starts throwing inside main.js's frame
     catch. Observed as an empty black orbit sub-map that no finite-state math could reproduce.
     A bad t re-bases to 0; valid t is untouched. js/navball.js also keeps its own NaN guard. */
  const ts = Number.isFinite(t) ? t : 0;
  simT = ts;
  spin = EARTH_SPIN * ts;
  earth.rotation.y = spin;
  moon.rotation.y = MOON_RATE * ts;
  moonPos(simT, moon.position);
  /* Weather drift is a function of absolute time, like the angles above: a teleport or a reset that
     re-based simT without re-basing the drift would leave the clouds where the old clock put them. */
  if (cloudMesh) updateWeather(cloudMesh, simT, spin, SUN_DIR);
}

const HORIZON = new THREE.Color(0xb2cfe2);

/* blue sky -> black space: the mix halves every ~55 km of climb, so the sky is effectively black
   by 200 km. The dome (built in initWorld) follows the vehicle and fades on this clock; the
   background under it is black space. The exponential fog thins on the same clock and takes the
   dome's horizon tone, so near-field haze always matches the sky behind it. */
const SKY_SCALE = 80;            // km — visual atmospheric depth for the sky/fog blend
/* The map is a chart, not a view: weather off (the shell and the shade it casts on the ground), so
   coastlines and the trajectory read cleanly from 100 000 km. */
let shadeFull = null;
export function setWeatherVisible(on) {
  if (!cloudMesh || cloudMesh.visible === on) return;
  cloudMesh.visible = on;
  if (weather && weather.shadeStrength) {
    if (shadeFull === null) shadeFull = weather.shadeStrength.value;
    weather.shadeStrength.value = on ? shadeFull : 0;
  }
}

export function updateSky(pos, camPos) {
  if (weather && camPos) setWeatherEye(weather, camPos);
  /* The frame is drawn in Earth-fixed axes (js/origin.js): shaders that work in planet-centred
     positions get the sun, and the haze its eye, turned the same way. */
  _sunF.copy(SUN_DIR).applyAxisAngle(Y_UP, -spin);
  if (atmo) atmo.material.uniforms.sunDir.value.copy(_sunF);
  if (sky) sky.material.uniforms.sunDir.value.copy(_sunF);
  const alt = Math.max(0, pos.length() - RE);
  _skyMix = Math.exp(-alt / SKY_SCALE);
  /* One part in eight of pale blue MIXED IN LINEAR SPACE already renders as 30 %-grey sRGB —
     that is what turned orbit into a grey poster: at 163 km the old linear mix left the whole
     sky measured-flat (69,82,90). The dome's alpha and the background therefore fall on the
     SQUARE of the physical mix: the pad keeps its full sky, the mesosphere goes dark fast, and
     above ~150 km there is nothing between the eye and the stars. The fog's density stays on
     this square (below) — near-field haze is optical depth, not mood. */
  const vis = _skyMix * _skyMix;
  /* ...and the dome + background fall on the QUARTIC. Apollo 8's "the sky is black even at
     30 000 feet" is the calibration: zenith optical depth is exp(−alt/8 km), so the sky OVERHEAD
     dies far faster than the horizon glow (which the shell draws independently, from grazing
     rays). On the quadratic alone the 68 km sky measured (77,91,100) — a flat slate poster with
     the stars suppressed; on the quartic it goes deep indigo by 40 km and black by 100. */
  /* And the sky needs a sun. The air only glows where sunlight reaches it: with the sun under the
     eye's horizon the dome, the background and the fog all go to night, through a short twilight
     (the sun from 5 deg up to 8 deg down). Without this the ground went dark at midnight under a
     noon-blue sky. */
  const sunUp = _eyeUp.copy(pos).normalize().dot(SUN_DIR);
  const day = THREE.MathUtils.smoothstep(sunUp, -0.14, 0.09);
  const skyVis = vis * vis * day;
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
  if (atmo) atmo.material.uniforms.nightFloor.value = THREE.MathUtils.lerp(0.012, 0.14, THREE.MathUtils.smoothstep(Math.max(0, (camPos || pos).length() - RE), 30, 150));
  if (hazeU) {
    const camAlt = Math.max(0, (camPos || pos).length() - RE);
    const kMix = Math.exp(-camAlt / SKY_SCALE);
    updateHaze(hazeU, _camF.copy(camPos || pos).applyAxisAngle(Y_UP, -spin), 0.0038 * kMix * kMix, _sky);
  }
  /* Stars come up against what the EYE measures, not the linear buffer: sRGB lightness. With
     the squared background this crosses fully visible around 300 km and is exactly zero for
     the whole pad day. */
  const per = Math.pow(0.2126 * _sky.r + 0.7152 * _sky.g + 0.0722 * _sky.b, 1 / 2.2);
  const dark = THREE.MathUtils.clamp((0.16 - per) / 0.10, 0, 1);
  for (const s of stars) { s.material.opacity = dark; s.visible = dark > 0.01; }
}


