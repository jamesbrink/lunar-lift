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
   foreground read as smooth smoke ("featureless smooth gradient"). The eighth-
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
  /* The pad's greys are authored for hardware drawn at its palette (HARD_GAIN in js/world.js): the
     hardstand is mid-grey so the white stack and the white tanks are the brightest things on it. */
  padConcrete: 0x858b93, padSteel: 0xb3bbc5, blast: 0x2b2f36, lutRed: 0xc2452f, padDeck: 0x6c747f,
  hardstand: 0x8d9094, gravel: 0xa8976f, asphalt: 0x4a4f57,
};

export function toon(opts = {}) {
  const m = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: RAMP_HARD, ...opts });
  return m;
}

/* ---- cel light: three's own lighting chunks, patched once, before any material compiles ----

   Every lit surface in the game is a MeshToonMaterial, so the cel rules live in the chunks they all
   include rather than in a dozen onBeforeCompile hooks (js/surface.js, js/clouds.js and js/haze.js
   splice the ground materials already, and three keys its program cache on that function's text).

   1. A cast shadow is a SHAPE: two tones and an edge. Three's PCF is five taps on a disc turned by
      per-pixel noise — a soft smear, against hardware drawn in ink. Here the map is read four times
      on a fixed half-texel square (hardware-bilinear compares, so a 3x3 tent) and the result is CUT
      at one half, with a screen-pixel of smoothstep for antialiasing. The contour of a bilinear
      field is a smooth line through the texel staircase.
   2. A cast shadow has the tone of the shaded side of the thing it falls on. It used to remove the
      sun entirely and leave the blue fill alone — navy blots, three times darker than the form
      shadow next to them. Now it caps the ramp at CEL_FLOOR, the ramp's own shadow band: min(ramp,
      shade), so a surface already turned from the sun is not darkened twice.
   3. Hardware (CEL_HARDWARE: the vehicle, the pad — see hardware() below) knows whether the sun
      reaches it. The sun light has no planet in its shadow box, so at midnight the stack stood
      day-bright on a navy field. celSun.x scales the sun, .y the fill, .z the emissive floor.
   4. ...and has a floodlight rig: one more hard-stepped direction (no shadow map, no second light
      for the planet to pick up), and a flat two-ring pool on upward faces round the pad. */
export const CEL_FLOOR = 0.32;
{
  const C = THREE.ShaderChunk;
  const patch = (name, from, to) => {
    const had = typeof from === 'string' ? C[name].includes(from) : from.test(C[name]);
    if (!had) throw new Error('js/toon.js: three\'s ' + name + ' chunk no longer holds the text the cel patch replaces');
    C[name] = C[name].replace(from, to);
  };
  patch('shadowmap_pars_fragment', /if \( frustumTest \) \{\s*(?:\/\/[^\n]*\s*)*vec2 texelSize[\s\S]*?\) \* 0\.2;\s*\}/, /* glsl */`
			float celLit = 1.0;
			if ( frustumTest ) {
				vec2 celT = vec2( 0.5 ) / shadowMapSize;
				celLit = (
					texture( shadowMap, vec3( shadowCoord.xy + vec2( -celT.x, -celT.y ), shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vec2( celT.x, -celT.y ), shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vec2( -celT.x, celT.y ), shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vec2( celT.x, celT.y ), shadowCoord.z ) )
				) * 0.25;
			}
			float celW = clamp( fwidth( celLit ), 0.02, 0.5 );
			shadow = smoothstep( 0.5 - celW, 0.5 + celW, celLit );`);
  patch('lights_pars_begin', 'uniform bool receiveShadow;', /* glsl */`uniform bool receiveShadow;
float celShade = 1.0;
#ifdef CEL_HARDWARE
	uniform vec4 celSun;        // sun reaching the hardware, fill scale, emissive scale, flood reach km
	uniform vec3 celFloodDir;   // toward the rig, world axes
	uniform vec3 celFloodCol;
	uniform vec4 celPad;        // the pad's origin in view space; w: 1 when the pool is drawn
	uniform vec3 celUp;         // the pad's up, world axes
	uniform vec3 celPool;       // inner radius, outer radius (km), strength
#endif`);
  patch('lights_fragment_begin', 'getDirectionalLightInfo( directionalLight, directLight );', /* glsl */`getDirectionalLightInfo( directionalLight, directLight );
		celShade = 1.0;
		#if defined( CEL_HARDWARE ) && ( UNROLLED_LOOP_INDEX == 0 )
		directLight.color *= celSun.x;
		#endif`);
  patch('lights_fragment_begin', /directLight\.color \*= (\( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap[^;]*: 1\.0);/, /* glsl */`
		#ifdef TOON
		celShade = mix( ${CEL_FLOOR.toFixed(2)}, 1.0, $1 );
		#else
		directLight.color *= $1;
		#endif`);
  patch('lights_fragment_begin', '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )', /* glsl */`#ifdef CEL_HARDWARE
	totalEmissiveRadiance *= celSun.z;
	if ( celFloodCol.r + celPool.z > 0.0 ) {
		float celD = length( geometryPosition - celPad.xyz );
		float celNL = dot( geometryNormal, normalize( ( viewMatrix * vec4( celFloodDir, 0.0 ) ).xyz ) );
		float celNU = dot( geometryNormal, normalize( ( viewMatrix * vec4( celUp, 0.0 ) ).xyz ) );
		float celA = max( fwidth( celNL ), 0.004 );
		float celSide = smoothstep( 0.12 - celA, 0.12 + celA, celNL ) * step( celD, celSun.w );
		float celGround = step( 0.7, celNU ) * celPad.w * ( 0.5 * step( celD, celPool.x ) + 0.5 * step( celD, celPool.y ) ) * celPool.z;
		reflectedLight.directDiffuse += celFloodCol * max( celSide, celGround ) * BRDF_Lambert( material.diffuseColor );
	}
#endif

#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )`);
  patch('lights_fragment_begin', 'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );', /* glsl */`vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );
	#ifdef CEL_HARDWARE
	irradiance *= celSun.y;
	#endif`);
  patch('lights_toon_pars_fragment', 'getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color',
    'min( getGradientIrradiance( geometryNormal, directLight.direction ), vec3( celShade ) ) * directLight.color');
}

/* One set of light uniforms per place the hardware can be: the vehicle (and what falls off it) and
   the launch complex. js/world.js fills them every frame. */
function lightRig() {
  return {
    celSun: { value: new THREE.Vector4(1, 1, 1, 1e9) },
    celFloodDir: { value: new THREE.Vector3(0, 1, 0) },
    celFloodCol: { value: new THREE.Color(0, 0, 0) },
    celPad: { value: new THREE.Vector4(0, 0, 0, 0) },
    celUp: { value: new THREE.Vector3(0, 1, 0) },
    celPool: { value: new THREE.Vector3(0, 0, 0) },
  };
}
export const SHIP_LIGHT = lightRig(), PAD_LIGHT = lightRig();

/* A toon material for built hardware: the same cel ramp, plus the night and floodlight terms. */
export function hardware(opts = {}, rig = SHIP_LIGHT) {
  const m = toon(opts);
  m.defines = { ...(m.defines || {}), CEL_HARDWARE: 1 };
  m.onBeforeCompile = (sh) => { Object.assign(sh.uniforms, rig); };
  return m;
}
export const padware = (opts) => hardware(opts, PAD_LIGHT);

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
