import * as THREE from 'three';

/* The half-resolution pass: everything translucent and fill-rate-bound is drawn here, into a
   target a quarter the pixels of the screen, and laid over the frame as one quad.

   Why it exists, measured with EXT_disjoint_timer_query on an Apple M4 Max at 2160 × 1250: the
   marched weather shell cost 6.7 ms of a 13.4 ms idle frame, and at full throttle on the pad the
   exhaust's overlapping sprites cost 16 ms of a 31.6 ms frame — neither is detail the eye resolves
   at full resolution, both are soft by nature, and both scale with pixels covered.

   The target has its own depth buffer, filled first from the scene's opaque meshes with colour
   writes off, so cloud and smoke are hidden by the planet, the pad and the ship exactly as they
   were. The price is the usual one for this technique: along an occluder's silhouette the upsampled
   layer can be one low-resolution texel out.

   Objects opt in by layer. LAYER_FX objects are drawn ONLY here (never by the main camera);
   LAYER_OCC marks the opaque meshes that hide them. */
export const LAYER_FX = 2, LAYER_OCC = 3;
export const RES_SCALE = 0.5;

const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
/* One quad, premultiplied over the frame: the target accumulates premultiplied colour whether a
   layer in it used straight alpha (the weather) or its own premultiplied law (the exhaust). */
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { map: { value: null }, texel: { value: new THREE.Vector2() } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D map;
    uniform vec2 texel;
    varying vec2 vUv;
    /* Four bilinear taps half a texel out: a 3x3 tent over the low-resolution layer. Both things
       drawn into it dither on purpose (the weather jitters its march, the exhaust orders its cel
       bands), and at half resolution that dither is two screen pixels wide — measured as hatching
       across every cloud flank. The tent is the filter those patterns are built to be removed by. */
    void main() {
      vec2 o = 0.5 * texel;
      gl_FragColor = 0.25 * ( texture2D( map, vUv + o ) + texture2D( map, vUv - o )
                            + texture2D( map, vUv + vec2( o.x, -o.y ) ) + texture2D( map, vUv + vec2( -o.x, o.y ) ) );
    }`,
  depthTest: false, depthWrite: false, transparent: true, fog: false,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
}));
quad.frustumCulled = false;
quad.renderOrder = 2;          // over the sky, the limb and the hardware; under the ribbon and flares

let target = null;
const _size = new THREE.Vector2(), _clear = new THREE.Color();

export function initHalfRes(scene) { scene.add(quad); }

/* Draw `root` only in the half-resolution pass. */
export function fxOnly(root) { root.traverse((o) => o.layers.set(LAYER_FX)); return root; }

/* Mark every opaque mesh under `root` as something that hides the half-resolution layer. Call it
   once the scene is built; meshes keep the mark when they are re-parented (a jettisoned stage). */
export function occlude(root) {
  root.traverse((o) => {
    if (o.isMesh && o.material && !o.material.transparent && o.layers.test(camLayer0)) o.layers.enable(LAYER_OCC);
  });
}
const camLayer0 = new THREE.Layers();

export function renderHalfRes(renderer, scene, camera) {
  renderer.getDrawingBufferSize(_size);
  const w = Math.max(1, Math.ceil(_size.x * RES_SCALE)), h = Math.max(1, Math.ceil(_size.y * RES_SCALE));
  if (!target || target.width !== w || target.height !== h) {
    if (target) target.dispose();
    target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
    quad.material.uniforms.map.value = target.texture;
    quad.material.uniforms.texel.value.set(1 / w, 1 / h);
  }
  const background = scene.background, autoClear = renderer.autoClear, shadows = renderer.shadowMap.autoUpdate;
  const alpha = renderer.getClearAlpha(); renderer.getClearColor(_clear);
  scene.background = null;                 // a background would be painted into the target
  renderer.autoClear = false;              // the second render must keep the first one's depth
  renderer.shadowMap.autoUpdate = false;   // one shadow pass per frame, and it belongs to the main render
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  camera.layers.set(LAYER_OCC); scene.overrideMaterial = depthOnly;
  renderer.render(scene, camera);
  camera.layers.set(LAYER_FX); scene.overrideMaterial = null;
  renderer.render(scene, camera);
  camera.layers.set(0);
  renderer.setRenderTarget(null);
  renderer.setClearColor(_clear, alpha);
  scene.background = background; renderer.autoClear = autoClear; renderer.shadowMap.autoUpdate = shadows;
}
