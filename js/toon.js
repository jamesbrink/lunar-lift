import * as THREE from 'three';

/* Cel shading, in one small module.

   The game used to be lit like a product shot: MeshStandardMaterial with metalness 0.3-0.85 and no
   environment map, which is the textbook way to render a rocket as a black silhouette (a metal with
   nothing to reflect reflects nothing), under ACES filmic tone mapping, which then desaturated the
   planet into mud. This is the replacement: quantised lighting in three bands, flat colours with a
   coloured shadow side, hard-edged shadow maps, and inverted-hull outlines so the vehicle reads
   against the Earth instead of dissolving into it.

   Everything here is Three.js core — MeshToonMaterial, DataTexture, and one tiny ShaderMaterial. No
   post-processing pass: the depth buffer is logarithmic (near 0.001 km to far 3,000,000 km in one
   scene), which makes depth-reconstruction effects like sobel-edge-detect unreliable, and an
   inverted hull costs one extra draw per outlined mesh and works at any scale. Because the renderer
   has logarithmicDepthBuffer, the outline shaders below MUST include the logdepthbuf chunks, or the
   outline is written at the wrong depth and disappears behind the planet. */

/* Four texels, top two equal. Three.js samples the ramp at `dotNL · 0.5 + 0.5` (gradientmap_pars_
   fragment), so an N-texel nearest ramp steps at dotNL = 2k/N − 1 — NOT at k/N. Four texels therefore
   step at −0.5, 0 and +0.5: the whole sunward hemisphere is one bright band and every step sits out by
   the terminator, where shading is supposed to change. The old three-texel ramp stepped at ±1/3, which
   is also above flat ground's dotNL = sin(38.7°) = 0.625 at MET 0, so neither ramp is what made the
   field around the pad read as a fan of wedges — that was `padAuthored` thresholding a 2.2 km lattice,
   now fixed in js/toonmap.js. Recorded here because the arithmetic was checked in the wrong scale once
   and a wrong comment outlives every wrong fix. The two lower bands stay well off black: a coloured
   shadow side is most of what makes cel shading read as cel shading. */
export const RAMP_EARTH = ramp([0.34, 0.72, 1.0, 1.0]);
/* Eight texels, steps at dotNL = 2k/8 − 1 = −0.75, −0.5, −0.25, 0, +0.25, +0.5. The old six-texel
   ramp ([0.16 .26 .34 .62 1 1], steps at ±1/3 and ±2/3) put flat ground under the 28° skim-frame
   sun at dotNL = sin 28° = 0.469 INSIDE the top 1.0 band: a wall had to tilt 22° off flat to cross
   a step, and 3 km bowls with 300 m rims tilt ~11°, so every crater sat in one band and the whole
   foreground read as smooth smoke (review 5, frame 12 "featureless smooth gradient"). The eighth-
   texel ramp steps every 0.25 dotNL ≈ 14° of tilt: sunward rims reach the 1.0 band, lee walls drop
   to 0.62, and bowls shade in silhouette. The terminator behaviour the six-texel ramp was built
   for survives untouched — dotNL = 0 is still exactly a step, with the 0.62 dusk strip on the lit
   side and 0.34 pre-dusk on the dark. Two top texels equal keeps the noon look identical. */
export const RAMP_MOON = ramp([0.16, 0.26, 0.34, 0.62, 0.86, 1.0, 1.0, 1.0]);
export const RAMP_HARD = ramp([0.30, 0.72, 1.0]);     // vehicle: keep the lit side bright
export const OUTLINE = 0x0d1117;
export const OUTLINE_W = 0.0038;                       // fraction of half-screen width, so ~px-constant

export function ramp(stops) {
  const data = new Uint8Array(stops.length * 4);
  stops.forEach((v, i) => {
    const c = Math.round(THREE.MathUtils.clamp(v, 0, 1) * 255);
    data[i * 4] = c; data[i * 4 + 1] = c; data[i * 4 + 2] = c; data[i * 4 + 3] = 255;
  });
  const t = new THREE.DataTexture(data, stops.length, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;      // Nearest is what makes the bands hard
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/* The vehicle's palette. Values are the colours a cartoon of this rocket would use: warm white hull,
   near-black interstages, one saturated accent, and a grey engine that is grey rather than chrome. */
export const PALETTE = {
  hull: 0xf1f4f8, dark: 0x232932, accent: 0xe0532c, engine: 0x767d87,
  silver: 0xcdd5de,
  padConcrete: 0x9aa1ab, padSteel: 0xc3cbd4, blast: 0x2b2f36, lutRed: 0xc2452f, padDeck: 0x7f8894,
  hardstand: 0xb4b9bf, gravel: 0xbfae8c, asphalt: 0x4a4f57,
};

export function toon(opts = {}) {
  const m = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP_HARD, ...opts });
  return m;
}

const OUT_VERT = /* glsl */`
  uniform float w;
  /* <common> is not optional here: logdepthbuf_vertex calls isPerspectiveMatrix, which three
     defines only in common — and a raw ShaderMaterial gets no built-in prefix that pulls it in.
     Without this line the whole program fails to compile and EVERY outline vanishes silently. */
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    /* Push along the view-space normal scaled by depth: the offset in clip space is then
       independent of distance, so the outline is a constant few pixels whether the camera is 60 m
       off the pad or 20 000 km out for the system view. */
    mv.xy += n.xy * w * max(-mv.z, 1e-5);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const OUT_FRAG = /* glsl */`
  uniform vec3 col;
  #include <logdepthbuf_pars_fragment>
  void main() {
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(col, 1.0);
  }`;

let outlineMat = null;
export function outlineMaterial() {
  if (!outlineMat) outlineMat = new THREE.ShaderMaterial({
    uniforms: { w: { value: OUTLINE_W }, col: { value: new THREE.Color(OUTLINE) } },
    vertexShader: OUT_VERT, fragmentShader: OUT_FRAG,
    side: THREE.BackSide, transparent: false, depthWrite: true,
  });
  return outlineMat;
}

/* Inverted-hull outline for one mesh: same geometry, back faces only, pushed outward. Attach the
   result as a CHILD of the mesh so it follows every transform, including a stage tumbling away
   after separation. */
export function outline(mesh, scale = 1) {
  const o = new THREE.Mesh(mesh.geometry, outlineMaterial());
  o.scale.setScalar(scale);
  o.castShadow = false; o.receiveShadow = false;
  o.frustumCulled = mesh.frustumCulled;
  o.renderOrder = mesh.renderOrder;
  mesh.add(o);
  return o;
}

/* The drawn flame: a teardrop that leaves the bell at the bell's own width, swells a little and
   tapers to a point. Its predecessor was a cone with its apex at the throat, widening aft to an
   open mouth — a megaphone, and one per stage however many engines the stage had. Unit size: radius
   1 at the root, length 1 along +y; the caller scales it per engine. Two tones, a saturated outer
   and a pale core parented inside so scaling one scales both. */
function flameGeo(seg) {
  const prof = [[0.86, 0], [1.0, 0.07], [1.05, 0.18], [0.97, 0.36], [0.76, 0.58], [0.46, 0.79], [0.18, 0.93], [0, 1]];
  return new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg);
}

export function flameMeshes(parent, outerColour, coreColour) {
  const mat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const outer = new THREE.Mesh(flameGeo(20), mat(outerColour, 0.55));
  const core = new THREE.Mesh(flameGeo(14), mat(coreColour, 0.9));
  core.scale.set(0.55, 0.62, 0.55);
  outer.add(core);
  outer.castShadow = core.castShadow = false;
  parent.add(outer);
  return { outer, core };
}
