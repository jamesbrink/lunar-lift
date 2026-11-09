import * as THREE from 'three';
import {
  RE, RM, MOON_RATE, EARTH_SPIN, PAD_UP, PAD_EAST, PAD_SCALE, PAD_POS, SKY_DAY, SKY_NULL, moonPos
} from './constants.js';
import { cumulusTex, cirrusTex, moonTex, earthTex, glowTex } from './textures.js';
import { toon, outline, PALETTE, RAMP_EARTH, RAMP_MOON, RAMP_CLOUD } from './toon.js';
import {
  applyRelief, sampleGrid, reliefField, coastField, shoreDistance, fineEarth,
  padWeight, paintedCanvas,
} from './toonmap.js';
import { makePatch, attachEarthPatch, updatePatch } from './terrain.js';
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
let clouds = null;
const _sky = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };
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
  /* The sky at human scale: a 64 km cloud tile on a cap that re-centres under the vehicle, plus its
     own terrain-draped shade cap. The planet-scale decks below cannot show a cumulus from the pad —
     one of their texels is 39 km and the whole visible sky spans a fraction of one. */
  clouds = makeCloudLayer(earth, groundKmLocal);

  /* ---- two cloud decks, both generated in js/textures.js, both white with the weather in alpha and
     read through `map` — see the note on alphaMap's green channel there.

     They blend; they do NOT alpha-test. That distinction is the reason clouds never appeared:
     the field is mipmapped (a nearest-sampled minified alpha is the grazing wedge the earlier
     attempt drew), and averaging a 50 %-coverage field into coarse mips lifts EVERY texel to
     around the global mean (~0.37) — above any threshold that could be chosen. `discard` is
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
  cumulus = new THREE.Mesh(new THREE.SphereGeometry(RE + CUMULUS_ALT, 256, 128),
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
  scene.add(cumulus);

  cirrus = new THREE.Mesh(new THREE.SphereGeometry(RE + CIRRUS_ALT, 256, 128),
    toon({
      color: 0xf4f8fc, map: cirrusMap, transparent: true, side: THREE.DoubleSide,
      opacity: 0.5, depthWrite: false, gradientMap: RAMP_CLOUD
    }));
  cirrus.castShadow = false;        // see the cumulus note: 9 km up is enough to wreck the ground
  cirrus.material.fog = false;
  scene.add(cirrus);

  /* ---- atmosphere: back-side limb shell. Intensity comes from the optical depth still in front of
     each fragment — long tangential sight lines glow, the thin overhead shell from the ground does not. ---- */
  atmo = new THREE.Mesh(new THREE.SphereGeometry(RE * ATMO_SHELL, 256, 128), new THREE.ShaderMaterial({
    uniforms: {
      glow: { value: new THREE.Color(0x63b7ff) },
      shellR: { value: RE * ATMO_SHELL },
      sunDir: { value: SUN_DIR.clone() }
    },
    vertexShader: `
      varying vec3 vP; varying vec3 vN;
      void main() {
        vP = (modelMatrix * vec4(position, 1.0)).xyz;
        vN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 glow; uniform float shellR; uniform vec3 sunDir;
      varying vec3 vP; varying vec3 vN;
      void main() {
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
        // Hard day/night cut — that edge is cel and stays cel.
        float day = dot(n, sunDir) > 0.02 ? 1.0 : 0.16;
        float rim = pow(grazing, 2.4) * depth;
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
      zenith: { value: new THREE.Color(0x2a6cb2) },
      band: { value: new THREE.Color(0xb2cfe2) },
      glowC: { value: new THREE.Color(0xfff0cf) },
      sunDir: { value: SUN_DIR.clone() },
      atmoMix: { value: 1 },
    },
    vertexShader: `
      varying vec3 vP;
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
      #include <logdepthbuf_fragment>
      void main() {
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
  moon.castShadow = true; moon.receiveShadow = true;
  scene.add(moon);
  applyRelief(moon.geometry, 'moon');
  reliefField('moon').then((f) => { moonField = f; });

  /* ---- starfield, well outside the moon's orbit ---- */
  {
    const N = 6000, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(STAR_R);
      pos.set([v.x, v.y, v.z], i * 3);
      const b = 0.35 + Math.pow(Math.random(), 3) * 0.65;
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
    stars = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 2, vertexColors: true, sizeAttenuation: false, transparent: true, opacity: 0, fog: false
    }));
    scene.add(stars);

    flare = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowMap, color: 0xffe9c4, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false
    }));
    flare.position.copy(PAD_POS).addScaledVector(SUN_DIR, SUN_DIST);
    flare.scale.setScalar(SUN_DIST * SUN_ANG);            // ~0.53 deg disk, like the real sun
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

/* the shadow box tracks the vehicle: tight enough that pad structures resolve at 2048² (~6 m/texel
   grounded), growing only as fast as the far detail actually needs it, and never past ±48 km —
   cloud weather does NOT come through this box (js/clouds.js supplies it), so it no longer has to be huge
   to hold cloud silhouettes, and hardware shadows no longer have to be coarse to fit weather in. */
function updateShadowBox(pos) {
  moonPos(simT, _moon);
  const local = Math.min(pos.length() - RE, pos.distanceTo(_moon) - RM);
  setShadowBox(THREE.MathUtils.clamp(SHADOW_MIN + local * 0.12, SHADOW_MIN, SHADOW_MAX));
}

/* 37 meshes + 4 lamp sprites, all in build units around the crawler deck */
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
  box(64, 46, 3, concrete, 0, 0, 1.5, false, true, true);
  box(64, 9, 3.6, concrete, 0, -23, 1.2, false, true);
  box(64, 9, 3.6, concrete, 0, 23, 1.2, false, true);
  // reinforced launch deck: four slabs ring the flame-trench opening; tops z = 4 (physics anchor)
  box(44, 12, 1, concrete, 0, -14, 3.5, false, true);
  box(44, 12, 1, concrete, 0, 14, 3.5, false, true);
  box(12, 16, 1, concrete, -16, 0, 3.5, false, true);
  box(12, 16, 1, concrete, 16, 0, 3.5, false, true);
  // flame trench below the opening + four canted exhaust deflectors
  box(21, 17, 4.4, blast, 0, 0, 0.8, false, true);
  const d1 = box(18, 7, 1.2, blast, 0, -3.5, 2.4, true, true); d1.rotation.x = 0.75;
  const d2 = box(18, 7, 1.2, blast, 0, 3.5, 2.4, true, true); d2.rotation.x = -0.75;
  const d3 = box(15, 7, 1.2, blast, -7, 0, 2.4, true, true); d3.rotation.y = 0.75;
  const d4 = box(15, 7, 1.2, blast, 7, 0, 2.4, true, true); d4.rotation.y = -0.75;
  // strongback tower (legs to z 56) with a swing arm reaching for the rocket at mid-vehicle height
  box(1.8, 1.8, 52, steel, -16, -10, 30, true);
  box(1.8, 1.8, 52, steel, -16, -2, 30, true);
  for (const bz of [14, 27, 40]) box(1.8, 8, 1.2, steel, -16, -6, bz, true);
  const swing = box(12, 1.6, 1.6, steel, -9, -2, 34, true); swing.rotation.z = 0.05;
  // service tower (legs to z 60) with a crew access arm at capsule height
  box(1.8, 1.8, 56, steel, 16, -10, 32, true);
  box(1.8, 1.8, 56, steel, 16, -2, 32, true);
  for (const bz of [18, 44]) box(1.8, 8, 1.2, steel, 16, -6, bz, true);
  const crewArm = box(11, 1.5, 1.5, steel, 10, -2, 56, true); crewArm.rotation.z = -0.04;
  // two thin lightning masts; tips clear the 74-unit vehicle
  for (const mx of [-30, 30]) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, 88, 8), steel);
    mast.position.set(mx, -26, 48); mast.rotation.x = Math.PI / 2; mast.castShadow = true; g.add(mast);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), steel);
    tip.position.set(mx, -26, 92.4); tip.castShadow = true; g.add(tip);
  }
  // clustered LOX/LH2 tanks on a pad with a manifold header and a feed line toward the deck
  box(34, 28, 2, concrete, 50, 36, 3, false, true);
  for (const [tx, ty] of [[40, 28], [58, 30], [42, 44], [60, 46]]) {
    const tank = new THREE.Mesh(new THREE.SphereGeometry(6, 24, 16), steel);
    tank.position.set(tx, ty, 10); tank.castShadow = true; tank.receiveShadow = true; g.add(tank);
    outline(tank);
  }
  const manifold = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 26, 10), steel);
  manifold.position.set(50, 36, 7); manifold.rotation.x = Math.PI / 2; manifold.castShadow = true; g.add(manifold);
  box(22, 1.2, 1.2, steel, 25, 36, 6.4, true);
  // floodlight rig: mast + cross-truss carrying four glow lamps
  box(1.4, 1.4, 22, steel, 0, -34, 15, true);
  box(30, 1.4, 1.4, steel, 0, -34, 26, true);
  for (let i = 0; i < 4; i++) {
    /* depthTest on: these are additive glow sprites, and with the test off their orange composited
       over anything in front — the chase camera saw the glow painted across the rocket hull whenever
       the pad sat behind it. A glow that respects the hull reads as light on a fixture; one that
       ignores it reads as a bug. The origins drop to z = 21.5 so the sprite disks clear the
       cross-truss at 26 instead of half-burying themselves in it — moving the fixture, not the test. */
    const l = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xfff2c9, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
    l.position.set(-13.5 + i * 9, -34, 21.5); l.scale.setScalar(7); g.add(l);
  }
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
  updateReliefPatches(pos);
}

/* One Earth patch, fed the ground point in the mesh-local frame (undo the spin — the patch is a
   child of the mesh, the vehicle position is inertial). Near the Moon altE is ~384 000 km, so the
   update's own altitude gate hides it; there is no lunar patch to switch to — the Moon has none. */
function updateReliefPatches(pos) {
  _ld.copy(pos).normalize();
  spinLocal(earth, _ld);
  updatePatch(earthPatch, _ld.x, _ld.y, _ld.z, pos.length() - RE);
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
  simT = t;
  spin = EARTH_SPIN * t;
  cloudSpin = EARTH_SPIN * 1.08 * t;
  cirrusSpin = EARTH_SPIN * 1.22 * t;
  earth.rotation.y = spin;
  cumulus.rotation.y = cloudSpin;
  cirrus.rotation.y = cirrusSpin;
  moon.rotation.y = MOON_RATE * t;
  moonPos(simT, moon.position);
}

/* the planet and its weather turn; the cloud decks drift a little faster than the ground (real
   superrotation), at rates of the same order as EARTH_SPIN, never orders of magnitude faster */
export function spinBodies(simDt) {
  simT += simDt;
  spin += EARTH_SPIN * simDt;
  cloudSpin += EARTH_SPIN * 1.08 * simDt;
  cirrusSpin += EARTH_SPIN * 1.22 * simDt;
  earth.rotation.y = spin;
  cumulus.rotation.y = cloudSpin;
  cirrus.rotation.y = cirrusSpin;
  moon.rotation.y += MOON_RATE * simDt;
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
  if (sky) {
    sky.position.copy(pos);
    sky.material.uniforms.atmoMix.value = _skyMix;
  }
  _sky.copy(SKY_NULL).lerp(HORIZON, _skyMix);
  scene.background.copy(_sky);
  scene.fog.color.copy(_sky);
  scene.fog.density = 0.0038 * _skyMix * _skyMix;
  /* Stars in proportion to how dark the sky actually is: zero against the daylight dome, coming
   back through the climb as the background drops below a quarter lightness. */
  const dark = THREE.MathUtils.clamp(1 - _sky.getHSL(_hsl).l / 0.28, 0, 1);
  stars.material.opacity = dark;
  stars.visible = dark > 0.01;
}

export function getSkyMix() { return _skyMix; }

