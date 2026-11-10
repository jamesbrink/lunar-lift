import * as THREE from 'three';
import { RE } from './constants.js';
import { getSimTime } from './physics.js';
import { moonPos } from './constants.js';
import { SUN_DIR } from './world.js';
import { frameDir } from './origin.js';
const _sunF = new THREE.Vector3();
import { LAYER_FX, RES_SCALE } from './halfres.js';
import { NP, pPos, pVel, pR, pLife, pAge, pInv, pHeat, pMode, pSmoke, pMoon, pPal, pColB, alive, nAlive, ship, moonV, plumeDebug, isSmoke,
  SM_SEAM, SM_SPRAY, SM_FLASH, SM_TRAIL, SM_STEAM } from './exhaust-pool.js';

/* The parcels on screen: drawn shapes, not blurred sprites. Three draw calls, three kinds of thing.

   PUFFS — smoke, steam, the fire the trench turns. Each is a hard-edged clump of four spheres shaded
   in three flat tones by the sun's direction, written OPAQUE and WITH DEPTH — and the depth it writes
   is the clump's own, bulging toward the eye. Two things follow, and they are the whole look:
   - neighbouring puffs cut into one another along the arcs two balls really meet on, so a few hundred
     of them read as one cauliflower cloud with a scalloped silhouette, where the same parcels as soft
     alpha sprites composited into beige fog with no shape;
   - order does not matter. Nothing is blended, so there is no back-to-front sort to get wrong and no
     overlap that deepens the tone. A puff ends by shrinking, never by fading.
   A burning engine paints the puffs round it: the side of a puff that faces the fire takes the fire's
   colour, in steps that fall off with distance from the exit plane, at full strength at night. There
   is no light in the scene for it; it is two uniforms and a dot product.

   DUST — what an engine lifts off the Moon. There is no air there, so nothing billows: a parcel is a
   flat lens lying in the ground plane, stretched along the line from the point under the engine, in
   the regolith's own grey a step lighter. A few hundred of them are the radial sheet Apollo filmed.

   SHARDS — sparks, burning fragments, and the staging flash: a spiked star drawn as three flat
   drawings one after another. Opaque, hard-edged, in the main pass at full resolution over the smoke
   layer. Nothing in this file is additive or soft any more; the discs with a bright heart and two
   rings that used to stand in for light stacked into glowing balls bigger than the vehicle.

   Puffs and dust live in the half-resolution pass (js/halfres.js), so a pixel there is two screen
   pixels and the point sizes carry RES_SCALE. The drawn flame (js/flame.js) punches its outline out
   of that layer. */

const hex = (h) => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];
/* Tones are written to the target as authored and reach the canvas unconverted (neither this
   ShaderMaterial nor the composite quad encodes), so the bytes below are the bytes on screen. */
const FIRE = [hex(0xfff3b8), hex(0xffb42c), hex(0xee5f1c)];   // heat > 0.75, > 0.5, > 0.22
const SOOT = hex(0x9c9488);        // kerosene smoke against the sky: warm grey, its shadow band darker than the pad sky
const FOOT = hex(0xe9e5dc);        // the same smoke rolling along the ground, seen against grass
const VAPOUR = hex(0xf4f6fa);      // what a hydrogen engine leaves in air: water
/* Lunar dust is grey, and one step lighter than the brightest ground it can lie on: the painted
   regolith's top class is (172, 174, 182) in js/palette.js, and there is no air out there to separate
   a sheet from the surface, so the tone has to. Sampled off a frame at a mid-sun site the ground ran
   #4d4c51 to #717077 and the dust on it #b9b9bc. It was a cream (0xf5eedd) drawn as shaded balls. */
const DUST = hex(0xb9b9bc);
/* The ascent trail is lit by the fire that made it for its first moments, then is smoke. A hard step. */
const TRAIL_WARM = hex(0xf0c489);

/* Dense render mirror, rebuilt every frame from the live list. Puffs fill it from the front and
   shards from the back, and the two draw calls take their own ends; the slot arrays themselves are
   never bound, because swap-remove leaves holes in them. Dust has a mirror of its own. */
const rPos = new Float32Array(NP * 3);
const rCol = new Float32Array(NP * 3);
const rSiz = new Float32Array(NP);        // drawn diameter, km
const rLit = new Float32Array(NP);        // seed + (puffs: 0 sun-shaded … 1 self-lit and flat; shards: phase of life)
const dPos = new Float32Array(NP * 3), dCol = new Float32Array(NP * 3), dSiz = new Float32Array(NP), dLit = new Float32Array(NP);
function geometry(pos, col, siz, lit) {
  const g = new THREE.BufferGeometry();
  const a = { position: new THREE.BufferAttribute(pos, 3), color: new THREE.BufferAttribute(col, 3),
    size: new THREE.BufferAttribute(siz, 1), lit: new THREE.BufferAttribute(lit, 1) };
  for (const k in a) { a[k].setUsage(THREE.DynamicDrawUsage); g.setAttribute(k, a[k]); }
  g.setDrawRange(0, 0);
  return g;
}
const puffGeo = geometry(rPos, rCol, rSiz, rLit), shardGeo = new THREE.BufferGeometry(), dustGeo = geometry(dPos, dCol, dSiz, dLit);
for (const k in puffGeo.attributes) shardGeo.setAttribute(k, puffGeo.attributes[k]);     // the same buffers, the other end
shardGeo.setDrawRange(0, 0);

const VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float size;
  attribute float lit;
  uniform float uScale, uCap;
  uniform vec3 uFlame;      // the fire, in this draw call's own coordinates (km from the vehicle)
  uniform float uFlameK, uFlameR;
  varying vec3 vTint;
  varying float vLit;
  varying float vRad;
  varying vec4 vLobeA;      // two lobe centres, xy and zw
  varying vec4 vLobeB;      // a third centre, then two lobe radii
  varying vec4 vFire;       // xyz: toward the fire, view space. w: how strongly it lights this puff, in steps
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
    /* Firelight: full within a fifth of its range of the exit plane, then three steps down to
       nothing. The step is per puff, so the falloff is a set of flat tones, not a gradient. */
    vec3 toFire = uFlame - position;
    float fl = uFlameK * clamp(1.25 - 1.25 * length(toFire) / uFlameR, 0.0, 1.0);
    vFire = vec4(normalize(mat3(modelViewMatrix) * toFire + vec3(0.0, 0.0, 1e-9)), floor(fl * 3.0 + 0.5) / 3.0);
    /* A puff shrinks away inside 35 m of the lens, and is capped on screen (uCap, in this pass's own
       pixels): a ball a few metres from the camera would otherwise be the whole frame. */
    float px = min(size * smoothstep(0.003, 0.035, dist) * uScale / dist, uCap);
    /* A far puff holds 2.4 of this pass's pixels until it is a third of a pixel across: a smoke
       column seen from kilometres away stays a line instead of breaking into the dots that
       survive the cut. */
    float thin = px < 0.35 ? 0.0 : 1.0;
    px = max(px, min(2.4, px * 3.0));
    gl_PointSize = px;
    vRad = 0.5 * px * dist / uScale;
    gl_Position = thin < 0.5 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const PUFF_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uSun;        // toward the sun, view space
  uniform float uDay;       // 0 on the night side
  uniform vec3 uFlameCol;
  varying vec3 vTint;
  varying float vLit;
  varying float vRad;
  varying vec4 vLobeA;
  varying vec4 vLobeB;
  varying vec4 vFire;
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
    vec3 n = vec3(p - c, z) / rr;
    float l = dot(n, uSun);
    /* three flat tones; the shadow leans blue, as the hull's does. At night there is no sun to
       shape it, so the sky does: the top of a puff is one step lighter than its underside. */
    vec3 shade = vTint * vec3(0.58, 0.62, 0.74);
    vec3 sunlit = l > 0.02 ? vTint : l > -0.42 ? vTint * vec3(0.82, 0.85, 0.92) : shade;
    vec3 night = n.y > 0.1 ? shade : shade * 0.8;
    vec3 col = mix(night, sunlit, uDay);
    /* the fire's side: two flat steps of its colour on the puff's own, never darker than the day */
    float lf = dot(n, vFire.xyz);
    vec3 warm = min(vTint * uFlameCol * 1.3, vec3(1.0));
    float w = vFire.w * (lf > 0.35 ? 1.0 : lf > -0.25 ? 0.55 : 0.0);
    col = mix(col, mix(warm, max(col, warm), uDay), w);
    vec3 self = vTint * (z > 0.45 ? 1.0 : 0.86);           // fire: flat, with a paler heart
    gl_FragColor = vec4(mix(col, self, vLit), 1.0);
    #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
      gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2(max(1e-6, vFragDepth - z * vRad)) * logDepthBufFC * 0.5;
    #endif
  }`;

/* Dust: a flat ellipsoid in the ground plane, its long axis on the line from the hub (the ground
   under the engine). The vertex stage projects its three half-axes to the screen and hands the
   fragment the ellipse they outline; the fragment discards outside it and writes two flat tones. */
const DUST_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float size;     // length along the throw, km
  attribute float lit;      // seed
  uniform float uScale, uCap;
  uniform vec3 uHub, uUp;
  varying vec3 vTint;
  varying vec3 vQ;          // the outline, as the inverse of its shape matrix in point coordinates
  varying float vLift, vSeed;
  void main() {
    vTint = color; vSeed = floor(lit);
    vec3 r = position - uHub; r -= uUp * dot(r, uUp);
    float rl = length(r);
    vec3 along = rl > 1e-7 ? r / rl : normalize(cross(uUp, vec3(0.3, 0.5, 0.8)));
    vec3 across = cross(uUp, along);
    float a = 0.5 * size, b = a * (0.15 + 0.012 * mod(vSeed, 9.0));
    mat3 m = mat3(modelViewMatrix);
    vec3 A = m * along * a, B = m * across * b, C = m * uUp * (0.4 * b);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(-mv.z, 1e-6), k = uScale / dist;
    vec2 a2 = A.xy * k, b2 = B.xy * k, c2 = C.xy * k;
    float qxx = a2.x * a2.x + b2.x * b2.x + c2.x * c2.x, qyy = a2.y * a2.y + b2.y * b2.y + c2.y * c2.y;
    float qxy = a2.x * a2.y + b2.x * b2.y + c2.x * c2.y;
    float hs = max(sqrt(max(qxx, qyy)), 1e-4), px = min(2.0 * hs, uCap);
    float det = max(qxx * qyy - qxy * qxy, 1e-12);
    vQ = vec3(qyy, -qxy, qxx) * (hs * hs / det);
    /* A sprite has one depth. Pulled toward the eye by the lens's own reach, or the ground in front
       of its centre would cut its near half away. */
    vLift = (abs(A.z) + abs(B.z)) * px / (2.0 * hs) + 0.0015;
    gl_PointSize = px;
    gl_Position = px < 0.9 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;
const DUST_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uDay;
  varying vec3 vTint;
  varying vec3 vQ;
  varying float vLift, vSeed;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    p.y = -p.y;
    float e = vQ.x * p.x * p.x + 2.0 * vQ.y * p.x * p.y + vQ.z * p.y * p.y;
    if (e > 1.0) discard;
    float tone = mod(vSeed, 3.0) < 1.0 ? 0.88 : 1.0;      // one flat tone a lens, one in three a step darker
    gl_FragColor = vec4(vTint * tone * mix(0.4, 1.0, uDay), 1.0);
    #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
      gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2(max(1e-6, vFragDepth - vLift)) * logDepthBufFC * 0.5;
    #endif
  }`;

/* Shards. lit = seed (0..63, +64 for a star) + phase of life (0 born … 1 gone).
   A spark is a sliver: a thin diamond turned by its seed, pale heart, coloured edge.
   The star is the staging flash, and it is three drawings: a white eight-pointed star with a yellow
   rim; the same star grown and turned half a point, yellow with an orange rim and a small white
   heart; then only the orange points, hollow, as it lets go. Each stands for a third of its life. */
const SHARD_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float size;
  attribute float lit;
  uniform float uScale, uCap;
  varying vec3 vTint;
  varying float vPhase, vStar, vSeed;
  void main() {
    vTint = color;
    float s = floor(lit);
    vStar = step(63.5, s); vSeed = mod(s, 64.0); vPhase = fract(lit) * 1.0159;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(-mv.z, 1e-6);
    float px = min(size * uScale / dist, uCap);
    gl_PointSize = px;
    /* A flash stands at a seam, on the axis, inside the hull: drawn at its own depth only the tips
       of its points show round the stack. It is brought toward the eye by its own radius, so it is
       in front of whatever it surrounds. */
    if (vStar > 0.5) mv.xyz *= max(0.25, (dist - 0.5 * size) / dist);
    gl_Position = px < 1.5 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;
const SHARD_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec3 vTint;
  varying float vPhase, vStar, vSeed;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    vec3 col;
    if (vStar > 0.5) {
      float f = min(floor(vPhase * 3.0), 2.0);
      float ang = atan(p.y, p.x) + vSeed * 0.31 + f * 0.3927;            // half a point per drawing
      float tri = abs(fract(ang * 1.27324) - 0.5) * 2.0;                 // 8 points: 0 between, 1 on a point
      float reach = f < 0.5 ? 0.70 : f < 1.5 ? 1.0 : 0.92;
      float edge = reach * mix(0.34, 1.0, pow(tri, 1.6));
      float r = length(p);
      if (r > edge) discard;
      float k = r / edge;
      if (f < 0.5) col = k < 0.72 ? vec3(1.0, 1.0, 0.96) : vec3(1.0, 0.88, 0.40);
      else if (f < 1.5) col = r < 0.24 ? vec3(1.0, 1.0, 0.96) : k < 0.70 ? vec3(1.0, 0.88, 0.40) : vec3(1.0, 0.58, 0.18);
      else { if (r < 0.50) discard; col = vec3(1.0, 0.58, 0.18); }
    } else {
      float a = vSeed * 0.0982;
      vec2 q = vec2(cos(a) * p.x + sin(a) * p.y, cos(a) * p.y - sin(a) * p.x);
      float m = abs(q.x) + 2.6 * abs(q.y);
      if (m > 1.0) discard;
      col = m < 0.45 ? mix(vTint, vec3(1.0), 0.75) : vTint;
    }
    gl_FragColor = vec4(col, 1.0);
  }`;

const uScale = { value: 600 }, uScaleFull = { value: 1200 }, uDay = { value: 1 };
const fire = { uFlame: { value: new THREE.Vector3() }, uFlameK: { value: 0 }, uFlameR: { value: 0.2 }, uFlameCol: { value: new THREE.Vector3(1, 0.6, 0.24) } };
const puffMat = new THREE.ShaderMaterial({
  uniforms: { uScale, uCap: { value: 150 * RES_SCALE }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uDay, ...fire },
  vertexShader: VERT, fragmentShader: PUFF_FRAG,
  vertexColors: true, transparent: true, blending: THREE.NoBlending, depthWrite: true,
});
const dustMat = new THREE.ShaderMaterial({
  uniforms: { uScale, uCap: { value: 120 * RES_SCALE }, uDay, uHub: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3(0, 1, 0) } },
  vertexShader: DUST_VERT, fragmentShader: DUST_FRAG,
  vertexColors: true, transparent: true, blending: THREE.NoBlending, depthWrite: true,
});
const shardMat = new THREE.ShaderMaterial({
  uniforms: { uScale: uScaleFull, uCap: { value: 420 } },
  vertexShader: SHARD_VERT, fragmentShader: SHARD_FRAG,
  vertexColors: true, transparent: true, blending: THREE.NoBlending, depthWrite: false,
});

const puffs = new THREE.Points(puffGeo, puffMat), dust = new THREE.Points(dustGeo, dustMat), shards = new THREE.Points(shardGeo, shardMat);
for (const o of [puffs, dust, shards]) { o.frustumCulled = false; o.castShadow = false; }
puffs.layers.set(LAYER_FX); dust.layers.set(LAYER_FX);
puffs.renderOrder = 3; dust.renderOrder = 3;         // js/flame.js's punch follows them, at 4
shards.renderOrder = 6;                              // main pass, over the half-resolution composite (2)

/* The smoke's shadow. Points do cast into three's shadow map, but only objects on the main camera's
   layer are considered and the puffs live on the half-resolution FX layer — so a second Points on
   layer 0 shares the puff geometry and exists only for the light: its own material throws every
   vertex off screen, and its customDepthMaterial draws each puff as a disc into the sun's map at
   its true size (the shadow camera is orthographic: projectionMatrix[0][0] is NDC per km). Self-lit
   puffs cast nothing. Cost: one extra draw of the live puffs in the shadow pass. */
const casterMat = new THREE.ShaderMaterial({
  vertexShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      gl_FragColor = vec4(0.0);
    }`,
  colorWrite: false, depthWrite: false, depthTest: false,
});
const shadowMat = new THREE.ShaderMaterial({
  uniforms: { uMap: { value: 4096 } },
  vertexShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_vertex>
    attribute float size;
    attribute float lit;
    uniform float uMap;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      /* 0.8 of the drawn diameter: the lobes do not fill their square. Self-lit parcels (fire)
         cast nothing. */
      float px = size * 0.8 * projectionMatrix[0][0] * 0.5 * uMap;
      gl_PointSize = fract(lit) > 0.5 ? 0.0 : clamp(px, 0.0, 256.0);
      if (gl_PointSize < 0.75) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_fragment>
    void main() {
      vec2 d = gl_PointCoord - 0.5;
      if (dot(d, d) > 0.25) discard;
      #include <logdepthbuf_fragment>
      gl_FragColor = vec4(1.0);     // three 0.187 reads the shadow map's depth attachment; colour is unused
    }`,
});
const casters = new THREE.Points(puffGeo, casterMat);
casters.frustumCulled = false; casters.castShadow = true; casters.customDepthMaterial = shadowMat; casters.renderOrder = -1;

const _dbSize = new THREE.Vector2(), _up = new THREE.Vector3(), _moon = new THREE.Vector3();
/* World-space attenuation, so a parcel is its true diameter at any zoom, and the sun as this camera
   sees it. Recomputed on render: this module does not own the camera. */
puffs.onBeforeRender = (renderer, sc, cam) => {
  if (!cam.isPerspectiveCamera) return;
  renderer.getDrawingBufferSize(_dbSize);
  uScale.value = _dbSize.y * RES_SCALE / (2 * Math.tan(cam.fov * Math.PI / 360));
  puffMat.uniforms.uSun.value.copy(frameDir(_sunF.copy(SUN_DIR))).transformDirection(cam.matrixWorldInverse);
};
dust.onBeforeRender = puffs.onBeforeRender;
shards.onBeforeRender = (renderer, sc, cam) => {
  if (!cam.isPerspectiveCamera) return;
  renderer.getDrawingBufferSize(_dbSize);
  uScaleFull.value = _dbSize.y / (2 * Math.tan(cam.fov * Math.PI / 360));
  shardMat.uniforms.uCap.value = Math.min(420, _dbSize.y * 0.45);
};

export function initExhaustDraw(scene) { scene.add(puffs); scene.add(dust); scene.add(shards); scene.add(casters); }
export function clearExhaustDraw() { puffGeo.setDrawRange(0, 0); shardGeo.setDrawRange(0, 0); dustGeo.setDrawRange(0, 0); }

/* The fire that lights the smoke this frame: where it is (km, world), its colour as a hex, and how
   hard it burns (0 off … 1 full throttle). js/vehicle.js calls it every frame it poses the vehicle. */
const firePos = new THREE.Vector3();
let fireOn = 0;
export function setFireLight(pos, hexColour, strength) {
  fireOn = strength;
  if (!(strength > 0)) return;
  firePos.copy(pos);
  const c = hex(hexColour); fire.uFlameCol.value.set(c[0], c[1], c[2]);
}

/* Draw-call anchor for the Float32 mirror. At lunar distance (~384,000 km) one unit in the last place
   is ~31 m, a third of the screen at a 50 m hover camera, while three positions the ground with
   float64 matrices. The mirror is rebuilt every frame anyway, so it is stored RELATIVE to the vehicle
   and the Points nodes carry the offset. */
const anchor = new THREE.Vector3();

/* Refill the mirrors from the live set. Colour is a hard lookup — on heat for fire, on age for the
   trail, on kind for everything else; nothing is interpolated. A parcel whose state went non-finite
   upstream is dropped and counted (plumeDebug.causeNaN) instead of uploaded: a NaN vertex colour
   renders as a black band no material toggle removes. */
export function fillExhaust() {
  if (nAlive === 0) { clearExhaustDraw(); return; }
  if (ship.live) anchor.copy(ship.pos); else moonPos(getSimTime(), anchor);
  puffs.position.copy(anchor); shards.position.copy(anchor); dust.position.copy(anchor);
  /* Daylight where the vehicle is: over whichever body is nearer, is the sun above its horizon? */
  moonPos(getSimTime(), _moon);
  const byMoon = anchor.distanceToSquared(_moon) < anchor.lengthSq();
  if (byMoon) _up.subVectors(anchor, _moon); else _up.copy(anchor);
  const day = _up.lengthSq() > 0 ? THREE.MathUtils.smoothstep(_up.normalize().dot(SUN_DIR), -0.12, 0.08) : 1;
  uDay.value = day;
  /* Firelight reaches 260 m at night and is a third as strong, over half the distance, by day. */
  fire.uFlame.value.subVectors(firePos, anchor);
  fire.uFlameK.value = fireOn * (1 - 0.62 * day);
  fire.uFlameR.value = 0.26 - 0.12 * day;
  /* The dust's hub: the ground under the engine — straight down the local vertical from the ship. */
  if (byMoon) {
    dustMat.uniforms.uUp.value.copy(_up);
    dustMat.uniforms.uHub.value.copy(_up).multiplyScalar(-(ship.live ? ship.pos.distanceTo(_moon) : 0));
    if (!ship.live) dustMat.uniforms.uHub.value.set(0, 0, 0);
  }

  let nP = 0, nL = 0, nD = 0, zs = 0;
  for (let k = 0; k < nAlive; k++) {
    const i = alive[k], i3 = i * 3;
    const x = pPos[i3], y = pPos[i3 + 1], z = pPos[i3 + 2];
    const R = pR[i];
    if (R === 0) zs++;
    let shard = false, flat = false, sz, lit = 0, c, o = 0, seed = i & 63;
    /* in over a tenth of a second, out over the last 40 % of the life — always as size */
    let fade = Math.min(1, pAge[i] * 8 + 0.05) * Math.min(1, pLife[i] * pInv[i] * 2.5 + 0.05);
    if (pMode[i] === 2) {
      const kind = pSmoke[i];
      c = pColB; o = i3;
      if (kind === 0) {
        /* A spark is a sliver a few metres long whatever radius it was spawned with: js/physics.js
           hands its staging burst 10-18 m, which as discs was a ball of light bigger than the stage. */
        shard = true; sz = Math.min(R, 3.2) * 0.0026 * Math.min(1, pLife[i] * pInv[i] * 2 + 0.1);
        lit = Math.min(0.98, pAge[i] * pInv[i]);
      } else if (kind === SM_FLASH) {
        shard = true; seed += 64; sz = R * 0.001; lit = Math.min(0.98, pAge[i] * pInv[i]);     // R is the star's span in metres
      } else if (kind === SM_TRAIL) {
        /* born at four fifths of its size: at 600 m/s a puff that swells in from nothing leaves a gap
           a rocket-length long between the flame and its own smoke */
        sz = R * 0.0030 * Math.min(1, pAge[i] * 4 + 0.8) * Math.min(1, pLife[i] * pInv[i] * 2.5 + 0.05);
        if (pAge[i] < 0.16) { c = TRAIL_WARM; o = 0; lit = 0.5; }
      } else if (kind === SM_SPRAY) {
        if (pMoon[i]) flat = true;
        sz = R * (flat ? 0.0016 : 0.0022) * fade; lit = 0.1;
      }
      else if (kind === SM_SEAM) sz = R * 0.0030 * fade * Math.min(1, Math.max(0, (pAge[i] - 0.10) * 10));
      else sz = R * 0.0030 * fade;                              // SM_SMOKE, SM_STEAM
    } else {
      const hot = !isSmoke(i), q = pHeat[i];
      if (pMoon[i]) {
        /* In vacuum the gas is invisible and the dust is the event: a parcel is drawn only once the
           ground has turned it, and then as dust. The flame mesh is the fire. */
        if (hot || !pSmoke[i]) continue;
        flat = true; sz = R * 0.0016 * fade;
      } else {
        const alt = Math.sqrt(x * x + y * y + z * z) - RE;
        /* Free-flying exhaust thins out with the air between 28 and 50 km: below, drag piles the
           parcels into a column; above, nothing stops them and the pool can only draw a scatter. */
        if (!pSmoke[i]) fade *= 1 - THREE.MathUtils.smoothstep(alt, 28, 50);
        if (pPal[i]) {                                          // hydrogen: no fire of its own, then a wisp of vapour
          if (hot) continue;
          c = VAPOUR; sz = R * 0.0026 * fade;
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
    if (flat) {
      /* A dust lens is as long as the parcel is wide plus what it travels in an eighth of a second:
         the fast ones are streaks pointing back at the engine. */
      const vx = pVel[i3] - moonV.x, vy = pVel[i3 + 1] - moonV.y, vz = pVel[i3 + 2] - moonV.z;
      sz += Math.min(0.014, Math.sqrt(vx * vx + vy * vy + vz * vz) * 0.16) * fade;
      c = DUST; o = 0;
    }
    const cr = c[o], cg = c[o + 1], cb = c[o + 2];
    if (!(x === x && y === y && z === z && sz === sz && cr === cr && cg === cg && cb === cb && lit === lit)) {
      plumeDebug.causeNaN++;
      continue;
    }
    if (flat) {
      const w3 = nD * 3;
      dPos[w3] = x - anchor.x; dPos[w3 + 1] = y - anchor.y; dPos[w3 + 2] = z - anchor.z;
      dCol[w3] = cr; dCol[w3 + 1] = cg; dCol[w3 + 2] = cb;
      dSiz[nD] = sz; dLit[nD++] = seed;
      continue;
    }
    const w = shard ? NP - 1 - nL++ : nP++, w3 = w * 3;
    rPos[w3] = x - anchor.x; rPos[w3 + 1] = y - anchor.y; rPos[w3 + 2] = z - anchor.z;
    rCol[w3] = cr; rCol[w3 + 1] = cg; rCol[w3 + 2] = cb;
    rSiz[w] = sz; rLit[w] = seed + lit * 0.984;          // seed in the integer part, see the vertex shaders
  }
  for (const k in puffGeo.attributes) puffGeo.attributes[k].needsUpdate = true;
  if (nD) for (const k in dustGeo.attributes) dustGeo.attributes[k].needsUpdate = true;
  puffGeo.setDrawRange(0, nP); shardGeo.setDrawRange(NP - nL, nL); dustGeo.setDrawRange(0, nD);
  plumeDebug.zeroSize = zs;
}
