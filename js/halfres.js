import * as THREE from 'three';

/* The half-resolution passes: layers that are soft by nature and bound by fill rate are drawn into
   targets a quarter the pixels of the screen and brought back over the frame.

   Why, measured with EXT_disjoint_timer_query on an Apple M4 Max at 2160 × 1250 when the pass was
   introduced: the weather shell (then a ray march) cost 6.7 ms of a 13.4 ms idle frame, and at full
   throttle on the pad the exhaust's overlapping sprites cost 16 ms of a 31.6 ms frame — neither is
   detail the eye resolves at full resolution, and both scale with pixels covered.

   Two layers, because they are hidden by things in two different ways.

   SKY (the weather). Drawn into a target with no depth buffer at all, then put on screen by the
   shell's own geometry in the main pass, with a material (js/clouds.js) that looks the result up
   by screen position. That geometry is depth-tested at FULL resolution, so the rocket, the tower
   and the planet cut the clouds along their true edges. An earlier version tested the weather
   against a low-resolution depth prepass and composited it with a quad: every silhouette then
   carried a fringe one low-resolution texel wide, bright cloud bleeding onto the hull's outline.
   What the weather writes into the target, and how it is cut back to a sharp edge, is
   js/clouds.js's business; nothing here filters it.

   FX (the exhaust). Smoke is in front of the hardware as often as behind it, so it does need a
   depth buffer of its own: the target's is filled first from the opaque meshes (LAYER_OCC) with
   colour writes off. Its silhouettes are therefore only half-resolution — on smoke, which has no
   edge of its own to compare against. The pass is skipped outright when no parcel is alive, which
   is most of the mission. It comes back through the quad below, a 3×3 tent. */
export const LAYER_FX = 2, LAYER_OCC = 3, LAYER_SKY = 4;
export const RES_SCALE = 0.5;

/* Shared with js/clouds.js's composite material: the weather target, its texel, the screen size. */
export const sky = { skyMap: { value: null }, skyTexel: { value: new THREE.Vector2() }, skyScreen: { value: new THREE.Vector2(1, 1) } };

const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { map: { value: null }, texel: { value: new THREE.Vector2() } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D map;
    uniform vec2 texel;
    varying vec2 vUv;
    void main() {
      vec2 o = 0.5 * texel;       // four bilinear taps half a texel out: a 3x3 tent
      gl_FragColor = 0.25 * ( texture2D( map, vUv + o ) + texture2D( map, vUv - o )
                            + texture2D( map, vUv + vec2( o.x, -o.y ) ) + texture2D( map, vUv + vec2( -o.x, o.y ) ) );
    }`,
  depthTest: false, depthWrite: false, transparent: true, fog: false,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
}));
quad.frustumCulled = false;
quad.renderOrder = 2;          // the FX composite: over the sky, the weather and the hardware; under the ribbon and flares

let skyTarget = null, fxTarget = null, fxLive = () => true;
const _size = new THREE.Vector2(), _clear = new THREE.Color(), layer0 = new THREE.Layers();

/* `live()` says whether anything on LAYER_FX has something to draw this frame. */
export function initHalfRes(scene, live) { scene.add(quad); if (live) fxLive = live; }

export function skyOnly(root) { root.traverse((o) => o.layers.set(LAYER_SKY)); return root; }

/* Mark every opaque mesh under `root` that the main camera draws as something that hides the FX
   layer. Call it once the scene is built; a mesh keeps the mark when it is re-parented. */
export function occlude(root) {
  root.traverse((o) => {
    if (o.isMesh && o.material && !o.material.transparent && o.layers.test(layer0)) o.layers.enable(LAYER_OCC);
  });
}

export function renderHalfRes(renderer, scene, camera) {
  renderer.getDrawingBufferSize(_size);
  const w = Math.max(1, Math.ceil(_size.x * RES_SCALE)), h = Math.max(1, Math.ceil(_size.y * RES_SCALE));
  if (!skyTarget || skyTarget.width !== w || skyTarget.height !== h) {
    if (skyTarget) { skyTarget.dispose(); fxTarget.dispose(); }
    skyTarget = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    fxTarget = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
    sky.skyMap.value = skyTarget.texture; sky.skyTexel.value.set(1 / w, 1 / h);
    quad.material.uniforms.map.value = fxTarget.texture; quad.material.uniforms.texel.value.set(1 / w, 1 / h);
  }
  sky.skyScreen.value.copy(_size);
  const background = scene.background, autoClear = renderer.autoClear, shadows = renderer.shadowMap.autoUpdate;
  const alpha = renderer.getClearAlpha(); renderer.getClearColor(_clear);
  scene.background = null;                 // a background would be painted into the targets
  renderer.autoClear = false;              // the FX render must keep the prepass's depth
  renderer.shadowMap.autoUpdate = false;   // one shadow pass per frame, and it belongs to the main render
  renderer.setClearColor(0x000000, 0);

  renderer.setRenderTarget(skyTarget); renderer.clear();
  camera.layers.set(LAYER_SKY); renderer.render(scene, camera);

  quad.visible = fxLive();
  if (quad.visible) {
    renderer.setRenderTarget(fxTarget); renderer.clear();
    camera.layers.set(LAYER_OCC); scene.overrideMaterial = depthOnly; renderer.render(scene, camera);
    camera.layers.set(LAYER_FX); scene.overrideMaterial = null; renderer.render(scene, camera);
  }
  camera.layers.set(0);
  renderer.setRenderTarget(null);
  renderer.setClearColor(_clear, alpha);
  scene.background = background; renderer.autoClear = autoClear; renderer.shadowMap.autoUpdate = shadows;
}
