import * as THREE from 'three';
import { RE } from './constants.js';
import { getSimTime } from './physics.js';
import { moonPos } from './constants.js';
import { SUN_DIR } from './world.js';
import { LAYER_FX, RES_SCALE } from './halfres.js';
import { NP, pPos, pR, pLife, pAge, pInv, pHeat, pMode, pSmoke, pMoon, pPal, pColB, alive, nAlive, ship, plumeDebug, isSmoke,
  SM_SEAM, SM_SPRAY, SM_FLASH, SM_TRAIL, SM_STEAM } from './exhaust-pool.js';

/* The parcels on screen: drawn puffs, not blurred sprites.

   Every smoke, steam, fire and dust parcel is a hard-edged clump of four spheres shaded in three flat
   tones by the sun's direction, written OPAQUE and WITH DEPTH — and the depth it writes is the clump's
   own, bulging toward the eye. Two things follow, and they are the whole look:
   - neighbouring puffs cut into one another along the arcs two balls really meet on, so a few hundred
     of them read as one cauliflower cloud with a scalloped silhouette, where the same parcels as soft
     alpha sprites composited into beige fog with no shape;
   - order does not matter. Nothing is blended, so there is no back-to-front sort to get wrong and no
     overlap that deepens the tone. A puff ends by shrinking, never by fading.
   The predecessor carried a coverage and an additive weight per parcel and dithered five alpha bands
   out of a glow texture; this path samples no texture at all.

   Light that is not a body — sparks, the staging flash, hot gas in vacuum — is a second draw call:
   additive two-step discs, depth-tested against the puffs but writing none.

   Both live in the half-resolution pass (js/halfres.js), so a pixel here is two screen pixels and the
   point sizes carry RES_SCALE. The drawn flame (js/flame.js) punches its outline out of this layer. */

const hex = (h) => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];
/* Tones are written to the target as authored and reach the canvas unconverted (neither this
   ShaderMaterial nor the composite quad encodes), so the bytes below are the bytes on screen. */
const FIRE = [hex(0xfff3b8), hex(0xffb42c), hex(0xee5f1c)];   // heat > 0.75, > 0.5, > 0.22
const SOOT = hex(0x9c9488);        // kerosene smoke against the sky: warm grey, its shadow band darker than the pad sky
const FOOT = hex(0xe9e5dc);        // the same smoke rolling along the ground, seen against grass
const VAPOUR = hex(0xf4f6fa);      // what a hydrogen engine leaves in air: water
const DUST = hex(0xf5eedd);        // lunar dust — paler than the brightest painted regolith, see exhaust-sim.js
const H2 = hex(0x8fc4ff);
/* The ascent trail is lit by the fire that made it for its first moments, then is smoke. A hard step. */
const TRAIL_WARM = hex(0xf0c489);

/* Dense render mirror, rebuilt every frame from the live list. Puffs fill it from the front and
   lights from the back, and the two draw calls take their own ends; the slot arrays themselves are
   never bound, because swap-remove leaves holes in them. */
const rPos = new Float32Array(NP * 3);
const rCol = new Float32Array(NP * 3);
const rSiz = new Float32Array(NP);        // drawn diameter, km
const rLit = new Float32Array(NP);        // seed + (puffs: 0 sun-shaded … 1 self-lit and flat; lights: intensity)
const attrs = {
  position: new THREE.BufferAttribute(rPos, 3), color: new THREE.BufferAttribute(rCol, 3),
  size: new THREE.BufferAttribute(rSiz, 1), lit: new THREE.BufferAttribute(rLit, 1),
};
function geometry() {
  const g = new THREE.BufferGeometry();
  for (const k in attrs) { attrs[k].setUsage(THREE.DynamicDrawUsage); g.setAttribute(k, attrs[k]); }
  g.setDrawRange(0, 0);
  return g;
}
const puffGeo = geometry(), lightGeo = geometry();

const VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float size;
  attribute float lit;
  uniform float uScale, uCap;
  varying vec3 vTint;
  varying float vLit;
  varying float vRad;
  varying vec4 vLobeA;      // two lobe centres, xy and zw
  varying vec4 vLobeB;      // a third centre, then two lobe radii
  void main() {
    vTint = color;
    /* The lit attribute carries two numbers: its integer part is a per-parcel seed (0..63), its fraction the
       self-illumination. The seed turns the lobes, so no two puffs are the same drawing. */
    float seed = floor(lit);
    vLit = fract(lit) * 1.0159;
    float a = seed * 0.0982;                         // 2 pi / 64
    float k = fract(seed * 0.381966);
    vLobeA = 0.5 * vec4(cos(a), sin(a), cos(a + 2.2 + k), sin(a + 2.2 + k));
    vLobeB = vec4(0.5 * cos(a + 4.1 - k), 0.5 * sin(a + 4.1 - k), 0.36 + 0.12 * k, 0.48 - 0.12 * k);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(-mv.z, 1e-6);
    /* A puff shrinks away inside 35 m of the lens, and is capped on screen (uCap, in this pass's own
       pixels): a ball a few metres from the camera would otherwise be the whole frame. */
    float px = min(size * smoothstep(0.003, 0.035, dist) * uScale / dist, uCap);
    gl_PointSize = px;
    vRad = 0.5 * px * dist / uScale;
    gl_Position = px < 0.7 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const PUFF_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uSun;        // toward the sun, view space
  uniform float uDay;       // 0 on the night side
  varying vec3 vTint;
  varying float vLit;
  varying float vRad;
  varying vec4 vLobeA;
  varying vec4 vLobeB;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    p.y = -p.y;
    /* A puff is a clump, not a ball: one body and three lobes round it, each a sphere. The pixel
       belongs to whichever stands highest, and is shaded by that one's normal — so every puff has
       creases of its own and a scalloped outline before it ever meets a neighbour. */
    vec2 c = vec2(0.0);
    float rr = 0.70, h2 = 0.49 - dot(p, p), q;
    vec2 d = p - vLobeA.xy; q = vLobeB.z * vLobeB.z - dot(d, d); if (q > h2) { h2 = q; c = vLobeA.xy; rr = vLobeB.z; }
    d = p - vLobeA.zw; q = vLobeB.w * vLobeB.w - dot(d, d); if (q > h2) { h2 = q; c = vLobeA.zw; rr = vLobeB.w; }
    d = p - vLobeB.xy; q = 0.1764 - dot(d, d); if (q > h2) { h2 = q; c = vLobeB.xy; rr = 0.42; }
    if (h2 < 0.0) discard;
    float z = sqrt(h2);
    float l = dot(vec3(p - c, z), uSun) / rr;
    /* three flat tones; the shadow leans blue, as the hull's does */
    vec3 shade = vTint * vec3(0.58, 0.62, 0.74);
    vec3 sunlit = l > 0.02 ? vTint : l > -0.42 ? vTint * vec3(0.82, 0.85, 0.92) : shade;
    vec3 self = vTint * (z > 0.45 ? 1.0 : 0.86);           // fire: flat, with a paler heart
    gl_FragColor = vec4(mix(mix(shade, sunlit, uDay), self, vLit), 1.0);
    #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
      gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2(max(1e-6, vFragDepth - z * vRad)) * logDepthBufFC * 0.5;
    #endif
  }`;

const LIGHT_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec3 vTint;
  varying float vLit;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float k = r2 < 0.22 ? 1.0 : r2 < 0.58 ? 0.5 : 0.2;     // a light is a bright heart and two rings
    gl_FragColor = vec4(vTint * k * vLit, 0.0);            // alpha 0 under ONE / ONE_MINUS_SRC_ALPHA: additive
  }`;

const uScale = { value: 600 };
const puffMat = new THREE.ShaderMaterial({
  uniforms: { uScale, uCap: { value: 150 * RES_SCALE }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uDay: { value: 1 } },
  vertexShader: VERT, fragmentShader: PUFF_FRAG,
  vertexColors: true, transparent: true, blending: THREE.NoBlending, depthWrite: true,
});
const lightMat = new THREE.ShaderMaterial({
  uniforms: { uScale, uCap: { value: 90 * RES_SCALE } },
  vertexShader: VERT, fragmentShader: LIGHT_FRAG,
  vertexColors: true, transparent: true, depthWrite: false,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
});

const puffs = new THREE.Points(puffGeo, puffMat), lights = new THREE.Points(lightGeo, lightMat);
for (const o of [puffs, lights]) { o.frustumCulled = false; o.castShadow = false; o.layers.set(LAYER_FX); }
puffs.renderOrder = 3; lights.renderOrder = 5;       // js/flame.js's punch goes between them, at 4

const _dbSize = new THREE.Vector2(), _up = new THREE.Vector3(), _moon = new THREE.Vector3();
/* World-space attenuation, so a parcel is its true diameter at any zoom, and the sun as this camera
   sees it. Recomputed on render: this module does not own the camera. */
puffs.onBeforeRender = (renderer, sc, cam) => {
  if (!cam.isPerspectiveCamera) return;
  renderer.getDrawingBufferSize(_dbSize);
  uScale.value = _dbSize.y * RES_SCALE / (2 * Math.tan(cam.fov * Math.PI / 360));
  puffMat.uniforms.uSun.value.copy(SUN_DIR).transformDirection(cam.matrixWorldInverse);
};

export function initExhaustDraw(scene) { scene.add(puffs); scene.add(lights); }
export function clearExhaustDraw() { puffGeo.setDrawRange(0, 0); lightGeo.setDrawRange(0, 0); }

/* Draw-call anchor for the Float32 mirror. At lunar distance (~384,000 km) one unit in the last place
   is ~31 m, a third of the screen at a 50 m hover camera, while three positions the ground with
   float64 matrices. The mirror is rebuilt every frame anyway, so it is stored RELATIVE to the vehicle
   and the Points nodes carry the offset. */
const anchor = new THREE.Vector3();

/* Refill the mirror from the live set. Colour is a hard lookup — on heat for fire, on age for the
   trail, on kind for everything else; nothing is interpolated. A parcel whose state went non-finite
   upstream is dropped and counted (plumeDebug.causeNaN) instead of uploaded: a NaN vertex colour
   renders as a black band no material toggle removes. */
export function fillExhaust() {
  if (nAlive === 0) { clearExhaustDraw(); return; }
  if (ship.live) anchor.copy(ship.pos); else moonPos(getSimTime(), anchor);
  puffs.position.copy(anchor); lights.position.copy(anchor);
  /* Daylight where the vehicle is: over whichever body is nearer, is the sun above its horizon? */
  moonPos(getSimTime(), _moon);
  if (anchor.distanceToSquared(_moon) < anchor.lengthSq()) _up.subVectors(anchor, _moon); else _up.copy(anchor);
  puffMat.uniforms.uDay.value = _up.lengthSq() > 0 ? THREE.MathUtils.smoothstep(_up.normalize().dot(SUN_DIR), -0.12, 0.08) : 1;

  let nP = 0, nL = 0, zs = 0;
  for (let k = 0; k < nAlive; k++) {
    const i = alive[k], i3 = i * 3;
    const x = pPos[i3], y = pPos[i3 + 1], z = pPos[i3 + 2];
    const R = pR[i];
    if (R === 0) zs++;
    let light = false, sz, lit = 0, c, o = 0;
    /* in over a tenth of a second, out over the last 40 % of the life — as size for a puff, as
       brightness for a light */
    let fade = Math.min(1, pAge[i] * 8 + 0.05) * Math.min(1, pLife[i] * pInv[i] * 2.5 + 0.05);
    if (pMode[i] === 2) {
      const kind = pSmoke[i];
      c = pColB; o = i3;
      if (kind === 0) { light = true; sz = R * 0.005; lit = 0.9 * fade; }
      else if (kind === SM_FLASH) {
        /* in 22 ms, out linearly, gone inside 0.3 s: the burst reads before any smoke exists */
        light = true; sz = R * 0.007; lit = Math.min(1, pAge[i] * 45) * Math.min(1, pLife[i] * 6);
      } else if (kind === SM_TRAIL) {
        /* born at four fifths of its size: at 600 m/s a puff that swells in from nothing leaves a gap
           a rocket-length long between the flame and its own smoke */
        sz = R * 0.0030 * Math.min(1, pAge[i] * 4 + 0.8) * Math.min(1, pLife[i] * pInv[i] * 2.5 + 0.05);
        if (pAge[i] < 0.16) { c = TRAIL_WARM; o = 0; lit = 0.5; }
        if (!pMoon[i]) sz *= 1 - THREE.MathUtils.smoothstep(Math.sqrt(x * x + y * y + z * z) - RE, 28, 50);   // thins out with the air, as below
      } else if (kind === SM_SPRAY) { sz = R * 0.0022 * fade; lit = 0.1; }
      else if (kind === SM_SEAM) sz = R * 0.0030 * fade * Math.min(1, Math.max(0, (pAge[i] - 0.10) * 10));
      else sz = R * 0.0030 * fade;                              // SM_SMOKE, SM_STEAM
    } else {
      const hot = !isSmoke(i), q = pHeat[i];
      if (pMoon[i]) {
        /* In vacuum the gas is faint and the dust is the event. Dust is lifted pale and stays paler
           than the ground it left; freshly deflected dust is briefly lit by the plume over it. */
        if (hot) { light = true; c = FIRE[0]; sz = R * 0.0025; lit = 0.35 * fade; }
        else { c = DUST; sz = R * 0.0026 * fade; lit = pAge[i] < 0.2 ? 0.7 : 0.1; }
      } else {
        const alt = Math.sqrt(x * x + y * y + z * z) - RE;
        /* Free-flying exhaust thins out with the air between 28 and 50 km: below, drag piles the
           parcels into a column; above, nothing stops them and the pool can only draw a scatter. */
        if (!pSmoke[i]) fade *= 1 - THREE.MathUtils.smoothstep(alt, 28, 50);
        if (pPal[i]) {                                          // hydrogen: pale light, then a wisp of vapour
          if (hot) { light = true; c = H2; sz = R * 0.0025; lit = 0.3 * fade; }
          else { c = VAPOUR; sz = R * 0.0026 * fade; }
        } else if (hot) {
          /* Fire is the drawn flame's job. The only parcels shown burning are the ones the trench has
             turned: the sheet of flame that comes out from under the pad. */
          if (!pSmoke[i]) continue;
          c = FIRE[q > 0.75 ? 0 : q > 0.5 ? 1 : 2]; sz = R * 0.0026 * fade; lit = 1;
        }
        /* The roll that hugs the ground is pale: against grass a dark puff reads as a scorch mark.
           Higher up the same smoke stands against the sky and goes back to soot. */
        else { c = alt < 0.05 ? FOOT : SOOT; sz = R * 0.0030 * fade; }
      }
    }
    const cr = c[o], cg = c[o + 1], cb = c[o + 2];
    if (!(x === x && y === y && z === z && sz === sz && cr === cr && cg === cg && cb === cb && lit === lit)) {
      plumeDebug.causeNaN++;
      continue;
    }
    const w = light ? NP - 1 - nL++ : nP++, w3 = w * 3;
    rPos[w3] = x - anchor.x; rPos[w3 + 1] = y - anchor.y; rPos[w3 + 2] = z - anchor.z;
    rCol[w3] = cr; rCol[w3 + 1] = cg; rCol[w3 + 2] = cb;
    rSiz[w] = sz; rLit[w] = (i & 63) + lit * 0.984;      // seed in the integer part, see the vertex shader
  }
  for (const k in attrs) attrs[k].needsUpdate = true;
  puffGeo.setDrawRange(0, nP); lightGeo.setDrawRange(NP - nL, nL);
  plumeDebug.zeroSize = zs;
}
